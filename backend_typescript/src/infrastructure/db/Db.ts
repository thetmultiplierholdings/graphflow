import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ArtifactRef } from '../../domain/artifact/ArtifactRef.js';
import { leafKinds, type Registry } from '../../domain/registry/Registry.js';
import { isSqliteConstraintError, NotFoundError, RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import { RUN_WORKFLOW_TYPE } from '../../temporal/Ids.js';
import { readPayload, writePayload } from '../storage/Storage.js';

// SQLite ledger + workspace + catalog mirror. Postgres-isms translated to SQLite:
//   - deferred circular FK pair (artifacts.produced_by_node_run <-> node_runs.output_artifact_id)
//     via DEFERRABLE INITIALLY DEFERRED, enforced because every connection sets PRAGMA foreign_keys=ON;
//   - node_run_id pre-allocation via MAX+1 inside BEGIN IMMEDIATE (SQLite is single-writer, race-free);
//   - ON CONFLICT DO NOTHING for the idempotent completion transaction.
// LEDGER (artifacts, node_runs, node_run_inputs) is insert-only; the one mutable ledger column is
// artifacts.label. WORKSPACE rows are editable; detaching a workflow_run_artifacts row is the only
// DELETE in the system.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engagements (
  engagement_id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  temporal_workflow_type TEXT NOT NULL,
  task_queue TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_kinds (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  kind TEXT NOT NULL,
  leaf INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  PRIMARY KEY (workflow_id, kind)
);

CREATE TABLE IF NOT EXISTS nodes (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  node_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('engine','human')),
  output_kind TEXT NOT NULL,
  display_name TEXT,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  payload_ref TEXT,
  produced_by_node_run INTEGER
    REFERENCES node_runs(node_run_id) DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (engagement_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_browse ON artifacts (engagement_id, kind, created_at);

CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  memo_key TEXT NOT NULL,
  output_artifact_id INTEGER NOT NULL
    REFERENCES artifacts(artifact_id) DEFERRABLE INITIALLY DEFERRED,
  temporal_id TEXT NOT NULL,
  UNIQUE (engagement_id, memo_key),
  FOREIGN KEY (workflow_id, node_id) REFERENCES nodes(workflow_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_reverse_lineage ON node_runs (output_artifact_id);

CREATE TABLE IF NOT EXISTS node_run_inputs (
  node_run_id INTEGER NOT NULL REFERENCES node_runs(node_run_id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY (node_run_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_consumer ON node_run_inputs (artifact_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  workflow_run_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  label TEXT NOT NULL,
  copied_from_workflow_run INTEGER REFERENCES workflow_runs(workflow_run_id),
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces ON workflow_runs (engagement_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(workflow_run_id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  source TEXT NOT NULL CHECK (source IN ('user','engine')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_impact ON workflow_run_artifacts (artifact_id);
`;

export interface EngagementRow {
  engagement_id: number;
  label: string;
  created_at: string;
}

export interface ArtifactRow {
  artifact_id: number;
  engagement_id: number;
  hash: string;
  kind: string;
  label: string | null;
  media_type: string;
  byte_size: number;
  payload_ref: string | null;
  produced_by_node_run: number | null;
  created_by: string;
  created_at: string;
}

export interface WorkflowRunRow {
  workflow_run_id: number;
  engagement_id: number;
  workflow_id: string;
  label: string;
  copied_from_workflow_run: number | null;
  archived_at: string | null;
  created_by: string;
  created_at: string;
}

export interface WorkspaceListRow extends WorkflowRunRow {
  user_docs: number;
  engine_results: number;
}

export interface NodeRunRow {
  node_run_id: number;
  engagement_id: number;
  workflow_id: string;
  node_id: string;
  code_hash: string;
  memo_key: string;
  output_artifact_id: number;
  temporal_id: string;
}

export interface NodeRunWithInputs extends NodeRunRow {
  input_artifact_ids: number[];
}

export interface SuppliedArtifact extends ArtifactRef {
  existed: boolean;
}

export interface WorkspaceArtifact extends ArtifactRef {
  source: 'user' | 'engine';
  produced: boolean;
}

export interface CompletionInput {
  engagementId: number;
  workflowRunId: number | null;
  workflowId: string;
  nodeId: string;
  codeHash: string;
  memoKey: string;
  outputKind: string;
  payload: Uint8Array;
  mediaType: string;
  createdBy: string;
  temporalId: string;
  inputArtifactIds: readonly number[];
}

export interface CompletionResult {
  ref: ArtifactRef;
  fresh: boolean;
}

export interface EngagementStats {
  artifacts: number;
  node_runs: number;
  human_answers: number;
  workspaces: number;
}

export interface ArtifactLineage {
  produced_by: NodeRunWithInputs | null;
  consumed_by: NodeRunWithInputs[];
}

export interface CatalogKindEntry {
  kind: string;
  leaf: number;
  display_name: string;
}

export interface CatalogNodeEntry {
  node_id: string;
  executor: string;
  output_kind: string;
  display_name: string | null;
  code_hash: string;
}

export interface CatalogWorkflow {
  workflow_id: string;
  display_name: string;
  temporal_workflow_type: string;
  task_queue: string;
  kinds: CatalogKindEntry[];
  nodes: CatalogNodeEntry[];
}

// UTC timestamps at seconds precision with a +00:00 offset (NOT Z, NOT millis). All
// created_at/added_at columns and the ORDER BY created_at read models depend on this format
// ordering lexicographically.
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

// {kind}_DDMMYY_HHMMSS (day-month-year!) in UTC.
export function autoLabel(kind: string): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
  const time = `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
  return `${kind}_${date}_${time}`;
}

export function connect(dbPath: string): Database.Database {
  const conn = new Database(dbPath);
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 15000');
  return conn;
}

export function initDb(dbPath: string): string {
  const conn = connect(dbPath);
  try {
    conn.pragma('journal_mode = WAL');
    conn.exec(SCHEMA);
    const row = conn.prepare<[], { value: string }>("SELECT value FROM meta WHERE key='instance_id'").get();
    if (row !== undefined) {
      return row.value;
    }
    const instance = randomBytes(4).toString('hex');
    conn.prepare("INSERT INTO meta (key, value) VALUES ('instance_id', ?)").run(instance);
    return instance;
  } finally {
    conn.close();
  }
}

export function instanceId(conn: Database.Database): string {
  const row = conn.prepare<[], { value: string }>("SELECT value FROM meta WHERE key='instance_id'").get();
  if (row === undefined) {
    throw new RuntimeError('instance_id missing from meta — initDb has not run for this database');
  }
  return row.value;
}

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const toRef = (row: ArtifactRow): ArtifactRef => ({
  artifact_id: row.artifact_id,
  hash: row.hash,
  kind: row.kind,
  label: row.label,
  media_type: row.media_type,
});

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new RuntimeError(`${what} returned no row`);
  }
  return row;
}

const MEMO_LOOKUP_SQL = `
  SELECT a.* FROM node_runs nr JOIN artifacts a ON a.artifact_id = nr.output_artifact_id
  WHERE nr.engagement_id=? AND nr.memo_key=?`;

const SELECT_ARTIFACT_BY_IDENTITY_SQL = 'SELECT * FROM artifacts WHERE engagement_id=? AND kind=? AND hash=?';

const ATTACH_ENGINE_SQL = `
  INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at)
  VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO NOTHING`;

const ATTACH_PROMOTE_SQL = `
  INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at)
  VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO UPDATE SET
  source='user', added_by=excluded.added_by, added_at=excluded.added_at`;

const INPUTS_FOR_RUN_SQL = 'SELECT artifact_id FROM node_run_inputs WHERE node_run_id=? ORDER BY artifact_id';

// ---------- catalog ----------

// CI-publish the code registry into the catalog mirror (upsert, never delete).
export function publishCatalog(conn: Database.Database, registry: Registry, taskQueue: string): string[] {
  const published: string[] = [];
  conn.exec('BEGIN IMMEDIATE');
  try {
    for (const wf of registry.workflows.values()) {
      conn
        .prepare(`
          INSERT INTO workflows (workflow_id, display_name, temporal_workflow_type, task_queue)
          VALUES (?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET
          display_name=excluded.display_name, temporal_workflow_type=excluded.temporal_workflow_type,
          task_queue=excluded.task_queue`)
        .run(wf.workflowId, wf.displayName, RUN_WORKFLOW_TYPE, taskQueue);
      // First-declared display wins for duplicate kind declarations.
      const displayByKind = new Map<string, string>();
      for (const k of wf.kinds) {
        if (!displayByKind.has(k.kind)) {
          displayByKind.set(k.kind, k.display ?? '');
        }
      }
      for (const [kind, leaf] of Object.entries(leafKinds(wf))) {
        const display = displayByKind.get(kind) ?? '';
        conn
          .prepare(`
            INSERT INTO workflow_kinds (workflow_id, kind, leaf, display_name) VALUES (?,?,?,?)
            ON CONFLICT(workflow_id, kind) DO UPDATE SET leaf=excluded.leaf, display_name=excluded.display_name`)
          .run(wf.workflowId, kind, leaf ? 1 : 0, display);
      }
      for (const nd of wf.nodes) {
        const codeHash = registry.nodeForWorkflow(wf.workflowId, nd.nodeId).codeHash;
        const prev = conn
          .prepare<[string, string], { code_hash: string }>(
            'SELECT code_hash FROM nodes WHERE workflow_id=? AND node_id=?'
          )
          .get(wf.workflowId, nd.nodeId);
        if (prev !== undefined && prev.code_hash !== codeHash) {
          published.push(
            `WARNING: in-place edit detected for ${wf.workflowId}/${nd.nodeId} (code_hash changed under an existing workflow_id — consider copying to _v2)`
          );
        }
        conn
          .prepare(`
            INSERT INTO nodes (workflow_id, node_id, executor, output_kind, display_name, code_hash)
            VALUES (?,?,?,?,?,?) ON CONFLICT(workflow_id, node_id) DO UPDATE SET
            executor=excluded.executor, output_kind=excluded.output_kind,
            display_name=excluded.display_name, code_hash=excluded.code_hash`)
          .run(wf.workflowId, nd.nodeId, nd.executor, nd.outputKind, nd.displayName, codeHash);
      }
      published.push(`published ${wf.workflowId} (${wf.nodes.length} nodes)`);
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return published;
}

// ---------- engagement space ----------

export function createEngagement(conn: Database.Database, label: string): number {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const info = conn.prepare('INSERT INTO engagements (label, created_at) VALUES (?,?)').run(label, nowIso());
    conn.exec('COMMIT');
    return Number(info.lastInsertRowid);
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// External supply (upload / reference table / hand-built value): produced_by_node_run = NULL.
// Re-supplying identical bytes under the same kind lands on the existing row — the revive path
// (reported via the returned 'existed' flag).
export function supplyArtifact(
  conn: Database.Database,
  storageRoot: string,
  engagementId: number,
  kind: string,
  data: Uint8Array,
  opts: { label?: string | null; mediaType?: string; createdBy?: string } = {}
): SuppliedArtifact {
  const contentHash = sha256Hex(data);
  const ref = writePayload(storageRoot, engagementId, contentHash, data);
  conn.exec('BEGIN IMMEDIATE');
  try {
    const existing = conn
      .prepare<[number, string, string], { '1': number }>(
        'SELECT 1 FROM artifacts WHERE engagement_id=? AND kind=? AND hash=?'
      )
      .get(engagementId, kind, contentHash);
    conn
      .prepare(`
        INSERT INTO artifacts (engagement_id, hash, kind, label, media_type, byte_size,
        payload_ref, produced_by_node_run, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?,?)
        ON CONFLICT(engagement_id, kind, hash) DO NOTHING`)
      .run(
        engagementId,
        contentHash,
        kind,
        opts.label || autoLabel(kind),
        opts.mediaType ?? 'text/plain',
        data.length,
        ref,
        opts.createdBy ?? 'user',
        nowIso()
      );
    const row = requireRow(
      conn
        .prepare<[number, string, string], ArtifactRow>(SELECT_ARTIFACT_BY_IDENTITY_SQL)
        .get(engagementId, kind, contentHash),
      'supply_artifact re-select'
    );
    conn.exec('COMMIT');
    return { ...toRef(row), existed: existing !== undefined };
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// Create a workspace; copying takes USER-sourced membership rows only — engine results are never
// copied (the new run recomputes or memo-hits them).
export function createWorkspace(
  conn: Database.Database,
  engagementId: number,
  workflowId: string,
  label: string,
  opts: { createdBy?: string; copiedFrom?: number | null } = {}
): number {
  const createdBy = opts.createdBy ?? 'user';
  const copiedFrom = opts.copiedFrom ?? null;
  conn.exec('BEGIN IMMEDIATE');
  try {
    const info = conn
      .prepare(`
        INSERT INTO workflow_runs (engagement_id, workflow_id, label,
        copied_from_workflow_run, created_by, created_at) VALUES (?,?,?,?,?,?)`)
      .run(engagementId, workflowId, label, copiedFrom, createdBy, nowIso());
    const wfr = Number(info.lastInsertRowid);
    if (copiedFrom !== null) {
      conn
        .prepare(`
          INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at)
          SELECT ?, artifact_id, 'user', ?, ? FROM workflow_run_artifacts
          WHERE workflow_run_id=? AND source='user'`)
        .run(wfr, createdBy, nowIso(), copiedFrom);
    }
    conn.exec('COMMIT');
    return wfr;
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// User attach PROMOTES an engine row to user; engine attach never demotes.
export function attach(
  conn: Database.Database,
  workflowRunId: number,
  artifactId: number,
  opts: { source?: 'user' | 'engine'; addedBy?: string } = {}
): void {
  const source = opts.source ?? 'user';
  const addedBy = opts.addedBy ?? 'user';
  conn.exec('BEGIN IMMEDIATE');
  try {
    const sql = source === 'user' ? ATTACH_PROMOTE_SQL : ATTACH_ENGINE_SQL;
    conn.prepare(sql).run(workflowRunId, artifactId, source, addedBy, nowIso());
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// The user-facing delete — the ONLY delete in the system. The ledger keeps everything, which is
// why reintroducing the same bytes revives prior work.
export function detach(conn: Database.Database, workflowRunId: number, artifactId: number): void {
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn
      .prepare('DELETE FROM workflow_run_artifacts WHERE workflow_run_id=? AND artifact_id=?')
      .run(workflowRunId, artifactId);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// The run snapshot: USER-sourced attachments only (invariant I7), ordered by content hash — this
// ordering feeds the deterministic snapshot given to Temporal.
export function userAttachments(conn: Database.Database, workflowRunId: number): ArtifactRef[] {
  const rows = conn
    .prepare<[number], ArtifactRow>(`
      SELECT a.* FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id)
      WHERE wra.workflow_run_id=? AND wra.source='user' ORDER BY a.hash`)
    .all(workflowRunId);
  return rows.map(toRef);
}

export function workspaceArtifacts(conn: Database.Database, workflowRunId: number): WorkspaceArtifact[] {
  const rows = conn
    .prepare<[number], ArtifactRow & { source: 'user' | 'engine'; produced: number }>(`
      SELECT a.*, wra.source, (a.produced_by_node_run IS NOT NULL) AS produced
      FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id)
      WHERE wra.workflow_run_id=? ORDER BY a.created_at, a.artifact_id`)
    .all(workflowRunId);
  return rows.map((r) => ({ ...toRef(r), source: r.source, produced: r.produced !== 0 }));
}

export function getWorkspace(conn: Database.Database, workflowRunId: number): WorkflowRunRow {
  const row = conn
    .prepare<[number], WorkflowRunRow>('SELECT * FROM workflow_runs WHERE workflow_run_id=?')
    .get(workflowRunId);
  if (row === undefined) {
    throw new NotFoundError(`workflow_run ${workflowRunId} not found`, 'workflow_run', workflowRunId);
  }
  return row;
}

export function getArtifact(conn: Database.Database, artifactId: number): ArtifactRow {
  const row = conn.prepare<[number], ArtifactRow>('SELECT * FROM artifacts WHERE artifact_id=?').get(artifactId);
  if (row === undefined) {
    throw new NotFoundError(`artifact ${artifactId} not found`, 'artifact', artifactId);
  }
  return row;
}

// The single mutable ledger column.
export function renameArtifact(conn: Database.Database, artifactId: number, label: string): void {
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn.prepare('UPDATE artifacts SET label=? WHERE artifact_id=?').run(label, artifactId);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// ---------- ledger / memo ----------

export function memoLookup(conn: Database.Database, engagementId: number, memoKey: string): ArtifactRef | null {
  const row = conn.prepare<[number, string], ArtifactRow>(MEMO_LOOKUP_SQL).get(engagementId, memoKey);
  return row === undefined ? null : toRef(row);
}

// The completion transaction: ONE atomic, idempotent write filing output artifact + node_run +
// input list + workspace attachment. fresh=false means the memo already had it.
export function recordCompletion(
  conn: Database.Database,
  storageRoot: string,
  input: CompletionInput
): CompletionResult {
  const contentHash = sha256Hex(input.payload);
  // Payload write is outside the tx (write-once, content-addressed: harmless if the tx then
  // discovers a memo hit).
  const ref = writePayload(storageRoot, input.engagementId, contentHash, input.payload);

  conn.exec('BEGIN IMMEDIATE');
  try {
    // Fast path: someone already answered this exact question.
    const existing = conn
      .prepare<[number, string], ArtifactRow>(MEMO_LOOKUP_SQL)
      .get(input.engagementId, input.memoKey);
    if (existing !== undefined) {
      if (input.workflowRunId !== null) {
        conn.prepare(ATTACH_ENGINE_SQL).run(input.workflowRunId, existing.artifact_id, 'engine', 'engine', nowIso());
      }
      conn.exec('COMMIT');
      return { ref: toRef(existing), fresh: false };
    }

    // Slow path: file the fact. Pre-allocate the node_run id (single-writer under BEGIN IMMEDIATE);
    // the deferred FK lets the artifact point at it before the node_run row exists.
    const nextId = requireRow(
      conn.prepare<[], { n: number }>('SELECT COALESCE(MAX(node_run_id), 0) + 1 AS n FROM node_runs').get(),
      'node_run id preallocation'
    ).n;
    conn
      .prepare(`
        INSERT INTO artifacts (engagement_id, hash, kind, label, media_type, byte_size,
        payload_ref, produced_by_node_run, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(engagement_id, kind, hash) DO NOTHING`)
      .run(
        input.engagementId,
        contentHash,
        input.outputKind,
        autoLabel(input.outputKind),
        input.mediaType,
        input.payload.length,
        ref,
        nextId,
        input.createdBy,
        nowIso()
      );
    const out = requireRow(
      conn
        .prepare<[number, string, string], ArtifactRow>(SELECT_ARTIFACT_BY_IDENTITY_SQL)
        .get(input.engagementId, input.outputKind, contentHash),
      'record_completion re-select'
    );
    conn
      .prepare(`
        INSERT INTO node_runs (node_run_id, engagement_id, workflow_id, node_id,
        code_hash, memo_key, output_artifact_id, temporal_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        nextId,
        input.engagementId,
        input.workflowId,
        input.nodeId,
        input.codeHash,
        input.memoKey,
        out.artifact_id,
        input.temporalId
      );
    const insertInput = conn.prepare(`
      INSERT INTO node_run_inputs (node_run_id, artifact_id) VALUES (?,?)
      ON CONFLICT(node_run_id, artifact_id) DO NOTHING`);
    for (const artifactId of new Set(input.inputArtifactIds)) {
      insertInput.run(nextId, artifactId);
    }
    if (input.workflowRunId !== null) {
      conn.prepare(ATTACH_ENGINE_SQL).run(input.workflowRunId, out.artifact_id, 'engine', 'engine', nowIso());
    }
    conn.exec('COMMIT');
    return { ref: toRef(out), fresh: true };
  } catch (e) {
    conn.exec('ROLLBACK');
    if (!isSqliteConstraintError(e)) {
      throw e;
    }
    // Lost the memo race (or a retry landed twice): resolve to the winner via the fast path.
    const winner = memoLookup(conn, input.engagementId, input.memoKey);
    if (winner === null) {
      throw e;
    }
    if (input.workflowRunId !== null) {
      attach(conn, input.workflowRunId, winner.artifact_id, { source: 'engine', addedBy: 'engine' });
    }
    return { ref: winner, fresh: false };
  }
}

export function readArtifactPayload(conn: Database.Database, storageRoot: string, artifactId: number): Uint8Array {
  const art = getArtifact(conn, artifactId);
  if (art.payload_ref === null) {
    throw new ValidationError(`artifact ${artifactId}: payload destroyed per policy`);
  }
  return readPayload(storageRoot, art.payload_ref);
}

export function stats(conn: Database.Database, engagementId: number): EngagementStats {
  const count = (sql: string): number =>
    requireRow(conn.prepare<[number], { n: number }>(sql).get(engagementId), 'COUNT').n;
  return {
    artifacts: count('SELECT COUNT(*) AS n FROM artifacts WHERE engagement_id=?'),
    node_runs: count('SELECT COUNT(*) AS n FROM node_runs WHERE engagement_id=?'),
    human_answers: count(`
      SELECT COUNT(*) AS n FROM node_runs nr JOIN nodes n
      ON n.workflow_id=nr.workflow_id AND n.node_id=nr.node_id
      WHERE nr.engagement_id=? AND n.executor='human'`),
    workspaces: count('SELECT COUNT(*) AS n FROM workflow_runs WHERE engagement_id=?'),
  };
}

// ---------- read models for the API service ----------

export function listEngagements(conn: Database.Database): EngagementRow[] {
  return conn.prepare<[], EngagementRow>('SELECT * FROM engagements ORDER BY created_at, engagement_id').all();
}

export function getEngagement(conn: Database.Database, engagementId: number): EngagementRow {
  const row = conn
    .prepare<[number], EngagementRow>('SELECT * FROM engagements WHERE engagement_id=?')
    .get(engagementId);
  if (row === undefined) {
    throw new NotFoundError(`engagement ${engagementId} not found`, 'engagement', engagementId);
  }
  return row;
}

// Workspaces with user/engine member counts (idx_workspaces order).
export function listWorkspaces(conn: Database.Database, engagementId: number): WorkspaceListRow[] {
  return conn
    .prepare<[number], WorkspaceListRow>(`
      SELECT wr.*,
       (SELECT COUNT(*) FROM workflow_run_artifacts wra
         WHERE wra.workflow_run_id = wr.workflow_run_id AND wra.source='user') AS user_docs,
       (SELECT COUNT(*) FROM workflow_run_artifacts wra
         WHERE wra.workflow_run_id = wr.workflow_run_id AND wra.source='engine') AS engine_results
      FROM workflow_runs wr WHERE wr.engagement_id=?
      ORDER BY wr.created_at, wr.workflow_run_id`)
    .all(engagementId);
}

// The pool browser (idx_browse), newest first, optional kind/substring filter.
export function browseArtifacts(
  conn: Database.Database,
  engagementId: number,
  opts: { kind?: string | null; q?: string | null } = {}
): ArtifactRow[] {
  let sql = 'SELECT * FROM artifacts WHERE engagement_id=?';
  const params: (number | string)[] = [engagementId];
  if (opts.kind) {
    sql += ' AND kind=?';
    params.push(opts.kind);
  }
  if (opts.q) {
    sql += ' AND (label LIKE ? OR kind LIKE ? OR hash LIKE ?)';
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC, artifact_id DESC';
  return conn.prepare<(number | string)[], ArtifactRow>(sql).all(...params);
}

// Ledger facts, newest first, each with its input artifact ids.
export function listNodeRuns(conn: Database.Database, engagementId: number): NodeRunWithInputs[] {
  const runs = conn
    .prepare<[number], NodeRunRow>('SELECT * FROM node_runs WHERE engagement_id=? ORDER BY node_run_id DESC')
    .all(engagementId);
  const inputsStmt = conn.prepare<[number], { artifact_id: number }>(INPUTS_FOR_RUN_SQL);
  return runs.map((r) => ({ ...r, input_artifact_ids: inputsStmt.all(r.node_run_id).map((i) => i.artifact_id) }));
}

function getNodeRun(conn: Database.Database, nodeRunId: number): NodeRunWithInputs {
  const row = conn.prepare<[number], NodeRunRow>('SELECT * FROM node_runs WHERE node_run_id=?').get(nodeRunId);
  if (row === undefined) {
    throw new NotFoundError(`node_run ${nodeRunId} not found`, 'node_run', nodeRunId);
  }
  const inputs = conn.prepare<[number], { artifact_id: number }>(INPUTS_FOR_RUN_SQL).all(nodeRunId);
  return { ...row, input_artifact_ids: inputs.map((i) => i.artifact_id) };
}

// produced_by (idx_reverse_lineage) and consumed_by (idx_consumer).
export function artifactLineage(conn: Database.Database, artifactId: number): ArtifactLineage {
  const produced = conn
    .prepare<[number], { node_run_id: number }>('SELECT node_run_id FROM node_runs WHERE output_artifact_id=?')
    .get(artifactId);
  const consumers = conn
    .prepare<[number], { node_run_id: number }>(
      'SELECT DISTINCT node_run_id FROM node_run_inputs WHERE artifact_id=? ORDER BY node_run_id'
    )
    .all(artifactId);
  return {
    produced_by: produced === undefined ? null : getNodeRun(conn, produced.node_run_id),
    consumed_by: consumers.map((r) => getNodeRun(conn, r.node_run_id)),
  };
}

// The catalog mirror: every published workflow with its kinds and nodes. ORDER BY rowid preserves
// first-insert order across upserts.
export function catalogSnapshot(conn: Database.Database): CatalogWorkflow[] {
  const workflows = conn
    .prepare<[], { workflow_id: string; display_name: string; temporal_workflow_type: string; task_queue: string }>(
      'SELECT * FROM workflows ORDER BY workflow_id'
    )
    .all();
  const kindsStmt = conn.prepare<[string], { kind: string; leaf: number; display_name: string | null }>(
    'SELECT kind, leaf, display_name FROM workflow_kinds WHERE workflow_id=? ORDER BY rowid'
  );
  const nodesStmt = conn.prepare<[string], CatalogNodeEntry>(
    'SELECT node_id, executor, output_kind, display_name, code_hash FROM nodes WHERE workflow_id=? ORDER BY rowid'
  );
  return workflows.map((wf) => ({
    ...wf,
    // Kinds declared without a display name fall back to the kind string — the UI never renders
    // an empty badge.
    kinds: kindsStmt
      .all(wf.workflow_id)
      .map((k) => ({ kind: k.kind, leaf: k.leaf, display_name: k.display_name || k.kind })),
    nodes: nodesStmt.all(wf.workflow_id),
  }));
}
