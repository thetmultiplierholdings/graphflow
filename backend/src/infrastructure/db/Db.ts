import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ArtifactRef } from '../../domain/artifact/ArtifactRef.js';
import { assertPrincipal } from '../../domain/principal/Principal.js';
import { type Registry, validateCatalog } from '../../domain/registry/Registry.js';
import { isSqliteConstraintError, NotFoundError, RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import { readPayload, writePayload } from '../storage/Storage.js';

// SQLite ledger + workspace + catalog mirror.
//   - ON CONFLICT DO NOTHING powers the idempotent completion transaction (convergence: identical
//     bytes under one nodeparamslot land on one row);
//   - artifact provenance is DERIVED, never stored: the artifact_facts view computes the producer
//     (earliest node_run whose output_artifact_id points at the row) and the origin class from
//     the nodeparamslot's authored source — nothing stored can diverge from lineage.
// LEDGER (artifacts, node_runs, node_run_inputs) is insert-only; the mutable ledger columns are
// artifacts.display_name and its updated_by/updated_at stamps. WORKSPACE rows are editable; detaching a
// workflow_run_artifacts row is the only user-facing DELETE (the publish transaction rewriting the
// workflow_nodeparamslots/node_input_nodeparamslots mirrors is the only other).
//
// Hygiene block conventions (tiered per table — schema.dbml carries the full rationale):
//   - created_by/created_at NOT NULL where present; convergence (ON CONFLICT DO NOTHING) keeps the
//     FIRST filer's values.
//   - updated_by/updated_at nullable; NULL means never updated. Every UPDATE statement must stamp
//     them. The idempotent write paths (promote upsert, publish upserts) are guarded so a no-op
//     never stamps; the request-driven UPDATEs (rename, workspace PATCH/archive) stamp per
//     request — resubmitting an identical value re-stamps, matching archived_at's behavior.
//   - deleted_at is dormant: always NULL, no reader filters on it — reserved for a future soft
//     delete. workflow_runs.archived_at stays a separate, reversible domain flag.
//   - actor columns hold principals '<type>[:<name>]' (domain/principal/Principal.ts), asserted at
//     every write boundary.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engagements (
  engagement_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS nodeparamslots (
  nodeparamslot TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('upload','questionnaire','email','computed')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_nodeparamslots (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  nodeparamslot TEXT NOT NULL REFERENCES nodeparamslots(nodeparamslot),
  PRIMARY KEY (workflow_id, nodeparamslot)
);

CREATE TABLE IF NOT EXISTS nodes (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  node_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('engine','human')),
  output_nodeparamslot TEXT NOT NULL REFERENCES nodeparamslots(nodeparamslot),
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (workflow_id, node_id)
);

CREATE TABLE IF NOT EXISTS node_input_nodeparamslots (
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  param TEXT NOT NULL,
  nodeparamslot TEXT REFERENCES nodeparamslots(nodeparamslot),
  PRIMARY KEY (workflow_id, node_id, param),
  FOREIGN KEY (workflow_id, node_id) REFERENCES nodes(workflow_id, node_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  hash TEXT NOT NULL,
  nodeparamslot TEXT NOT NULL REFERENCES nodeparamslots(nodeparamslot),
  display_name TEXT,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  payload_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  UNIQUE (engagement_id, nodeparamslot, hash)
);
CREATE INDEX IF NOT EXISTS idx_browse ON artifacts (engagement_id, nodeparamslot, created_at);

CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  memo_key TEXT NOT NULL,
  output_artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  temporal_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
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
  display_name TEXT NOT NULL,
  copied_from_workflow_run INTEGER REFERENCES workflow_runs(workflow_run_id),
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspaces ON workflow_runs (engagement_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(workflow_run_id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  source TEXT NOT NULL CHECK (source IN ('user','engine')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (workflow_run_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_impact ON workflow_run_artifacts (artifact_id);

-- READ MODEL: derived provenance. produced_by_node_run = earliest run whose output points here
-- (several runs can converge on one artifact via ON CONFLICT DO NOTHING); origin = 'produced'
-- when such a run exists, else 'override' for a hand-supplied computed nodeparamslot, else the nodeparamslot's
-- authored birth channel. Writers stay on base tables.
CREATE VIEW IF NOT EXISTS artifact_facts AS
SELECT
  a.*,
  (SELECT MIN(nr.node_run_id) FROM node_runs nr WHERE nr.output_artifact_id = a.artifact_id)
    AS produced_by_node_run,
  CASE
    WHEN EXISTS (SELECT 1 FROM node_runs nr WHERE nr.output_artifact_id = a.artifact_id)
      THEN 'produced'
    WHEN k.source = 'computed' THEN 'override'
    ELSE k.source
  END AS origin
FROM artifacts a JOIN nodeparamslots k ON k.nodeparamslot = a.nodeparamslot;
`;

export interface EngagementRow {
  engagement_id: number;
  display_name: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

export interface ArtifactRow {
  artifact_id: number;
  engagement_id: number;
  hash: string;
  nodeparamslot: string;
  display_name: string | null;
  media_type: string;
  byte_size: number;
  payload_ref: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

// How the artifact came to exist — derived by the artifact_facts view, never stored. 'produced'
// wins over everything (a producing run exists); 'override' is a hand-supplied computed nodeparamslot;
// the rest are the nodeparamslot's authored birth channel.
export type ArtifactOrigin = 'produced' | 'upload' | 'questionnaire' | 'email' | 'override';

// A row of the artifact_facts view: the base artifact columns plus derived provenance.
export interface ArtifactFactsRow extends ArtifactRow {
  produced_by_node_run: number | null;
  origin: ArtifactOrigin;
}

export interface WorkflowRunRow {
  workflow_run_id: number;
  engagement_id: number;
  workflow_id: string;
  display_name: string;
  copied_from_workflow_run: number | null;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  deleted_at: string | null;
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
  memo_key: string;
  output_artifact_id: number;
  temporal_id: string;
  created_by: string;
  created_at: string;
}

export interface NodeRunWithInputs extends NodeRunRow {
  input_artifact_ids: number[];
}

export interface SuppliedArtifact extends ArtifactRef {
  existed: boolean;
}

export interface WorkspaceArtifact extends ArtifactRef {
  source: 'user' | 'engine';
  origin: ArtifactOrigin;
}

export interface CompletionInput {
  engagementId: number;
  workflowRunId: number | null;
  workflowId: string;
  nodeId: string;
  memoKey: string;
  outputNodeparamslot: string;
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

export interface CatalogNodeparamslotEntry {
  nodeparamslot: string;
  source: string;
  // Derived, not stored: 1 iff no node of the workflow produces the nodeparamslot (SQLite int-as-boolean).
  leaf: number;
  display_name: string;
}

export interface CatalogNodeEntry {
  node_id: string;
  executor: string;
  output_nodeparamslot: string;
  display_name: string | null;
  input_nodeparamslots: Record<string, string | null>;
}

export interface CatalogWorkflow {
  workflow_id: string;
  display_name: string;
  created_at: string;
  updated_at: string | null;
  nodeparamslots: CatalogNodeparamslotEntry[];
  nodes: CatalogNodeEntry[];
}

// UTC timestamps at seconds precision with a +00:00 offset (NOT Z, NOT millis). Every timestamp
// column (created_at/updated_at/archived_at/deleted_at) and the ORDER BY created_at read models
// depend on this format ordering lexicographically.
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

// {nodeparamslot}_DDMMYY_HHMMSS (day-month-year!) in UTC.
export function autoDisplayName(nodeparamslot: string): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}`;
  const time = `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
  return `${nodeparamslot}_${date}_${time}`;
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
  nodeparamslot: row.nodeparamslot,
  display_name: row.display_name,
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

const SELECT_ARTIFACT_BY_IDENTITY_SQL = 'SELECT * FROM artifacts WHERE engagement_id=? AND nodeparamslot=? AND hash=?';

const ATTACH_ENGINE_SQL = `
  INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, created_by, created_at)
  VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO NOTHING`;

// Promotion flips source and stamps updated_* with the promoter; created_* (who first attached,
// and when) survives. The WHERE guard makes a user→user re-attach a true no-op instead of a fake
// update — updated_* may only record a real change.
const ATTACH_PROMOTE_SQL = `
  INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, created_by, created_at)
  VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO UPDATE SET
  source='user', updated_by=excluded.created_by, updated_at=excluded.created_at
  WHERE workflow_run_artifacts.source='engine'`;

const INPUTS_FOR_RUN_SQL = 'SELECT artifact_id FROM node_run_inputs WHERE node_run_id=? ORDER BY artifact_id';

// ---------- catalog ----------

// CI-publish the code registry into the catalog mirror. nodeparamslots/workflows/nodes are upsert-only
// (retired rows persist — they are FK parents and what makes retired-workspace dispatch fail
// loud); workflow_nodeparamslots and node_input_nodeparamslots are pure mirrors nothing FKs, rewritten
// delete-then-insert so declarations removed from code stop lingering between resets.
// created_at is first-publish; updated_at stamps only a real change TO THE MIRRORED ROW'S OWN
// COLUMNS (the DO UPDATE WHERE guards, IS NOT for NULL-safety) — a worker restart republishing an
// identical registry leaves both untouched. Scope caveat: the guards compare exactly what the row
// stores, so a workflow gaining a node, or a node changing inputNodeparamslots, moves only the
// delete-then-insert mirrors and bumps nothing here. No actor columns: the publisher is always
// the code registry itself.
export function publishCatalog(conn: Database.Database, registry: Registry): string[] {
  const all = [...registry.workflows.values()];
  // Publish hygiene: validate the in-memory registry (not possibly-stale DB rows) before any write.
  validateCatalog(all);
  const published: string[] = [];
  const publishedAt = nowIso();
  conn.exec('BEGIN IMMEDIATE');
  try {
    for (const wf of all) {
      conn
        .prepare(`
          INSERT INTO workflows (workflow_id, display_name, created_at) VALUES (?,?,?)
          ON CONFLICT(workflow_id) DO UPDATE SET display_name=excluded.display_name,
          updated_at=excluded.created_at
          WHERE workflows.display_name IS NOT excluded.display_name`)
        .run(wf.workflowId, wf.displayName, publishedAt);
      // The global nodeparamslot vocabulary first — nodes.output_nodeparamslot and workflow_nodeparamslots.nodeparamslot FK it.
      // validateCatalog already rejected cross-workflow source/display conflicts.
      const nodeparamslotUpsert = conn.prepare(`
        INSERT INTO nodeparamslots (nodeparamslot, source, display_name, created_at) VALUES (?,?,?,?)
        ON CONFLICT(nodeparamslot) DO UPDATE SET source=excluded.source, display_name=excluded.display_name,
        updated_at=excluded.created_at
        WHERE nodeparamslots.source IS NOT excluded.source OR nodeparamslots.display_name IS NOT excluded.display_name`);
      for (const k of wf.nodeparamslots) {
        nodeparamslotUpsert.run(k.nodeparamslot, k.source, k.display ?? '', publishedAt);
      }
      conn.prepare('DELETE FROM workflow_nodeparamslots WHERE workflow_id=?').run(wf.workflowId);
      const membershipInsert = conn.prepare(
        'INSERT INTO workflow_nodeparamslots (workflow_id, nodeparamslot) VALUES (?,?)'
      );
      for (const k of wf.nodeparamslots) {
        membershipInsert.run(wf.workflowId, k.nodeparamslot);
      }
      const nodeUpsert = conn.prepare(`
        INSERT INTO nodes (workflow_id, node_id, executor, output_nodeparamslot, display_name, created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(workflow_id, node_id) DO UPDATE SET
        executor=excluded.executor, output_nodeparamslot=excluded.output_nodeparamslot,
        display_name=excluded.display_name, updated_at=excluded.created_at
        WHERE nodes.executor IS NOT excluded.executor
          OR nodes.output_nodeparamslot IS NOT excluded.output_nodeparamslot
          OR nodes.display_name IS NOT excluded.display_name`);
      for (const nd of wf.nodes) {
        nodeUpsert.run(wf.workflowId, nd.nodeId, nd.executor, nd.outputNodeparamslot, nd.displayName, publishedAt);
      }
      conn.prepare('DELETE FROM node_input_nodeparamslots WHERE workflow_id=?').run(wf.workflowId);
      const inputNodeparamslotInsert = conn.prepare(
        'INSERT INTO node_input_nodeparamslots (workflow_id, node_id, param, nodeparamslot) VALUES (?,?,?,?)'
      );
      for (const nd of wf.nodes) {
        for (const param of nd.paramNames) {
          inputNodeparamslotInsert.run(wf.workflowId, nd.nodeId, param, nd.inputNodeparamslots[param]);
        }
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

export function createEngagement(
  conn: Database.Database,
  displayName: string,
  opts: { createdBy?: string } = {}
): number {
  const createdBy = opts.createdBy ?? 'user';
  assertPrincipal(createdBy);
  conn.exec('BEGIN IMMEDIATE');
  try {
    const info = conn
      .prepare('INSERT INTO engagements (display_name, created_by, created_at) VALUES (?,?,?)')
      .run(displayName, createdBy, nowIso());
    conn.exec('COMMIT');
    return Number(info.lastInsertRowid);
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// External supply (upload / questionnaire answers / hand-built value): the artifact enters with
// no producing run, so its origin derives from the nodeparamslot's birth channel — or 'override' when a
// computed nodeparamslot is hand-staged (a corrected intermediate is a legal supply species).
// Re-supplying identical bytes under the same nodeparamslot lands on the existing row — the revive path
// (reported via the returned 'existed' flag).
export function supplyArtifact(
  conn: Database.Database,
  storageRoot: string,
  engagementId: number,
  nodeparamslot: string,
  data: Uint8Array,
  opts: { displayName?: string | null; mediaType?: string; createdBy?: string } = {}
): SuppliedArtifact {
  // Guards before the payload write: an unknown nodeparamslot or a malformed principal must not leave an
  // orphaned blob behind. Nodeparamslots absent from the published vocabulary are rejected; supplying a
  // computed nodeparamslot is legal.
  const known = conn
    .prepare<[string], { nodeparamslot: string }>('SELECT nodeparamslot FROM nodeparamslots WHERE nodeparamslot=?')
    .get(nodeparamslot);
  if (known === undefined) {
    throw new ValidationError(`nodeparamslot '${nodeparamslot}' is not in the published nodeparamslot vocabulary`);
  }
  const createdBy = opts.createdBy ?? 'user';
  assertPrincipal(createdBy);
  const contentHash = sha256Hex(data);
  const ref = writePayload(storageRoot, engagementId, contentHash, data);
  conn.exec('BEGIN IMMEDIATE');
  try {
    const existing = conn
      .prepare<[number, string, string], { '1': number }>(
        'SELECT 1 FROM artifacts WHERE engagement_id=? AND nodeparamslot=? AND hash=?'
      )
      .get(engagementId, nodeparamslot, contentHash);
    conn
      .prepare(`
        INSERT INTO artifacts (engagement_id, hash, nodeparamslot, display_name, media_type, byte_size,
        payload_ref, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(engagement_id, nodeparamslot, hash) DO NOTHING`)
      .run(
        engagementId,
        contentHash,
        nodeparamslot,
        opts.displayName || autoDisplayName(nodeparamslot),
        opts.mediaType ?? 'text/plain',
        data.length,
        ref,
        createdBy,
        nowIso()
      );
    const row = requireRow(
      conn
        .prepare<[number, string, string], ArtifactRow>(SELECT_ARTIFACT_BY_IDENTITY_SQL)
        .get(engagementId, nodeparamslot, contentHash),
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
  displayName: string,
  opts: { createdBy?: string; copiedFrom?: number | null } = {}
): number {
  const createdBy = opts.createdBy ?? 'user';
  assertPrincipal(createdBy);
  const copiedFrom = opts.copiedFrom ?? null;
  conn.exec('BEGIN IMMEDIATE');
  try {
    const info = conn
      .prepare(`
        INSERT INTO workflow_runs (engagement_id, workflow_id, display_name,
        copied_from_workflow_run, created_by, created_at) VALUES (?,?,?,?,?,?)`)
      .run(engagementId, workflowId, displayName, copiedFrom, createdBy, nowIso());
    const wfr = Number(info.lastInsertRowid);
    if (copiedFrom !== null) {
      // Copied memberships are NEW memberships: fresh created_* under the copying actor.
      conn
        .prepare(`
          INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, created_by, created_at)
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

// User attach PROMOTES an engine row to user (created_* preserved, updated_* stamped — see
// ATTACH_PROMOTE_SQL); engine attach never demotes.
export function attach(
  conn: Database.Database,
  workflowRunId: number,
  artifactId: number,
  opts: { source?: 'user' | 'engine'; createdBy?: string } = {}
): void {
  const source = opts.source ?? 'user';
  const createdBy = opts.createdBy ?? 'user';
  assertPrincipal(createdBy);
  conn.exec('BEGIN IMMEDIATE');
  try {
    const sql = source === 'user' ? ATTACH_PROMOTE_SQL : ATTACH_ENGINE_SQL;
    conn.prepare(sql).run(workflowRunId, artifactId, source, createdBy, nowIso());
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

// The user-facing delete — the only other DELETEs are the publish transaction rewriting the
// workflow_nodeparamslots/node_input_nodeparamslots mirrors. The ledger keeps everything, which is why
// reintroducing the same bytes revives prior work.
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
    .prepare<[number], ArtifactFactsRow & { source: 'user' | 'engine' }>(`
      SELECT a.*, wra.source
      FROM workflow_run_artifacts wra JOIN artifact_facts a USING (artifact_id)
      WHERE wra.workflow_run_id=? ORDER BY a.created_at, a.artifact_id`)
    .all(workflowRunId);
  return rows.map((r) => ({ ...toRef(r), source: r.source, origin: r.origin }));
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

export function getArtifact(conn: Database.Database, artifactId: number): ArtifactFactsRow {
  const row = conn
    .prepare<[number], ArtifactFactsRow>('SELECT * FROM artifact_facts WHERE artifact_id=?')
    .get(artifactId);
  if (row === undefined) {
    throw new NotFoundError(`artifact ${artifactId} not found`, 'artifact', artifactId);
  }
  return row;
}

// The one content-facing mutable ledger column, stamped: display-name edits record their actor and time
// in updated_by/updated_at; everything else on an artifact row stays immutable.
export function renameArtifact(
  conn: Database.Database,
  artifactId: number,
  displayName: string,
  updatedBy: string
): void {
  assertPrincipal(updatedBy);
  conn.exec('BEGIN IMMEDIATE');
  try {
    conn
      .prepare('UPDATE artifacts SET display_name=?, updated_by=?, updated_at=? WHERE artifact_id=?')
      .run(displayName, updatedBy, nowIso(), artifactId);
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
// input list + workspace attachment — every row it files shares one filedAt stamp.
// fresh=false means the memo already had it.
export function recordCompletion(
  conn: Database.Database,
  storageRoot: string,
  input: CompletionInput
): CompletionResult {
  // Guard before the payload write: a malformed principal must not leave an orphaned blob behind
  // (same rule as supplyArtifact).
  assertPrincipal(input.createdBy);
  const contentHash = sha256Hex(input.payload);
  // Payload write is outside the tx (write-once, content-addressed: harmless if the tx then
  // discovers a memo hit).
  const ref = writePayload(storageRoot, input.engagementId, contentHash, input.payload);

  const filedAt = nowIso();
  conn.exec('BEGIN IMMEDIATE');
  try {
    // Fast path: someone already answered this exact question.
    const existing = conn
      .prepare<[number, string], ArtifactRow>(MEMO_LOOKUP_SQL)
      .get(input.engagementId, input.memoKey);
    if (existing !== undefined) {
      if (input.workflowRunId !== null) {
        conn.prepare(ATTACH_ENGINE_SQL).run(input.workflowRunId, existing.artifact_id, 'engine', 'engine', filedAt);
      }
      conn.exec('COMMIT');
      return { ref: toRef(existing), fresh: false };
    }

    // Slow path: file the fact — the output artifact first, then the run row pointing at it
    // (plain immediate FKs; the circular pair died with the stored producer column).
    // Nodeparamslot-class assertion: runs may only produce computed nodeparamslots. A typed error here keeps
    // FK noise out of the constraint-race catch below.
    const nodeparamslotRow = conn
      .prepare<[string], { source: string }>('SELECT source FROM nodeparamslots WHERE nodeparamslot=?')
      .get(input.outputNodeparamslot);
    if (nodeparamslotRow === undefined) {
      throw new RuntimeError(
        `output nodeparamslot '${input.outputNodeparamslot}' is not in the published nodeparamslot vocabulary`
      );
    }
    if (nodeparamslotRow.source !== 'computed') {
      throw new RuntimeError(
        `output nodeparamslot '${input.outputNodeparamslot}' is a leaf channel ('${nodeparamslotRow.source}') — runs may only produce computed nodeparamslots`
      );
    }
    conn
      .prepare(`
        INSERT INTO artifacts (engagement_id, hash, nodeparamslot, display_name, media_type, byte_size,
        payload_ref, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(engagement_id, nodeparamslot, hash) DO NOTHING`)
      .run(
        input.engagementId,
        contentHash,
        input.outputNodeparamslot,
        autoDisplayName(input.outputNodeparamslot),
        input.mediaType,
        input.payload.length,
        ref,
        input.createdBy,
        filedAt
      );
    const out = requireRow(
      conn
        .prepare<[number, string, string], ArtifactRow>(SELECT_ARTIFACT_BY_IDENTITY_SQL)
        .get(input.engagementId, input.outputNodeparamslot, contentHash),
      'record_completion re-select'
    );
    const runInfo = conn
      .prepare(`
        INSERT INTO node_runs (engagement_id, workflow_id, node_id,
        memo_key, output_artifact_id, temporal_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        input.engagementId,
        input.workflowId,
        input.nodeId,
        input.memoKey,
        out.artifact_id,
        input.temporalId,
        input.createdBy,
        filedAt
      );
    const nodeRunId = Number(runInfo.lastInsertRowid);
    const insertInput = conn.prepare(`
      INSERT INTO node_run_inputs (node_run_id, artifact_id) VALUES (?,?)
      ON CONFLICT(node_run_id, artifact_id) DO NOTHING`);
    for (const artifactId of new Set(input.inputArtifactIds)) {
      insertInput.run(nodeRunId, artifactId);
    }
    if (input.workflowRunId !== null) {
      conn.prepare(ATTACH_ENGINE_SQL).run(input.workflowRunId, out.artifact_id, 'engine', 'engine', filedAt);
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
      attach(conn, input.workflowRunId, winner.artifact_id, { source: 'engine', createdBy: 'engine' });
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

// The pool browser (idx_browse), newest first, optional nodeparamslot/substring filter. Reads the
// artifact_facts view — browse rows carry derived provenance onto the wire.
export function browseArtifacts(
  conn: Database.Database,
  engagementId: number,
  opts: { nodeparamslot?: string | null; q?: string | null } = {}
): ArtifactFactsRow[] {
  let sql = 'SELECT * FROM artifact_facts WHERE engagement_id=?';
  const params: (number | string)[] = [engagementId];
  if (opts.nodeparamslot) {
    sql += ' AND nodeparamslot=?';
    params.push(opts.nodeparamslot);
  }
  if (opts.q) {
    sql += ' AND (display_name LIKE ? OR nodeparamslot LIKE ? OR hash LIKE ?)';
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC, artifact_id DESC';
  return conn.prepare<(number | string)[], ArtifactFactsRow>(sql).all(...params);
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

// produced_by (idx_reverse_lineage) and consumed_by (idx_consumer). Several runs can converge on
// one artifact; the earliest run wins deterministically — the same rule artifact_facts serves.
export function artifactLineage(conn: Database.Database, artifactId: number): ArtifactLineage {
  const produced = conn
    .prepare<[number], { node_run_id: number }>(
      'SELECT node_run_id FROM node_runs WHERE output_artifact_id=? ORDER BY node_run_id LIMIT 1'
    )
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

// The catalog mirror: every published workflow with its nodeparamslots and nodes. workflow_nodeparamslots and
// node_input_nodeparamslots are rewritten per publish, so their rowid order is declaration order; nodes
// keep first-insert order across upserts. leaf is derived per workflow (no node produces the
// nodeparamslot), never stored. Known skew, accepted: nodes rows are never deleted, so a RETIRED node row
// (renamed without a db reset) still counts as a producer here — a nodeparamslot that lost its last
// current producer keeps leaf=false until the stale row is retired for real.
export function catalogSnapshot(conn: Database.Database): CatalogWorkflow[] {
  // Explicit projection — the spread below puts exactly these columns on the snapshot, so a new
  // workflows column never leaks by accident.
  const workflows = conn
    .prepare<[], { workflow_id: string; display_name: string; created_at: string; updated_at: string | null }>(
      'SELECT workflow_id, display_name, created_at, updated_at FROM workflows ORDER BY workflow_id'
    )
    .all();
  const nodeparamslotsStmt = conn.prepare<
    [string],
    { nodeparamslot: string; source: string; leaf: number; display_name: string | null }
  >(`
    SELECT wk.nodeparamslot, k.source, k.display_name,
      NOT EXISTS (SELECT 1 FROM nodes n WHERE n.workflow_id = wk.workflow_id AND n.output_nodeparamslot = wk.nodeparamslot) AS leaf
    FROM workflow_nodeparamslots wk JOIN nodeparamslots k ON k.nodeparamslot = wk.nodeparamslot
    WHERE wk.workflow_id=? ORDER BY wk.rowid`);
  const nodesStmt = conn.prepare<
    [string],
    { node_id: string; executor: string; output_nodeparamslot: string; display_name: string | null }
  >('SELECT node_id, executor, output_nodeparamslot, display_name FROM nodes WHERE workflow_id=? ORDER BY rowid');
  const inputNodeparamslotsStmt = conn.prepare<[string, string], { param: string; nodeparamslot: string | null }>(
    'SELECT param, nodeparamslot FROM node_input_nodeparamslots WHERE workflow_id=? AND node_id=? ORDER BY rowid'
  );
  return workflows.map((wf) => ({
    ...wf,
    // Nodeparamslots declared without a display name fall back to the nodeparamslot string — the UI never renders
    // an empty badge.
    nodeparamslots: nodeparamslotsStmt.all(wf.workflow_id).map((k) => ({
      nodeparamslot: k.nodeparamslot,
      source: k.source,
      leaf: k.leaf,
      display_name: k.display_name || k.nodeparamslot,
    })),
    nodes: nodesStmt.all(wf.workflow_id).map((n) => ({
      ...n,
      input_nodeparamslots: Object.fromEntries(
        inputNodeparamslotsStmt.all(wf.workflow_id, n.node_id).map((row) => [row.param, row.nodeparamslot])
      ),
    })),
  }));
}
