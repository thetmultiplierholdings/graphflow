import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildRegistry, defineNode, defineWorkflow, type Kind } from '../../domain/registry/Registry.js';
import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import {
  artifactLineage,
  attach,
  autoLabel,
  browseArtifacts,
  catalogSnapshot,
  connect,
  createEngagement,
  createWorkspace,
  detach,
  getArtifact,
  initDb,
  instanceId,
  memoLookup,
  nowIso,
  publishCatalog,
  recordCompletion,
  renameArtifact,
  supplyArtifact,
  userAttachments,
  workspaceArtifacts,
} from './Db.js';

// The nowIso format contract — every hygiene timestamp asserts against it.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

// Ledger semantics: revive, kind-scoped content addressing, idempotent completion transaction,
// attach promotion, copy-user-rows-only, derived provenance (artifact_facts).
describe('db ledger', () => {
  let dir: string;
  let conn: Database.Database;
  let storage: string;
  let eng: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphflow-db-'));
    const dbPath = join(dir, 'test.sqlite3');
    storage = join(dir, 'store');
    initDb(dbPath);
    conn = connect(dbPath);
    // Minimal catalog so FKs hold: the kind vocabulary first (artifacts/nodes FK it), then one
    // workflow with one engine node. Explicit column lists — positional inserts break silently on
    // schema evolution.
    const seededAt = nowIso();
    conn.exec('BEGIN IMMEDIATE');
    conn.exec(`INSERT INTO kinds (kind, source, display_name, created_at) VALUES
      ('brokerage_statement','upload','','${seededAt}'),
      ('payment_slip','upload','','${seededAt}'),
      ('answers_kind','questionnaire','','${seededAt}'),
      ('k','upload','','${seededAt}'),
      ('out_kind','computed','','${seededAt}')`);
    conn.exec(`INSERT INTO workflows (workflow_id, display_name, created_at) VALUES ('wf','WF','${seededAt}')`);
    conn.exec(
      `INSERT INTO nodes (workflow_id, node_id, executor, output_kind, display_name, created_at) VALUES ('wf','n1','engine','out_kind','N1','${seededAt}')`
    );
    conn.exec('COMMIT');
    eng = createEngagement(conn, 'test-eng');
  });

  afterEach(() => {
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const complete = (wfr: number | null, memo = 'm1', payload: Uint8Array = Buffer.from('{"x":1}')) =>
    recordCompletion(conn, storage, {
      engagementId: eng,
      workflowRunId: wfr,
      workflowId: 'wf',
      nodeId: 'n1',
      memoKey: memo,
      outputKind: 'out_kind',
      payload,
      mediaType: 'application/json',
      createdBy: 'engine',
      temporalId: 't/1/1',
      inputArtifactIds: [],
    });

  test('supply revive: same kind + bytes reuses the row', () => {
    const a = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    const b = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    expect(a.artifact_id).toBe(b.artifact_id); // the revive path
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(true);
  });

  test('same bytes different kind is a new row', () => {
    const a = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('BYTES'));
    const b = supplyArtifact(conn, storage, eng, 'payment_slip', Buffer.from('BYTES'));
    expect(a.artifact_id).not.toBe(b.artifact_id); // kinds route resolution
  });

  test('supply guard: a kind absent from the vocabulary is rejected, leaving no orphaned blob', () => {
    const supply = () => supplyArtifact(conn, storage, eng, 'never_published', Buffer.from('BYTES'));
    expect(supply).toThrow(ValidationError);
    expect(supply).toThrow("kind 'never_published' is not in the published kind vocabulary");
    // The guard runs BEFORE writePayload: a rejected supply must not leave a content-addressed
    // blob behind (nothing has written to the store yet in this test).
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([]);
  });

  test('supplying a computed kind stays legal and derives origin=override', () => {
    const a = supplyArtifact(conn, storage, eng, 'out_kind', Buffer.from('{"hand":"built"}'));
    expect(getArtifact(conn, a.artifact_id).origin).toBe('override');
  });

  test('origin derives from the kind birth channel for leaf supplies', () => {
    const upload = supplyArtifact(conn, storage, eng, 'brokerage_statement', Buffer.from('DOC'));
    const answers = supplyArtifact(conn, storage, eng, 'answers_kind', Buffer.from('{"q":"a"}'));
    expect(getArtifact(conn, upload.artifact_id).origin).toBe('upload');
    expect(getArtifact(conn, answers.artifact_id).origin).toBe('questionnaire');
  });

  test('recordCompletion is idempotent (fresh flags, 1 node_run)', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const { ref: ref1, fresh: fresh1 } = complete(wfr);
    const { ref: ref2, fresh: fresh2 } = complete(wfr);
    expect(fresh1).toBe(true);
    expect(fresh2).toBe(false);
    expect(ref1.artifact_id).toBe(ref2.artifact_id);
    const row = conn.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM node_runs').get();
    expect(row?.n).toBe(1);
  });

  test('completion links producer via the reverse edge (derived, not stored)', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
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
    const supplied = supplyArtifact(conn, storage, eng, 'out_kind', Buffer.from('{"x":1}'));
    expect(getArtifact(conn, supplied.artifact_id).origin).toBe('override');
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
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

  test('recordCompletion rejects a non-computed output kind with a typed error', () => {
    const leafOutput = () =>
      recordCompletion(conn, storage, {
        engagementId: eng,
        workflowRunId: null,
        workflowId: 'wf',
        nodeId: 'n1',
        memoKey: 'm-leaf',
        outputKind: 'brokerage_statement',
        payload: Buffer.from('X'),
        mediaType: 'text/plain',
        createdBy: 'engine',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(leafOutput).toThrow(RuntimeError);
    expect(leafOutput).toThrow(
      "output kind 'brokerage_statement' is a leaf channel ('upload') — runs may only produce computed kinds"
    );
    const unknownOutput = () =>
      recordCompletion(conn, storage, {
        engagementId: eng,
        workflowRunId: null,
        workflowId: 'wf',
        nodeId: 'n1',
        memoKey: 'm-unknown',
        outputKind: 'never_published',
        payload: Buffer.from('X'),
        mediaType: 'text/plain',
        createdBy: 'engine',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(unknownOutput).toThrow("output kind 'never_published' is not in the published kind vocabulary");
  });

  test('completion files the input edges under the assigned node_run_id (dupes collapse)', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('IN-A'));
    const b = supplyArtifact(conn, storage, eng, 'k', Buffer.from('IN-B'));
    const { ref } = recordCompletion(conn, storage, {
      engagementId: eng,
      workflowRunId: wfr,
      workflowId: 'wf',
      nodeId: 'n1',
      memoKey: 'm-inputs',
      outputKind: 'out_kind',
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
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    expect(memoLookup(conn, eng, 'm1')).toBeNull();
    const { ref } = complete(wfr);
    expect(memoLookup(conn, eng, 'm1')?.artifact_id).toBe(ref.artifact_id);
    // hard isolation: another engagement sees nothing
    const eng2 = createEngagement(conn, 'other');
    expect(memoLookup(conn, eng2, 'm1')).toBeNull();
  });

  test('attach promotes, never demotes; promotion preserves created_*, stamps updated_*', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
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
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
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
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
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
    expect(getArtifact(conn, a.artifact_id).label).toBe('renamed');
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
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    expect(() => createEngagement(conn, 'x', { createdBy: 'nobody' })).toThrow(ValidationError);
    expect(() => createWorkspace(conn, eng, 'wf', 'ws2', { createdBy: 'engineer' })).toThrow(ValidationError);
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
        outputKind: 'out_kind',
        payload: Buffer.from('{"z":9}'),
        mediaType: 'application/json',
        createdBy: 'robot',
        temporalId: 't/1/1',
        inputArtifactIds: [],
      });
    expect(completeBad).toThrow(ValidationError);
    // The principal guards run BEFORE writePayload — the same no-orphaned-blob rule as the kind
    // guard above.
    expect(existsSync(storage) ? readdirSync(storage) : []).toEqual([]);
    const ok = supplyArtifact(conn, storage, eng, 'k', Buffer.from('OK'));
    expect(() => attach(conn, wfr, ok.artifact_id, { createdBy: 'bob' })).toThrow(ValidationError);
    expect(() => renameArtifact(conn, ok.artifact_id, 'x', 'bob')).toThrow(ValidationError);
  });

  test('copy takes user rows only', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'January');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    complete(wfr); // engine result lands in the workspace
    expect(workspaceArtifacts(conn, wfr)).toHaveLength(2);

    const feb = createWorkspace(conn, eng, 'wf', 'February', { copiedFrom: wfr });
    const copied = workspaceArtifacts(conn, feb);
    expect(copied.map((a) => a.artifact_id)).toEqual([doc.artifact_id]);
    expect(copied[0]?.source).toBe('user');
    expect(copied[0]?.origin).toBe('upload');
  });

  test('detach removes membership, ledger survives', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const doc = supplyArtifact(conn, storage, eng, 'k', Buffer.from('DOC'));
    attach(conn, wfr, doc.artifact_id, { source: 'user' });
    detach(conn, wfr, doc.artifact_id);
    expect(workspaceArtifacts(conn, wfr)).toEqual([]);
    // ledger untouched
    expect(getArtifact(conn, doc.artifact_id).hash).toBe(doc.hash);
  });

  test('user attachments hash-ordered', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('AAA'));
    const b = supplyArtifact(conn, storage, eng, 'k', Buffer.from('BBB'));
    attach(conn, wfr, a.artifact_id, { source: 'user' });
    attach(conn, wfr, b.artifact_id, { source: 'user' });
    const hashes = userAttachments(conn, wfr).map((r) => r.hash);
    expect(hashes).toHaveLength(2);
    expect(hashes).toEqual([...hashes].sort());
  });
});

// Publish hygiene: validateCatalog gating, upsert-only kinds/workflows/nodes, delete-then-insert
// mirrors (workflow_kinds, node_input_kinds).
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

  const makeNode = (inputKinds: Record<string, string | null>) =>
    defineNode({
      name: 'n1',
      outputKind: 'out_kind',
      inputKinds,
      run: () => ({ ok: true }),
    });

  const makeRegistry = (kinds: readonly Kind[], node = makeNode({ doc: 'doc_kind', note: null })) =>
    buildRegistry([defineWorkflow({ id: 'wf', kinds, nodes: [node], run: async () => undefined })]);

  const count = (sql: string): number => {
    const row = conn.prepare<[], { n: number }>(sql).get();
    return row?.n ?? -1;
  };

  test('re-publish with a slimmer vocabulary shrinks the mirrors; kinds/nodes rows persist', () => {
    const wide = makeRegistry([
      { kind: 'doc_kind', source: 'upload', display: 'Document' },
      { kind: 'out_kind', source: 'computed' },
      { kind: 'extra_kind', source: 'email' },
    ]);
    publishCatalog(conn, wide);
    expect(count('SELECT COUNT(*) AS n FROM workflow_kinds')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM node_input_kinds')).toBe(2);

    const slim = makeRegistry(
      [
        { kind: 'doc_kind', source: 'upload', display: 'Document' },
        { kind: 'out_kind', source: 'computed' },
      ],
      makeNode({ doc: 'doc_kind' })
    );
    publishCatalog(conn, slim);
    // The mirrors are rewritten: the removed kind and the removed param stop lingering.
    const memberKinds = conn
      .prepare<[], { kind: string }>('SELECT kind FROM workflow_kinds ORDER BY rowid')
      .all()
      .map((r) => r.kind);
    expect(memberKinds).toEqual(['doc_kind', 'out_kind']);
    const params = conn
      .prepare<[], { param: string }>('SELECT param FROM node_input_kinds ORDER BY rowid')
      .all()
      .map((r) => r.param);
    expect(params).toEqual(['doc']);
    // Upsert-only tables keep retired rows: the kind vocabulary and node rows persist as FK parents.
    expect(count("SELECT COUNT(*) AS n FROM kinds WHERE kind='extra_kind'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM nodes')).toBe(1);
  });

  test('an invalid registry is rejected before any write', () => {
    // out_kind is produced by n1 but declared with a leaf source — validateCatalog must refuse.
    const bad = makeRegistry([
      { kind: 'doc_kind', source: 'upload' },
      { kind: 'out_kind', source: 'upload' },
    ]);
    const publish = () => publishCatalog(conn, bad);
    expect(publish).toThrow(ValidationError);
    expect(publish).toThrow("wf: kind 'out_kind' is produced by a node but declared with leaf source 'upload'");
    expect(count('SELECT COUNT(*) AS n FROM workflows')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM kinds')).toBe(0);
  });

  test('republish stamps: identical registry is a no-op, a real change bumps updated_at once', () => {
    const registry = makeRegistry([
      { kind: 'doc_kind', source: 'upload', display: 'Document' },
      { kind: 'out_kind', source: 'computed' },
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
    expect(staleStamps('kinds')).toBe(0);
    expect(staleStamps('nodes')).toBe(0);

    // A real change (kind display rename) bumps that row's updated_at; created_at holds.
    const changed = makeRegistry([
      { kind: 'doc_kind', source: 'upload', display: 'Document v2' },
      { kind: 'out_kind', source: 'computed' },
    ]);
    publishCatalog(conn, changed);
    const kindStamp = conn
      .prepare<[], { created_at: string; updated_at: string | null }>(
        "SELECT created_at, updated_at FROM kinds WHERE kind='doc_kind'"
      )
      .get();
    expect(kindStamp?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(wfStamps()?.created_at).toBe(first?.created_at); // workflows row unchanged, not re-dated
    expect(wfStamps()?.updated_at).toBeNull();

    // NULL-safe compare (IS NOT): a NULL→value display flip counts as a change, not a crash/no-op.
    conn.prepare("UPDATE kinds SET display_name=NULL, updated_at=NULL WHERE kind='doc_kind'").run();
    publishCatalog(conn, changed);
    const flipped = conn
      .prepare<[], { display_name: string | null; updated_at: string | null }>(
        "SELECT display_name, updated_at FROM kinds WHERE kind='doc_kind'"
      )
      .get();
    expect(flipped?.display_name).toBe('Document v2');
    expect(flipped?.updated_at).not.toBeNull();
  });

  test('catalogSnapshot serves declaration order and the display fallback', () => {
    const registry = makeRegistry([
      { kind: 'doc_kind', source: 'upload', display: 'Document' },
      { kind: 'out_kind', source: 'computed' },
    ]);
    publishCatalog(conn, registry);
    const snapshot = catalogSnapshot(conn);
    expect(snapshot).toHaveLength(1);
    const wf = snapshot[0];
    expect(wf?.kinds.map((k) => k.kind)).toEqual(['doc_kind', 'out_kind']);
    expect(wf?.kinds.map((k) => k.leaf)).toEqual([1, 0]);
    // Kinds declared without a display fall back to the kind string — never an empty badge.
    expect(wf?.kinds.map((k) => k.display_name)).toEqual(['Document', 'out_kind']);
    expect(wf?.nodes[0]?.input_kinds).toEqual({ doc: 'doc_kind', note: null });
    expect(Object.keys(wf?.nodes[0]?.input_kinds ?? {})).toEqual(['doc', 'note']);
  });
});

describe('db helpers', () => {
  test('nowIso: UTC seconds precision with +00:00 suffix (not Z, no millis)', () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(Math.abs(new Date(s).getTime() - Date.now())).toBeLessThan(2000);
  });

  test('autoLabel: {kind}_DDMMYY_HHMMSS in UTC', () => {
    const ddmmyy = (d: Date): string => {
      const two = (n: number): string => String(n).padStart(2, '0');
      return `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
    };
    const before = ddmmyy(new Date());
    const label = autoLabel('tax_report');
    const after = ddmmyy(new Date());
    expect(label).toMatch(/^tax_report_\d{6}_\d{6}$/);
    const datePart = label.slice('tax_report_'.length, 'tax_report_'.length + 6);
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
});
