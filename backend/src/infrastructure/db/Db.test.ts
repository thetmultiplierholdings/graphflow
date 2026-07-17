import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  attach,
  autoLabel,
  connect,
  createEngagement,
  createWorkspace,
  detach,
  getArtifact,
  initDb,
  instanceId,
  memoLookup,
  nowIso,
  recordCompletion,
  supplyArtifact,
  userAttachments,
  workspaceArtifacts,
} from './Db.js';

// Ledger semantics: revive, kind-scoped content addressing, idempotent completion transaction,
// attach promotion, copy-user-rows-only.
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
    // minimal catalog so FKs hold
    conn.exec('BEGIN IMMEDIATE');
    conn.exec("INSERT INTO workflows VALUES ('wf','WF','GraphflowRun','q')");
    conn.exec("INSERT INTO nodes VALUES ('wf','n1','engine','out_kind','N1','ch1')");
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
      codeHash: 'ch1',
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

  test('completion links producer (circular pair)', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const { ref } = complete(wfr);
    const art = getArtifact(conn, ref.artifact_id);
    const nr = conn
      .prepare<[number | null], { output_artifact_id: number }>('SELECT * FROM node_runs WHERE node_run_id=?')
      .get(art.produced_by_node_run);
    expect(nr?.output_artifact_id).toBe(ref.artifact_id); // the circular pair holds
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

  test('attach promotes, never demotes', () => {
    const wfr = createWorkspace(conn, eng, 'wf', 'ws');
    const a = supplyArtifact(conn, storage, eng, 'k', Buffer.from('D'));
    attach(conn, wfr, a.artifact_id, { source: 'engine', addedBy: 'engine' });
    attach(conn, wfr, a.artifact_id, { source: 'user', addedBy: 'alice' }); // promote
    attach(conn, wfr, a.artifact_id, { source: 'engine', addedBy: 'engine' }); // no demote
    const rows = conn
      .prepare<[number], { source: string }>('SELECT source FROM workflow_run_artifacts WHERE workflow_run_id=?')
      .all(wfr);
    expect(rows).toEqual([{ source: 'user' }]);
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
