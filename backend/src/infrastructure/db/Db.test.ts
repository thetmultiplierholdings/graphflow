import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRegistry, defineNode, defineWorkflow, type Nodeparamslot } from '../../domain/registry/Registry.js';
import { NotFoundError, RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import {
  artifactLineage,
  attach,
  autoDisplayName,
  browseArtifacts,
  catalogSnapshot,
  connect,
  createEngagement,
  createWorkflowRun,
  detach,
  freezeAndLoadDispatch,
  getArtifact,
  getWorkflowRun,
  initDb,
  instanceId,
  type LineageKind,
  listWorkflowRuns,
  memoLookup,
  nowIso,
  publishCatalog,
  recordCompletion,
  renameArtifact,
  resolveLineageKind,
  stats,
  supplyArtifact,
  userAttachments,
  workflowRunArtifacts,
} from './Db.js';

// The nowIso format contract — every hygiene timestamp asserts against it.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

// The exact error strings and RuntimeError context codes below ARE the wire contract (App.ts maps
// RUN_FROZEN/RUN_NOT_COPYABLE to 409 off the code literal; the routes forward the messages as
// {detail}). Capture the instance so messages pin with toBe instead of toThrow's substring match.
const capture = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to throw');
};

const sha256Hex = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex');

// A payload pair whose sha256 order INVERTS creation order: supplying `hi` first gives it the
// SMALLER artifact_id, so an ORDER BY hash regression to rowid/artifact_id/attach order becomes
// observable. (A fixed pair like 'AAA'/'BBB' can coincide with hash order and pass vacuously.)
const divergentPayloads = (): [hi: string, lo: string] => {
  const first = 'ORDER-PROBE-0';
  for (let i = 1; i < 256; i += 1) {
    const cand = `ORDER-PROBE-${i}`;
    if (sha256Hex(cand) < sha256Hex(first)) {
      return [first, cand];
    }
  }
  throw new Error('unreachable: no smaller hash among 255 candidates');
};

interface Fixture {
  dir: string;
  conn: Database.Database;
  storage: string;
  eng: number;
}

// Minimal catalog so FKs hold: the nodeparamslot vocabulary first (artifacts/nodes FK it), then two
// workflows — 'wf' with one engine node and its declared nodeparamslots (dispatch payloads carry
// them), 'wf2' as the cross-workflow copy target. Explicit column lists — positional inserts break
// silently on schema evolution.
const openFixture = (prefix = 'graphflow-db-'): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'test.sqlite3');
  const storage = join(dir, 'store');
  initDb(dbPath);
  const conn = connect(dbPath);
  const seededAt = nowIso();
  conn.exec('BEGIN IMMEDIATE');
  conn.exec(`INSERT INTO nodeparamslots (nodeparamslot, source, display_name, created_at) VALUES
    ('brokerage_statement','upload','','${seededAt}'),
    ('payment_slip','upload','','${seededAt}'),
    ('answers_nodeparamslot','questionnaire','','${seededAt}'),
    ('k','upload','','${seededAt}'),
    ('out_nodeparamslot','computed','','${seededAt}')`);
  conn.exec(
    `INSERT INTO workflows (workflow_id, display_name, created_at) VALUES ('wf','WF','${seededAt}'), ('wf2','WF2','${seededAt}')`
  );
  conn.exec(
    `INSERT INTO nodes (workflow_id, node_id, executor, output_nodeparamslot, display_name, created_at) VALUES ('wf','n1','engine','out_nodeparamslot','N1','${seededAt}')`
  );
  conn.exec(
    `INSERT INTO workflow_nodeparamslots (workflow_id, nodeparamslot) VALUES ('wf','k'),('wf','out_nodeparamslot')`
  );
  conn.exec('COMMIT');
  const eng = createEngagement(conn, 'test-eng');
  return { dir, conn, storage, eng };
};

// One canonical engine completion against the fixture's 'wf'/'n1' — every attach-back path under
// test routes through here.
const completeOn = (
  conn: Database.Database,
  storage: string,
  eng: number,
  wfr: number | null,
  memo = 'm1',
  payload: Uint8Array = Buffer.from('{"x":1}')
) =>
  recordCompletion(conn, storage, {
    engagementId: eng,
    workflowRunId: wfr,
    workflowId: 'wf',
    nodeId: 'n1',
    memoKey: memo,
    outputNodeparamslot: 'out_nodeparamslot',
    payload,
    mediaType: 'application/json',
    createdBy: 'engine',
    temporalId: 't/1/1',
    inputArtifactIds: [],
  });

// Ledger semantics: revive, nodeparamslot-scoped content addressing, idempotent completion transaction,
// attach promotion, copy-user-rows-only, derived provenance (artifact_facts).
describe('db ledger', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    ({ dir, conn, storage, eng } = openFixture());
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const complete = (wfr: number | null, memo = 'm1', payload?: Uint8Array) =>
    completeOn(conn, storage, eng, wfr, memo, payload);

  test('supply revive: same nodeparamslot + bytes reuses the row', () => {
    const a = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    const b = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    expect(a.artifact_id).toBe(b.artifact_id); // the revive path
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(true);
  });

  test('same bytes different nodeparamslot is a new row', () => {
    const a = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    const b = supplyArtifact(conn, storage, eng, 'payment_slip', Buffer.from('BYTES'));
    expect(a.artifact_id).not.toBe(b.artifact_id); // nodeparamslots route resolution
  });

  test('supply guard: a nodeparamslot absent from the vocabulary is rejected, leaving no orphaned blob', () => {
    const supply = () => supplyArtifact(conn, storage, eng, 'never_published', Buffer.from('BYTES'));
    expect(supply).toThrow(ValidationError);
    expect(supply).toThrow("nodeparamslot 'never_published' is not in the published nodeparamslot vocabulary");
    // The guard runs BEFORE writePayload: a rejected supply must not leave a content-addressed
    // blob behind (nothing has written to the store yet in this test).
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([]);
  });

  test('supplying a computed nodeparamslot stays legal and derives origin=override', () => {
    const a = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"hand":"built"}'));
    expect(getArtifact(conn, a.artifact_id).origin).toBe('override');
  });

  test('origin derives from the nodeparamslot birth channel for leaf supplies', () => {
    const upload = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('DOC'));
    const answers = supplyArtifact(conn, storage, eng, 'answers_nodeparamslot', Buffer.from('{"q":"a"}'));
    expect(getArtifact(conn, upload.artifact_id).origin).toBe('upload');
    expect(getArtifact(conn, answers.artifact_id).origin).toBe('questionnaire');
  });

  test('recordCompletion is idempotent (fresh flags, 1 node_run)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const { ref: ref1, fresh: fresh1 } = complete(wfr);
    const { ref: ref2, fresh: fresh2 } = complete(wfr);
    expect(fresh1).toBe(true);
    expect(fresh2).toBe(false);
    expect(ref1.artifact_id).toBe(ref2.artifact_id);
    const row = conn.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM node_runs').get();
    expect(row?.n).toBe(1);
  });

  test('completion links producer via the reverse edge (derived, not stored)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const { ref } = complete(wfr);
    const facts = getArtifact(conn, ref.artifact_id);
    expect(facts.origin).toBe('produced');
    expect(facts.produced_by_node_run).not.toBeNull();
    const nr = conn
      .prepare<[number | null], { output_artifact_id: number }>('SELECT * FROM node_runs WHERE node_run_id=?')
      .get(facts.produced_by_node_run);
    expect(nr?.output_artifact_id).toBe(ref.artifact_id); // the reverse edge holds
    const lineage = artifactLineage(conn, ref.artifact_id);
    expect(lineage.produced_by?.node_run_id).toBe(facts.produced_by_node_run);
  });

  test('convergence: hand-supplied then produced flips origin, earliest run wins', () => {
    // Supply the exact bytes a later run will produce: ON CONFLICT DO NOTHING converges both on
    // one row; the artifact_facts producer is the run, and MIN(node_run_id) stays deterministic
    // when a second distinct question converges on the same answer bytes.
    const supplied = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"x":1}'));
    expect(getArtifact(conn, supplied.artifact_id).origin).toBe('override');
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const first = complete(wfr, 'memo-a');
    const second = complete(wfr, 'memo-b'); // different question, identical answer bytes
    expect(first.ref.artifact_id).toBe(supplied.artifact_id);
    expect(second.ref.artifact_id).toBe(supplied.artifact_id);
    const facts = getArtifact(conn, supplied.artifact_id);
    expect(facts.origin).toBe('produced');
    const runs = conn
      .prepare<[], { node_run_id: number }>('SELECT node_run_id FROM node_runs ORDER BY node_run_id')
      .all();
    expect(runs).toHaveLength(2);
    expect(facts.produced_by_node_run).toBe(runs[0]?.node_run_id); // earliest run wins
    expect(artifactLineage(conn, supplied.artifact_id).produced_by?.node_run_id).toBe(runs[0]?.node_run_id);
  });

  test('recordCompletion rejects a non-computed output nodeparamslot with a typed error', () => {
    const leafOutput = () =>
      recordCompletion(conn, storage, {
        engagementId: eng,
        workflowRunId: null,
        workflowId: 'wf',
        nodeId: 'n1',
        memoKey: 'm-leaf',
        outputNodeparamslot: 'brokerage_statement',
        payload: Buffer.from('X'),
        mediaType: 'text/plain',
        createdBy: 'engine',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(leafOutput).toThrow(RuntimeError);
    expect(leafOutput).toThrow(
      "output nodeparamslot 'brokerage_statement' is a leaf channel ('upload') — runs may only produce computed nodeparamslots"
    );
    const unknownOutput = () =>
      recordCompletion(conn, storage, {
        engagementId: eng,
        workflowRunId: null,
        workflowId: 'wf',
        nodeId: 'n1',
        memoKey: 'm-unknown',
        outputNodeparamslot: 'never_published',
        payload: Buffer.from('X'),
        mediaType: 'text/plain',
        createdBy: 'engine',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(unknownOutput).toThrow(
      "output nodeparamslot 'never_published' is not in the published nodeparamslot vocabulary"
    );
  });

  test('completion files the input edges under the assigned node_run_id (dupes collapse)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('IN-A'));
    const b = supplyArtifact(conn, storage, eng, 'k', Buffer.from('IN-B'));
    const { ref } = recordCompletion(conn, storage, {
      engagementId: eng,
      workflowRunId: wfr,
      workflowId: 'wf',
      nodeId: 'n1',
      memoKey: 'm-inputs',
      outputNodeparamslot: 'out_nodeparamslot',
      payload: Buffer.from('{"y":2}'),
      mediaType: 'application/json',
      createdBy: 'engine',
      temporalId: 't/1/1',
      inputArtifactIds: [a.artifact_id, b.artifact_id, a.artifact_id],
    });
    const runId = getArtifact(conn, ref.artifact_id).produced_by_node_run;
    const edges = conn
      .prepare<[number | null], { artifact_id: number }>(
        'SELECT artifact_id FROM node_run_inputs WHERE node_run_id=? ORDER BY artifact_id'
      )
      .all(runId);
    expect(edges.map((e) => e.artifact_id)).toEqual([a.artifact_id, b.artifact_id]);
    expect(artifactLineage(conn, a.artifact_id).consumed_by.map((r) => r.node_run_id)).toEqual([runId]);
    expect(artifactLineage(conn, ref.artifact_id).produced_by?.input_artifact_ids).toEqual([
      a.artifact_id,
      b.artifact_id,
    ]);
  });

  test('memo lookup + hard engagement isolation', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    expect(memoLookup(conn, eng, 'm1')).toBeNull();
    const { ref } = complete(wfr);
    expect(memoLookup(conn, eng, 'm1')?.artifact_id).toBe(ref.artifact_id);
    // hard isolation: another engagement sees nothing
    const eng2 = createEngagement(conn, 'other');
    expect(memoLookup(conn, eng2, 'm1')).toBeNull();
  });

  test('attach promotes, never demotes; promotion preserves created_*, stamps updated_*', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('D'));
    attach(conn, wfr, a.artifact_id, { source: 'engine', createdBy: 'engine' });
    attach(conn, wfr, a.artifact_id, { source: 'user', createdBy: 'user:alice' }); // promote
    attach(conn, wfr, a.artifact_id, { source: 'engine', createdBy: 'engine' }); // no demote
    const rows = conn
      .prepare<[number], { source: string; created_by: string; updated_by: string | null }>(
        'SELECT source, created_by, updated_by FROM workflow_run_artifacts WHERE workflow_run_id=?'
      )
      .all(wfr);
    // Who first attached (the engine) survives promotion; the promoter lands in updated_*.
    expect(rows).toEqual([{ source: 'user', created_by: 'engine', updated_by: 'user:alice' }]);
  });

  test('user→user re-attach is a true no-op: updated_* only records real promotions', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const membership = conn.prepare<[number, number], { created_by: string; updated_by: string | null }>(
      'SELECT created_by, updated_by FROM workflow_run_artifacts WHERE workflow_run_id=? AND artifact_id=?'
    );
    // Promoted row: re-attaching as another user must not re-stamp the promotion.
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('D'));
    attach(conn, wfr, a.artifact_id, { source: 'engine', createdBy: 'engine' });
    attach(conn, wfr, a.artifact_id, { source: 'user', createdBy: 'user:alice' });
    attach(conn, wfr, a.artifact_id, { source: 'user', createdBy: 'user:bob' });
    expect(membership.get(wfr, a.artifact_id)).toEqual({ created_by: 'engine', updated_by: 'user:alice' });
    // User-born row: never promoted, so updated_* stays NULL through re-attaches.
    const b = supplyArtifact(conn, storage, eng, 'k', Buffer.from('E'));
    attach(conn, wfr, b.artifact_id, { source: 'user', createdBy: 'user:alice' });
    attach(conn, wfr, b.artifact_id, { source: 'user', createdBy: 'user:bob' });
    expect(membership.get(wfr, b.artifact_id)).toEqual({ created_by: 'user:alice', updated_by: null });
  });

  test('convergence keeps the first filer: created_* immutable, updated_* stays NULL', () => {
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('BYTES'), { createdBy: 'user:alpha' });
    const b = supplyArtifact(conn, storage, eng, 'k', Buffer.from('BYTES'), { createdBy: 'user:beta' });
    expect(b.artifact_id).toBe(a.artifact_id);
    const row = conn
      .prepare<[number], { created_by: string; updated_by: string | null; updated_at: string | null }>(
        'SELECT created_by, updated_by, updated_at FROM artifacts WHERE artifact_id=?'
      )
      .get(a.artifact_id);
    expect(row).toEqual({ created_by: 'user:alpha', updated_by: null, updated_at: null });
  });

  test('a completion tx shares ONE filedAt: node_run, artifact and attach stamps agree', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const { ref } = complete(wfr);
    const art = conn
      .prepare<[number], { created_by: string; created_at: string }>(
        'SELECT created_by, created_at FROM artifacts WHERE artifact_id=?'
      )
      .get(ref.artifact_id);
    const nr = conn
      .prepare<[], { created_by: string; created_at: string }>('SELECT created_by, created_at FROM node_runs')
      .get();
    const wra = conn
      .prepare<[number], { created_at: string }>('SELECT created_at FROM workflow_run_artifacts WHERE artifact_id=?')
      .get(ref.artifact_id);
    expect(art?.created_at).toMatch(ISO_RE);
    expect(nr).toEqual({ created_by: 'engine', created_at: art?.created_at });
    expect(wra?.created_at).toBe(art?.created_at);
  });

  test('renameArtifact stamps updated_*; created_* and fresh rows stay untouched', () => {
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    const stamps = conn.prepare<[number], { created_by: string; updated_by: string | null; updated_at: string | null }>(
      'SELECT created_by, updated_by, updated_at FROM artifacts WHERE artifact_id=?'
    );
    expect(stamps.get(a.artifact_id)).toEqual({ created_by: 'user', updated_by: null, updated_at: null });
    renameArtifact(conn, a.artifact_id, 'renamed', 'user:alice');
    const after = stamps.get(a.artifact_id);
    expect(after?.created_by).toBe('user');
    expect(after?.updated_by).toBe('user:alice');
    expect(after?.updated_at).toMatch(ISO_RE);
    expect(getArtifact(conn, a.artifact_id).display_name).toBe('renamed');
  });

  test('deleted_at is dormant: never set by any operation, never filtered by readers', () => {
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    renameArtifact(conn, a.artifact_id, 'renamed', 'user');
    const tombstone = conn.prepare<[number], { deleted_at: string | null }>(
      'SELECT deleted_at FROM artifacts WHERE artifact_id=?'
    );
    expect(tombstone.get(a.artifact_id)).toEqual({ deleted_at: null });
    // Reserved, not implemented: a hand-tombstoned row still reads back everywhere (and would
    // still block re-supplying identical bytes — the documented trap for a future soft delete).
    conn.prepare('UPDATE artifacts SET deleted_at=? WHERE artifact_id=?').run(nowIso(), a.artifact_id);
    expect(getArtifact(conn, a.artifact_id).artifact_id).toBe(a.artifact_id);
    expect(browseArtifacts(conn, eng).map((r) => r.artifact_id)).toContain(a.artifact_id);
  });

  test('malformed principals are rejected at every write boundary, leaving no orphaned blob', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    expect(() => createEngagement(conn, 'x', { createdBy: 'nobody' })).toThrow(ValidationError);
    expect(() => createWorkflowRun(conn, eng, 'wf', 'ws2', { createdBy: 'engineer' })).toThrow(ValidationError);
    const supply = () => supplyArtifact(conn, storage, eng, 'k', Buffer.from('P'), { createdBy: 'alice' });
    expect(supply).toThrow(ValidationError);
    expect(supply).toThrow(
      "'alice' is not a principal — expected '<type>[:<name>]' with type user|engine|system|agent"
    );
    const completeBad = () =>
      recordCompletion(conn, storage, {
        engagementId: eng,
        workflowRunId: wfr,
        workflowId: 'wf',
        nodeId: 'n1',
        memoKey: 'm-bad',
        outputNodeparamslot: 'out_nodeparamslot',
        payload: Buffer.from('{"z":9}'),
        mediaType: 'application/json',
        createdBy: 'robot',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(completeBad).toThrow(ValidationError);
    // The principal guards run BEFORE writePayload — the same no-orphaned-blob rule as the nodeparamslot
    // guard above.
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([]);
    const ok = supplyArtifact(conn, storage, eng, 'k', Buffer.from('OK'));
    expect(() => attach(conn, wfr, ok.artifact_id, { createdBy: 'bob' })).toThrow(ValidationError);
    expect(() => renameArtifact(conn, ok.artifact_id, 'x', 'bob')).toThrow(ValidationError);
  });

  test('copy takes user rows only', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'January');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    complete(wfr); // engine result lands in the workflow run
    expect(workflowRunArtifacts(conn, wfr)).toHaveLength(2);
    freezeAndLoadDispatch(conn, wfr); // the copyability gate: only executed runs can be copied

    const feb = createWorkflowRun(conn, eng, 'wf', 'February', { copiedFrom: wfr });
    expect(getWorkflowRun(conn, feb).lineage_kind).toBe('copy');
    const copied = workflowRunArtifacts(conn, feb);
    expect(copied.map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    expect(copied[0]?.source).toBe('user');
    expect(copied[0]?.origin).toBe('upload');
  });

  test('detach removes membership, ledger survives', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    detach(conn, wfr, doc.artifact_id);
    expect(workflowRunArtifacts(conn, wfr)).toEqual([]);
    // ledger untouched
    expect(getArtifact(conn, doc.artifact_id).hash).toBe(doc.hash);
  });

  test('user attachments hash-ordered (both artifact_id and attach order diverge from hash order)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    // divergentPayloads: hi is supplied FIRST (smaller artifact_id, larger hash), so the wra
    // PK-autoindex fallback order — which a fixed 'AAA'/'BBB' pair happens to coincide with —
    // cannot fake the pass either.
    const [hiPayload, loPayload] = divergentPayloads();
    const hi = supplyArtifact(conn, storage, eng, 'k', Buffer.from(hiPayload));
    const lo = supplyArtifact(conn, storage, eng, 'k', Buffer.from(loPayload));
    expect(lo.hash < hi.hash).toBe(true);
    expect(hi.artifact_id).toBeLessThan(lo.artifact_id);
    attach(conn, wfr, hi.artifact_id, { source: 'user' }); // attach order == id order != hash order
    attach(conn, wfr, lo.artifact_id, { source: 'user' });
    expect(userAttachments(conn, wfr).map((r) => r.hash)).toEqual([lo.hash, hi.hash]);
  });

  test('stats counts under the workflow_runs key', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'ws');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    complete(wfr);
    // Exact key set: 'workspaces' is retired vocabulary — toEqual dies on a lingering or
    // reverted key, toMatchObject would not.
    expect(stats(conn, eng)).toEqual({ artifacts: 2, node_runs: 1, human_answers: 0, workflow_runs: 1 });
  });

  test('listWorkflowRuns: asymmetric per-source counts, derived lineage, stable order', () => {
    const a = createWorkflowRun(conn, eng, 'wf', 'A');
    const d1 = supplyArtifact(conn, storage, eng, 'k', Buffer.from('LIST-1'));
    const d2 = supplyArtifact(conn, storage, eng, 'k', Buffer.from('LIST-2'));
    attach(conn, a, d1.artifact_id, { source: 'user' });
    attach(conn, a, d2.artifact_id, { source: 'user' });
    complete(a, 'm-list'); // exactly one engine result pinned to a
    const b = createWorkflowRun(conn, eng, 'wf', 'B');
    const rows = listWorkflowRuns(conn, eng);
    expect(rows.map((r) => r.workflow_run_id)).toEqual([a, b]); // ORDER BY created_at, id
    // 2 user vs 1 engine — asymmetric on purpose: a source-filter swap cannot pass.
    expect([rows[0]?.user_docs, rows[0]?.engine_results]).toEqual([2, 1]);
    expect([rows[1]?.user_docs, rows[1]?.engine_results]).toEqual([0, 0]);
    // The list reads workflow_run_facts: derived lineage rides along.
    expect(rows[0]?.lineage_byid).toBe(String(a));
    expect(rows[0]?.root_workflow_run_id).toBe(a);
    expect(rows[0]?.lineage_display).toBe('A');
    expect(rows[1]?.lineage_kind).toBe('root');
  });
});

// The pure copy_from/lineage_kind pairing rules — shared by the route's fast-fail 422 and
// createWorkflowRun's authoritative in-tx path, so the messages here are the wire contract.
describe('resolveLineageKind', () => {
  test('defaults: a bare create is root, copy_from alone means copy', () => {
    expect(resolveLineageKind(null)).toBe('root');
    expect(resolveLineageKind(5)).toBe('copy');
  });

  test('explicit kinds pass through when the pairing is legal', () => {
    expect(resolveLineageKind(null, 'root')).toBe('root');
    expect(resolveLineageKind(5, 'copy')).toBe('copy');
    expect(resolveLineageKind(5, 'revision')).toBe('revision');
    expect(resolveLineageKind(5, 'simulation')).toBe('simulation');
  });

  test('illegal pairings throw the exact route-contract messages', () => {
    const rootWithParent = capture(() => resolveLineageKind(5, 'root'));
    expect(rootWithParent).toBeInstanceOf(ValidationError);
    expect(rootWithParent.message).toBe(
      "lineage_kind 'root' cannot carry copy_from — use 'copy', 'revision' or 'simulation'"
    );
    for (const kind of ['copy', 'revision', 'simulation'] as const) {
      const err = capture(() => resolveLineageKind(null, kind));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(`lineage_kind '${kind}' requires copy_from`);
    }
  });
});

// The db half of the copyability gate: parent exists, same engagement, executed at least once,
// revision/simulation keep the parent's workflow. Enforced in createWorkflowRun's BEGIN IMMEDIATE
// so the CLI and seed cannot bypass it.
describe('createWorkflowRun lineage gates', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    ({ dir, conn, storage, eng } = openFixture());
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A frozen parent with one user attachment — the precondition every copy needs.
  const executedRun = (name: string) => {
    const wfr = createWorkflowRun(conn, eng, 'wf', name);
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from(`doc for ${name}`));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    freezeAndLoadDispatch(conn, wfr);
    return { wfr, doc };
  };

  test("copy may cross workflows; revision and simulation must keep the parent's workflow", () => {
    const { wfr: parent, doc } = executedRun('January');
    const cross = createWorkflowRun(conn, eng, 'wf2', 'January on v2', { copiedFrom: parent, lineageKind: 'copy' });
    const crossRow = getWorkflowRun(conn, cross);
    expect(crossRow.workflow_id).toBe('wf2');
    expect(crossRow.lineage_kind).toBe('copy');
    expect(workflowRunArtifacts(conn, cross).map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    // Test revision AND simulation — a mutation dropping either kind from the family-extending
    // branch must die here.
    for (const kind of ['revision', 'simulation'] as const) {
      const err = capture(() =>
        createWorkflowRun(conn, eng, 'wf2', `${kind} on v2`, { copiedFrom: parent, lineageKind: kind })
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(
        `a ${kind} must keep the parent's workflow 'wf' — asking for a different workflow is a copy`
      );
    }
  });

  test('an unexecuted parent is uncopyable: RUN_NOT_COPYABLE rides the error context', () => {
    const draft = createWorkflowRun(conn, eng, 'wf', 'draft');
    const err = capture(() => createWorkflowRun(conn, eng, 'wf', 'too early', { copiedFrom: draft }));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).context).toEqual({ code: 'RUN_NOT_COPYABLE' }); // App.ts maps 409 off this literal
    expect(err.message).toBe(`workflow run ${draft} has never been executed — only finished runs can be copied`);
    // The rejected create leaked no row.
    const n = conn.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM workflow_runs').get();
    expect(n?.n).toBe(1);
  });

  test('copy_from is engagement-scoped; a missing parent 404s', () => {
    const { wfr: parent } = executedRun('January');
    const eng2 = createEngagement(conn, 'other');
    const cross = capture(() => createWorkflowRun(conn, eng2, 'wf', 'poached', { copiedFrom: parent }));
    expect(cross).toBeInstanceOf(ValidationError);
    expect(cross.message).toBe('copy_from must be a workflow run in the same engagement');
    const missing = () => createWorkflowRun(conn, eng, 'wf', 'orphan', { copiedFrom: 424_242 });
    expect(missing).toThrow(NotFoundError);
    expect(missing).toThrow('workflow_run 424242 not found');
  });

  test('copy takes promoted + user rows, skips post-freeze engine rows, mints fresh stamps', () => {
    const parent = createWorkflowRun(conn, eng, 'wf', 'parent');
    const e1 = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"e":1}'));
    attach(conn, parent, e1.artifact_id, { source: 'engine', createdBy: 'engine' });
    attach(conn, parent, e1.artifact_id, { source: 'user', createdBy: 'user:alice' }); // promote
    const u1 = supplyArtifact(conn, storage, eng, 'k', Buffer.from('U1'));
    attach(conn, parent, u1.artifact_id, { source: 'user', createdBy: 'user:alice' });
    freezeAndLoadDispatch(conn, parent);
    const post = completeOn(conn, storage, eng, parent, 'm-post-freeze'); // engine attach-back after the freeze

    const child = createWorkflowRun(conn, eng, 'wf', 'child', { copiedFrom: parent, createdBy: 'user:reviewer' });
    const rows = conn
      .prepare<
        [number],
        {
          artifact_id: number;
          source: string;
          created_by: string;
          created_at: string;
          updated_by: string | null;
          updated_at: string | null;
        }
      >(
        'SELECT artifact_id, source, created_by, created_at, updated_by, updated_at FROM workflow_run_artifacts WHERE workflow_run_id=? ORDER BY artifact_id'
      )
      .all(child);
    expect(rows.map((r) => r.artifact_id)).toEqual([e1.artifact_id, u1.artifact_id].sort((m, n) => m - n));
    expect(rows.map((r) => r.artifact_id)).not.toContain(post.ref.artifact_id);
    for (const row of rows) {
      expect(row.source).toBe('user'); // membership is by source, not by who created the row
      expect(row.created_by).toBe('user:reviewer'); // fresh membership under the copying actor
      expect(row.created_at).toMatch(ISO_RE);
      expect(row.updated_by).toBeNull(); // promotion history is NOT copied
      expect(row.updated_at).toBeNull();
    }
  });

  test('a copy is born unfrozen and editable while the parent stays frozen', () => {
    const { wfr: parent } = executedRun('parent');
    const kid = createWorkflowRun(conn, eng, 'wf', 'kid', { copiedFrom: parent });
    expect(getWorkflowRun(conn, kid).executed_at).toBeNull();
    const extra = supplyArtifact(conn, storage, eng, 'k', Buffer.from('EXTRA'));
    attach(conn, kid, extra.artifact_id, { source: 'user' });
    detach(conn, kid, extra.artifact_id);
    const err = capture(() => attach(conn, parent, extra.artifact_id, { source: 'user' }));
    expect((err as RuntimeError).context).toEqual({ code: 'RUN_FROZEN' });
  });

  test('archive is display metadata, not a lineage gate: an archived executed parent still copies', () => {
    const { wfr: parent } = executedRun('parent');
    conn.prepare('UPDATE workflow_runs SET archived_at=? WHERE workflow_run_id=?').run(nowIso(), parent);
    const kid = createWorkflowRun(conn, eng, 'wf', 'kid', { copiedFrom: parent });
    expect(getWorkflowRun(conn, kid).lineage_kind).toBe('copy');
  });

  test('two children of one parent are independent siblings', () => {
    const { wfr: parent, doc } = executedRun('parent');
    const r1 = createWorkflowRun(conn, eng, 'wf', 'rev one', { copiedFrom: parent, lineageKind: 'revision' });
    const r2 = createWorkflowRun(conn, eng, 'wf', 'rev two', { copiedFrom: parent, lineageKind: 'revision' });
    const k = createWorkflowRun(conn, eng, 'wf', 'copy kid', { copiedFrom: parent });
    expect(new Set([r1, r2, k]).size).toBe(3);
    expect(getWorkflowRun(conn, r1).lineage_byid).toBe(`${parent}/${r1}`);
    expect(getWorkflowRun(conn, r2).lineage_byid).toBe(`${parent}/${r2}`);
    // Each child owns its membership rows: detaching from one sibling leaves the other whole.
    expect(workflowRunArtifacts(conn, r1).map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    expect(workflowRunArtifacts(conn, r2).map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    detach(conn, r1, doc.artifact_id);
    expect(workflowRunArtifacts(conn, r1)).toEqual([]);
    expect(workflowRunArtifacts(conn, r2).map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
  });
});

// The freeze transaction: guards BEFORE the stamp (races F2/F3), set-once stamp, user-only
// hash-ordered snapshot.
describe('freezeAndLoadDispatch', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    ({ dir, conn, storage, eng } = openFixture());
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const executedAtOf = (wfr: number) =>
    conn
      .prepare<[number], { executed_at: string | null }>(
        'SELECT executed_at FROM workflow_runs WHERE workflow_run_id=?'
      )
      .get(wfr)?.executed_at;

  test('returns everything a dispatch needs in one payload', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'run');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    expect(freezeAndLoadDispatch(conn, wfr)).toEqual({
      engagementId: eng,
      workflowId: 'wf',
      attachments: [
        {
          artifact_id: doc.artifact_id,
          hash: doc.hash,
          nodeparamslot: 'k',
          display_name: doc.display_name,
          media_type: doc.media_type,
        },
      ],
      instance: instanceId(conn),
      declaredNodeparamslots: ['k', 'out_nodeparamslot'],
    });
  });

  test('stamps executed_at exactly once; updated_* stays NULL (the documented hygiene exemption)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'run');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    const stamps = conn.prepare<
      [number],
      {
        executed_at: string | null;
        created_by: string;
        created_at: string;
        updated_by: string | null;
        updated_at: string | null;
      }
    >('SELECT executed_at, created_by, created_at, updated_by, updated_at FROM workflow_runs WHERE workflow_run_id=?');
    const before = stamps.get(wfr);
    expect(before?.executed_at).toBeNull();
    const dispatch = freezeAndLoadDispatch(conn, wfr);
    const frozen = stamps.get(wfr);
    expect(frozen?.executed_at).toMatch(ISO_RE);
    expect(frozen?.updated_by).toBeNull(); // executed_at is itself the write-once audit stamp
    expect(frozen?.updated_at).toBeNull();
    expect(frozen?.created_by).toBe(before?.created_by);
    expect(frozen?.created_at).toBe(before?.created_at);
    // Set-once probe with a sentinel: nowIso() is seconds-precision, so freeze-twice-compare
    // could pass vacuously inside one second — a planted stamp makes a re-stamp observable.
    conn
      .prepare('UPDATE workflow_runs SET executed_at=? WHERE workflow_run_id=?')
      .run('2020-01-01T00:00:00+00:00', wfr);
    const retry = freezeAndLoadDispatch(conn, wfr); // retry-in-place is a no-op stamp, not an error
    expect(stamps.get(wfr)?.executed_at).toBe('2020-01-01T00:00:00+00:00');
    expect(retry.attachments).toEqual(dispatch.attachments);
  });

  test('an empty USER snapshot rejects before the stamp; engine-only membership counts as empty', () => {
    // The detach-race fix (F2): the route pre-check is only a fast path — this in-tx check is
    // what prevents freezing an empty snapshot.
    const wfr = createWorkflowRun(conn, eng, 'wf', 'empty');
    const dispatch = () => freezeAndLoadDispatch(conn, wfr);
    const bare = capture(dispatch);
    expect(bare).toBeInstanceOf(ValidationError);
    expect(bare.message).toBe('this workflow run has no documents attached — attach at least one before running');
    expect(executedAtOf(wfr)).toBeNull(); // guard-before-stamp: the doomed dispatch froze nothing
    // Engine rows do not satisfy the snapshot (invariant I7: dispatch is user-sourced only).
    const r = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"r":1}'));
    attach(conn, wfr, r.artifact_id, { source: 'engine', createdBy: 'engine' });
    const engineOnly = capture(dispatch);
    expect(engineOnly).toBeInstanceOf(ValidationError);
    expect(executedAtOf(wfr)).toBeNull();
  });

  test('a run pointing outside the catalog fails loud AND stays unfrozen (guard order, F3)', () => {
    // FK drift fixture: the guard exists for a run row whose workflow the catalog no longer
    // publishes — only reachable by raw SQL with FKs off.
    conn.pragma('foreign_keys = OFF');
    const info = conn
      .prepare(
        'INSERT INTO workflow_runs (engagement_id, workflow_id, display_name, created_by, created_at) VALUES (?,?,?,?,?)'
      )
      .run(eng, 'nope', 'ghost', 'user', nowIso());
    conn.pragma('foreign_keys = ON');
    const ghost = Number(info.lastInsertRowid);
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, ghost, doc.artifact_id, { source: 'user' });
    const err = capture(() => freezeAndLoadDispatch(conn, ghost));
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.message).toBe("workflow 'nope' is not in the catalog (run `init` first)");
    expect(executedAtOf(ghost)).toBeNull(); // a doomed dispatch must not freeze the row irrevocably
  });

  test('retry dispatch replays the frozen snapshot: post-freeze engine attach-backs stay out', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'run');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    const first = freezeAndLoadDispatch(conn, wfr);
    expect(first.attachments.map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    const post = completeOn(conn, storage, eng, wfr, 'm-post-freeze'); // engine attach-back to the frozen row
    expect(workflowRunArtifacts(conn, wfr).map((a) => a.artifact_id)).toContain(post.ref.artifact_id);
    const retry = freezeAndLoadDispatch(conn, wfr); // retry-in-place: same row, same snapshot
    expect(retry.attachments.map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
  });

  test('the dispatch snapshot is hash-ordered (artifact_id and attach order both diverge)', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'run');
    // divergentPayloads: hash order inverts creation order, so neither the wra PK-autoindex
    // fallback nor attach order can fake a stable memo-key ordering.
    const [hiPayload, loPayload] = divergentPayloads();
    const hi = supplyArtifact(conn, storage, eng, 'k', Buffer.from(hiPayload));
    const lo = supplyArtifact(conn, storage, eng, 'k', Buffer.from(loPayload));
    expect(lo.hash < hi.hash).toBe(true);
    expect(hi.artifact_id).toBeLessThan(lo.artifact_id);
    attach(conn, wfr, hi.artifact_id, { source: 'user' });
    attach(conn, wfr, lo.artifact_id, { source: 'user' });
    const d = freezeAndLoadDispatch(conn, wfr);
    expect(d.attachments.map((a) => a.artifact_id)).toEqual([lo.artifact_id, hi.artifact_id]);
  });

  test('the freeze stamp is scoped to the dispatched run: a pre-existing draft stays unfrozen', () => {
    // The bystander must exist BEFORE the stamp: a row-scoping regression in the freeze UPDATE
    // (one dispatch freezing every draft db-wide) is invisible to any later-created row.
    const bystander = createWorkflowRun(conn, eng, 'wf', 'bystander');
    const bDoc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('BYSTANDER'));
    attach(conn, bystander, bDoc.artifact_id, { source: 'user' });
    const target = createWorkflowRun(conn, eng, 'wf', 'target');
    const tDoc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('TARGET'));
    attach(conn, target, tDoc.artifact_id, { source: 'user' });
    freezeAndLoadDispatch(conn, target);
    expect(executedAtOf(target)).toMatch(ISO_RE);
    expect(executedAtOf(bystander)).toBeNull();
    // ...and the bystander is still a fully editable draft.
    const extra = supplyArtifact(conn, storage, eng, 'k', Buffer.from('EXTRA'));
    attach(conn, bystander, extra.artifact_id, { source: 'user' });
    detach(conn, bystander, extra.artifact_id);
  });

  test("declared nodeparamslots are scoped to the run's OWN workflow", () => {
    // Give wf2 a distinct one-slot vocabulary: losing the WHERE workflow_id scope on the
    // membership query would leak wf's ['k','out_nodeparamslot'] into a wf2 dispatch.
    conn
      .prepare("INSERT INTO workflow_nodeparamslots (workflow_id, nodeparamslot) VALUES ('wf2','brokerage_statement')")
      .run();
    const wfr = createWorkflowRun(conn, eng, 'wf2', 'other-wf');
    const doc = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('STMT'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    expect(freezeAndLoadDispatch(conn, wfr).declaredNodeparamslots).toEqual(['brokerage_statement']);
  });

  test('a missing run 404s', () => {
    const missing = () => freezeAndLoadDispatch(conn, 424_242);
    expect(missing).toThrow(NotFoundError);
    expect(missing).toThrow('workflow_run 424242 not found');
  });
});

// Freeze enforcement at the Db layer: a frozen run's user-attachment set is immutable; the engine
// attach-back paths stay exempt (executions keep pinning results to their own row).
// Accepted residual (QA panel): the guard-INSIDE-the-tx placement in attach/detach cannot be
// distinguished from guard-before-tx by any single-connection deterministic test (better-sqlite3
// is synchronous), and a two-connection busy_timeout race test would be slow and flaky. The
// protection is structural — assertNotFrozen sits inside the BEGIN IMMEDIATE; reviewers watch
// that placement.
describe('freeze guards', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    ({ dir, conn, storage, eng } = openFixture());
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const executedRun = (name: string) => {
    const wfr = createWorkflowRun(conn, eng, 'wf', name);
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from(`doc for ${name}`));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    freezeAndLoadDispatch(conn, wfr);
    return { wfr, doc };
  };

  const frozenMessage = (wfr: number) =>
    `workflow run ${wfr} is frozen (already executed) — attachments can no longer change; create a copy or revision`;

  test('fresh user attach on a frozen run rejects RUN_FROZEN and inserts NO row', () => {
    const { wfr } = executedRun('run');
    const stranger = supplyArtifact(conn, storage, eng, 'k', Buffer.from('LATE'));
    const err = capture(() => attach(conn, wfr, stranger.artifact_id, { source: 'user' }));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).context).toEqual({ code: 'RUN_FROZEN' });
    expect(err.message).toBe(frozenMessage(wfr));
    // Negative assertion: the guard runs before the INSERT — no row leaked despite the throw.
    const n = conn
      .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM workflow_run_artifacts WHERE workflow_run_id=?')
      .get(wfr);
    expect(n?.n).toBe(1); // the pre-freeze doc only
  });

  test('promoting an engine row on a frozen run rejects RUN_FROZEN and leaves the row untouched', () => {
    const wfr = createWorkflowRun(conn, eng, 'wf', 'run');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    const engineArt = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"e":1}'));
    attach(conn, wfr, engineArt.artifact_id, { source: 'engine', createdBy: 'engine' });
    freezeAndLoadDispatch(conn, wfr);
    // Promotion is a user mutation of the frozen set too — not just fresh inserts.
    const err = capture(() => attach(conn, wfr, engineArt.artifact_id, { source: 'user', createdBy: 'user:alice' }));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).context).toEqual({ code: 'RUN_FROZEN' });
    expect(err.message).toBe(frozenMessage(wfr));
    const row = conn
      .prepare<[number, number], { source: string; updated_by: string | null; updated_at: string | null }>(
        'SELECT source, updated_by, updated_at FROM workflow_run_artifacts WHERE workflow_run_id=? AND artifact_id=?'
      )
      .get(wfr, engineArt.artifact_id);
    expect(row).toEqual({ source: 'engine', updated_by: null, updated_at: null });
  });

  test('detach on a frozen run rejects even for a non-member: the guard is state-based, not row-based', () => {
    const { wfr } = executedRun('run');
    const stranger = supplyArtifact(conn, storage, eng, 'k', Buffer.from('NEVER-ATTACHED'));
    const err = capture(() => detach(conn, wfr, stranger.artifact_id));
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).context).toEqual({ code: 'RUN_FROZEN' });
    expect(err.message).toBe(frozenMessage(wfr));
    // Companion (preserved behavior): a non-member detach on an UNFROZEN run is a silent no-op.
    const editable = createWorkflowRun(conn, eng, 'wf', 'editable');
    expect(() => detach(conn, editable, stranger.artifact_id)).not.toThrow();
  });

  test('engine attach and both recordCompletion attach-back paths still land on frozen rows', () => {
    const { wfr: run1 } = executedRun('run one');
    const membership = conn.prepare<[number, number], { source: string }>(
      'SELECT source FROM workflow_run_artifacts WHERE workflow_run_id=? AND artifact_id=?'
    );
    // (a) plain engine attach onto the frozen row
    const e = supplyArtifact(conn, storage, eng, 'out_nodeparamslot', Buffer.from('{"e":1}'));
    attach(conn, run1, e.artifact_id, { source: 'engine', createdBy: 'engine' });
    expect(membership.get(run1, e.artifact_id)).toEqual({ source: 'engine' });
    // (b) slow path: a fresh memo files the fact and attaches back
    const slow = completeOn(conn, storage, eng, run1, 'm-shared', Buffer.from('{"slow":1}'));
    expect(slow.fresh).toBe(true);
    expect(membership.get(run1, slow.ref.artifact_id)).toEqual({ source: 'engine' });
    // (c) fast path: the same memo hit attaches back to a SECOND frozen run
    const { wfr: run2 } = executedRun('run two');
    const fast = completeOn(conn, storage, eng, run2, 'm-shared', Buffer.from('{"slow":1}'));
    expect(fast.fresh).toBe(false);
    expect(fast.ref.artifact_id).toBe(slow.ref.artifact_id);
    expect(membership.get(run2, fast.ref.artifact_id)).toEqual({ source: 'engine' });
  });

  test('user attach to a nonexistent run is NotFoundError, not an FK error', () => {
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    const attempt = () => attach(conn, 999_999, doc.artifact_id, { source: 'user' });
    expect(attempt).toThrow(NotFoundError);
    expect(attempt).toThrow('workflow_run 999999 not found');
  });
});

// Derived lineage: the workflow_run_facts view recomputes family root, depth and paths from
// copied_from_workflow_run + lineage_kind on every read — nothing stored can go stale.
describe('workflow_run_facts view', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    ({ dir, conn, storage, eng } = openFixture());
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const executedRun = (name: string): number => {
    const wfr = createWorkflowRun(conn, eng, 'wf', name);
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from(`doc for ${name}`));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    freezeAndLoadDispatch(conn, wfr);
    return wfr;
  };

  // Children inherit the parent's copied user memberships, so they can freeze without new docs.
  const child = (parent: number, kind: LineageKind, name: string): number =>
    createWorkflowRun(conn, eng, 'wf', name, { copiedFrom: parent, lineageKind: kind });

  const freeze = (wfr: number): void => {
    freezeAndLoadDispatch(conn, wfr);
  };

  test('every run appears exactly once, whatever its kind (view totality)', () => {
    const a = executedRun('Root a');
    const b = child(a, 'revision', 'Rev b');
    freeze(b);
    const c = child(b, 'simulation', 'Sim c');
    const k = child(a, 'copy', 'Copy k');
    const count = (table: string): number | undefined =>
      conn.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
    expect(count('workflow_runs')).toBe(4);
    expect(count('workflow_run_facts')).toBe(4);
    // Per-id exactly once: a narrowed anchor drops copies (404s), a widened anchor doubles
    // revisions/simulations (nondeterministic .get()) — both die on this shape.
    const rows = conn
      .prepare<[], { workflow_run_id: number; lineage_kind: string; n: number }>(
        'SELECT workflow_run_id, lineage_kind, COUNT(*) AS n FROM workflow_run_facts GROUP BY workflow_run_id ORDER BY workflow_run_id'
      )
      .all();
    expect(rows).toEqual([
      { workflow_run_id: a, lineage_kind: 'root', n: 1 },
      { workflow_run_id: b, lineage_kind: 'revision', n: 1 },
      { workflow_run_id: c, lineage_kind: 'simulation', n: 1 },
      { workflow_run_id: k, lineage_kind: 'copy', n: 1 },
    ]);
  });

  test("a revision of a copy roots at the copy — the family boundary is the child row's own kind", () => {
    const a = executedRun('Root alpha');
    const c = child(a, 'copy', 'Copy gamma');
    freeze(c);
    const r = child(c, 'revision', 'Rev rho');
    const rf = getWorkflowRun(conn, r);
    expect(rf.root_workflow_run_id).toBe(c);
    expect(rf.lineage_depth).toBe(1);
    expect(rf.lineage_byid).toBe(`${c}/${r}`);
    expect(rf.lineage_display).toBe('Copy gamma/Rev rho'); // Root alpha appears nowhere
    const cf = getWorkflowRun(conn, c);
    expect(cf.root_workflow_run_id).toBe(c);
    expect(cf.lineage_depth).toBe(0);
    expect(cf.lineage_byid).toBe(String(c));
    expect(cf.lineage_display).toBe('Copy gamma'); // depth-0: never prefixed
  });

  test('a copy of a simulation starts a new family; parenthood is preserved', () => {
    const a = executedRun('Root alpha');
    const s = child(a, 'simulation', 'Sim sigma');
    const sf = getWorkflowRun(conn, s);
    expect(sf.root_workflow_run_id).toBe(a); // simulation extends the family
    expect(sf.lineage_byid).toBe(`${a}/${s}`);
    freeze(s);
    const k = child(s, 'copy', 'Copy kappa');
    const kf = getWorkflowRun(conn, k);
    expect(kf.root_workflow_run_id).toBe(k); // copy restarts the family
    expect(kf.lineage_depth).toBe(0);
    expect(kf.copied_from_workflow_run).toBe(s); // …but never forgets its parent
    expect(kf.lineage_byid).toBe(String(k));
    expect(kf.lineage_display).toBe('Copy kappa');
  });

  test("a grandchild displays under the ROOT's name; intermediates appear in byid only", () => {
    const a = executedRun('Root alpha');
    const b = child(a, 'revision', 'Middle beta');
    freeze(b);
    const c = child(b, 'revision', 'Grandchild gamma');
    const cf = getWorkflowRun(conn, c);
    expect(cf.lineage_byid).toBe(`${a}/${b}/${c}`); // the full recursive path — no single self-join fakes this
    expect(cf.lineage_depth).toBe(2);
    expect(cf.lineage_display).toBe('Root alpha/Grandchild gamma'); // Middle beta in NEITHER field's display
  });

  test('renaming the family root flows through lineage_display instantly; child rows untouched', () => {
    const a = executedRun('Old name');
    const b = child(a, 'revision', 'Rev b');
    const s = child(a, 'revision', 'Rev s');
    conn.prepare('UPDATE workflow_runs SET display_name=? WHERE workflow_run_id=?').run('New name', a);
    expect(getWorkflowRun(conn, b).lineage_display).toBe('New name/Rev b');
    expect(getWorkflowRun(conn, b).updated_at).toBeNull(); // derived — nothing stored on the child moved
    expect(getWorkflowRun(conn, a).lineage_display).toBe('New name'); // depth-0 CASE: never doubled
    // Inverse: renaming a child touches only its own suffix.
    conn.prepare('UPDATE workflow_runs SET display_name=? WHERE workflow_run_id=?').run('Rev b2', b);
    expect(getWorkflowRun(conn, b).lineage_display).toBe('New name/Rev b2');
    expect(getWorkflowRun(conn, s).lineage_display).toBe('New name/Rev s'); // sibling unchanged
    expect(getWorkflowRun(conn, a).lineage_display).toBe('New name');
  });

  test('lineage_byid is TEXT even at depth 0', () => {
    // Dropping the anchor CAST would hand JS a number for depth-0 rows (SQLite dynamic typing),
    // breaking the wire type and the family LIKE pattern below.
    const a = createWorkflowRun(conn, eng, 'wf', 'root');
    const row = getWorkflowRun(conn, a);
    expect(typeof row.lineage_byid).toBe('string');
    expect(row.lineage_byid).toBe(String(a));
  });

  test("family grep (byid = ? OR LIKE ? || '/%') does not bleed across id-prefix collisions", () => {
    const one = executedRun('Root one');
    expect(one).toBe(1); // fresh db: deterministic ids make the prefix collision below real
    const two = child(one, 'revision', 'Rev two');
    expect(two).toBe(2);
    // A second family rooted at an id string-prefixed by '1': raw insert with an explicit id
    // (executed_at set directly so a child can hang off it).
    const stamped = nowIso();
    conn
      .prepare(
        'INSERT INTO workflow_runs (workflow_run_id, engagement_id, workflow_id, display_name, lineage_kind, executed_at, created_by, created_at) VALUES (12,?,?,?,?,?,?,?)'
      )
      .run(eng, 'wf', 'Root twelve', 'root', stamped, 'user', stamped);
    const thirteen = child(12, 'revision', 'Rev thirteen');
    expect(getWorkflowRun(conn, thirteen).lineage_byid).toBe(`12/${thirteen}`);
    const family = conn
      .prepare<[string, string], { workflow_run_id: number }>(
        "SELECT workflow_run_id FROM workflow_run_facts WHERE lineage_byid = ? OR lineage_byid LIKE ? || '/%' ORDER BY workflow_run_id"
      )
      .all('1', '1');
    expect(family.map((r) => r.workflow_run_id)).toEqual([one, two]); // no bleed from family 12
  });

  test('raw INSERTs violating the lineage CHECKs are rejected by the schema', () => {
    const parent = createWorkflowRun(conn, eng, 'wf', 'parent');
    const rawInsert = (kind: string, copiedFrom: number | null) => () =>
      conn
        .prepare(
          'INSERT INTO workflow_runs (engagement_id, workflow_id, display_name, copied_from_workflow_run, lineage_kind, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(eng, 'wf', 'raw', copiedFrom, kind, 'user', nowIso());
    // The Db functions can never reach these — only raw SQL exercises the CHECKs, and the
    // coupling CHECK is what makes the view walk total.
    for (const bad of [
      rawInsert('banana', null), // enum CHECK
      rawInsert('root', parent), // coupling: root must not carry a parent
      rawInsert('copy', null), // coupling: copy/revision require a parent
      rawInsert('revision', null),
    ]) {
      const err = capture(bad);
      expect(Reflect.get(err, 'code')).toBe('SQLITE_CONSTRAINT_CHECK');
    }
    const n = conn.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM workflow_runs').get();
    expect(n?.n).toBe(1); // nothing leaked past the CHECKs
  });

  test('a self-parent raw row is rejected by the no-self-parent CHECK (view totality holds)', () => {
    // id = copied_from would satisfy the FK (the row is its own parent) and the coupling CHECK,
    // but no family anchor could ever reach it — the view would silently drop the row. The
    // no-self-parent CHECK closes that hole at write time; with parents forced to pre-exist,
    // every row is reachable and workflow_run_facts stays total over the base table.
    const err = capture(() =>
      conn
        .prepare(
          "INSERT INTO workflow_runs (workflow_run_id, engagement_id, workflow_id, display_name, copied_from_workflow_run, lineage_kind, created_by, created_at) VALUES (77,?,?,?,77,'revision',?,?)"
        )
        .run(eng, 'wf', 'ouroboros', 'user', nowIso())
    );
    expect(Reflect.get(err, 'code')).toBe('SQLITE_CONSTRAINT_CHECK');
    const base = conn
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_run_id=77')
      .get();
    expect(base?.n).toBe(0); // nothing leaked into the base table
  });
});

// Publish hygiene: validateCatalog gating, upsert-only nodeparamslots/workflows/nodes, delete-then-insert
// mirrors (workflow_nodeparamslots, node_input_nodeparamslots).
describe('publish catalog', () => {
  let dir: string;
  let conn: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphflow-publish-'));
    initDb(join(dir, 'test.sqlite3'));
    conn = connect(join(dir, 'test.sqlite3'));
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeNode = (inputNodeparamslots: Record<string, string | null>) =>
    defineNode({
      name: 'n1',
      outputNodeparamslot: 'out_nodeparamslot',
      inputNodeparamslots,
      run: () => ({ ok: true }),
    });

  const makeRegistry = (
    nodeparamslots: readonly Nodeparamslot[],
    node = makeNode({ doc: 'doc_nodeparamslot', note: null })
  ) => buildRegistry([defineWorkflow({ id: 'wf', nodeparamslots, nodes: [node], run: async () => undefined })]);

  const count = (sql: string): number => {
    const row = conn.prepare<[], { n: number }>(sql).get();
    return row?.n ?? -1;
  };

  test('re-publish with a slimmer vocabulary shrinks the mirrors; nodeparamslots/nodes rows persist', () => {
    const wide = makeRegistry([
      { nodeparamslot: 'doc_nodeparamslot', source: 'upload', display: 'Document' },
      { nodeparamslot: 'out_nodeparamslot', source: 'computed' },
      { nodeparamslot: 'extra_nodeparamslot', source: 'email' },
    ]);
    publishCatalog(conn, wide);
    expect(count('SELECT COUNT(*) AS n FROM workflow_nodeparamslots')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM node_input_nodeparamslots')).toBe(2);

    const slim = makeRegistry(
      [
        { nodeparamslot: 'doc_nodeparamslot', source: 'upload', display: 'Document' },
        { nodeparamslot: 'out_nodeparamslot', source: 'computed' },
      ],
      makeNode({ doc: 'doc_nodeparamslot' })
    );
    publishCatalog(conn, slim);
    // The mirrors are rewritten: the removed nodeparamslot and the removed param stop lingering.
    const memberNodeparamslots = conn
      .prepare<[], { nodeparamslot: string }>('SELECT nodeparamslot FROM workflow_nodeparamslots ORDER BY rowid')
      .all()
      .map((r) => r.nodeparamslot);
    expect(memberNodeparamslots).toEqual(['doc_nodeparamslot', 'out_nodeparamslot']);
    const params = conn
      .prepare<[], { param: string }>('SELECT param FROM node_input_nodeparamslots ORDER BY rowid')
      .all()
      .map((r) => r.param);
    expect(params).toEqual(['doc']);
    // Upsert-only tables keep retired rows: the nodeparamslot vocabulary and node rows persist as FK parents.
    expect(count("SELECT COUNT(*) AS n FROM nodeparamslots WHERE nodeparamslot='extra_nodeparamslot'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM nodes')).toBe(1);
  });

  test('an invalid registry is rejected before any write', () => {
    // out_nodeparamslot is produced by n1 but declared with a leaf source — validateCatalog must refuse.
    const bad = makeRegistry([
      { nodeparamslot: 'doc_nodeparamslot', source: 'upload' },
      { nodeparamslot: 'out_nodeparamslot', source: 'upload' },
    ]);
    const publish = () => publishCatalog(conn, bad);
    expect(publish).toThrow(ValidationError);
    expect(publish).toThrow(
      "wf: nodeparamslot 'out_nodeparamslot' is produced by a node but declared with leaf source 'upload'"
    );
    expect(count('SELECT COUNT(*) AS n FROM workflows')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM nodeparamslots')).toBe(0);
  });

  test('republish stamps: identical registry is a no-op, a real change bumps updated_at once', () => {
    const registry = makeRegistry([
      { nodeparamslot: 'doc_nodeparamslot', source: 'upload', display: 'Document' },
      { nodeparamslot: 'out_nodeparamslot', source: 'computed' },
    ]);
    publishCatalog(conn, registry);
    const wfStamps = () =>
      conn
        .prepare<[], { created_at: string; updated_at: string | null }>('SELECT created_at, updated_at FROM workflows')
        .get();
    const first = wfStamps();
    expect(first?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(first?.updated_at).toBeNull();

    // The worker-restart path: identical registry, republished — nothing may move.
    publishCatalog(conn, registry);
    expect(wfStamps()).toEqual(first);
    const staleStamps = (table: string): number => {
      const row = conn
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE updated_at IS NOT NULL`)
        .get();
      return row?.n ?? -1;
    };
    expect(staleStamps('nodeparamslots')).toBe(0);
    expect(staleStamps('nodes')).toBe(0);

    // A real change (nodeparamslot display rename) bumps that row's updated_at; created_at holds.
    const changed = makeRegistry([
      { nodeparamslot: 'doc_nodeparamslot', source: 'upload', display: 'Document v2' },
      { nodeparamslot: 'out_nodeparamslot', source: 'computed' },
    ]);
    publishCatalog(conn, changed);
    const nodeparamslotStamp = conn
      .prepare<[], { created_at: string; updated_at: string | null }>(
        "SELECT created_at, updated_at FROM nodeparamslots WHERE nodeparamslot='doc_nodeparamslot'"
      )
      .get();
    expect(nodeparamslotStamp?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(wfStamps()?.created_at).toBe(first?.created_at); // workflows row unchanged, not re-dated
    expect(wfStamps()?.updated_at).toBeNull();

    // NULL-safe compare (IS NOT): a NULL→value display flip counts as a change, not a crash/no-op.
    conn
      .prepare("UPDATE nodeparamslots SET display_name=NULL, updated_at=NULL WHERE nodeparamslot='doc_nodeparamslot'")
      .run();
    publishCatalog(conn, changed);
    const flipped = conn
      .prepare<[], { display_name: string | null; updated_at: string | null }>(
        "SELECT display_name, updated_at FROM nodeparamslots WHERE nodeparamslot='doc_nodeparamslot'"
      )
      .get();
    expect(flipped?.display_name).toBe('Document v2');
    expect(flipped?.updated_at).not.toBeNull();
  });

  test('catalogSnapshot serves declaration order and the display fallback', () => {
    const registry = makeRegistry([
      { nodeparamslot: 'doc_nodeparamslot', source: 'upload', display: 'Document' },
      { nodeparamslot: 'out_nodeparamslot', source: 'computed' },
    ]);
    publishCatalog(conn, registry);
    const snapshot = catalogSnapshot(conn);
    expect(snapshot).toHaveLength(1);
    const wf = snapshot[0];
    expect(wf?.nodeparamslots.map((k) => k.nodeparamslot)).toEqual(['doc_nodeparamslot', 'out_nodeparamslot']);
    expect(wf?.nodeparamslots.map((k) => k.leaf)).toEqual([1, 0]);
    // Nodeparamslots declared without a display fall back to the nodeparamslot string — never an empty badge.
    expect(wf?.nodeparamslots.map((k) => k.display_name)).toEqual(['Document', 'out_nodeparamslot']);
    expect(wf?.nodes[0]?.input_nodeparamslots).toEqual({ doc: 'doc_nodeparamslot', note: null });
    expect(Object.keys(wf?.nodes[0]?.input_nodeparamslots ?? {})).toEqual(['doc', 'note']);
  });
});

describe('db helpers', () => {
  test('nowIso: UTC seconds precision with +00:00 suffix (not Z, no millis)', () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(Math.abs(new Date(s).getTime() - Date.now())).toBeLessThan(2000);
  });

  test('autoDisplayName: {nodeparamslot}_DDMMYY_HHMMSS in UTC', () => {
    const ddmmyy = (d: Date): string => {
      const two = (n: number): string => String(n).padStart(2, '0');
      return `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
    };
    const before = ddmmyy(new Date());
    const displayName = autoDisplayName('tax_report');
    const after = ddmmyy(new Date());
    expect(displayName).toMatch(/^tax_report_\d{6}_\d{6}$/);
    const datePart = displayName.slice('tax_report_'.length, 'tax_report_'.length + 6);
    expect([before, after]).toContain(datePart);
  });

  test('initDb mints one instance id and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graphflow-db-'));
    try {
      const dbPath = join(dir, 'init.sqlite3');
      const first = initDb(dbPath);
      const second = initDb(dbPath);
      expect(first).toMatch(/^[0-9a-f]{8}$/);
      expect(second).toBe(first);
      const conn = connect(dbPath);
      expect(instanceId(conn)).toBe(first);
      conn.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('initDb fails loud against a pre-lineage database (the stale-db probe)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graphflow-db-'));
    try {
      const dbPath = join(dir, 'stale.sqlite3');
      const stale = connect(dbPath);
      // A pre-lineage workflow_runs: no lineage_kind / executed_at, no view. CREATE TABLE IF NOT
      // EXISTS skips it and CREATE VIEW resolves columns lazily — without the probe this db
      // would boot fine and die on the first request instead.
      stale.exec(`CREATE TABLE workflow_runs (
        workflow_run_id INTEGER PRIMARY KEY,
        engagement_id INTEGER NOT NULL,
        workflow_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        copied_from_workflow_run INTEGER,
        archived_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT,
        deleted_at TEXT
      )`);
      stale.close();
      expect(() => initDb(dbPath)).toThrow(/no such column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
