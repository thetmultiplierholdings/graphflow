import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildRegistry } from '../domain/registry/Registry.js';
import type { LineageKind } from '../infrastructure/db/Db.js';
import { attach, connect, initDb, nowIso, publishCatalog, recordCompletion } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { NotFoundError, RuntimeError } from '../shared/errors/Errors.js';
import { runWorkflowId } from '../temporal/Ids.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import { buildApp } from './App.js';
import type { DerivedRunStatus, TemporalGateway } from './Deps.js';
import type { CatalogOut, CatalogWorkflowOut, ExecuteOut, StatusOut, UploadOut } from './Schemas.js';
import type {
  ArtifactMetaOut,
  EngagementOut,
  MemberOut,
  WorkflowRunDetailOut,
  WorkflowRunListOut,
} from './Serializers.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

// HTTP CRUD over the real app: embedded worker OFF and Temporal replaced by a stub gateway.
// describeRun answers from a per-test map keyed by the temporal workflow id — an unknown id is
// NOT_FOUND (null), exactly the real gateway's answer for a run that never reached Temporal.
// startWorkflowRun is per-test swappable (default: not stubbed → throws). Both reset before each
// test. Scratch db + storage per run, deleted on teardown.

const TASK_QUEUE = 'graphflow-crud-test-queue';

const describeStatuses = new Map<string, DerivedRunStatus>();

const startNotStubbed = async (): Promise<string> => {
  throw new RuntimeError('startWorkflowRun is not stubbed in the CRUD suite');
};
let startWorkflowRunImpl: (workflowRunId: number) => Promise<string> = startNotStubbed;

const stubTemporal: TemporalGateway = {
  async describeRun(temporalWorkflowId) {
    return describeStatuses.get(temporalWorkflowId) ?? null;
  },
  async failureMessage() {
    return 'run failed';
  },
  async queryProgress() {
    return {};
  },
  async queryTaskInfo() {
    throw new RuntimeError('queryTaskInfo is not stubbed in the CRUD suite');
  },
  async listTaskWorkflows() {
    return [];
  },
  async startWorkflowRun(workflowRunId) {
    return await startWorkflowRunImpl(workflowRunId);
  },
  async executeSubmit() {
    throw new NotFoundError('task not found or already completed');
  },
};

describe('API CRUD (fastify.inject over a scratch ledger, stub Temporal)', () => {
  let scratch: string;
  let dbPath: string;
  let storageRoot: string;
  let instance: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'graphflow_api_crud_'));
    dbPath = join(scratch, `crud_${randomBytes(4).toString('hex')}.sqlite3`);
    storageRoot = join(scratch, 'store');
    instance = initDb(dbPath);
    const registry = buildRegistry(ALL_WORKFLOWS);
    const conn = connect(dbPath);
    try {
      publishCatalog(conn, registry);
    } finally {
      conn.close();
    }
    const env: Env = {
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      temporalApiKey: undefined,
      temporalTaskQueue: TASK_QUEUE,
      dbPath,
      storageRoot,
      embedWorker: false,
      corsOrigins: ['http://localhost:3000'],
      host: '127.0.0.1',
      port: 0,
    };
    app = await buildApp({
      connect: () => connect(dbPath),
      env,
      temporal: stubTemporal,
      registry,
      instance,
      storageRoot,
      dbPath,
    });
    await app.ready();
  });

  beforeEach(() => {
    describeStatuses.clear();
    startWorkflowRunImpl = startNotStubbed;
  });

  afterAll(async () => {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  // ---------- helpers ----------

  async function createEngagement(displayName: string): Promise<EngagementOut> {
    const res = await app.inject({ method: 'POST', url: '/engagements', payload: { display_name: displayName } });
    expect(res.statusCode).toBe(200);
    return res.json<EngagementOut>();
  }

  interface WorkflowRunCreatePayload {
    workflow_id: string;
    display_name: string;
    copy_from?: number;
    // string (not LineageKind) so rejection tests can send garbage kinds.
    lineage_kind?: string;
  }

  // Raw variant for tests asserting rejections; `createWorkflowRun` wraps it with the 200 check.
  async function createWorkflowRunRaw(engagementId: number, payload: WorkflowRunCreatePayload) {
    return await app.inject({ method: 'POST', url: `/engagements/${engagementId}/workflow-runs`, payload });
  }

  async function createWorkflowRun(
    engagementId: number,
    displayName: string,
    opts: { workflowId?: string; copyFrom?: number; lineageKind?: LineageKind } = {}
  ): Promise<WorkflowRunDetailOut> {
    const payload: WorkflowRunCreatePayload = {
      workflow_id: opts.workflowId ?? 'tax_demo_workflow',
      display_name: displayName,
    };
    if (opts.copyFrom !== undefined) {
      payload.copy_from = opts.copyFrom;
    }
    if (opts.lineageKind !== undefined) {
      payload.lineage_kind = opts.lineageKind;
    }
    const res = await createWorkflowRunRaw(engagementId, payload);
    expect(res.statusCode).toBe(200);
    return res.json<WorkflowRunDetailOut>();
  }

  // A rejected create must also leave the ledger untouched: every guard (engagement, catalog,
  // pairing, parent scoping, copyability) runs before Phase B's authoritative insert, so a
  // rejection that still grows the run list means the phases were reordered and a phantom child
  // row leaked. The engagement's run ids are snapshotted around the attempt and asserted here;
  // callers assert status/detail on the returned response.
  async function createRejected(engagementId: number, payload: WorkflowRunCreatePayload) {
    const before = (await listRuns(engagementId)).map((r) => r.workflow_run_id);
    const res = await createWorkflowRunRaw(engagementId, payload);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await listRuns(engagementId)).map((r) => r.workflow_run_id)).toEqual(before);
    return res;
  }

  async function getRun(workflowRunId: number): Promise<WorkflowRunDetailOut> {
    const res = await app.inject({ method: 'GET', url: `/workflow-runs/${workflowRunId}` });
    expect(res.statusCode).toBe(200);
    return res.json<WorkflowRunDetailOut>();
  }

  async function listRuns(engagementId: number): Promise<WorkflowRunListOut[]> {
    const res = await app.inject({ method: 'GET', url: `/engagements/${engagementId}/workflow-runs` });
    expect(res.statusCode).toBe(200);
    return res.json<WorkflowRunListOut[]>();
  }

  // Simulates the freeze the real dispatch path stamps (freezeAndLoadDispatch itself is the Db
  // suite's territory) and registers the run's Temporal-side state in the describe map. status
  // null = frozen-but-idle: executed_at set but the dispatch never reached Temporal, so
  // describeRun keeps answering NOT_FOUND. The map is keyed by the run's EXACT temporal workflow
  // id — a route describing any other id gets null, so gate tests fail if the wrong id is asked.
  function markExecuted(workflowRunId: number, status: DerivedRunStatus | null = 'completed'): void {
    const conn = connect(dbPath);
    try {
      conn.prepare('UPDATE workflow_runs SET executed_at=? WHERE workflow_run_id=?').run(nowIso(), workflowRunId);
    } finally {
      conn.close();
    }
    if (status !== null) {
      describeStatuses.set(runWorkflowId(instance, workflowRunId), status);
    }
  }

  function multipartBody(
    fields: Record<string, string>,
    file: { filename: string; data: Buffer; contentType: string }
  ): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----graphflow${randomBytes(8).toString('hex')}`;
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    return {
      payload: Buffer.concat(chunks),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  interface UploadOpts {
    displayName?: string;
    workflowRunId?: number;
    mediaType?: string;
    canonicalJson?: boolean;
  }

  // Raw variant for tests asserting rejections; `upload` wraps it with the happy-path 200 check.
  async function uploadRaw(
    engagementId: number,
    name: string,
    data: Buffer,
    nodeparamslot: string,
    opts: UploadOpts = {}
  ) {
    const fields: Record<string, string> = { nodeparamslot };
    if (opts.displayName !== undefined) {
      fields.display_name = opts.displayName;
    }
    if (opts.workflowRunId !== undefined) {
      fields.workflow_run_id = String(opts.workflowRunId);
    }
    if (opts.canonicalJson === true) {
      fields.canonical_json = 'true';
    }
    const body = multipartBody(fields, { filename: name, data, contentType: opts.mediaType ?? 'text/plain' });
    return await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/artifacts`,
      payload: body.payload,
      headers: body.headers,
    });
  }

  async function upload(
    engagementId: number,
    name: string,
    data: Buffer,
    nodeparamslot: string,
    opts: UploadOpts = {}
  ): Promise<UploadOut> {
    const res = await uploadRaw(engagementId, name, data, nodeparamslot, opts);
    expect(res.statusCode).toBe(200);
    return res.json<UploadOut>();
  }

  // Plants an engine-sourced membership row directly in the scratch db — executing a workflow is
  // the integration suite's job, not this one's.
  function engineAttach(workflowRunId: number, artifactId: number): void {
    const conn = connect(dbPath);
    try {
      attach(conn, workflowRunId, artifactId, { source: 'engine', createdBy: 'engine' });
    } finally {
      conn.close();
    }
  }

  async function members(workflowRunId: number): Promise<MemberOut[]> {
    return (await getRun(workflowRunId)).members;
  }

  async function browseArtifactIds(engagementId: number): Promise<number[]> {
    const res = await app.inject({ method: 'GET', url: `/engagements/${engagementId}/artifacts` });
    expect(res.statusCode).toBe(200);
    return res.json<ArtifactMetaOut[]>().map((a) => a.artifact_id);
  }

  // ---------- tests ----------

  it('engagement create, list, get, 404', async () => {
    const eng = await createEngagement('CRUD Co — FY 2026');
    expect(eng.display_name).toBe('CRUD Co — FY 2026');
    expect(eng.stats).toEqual({ workflow_runs: 0, artifacts: 0, node_runs: 0, human_answers: 0 });
    // The wire key rename is one-way: the retired 'workspaces' key must never resurface.
    expect('workspaces' in eng.stats).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/engagements' });
    expect(list.statusCode).toBe(200);
    const mine = list.json<EngagementOut[]>().filter((e) => e.engagement_id === eng.engagement_id);
    expect(mine).toHaveLength(1);
    expect(mine[0].display_name).toBe('CRUD Co — FY 2026');
    expect(mine[0].stats.artifacts).toBe(0);

    const got = await app.inject({ method: 'GET', url: `/engagements/${eng.engagement_id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<EngagementOut>().engagement_id).toBe(eng.engagement_id);

    const missing = await app.inject({ method: 'GET', url: '/engagements/999999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ detail: string }>().detail).toContain('not found');
  });

  it('upload, attach, revive and nodeparamslot scoping', async () => {
    const eng = await createEngagement('upload-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'run-upload');
    const data = Buffer.from('STATEMENT - JAN\n2026-01-05 | DIVIDEND | 10.00\n');

    const up = await upload(eng.engagement_id, 's.txt', data, 'brokerage_statement', {
      displayName: 'stmt jan',
      workflowRunId: run.workflow_run_id,
    });
    expect(up.revived).toBe(false);
    const art = up.artifact;
    expect(art.nodeparamslot).toBe('brokerage_statement');
    expect(art.display_name).toBe('stmt jan');
    expect(art.byte_size).toBe(data.length);
    expect(art.created_by).toBe('user');
    expect(art.payload_available).toBe(true);
    // Derived provenance: an uploaded leaf nodeparamslot carries its birth channel.
    expect(art.origin).toBe('upload');
    expect(art.produced_by_node_run).toBeNull();
    // ArtifactMeta never carries bytes.
    expect(art).not.toHaveProperty('payload');

    const attached = (await members(run.workflow_run_id)).filter((m) => m.artifact_id === art.artifact_id);
    expect(attached).toHaveLength(1);
    expect(attached[0].source).toBe('user');

    const again = await upload(eng.engagement_id, 's.txt', data, 'brokerage_statement');
    expect(again.revived).toBe(true);
    expect(again.artifact.artifact_id).toBe(art.artifact_id);

    const other = await upload(eng.engagement_id, 's.txt', data, 'payment_slip');
    expect(other.revived).toBe(false);
    expect(other.artifact.artifact_id).not.toBe(art.artifact_id);
    expect(other.artifact.hash).toBe(art.hash);
  });

  it('attach promotes, detach deletes, cross-engagement rejected', async () => {
    const eng = await createEngagement('attach-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'run-attach');
    const up = await upload(eng.engagement_id, 'd.txt', Buffer.from('DOC-A'), 'brokerage_statement');
    const artifactId = up.artifact.artifact_id;

    engineAttach(run.workflow_run_id, artifactId);
    const asEngine = (await members(run.workflow_run_id)).filter((m) => m.artifact_id === artifactId);
    expect(asEngine.map((m) => m.source)).toEqual(['engine']);

    const promote = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/attachments`,
      payload: { artifact_id: artifactId },
    });
    expect(promote.statusCode).toBe(204);
    const asUser = (await members(run.workflow_run_id)).filter((m) => m.artifact_id === artifactId);
    expect(asUser.map((m) => m.source)).toEqual(['user']);

    const del = await app.inject({
      method: 'DELETE',
      url: `/workflow-runs/${run.workflow_run_id}/attachments/${artifactId}`,
    });
    expect(del.statusCode).toBe(204);
    expect(await members(run.workflow_run_id)).toEqual([]);
    const still = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}` });
    expect(still.statusCode).toBe(200);

    // Detach of a non-member on an UNFROZEN run stays a silent no-op — the freeze guard is
    // state-based, not row-based (contrast with the frozen 409 below).
    const noopDetach = await app.inject({
      method: 'DELETE',
      url: `/workflow-runs/${run.workflow_run_id}/attachments/${artifactId}`,
    });
    expect(noopDetach.statusCode).toBe(204);

    const eng2 = await createEngagement('attach-eng-2');
    const foreign = await upload(eng2.engagement_id, 'f.txt', Buffer.from('DOC-B'), 'payment_slip');
    const cross = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/attachments`,
      payload: { artifact_id: foreign.artifact.artifact_id },
    });
    expect(cross.statusCode).toBe(422);
    expect(cross.json<{ detail: string }>().detail).toContain('different engagement');
  });

  it('copy_from takes user rows only', async () => {
    const eng = await createEngagement('copy-eng');
    const src = await createWorkflowRun(eng.engagement_id, 'January');
    const userArt = await upload(eng.engagement_id, 'doc.txt', Buffer.from('USER DOC'), 'brokerage_statement', {
      workflowRunId: src.workflow_run_id,
    });
    const engineArt = await upload(eng.engagement_id, 'res.txt', Buffer.from('ENGINE RESULT'), 'ocr_txns');
    // Hand-staging a computed nodeparamslot is a legal supply species: origin derives to 'override'.
    expect(engineArt.artifact.origin).toBe('override');
    engineAttach(src.workflow_run_id, engineArt.artifact.artifact_id);
    expect(await members(src.workflow_run_id)).toHaveLength(2);
    // Only finished runs are copyable: freeze the source and mark its execution terminal.
    markExecuted(src.workflow_run_id);

    const copy = await createWorkflowRun(eng.engagement_id, 'February', { copyFrom: src.workflow_run_id });
    expect(copy.copied_from_workflow_run).toBe(src.workflow_run_id);
    expect(copy.lineage_kind).toBe('copy');
    // Born unfrozen and own-rooted: a copy starts a new family.
    expect(copy.executed_at).toBeNull();
    expect(copy.root_workflow_run_id).toBe(copy.workflow_run_id);
    expect(copy.members.map((m) => m.artifact_id)).toEqual([userArt.artifact.artifact_id]);
    expect(copy.members[0].source).toBe('user');
  });

  it('patch artifact and workflow run, archive toggle', async () => {
    const eng = await createEngagement('patch-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'before');
    const up = await upload(eng.engagement_id, 'a.txt', Buffer.from('PATCH ME'), 'payment_slip');
    expect(up.artifact.updated_by).toBeNull();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/artifacts/${up.artifact.artifact_id}`,
      payload: { display_name: 'renamed display name' },
    });
    expect(patched.statusCode).toBe(200);
    const renamed = patched.json<{ artifact: ArtifactMetaOut }>().artifact;
    expect(renamed.display_name).toBe('renamed display name');
    // A rename is a stamped update; creation provenance stays put.
    expect(renamed.updated_by).toBe('user');
    expect(renamed.updated_at).toMatch(ISO_RE);
    expect(renamed.created_by).toBe('user');
    expect(renamed.created_at).toBe(up.artifact.created_at);

    // PATCH {} changes nothing and must not fake an update.
    const noop = await app.inject({ method: 'PATCH', url: `/workflow-runs/${run.workflow_run_id}`, payload: {} });
    expect(noop.statusCode).toBe(200);
    expect(noop.json<WorkflowRunDetailOut>().updated_at).toBeNull();

    // Explicit null is the same no-op (the schema allows it; the route early-returns).
    const noopNull = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${run.workflow_run_id}`,
      payload: { display_name: null },
    });
    expect(noopNull.statusCode).toBe(200);
    expect(noopNull.json<WorkflowRunDetailOut>().updated_at).toBeNull();

    // Empty string is neither a rename nor a no-op request: zod .min(1) rejects it before the
    // route (array envelope), and nothing — name or updated_* — moves.
    const emptyName = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${run.workflow_run_id}`,
      payload: { display_name: '' },
    });
    expect(emptyName.statusCode).toBe(422);
    expect(Array.isArray(emptyName.json<{ detail: unknown }>().detail)).toBe(true);
    const afterEmpty = await getRun(run.workflow_run_id);
    expect(afterEmpty.display_name).toBe('before');
    expect(afterEmpty.updated_at).toBeNull();

    // workflow_id left the PATCH surface entirely (immutable after create — a different DAG is a
    // root-class copy, never a re-point). A stale client's key is zod-stripped, the early-return
    // skips the UPDATE, and nothing — not even updated_* — moves.
    const stale = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${run.workflow_run_id}`,
      payload: { workflow_id: 'tax_demo_workflow_v2' },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json<WorkflowRunDetailOut>().workflow_id).toBe('tax_demo_workflow');
    expect(stale.json<WorkflowRunDetailOut>().updated_at).toBeNull();

    // A rename alongside the stripped key still lands — and only display_name changes.
    const runPatch = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${run.workflow_run_id}`,
      payload: { display_name: 'after', workflow_id: 'tax_demo_workflow_v2' },
    });
    expect(runPatch.statusCode).toBe(200);
    expect(runPatch.json<WorkflowRunDetailOut>().display_name).toBe('after');
    expect(runPatch.json<WorkflowRunDetailOut>().workflow_id).toBe('tax_demo_workflow');
    expect(runPatch.json<WorkflowRunDetailOut>().updated_by).toBe('user');
    expect(runPatch.json<WorkflowRunDetailOut>().updated_at).toMatch(ISO_RE);

    const archived = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/archive`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<WorkflowRunDetailOut>().archived_at).not.toBeNull();

    const unarchived = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/archive`,
      payload: { archived: false },
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json<WorkflowRunDetailOut>().archived_at).toBeNull();

    // Archive is itself a stamped update — pinned on a workflow run no PATCH has touched.
    const run2 = await createWorkflowRun(eng.engagement_id, 'archive-me');
    expect(run2.updated_at).toBeNull();
    const archived2 = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run2.workflow_run_id}/archive`,
      payload: { archived: true },
    });
    expect(archived2.statusCode).toBe(200);
    expect(archived2.json<WorkflowRunDetailOut>().archived_at).not.toBeNull();
    expect(archived2.json<WorkflowRunDetailOut>().updated_by).toBe('user');
    expect(archived2.json<WorkflowRunDetailOut>().updated_at).toMatch(ISO_RE);
  });

  it('fresh-run wire defaults and the exact key set on detail and list', async () => {
    const eng = await createEngagement('defaults-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'fresh run');
    expect(run.lineage_kind).toBe('root');
    expect(run.executed_at).toBeNull();
    expect(run.copied_from_workflow_run).toBeNull();
    expect(run.root_workflow_run_id).toBe(run.workflow_run_id);
    // lineage_byid is TEXT even at depth 0 — toBe is strict, a numeric anchor would fail here.
    expect(run.lineage_byid).toBe(String(run.workflow_run_id));
    expect(run.lineage_display).toBe('fresh run');

    // The serializers are explicit projections: lineage_depth and deleted_at exist on the view
    // row but must never reach the wire — a `...run` spread would leak them.
    expect(Object.keys(run).sort()).toEqual([
      'archived_at',
      'copied_from_workflow_run',
      'created_at',
      'created_by',
      'display_name',
      'engagement_id',
      'executed_at',
      'lineage_byid',
      'lineage_display',
      'lineage_kind',
      'members',
      'root_workflow_run_id',
      'updated_at',
      'updated_by',
      'workflow_id',
      'workflow_run_id',
    ]);

    // The list row is a second, independently mutable projection — same defaults, own key set.
    const rows = await listRuns(eng.engagement_id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.lineage_kind).toBe('root');
    expect(row.executed_at).toBeNull();
    expect(row.root_workflow_run_id).toBe(run.workflow_run_id);
    expect(row.lineage_byid).toBe(String(run.workflow_run_id));
    expect(row.lineage_display).toBe('fresh run');
    expect(Object.keys(row).sort()).toEqual([
      'archived_at',
      'copied_from_workflow_run',
      'created_at',
      'created_by',
      'display_name',
      'engagement_id',
      'engine_results',
      'executed_at',
      'lineage_byid',
      'lineage_display',
      'lineage_kind',
      'root_workflow_run_id',
      'updated_at',
      'updated_by',
      'user_docs',
      'workflow_id',
      'workflow_run_id',
    ]);
  });

  it('create-route guards: unknown workflow 422 (no phantom row), missing engagement 404', async () => {
    const eng = await createEngagement('create-guard-eng');

    // Catalog membership is a create-time guard with its own exact message — and it fires before
    // Phase B, so nothing is persisted.
    const unknown = await createRejected(eng.engagement_id, {
      workflow_id: 'nope',
      display_name: 'never born',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ detail: string }>().detail).toBe("workflow 'nope' is not in the catalog");

    // A valid body against a nonexistent engagement is the engagement's 404, not a body 422 —
    // getEngagement outranks the catalog check.
    const orphan = await createWorkflowRunRaw(424_242, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'orphan run',
    });
    expect(orphan.statusCode).toBe(404);
    expect(orphan.json<{ detail: string }>().detail).toBe('engagement 424242 not found');
  });

  it('wire lineage matrix: pairing 422s, kind semantics, cross-workflow rules', async () => {
    const eng = await createEngagement('lineage-eng');
    const parent = await createWorkflowRun(eng.engagement_id, 'January estimate');
    markExecuted(parent.workflow_run_id);

    // Pairing guards (resolveLineageKind) — exact messages, they ARE the 422 contract.
    const copyAlone = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'no-parent copy',
      lineage_kind: 'copy',
    });
    expect(copyAlone.statusCode).toBe(422);
    expect(copyAlone.json<{ detail: string }>().detail).toBe("lineage_kind 'copy' requires copy_from");

    const revisionAlone = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'no-parent revision',
      lineage_kind: 'revision',
    });
    expect(revisionAlone.statusCode).toBe(422);
    expect(revisionAlone.json<{ detail: string }>().detail).toBe("lineage_kind 'revision' requires copy_from");

    const rootWithParent = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'rooted',
      lineage_kind: 'root',
      copy_from: parent.workflow_run_id,
    });
    expect(rootWithParent.statusCode).toBe(422);
    expect(rootWithParent.json<{ detail: string }>().detail).toBe(
      "lineage_kind 'root' cannot carry copy_from — use 'copy', 'revision' or 'simulation'"
    );

    // The pairing check runs before any db lookup: a nonexistent engagement still gets the
    // pairing 422, not a 404. (Raw, not createRejected: engagement 999999 has no run list to
    // snapshot — GET on it 404s. No row can land there anyway; the FK has no engagement row.)
    const pairingFirst = await createWorkflowRunRaw(999_999, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'x',
      lineage_kind: 'simulation',
    });
    expect(pairingFirst.statusCode).toBe(422);
    expect(pairingFirst.json<{ detail: string }>().detail).toBe("lineage_kind 'simulation' requires copy_from");

    // revision AND simulation must keep the parent's workflow — both kinds, exact message.
    for (const kind of ['revision', 'simulation'] as const) {
      const crossed = await createRejected(eng.engagement_id, {
        workflow_id: 'tax_demo_workflow_v2',
        display_name: `${kind} crossed`,
        copy_from: parent.workflow_run_id,
        lineage_kind: kind,
      });
      expect(crossed.statusCode).toBe(422);
      expect(crossed.json<{ detail: string }>().detail).toBe(
        `a ${kind} must keep the parent's workflow 'tax_demo_workflow' — asking for a different workflow is a copy`
      );
    }

    // A simulation with the parent's workflow extends the family.
    const sim = await createWorkflowRun(eng.engagement_id, 'what-if', {
      copyFrom: parent.workflow_run_id,
      lineageKind: 'simulation',
    });
    expect(sim.lineage_kind).toBe('simulation');
    expect(sim.copied_from_workflow_run).toBe(parent.workflow_run_id);
    expect(sim.executed_at).toBeNull();
    expect(sim.root_workflow_run_id).toBe(parent.workflow_run_id);
    expect(sim.lineage_byid).toBe(`${parent.workflow_run_id}/${sim.workflow_run_id}`);
    expect(sim.lineage_display).toBe('January estimate/what-if');

    // A copy may cross workflows and starts its own family.
    const copy = await createWorkflowRun(eng.engagement_id, 'ported to v2', {
      workflowId: 'tax_demo_workflow_v2',
      copyFrom: parent.workflow_run_id,
      lineageKind: 'copy',
    });
    expect(copy.lineage_kind).toBe('copy');
    expect(copy.workflow_id).toBe('tax_demo_workflow_v2');
    expect(copy.copied_from_workflow_run).toBe(parent.workflow_run_id);
    expect(copy.root_workflow_run_id).toBe(copy.workflow_run_id);
    expect(copy.lineage_byid).toBe(String(copy.workflow_run_id));
    expect(copy.lineage_display).toBe('ported to v2');

    // An unknown kind is a schema failure: array envelope, not a domain string.
    const bad = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'x',
      lineage_kind: 'banana',
    });
    expect(bad.statusCode).toBe(422);
    expect(Array.isArray(bad.json<{ detail: unknown }>().detail)).toBe(true);

    // copy_from scoping: cross-engagement 422, missing parent 404.
    const eng2 = await createEngagement('lineage-eng-2');
    const cross = await createRejected(eng2.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'poached',
      copy_from: parent.workflow_run_id,
    });
    expect(cross.statusCode).toBe(422);
    expect(cross.json<{ detail: string }>().detail).toBe('copy_from must be a workflow run in the same engagement');

    const ghost = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'ghost parent',
      copy_from: 424_242,
    });
    expect(ghost.statusCode).toBe(404);
  });

  it('copyability gates: draft, running and frozen-but-idle 409; completed and failed copy fine', async () => {
    const eng = await createEngagement('gates-eng');

    // Never executed: uncopyable, code RUN_NOT_COPYABLE → 409 with the exact detail.
    const draft = await createWorkflowRun(eng.engagement_id, 'draft');
    const fromDraft = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'copy of draft',
      copy_from: draft.workflow_run_id,
    });
    expect(fromDraft.statusCode).toBe(409);
    expect(fromDraft.json<{ detail: string }>().detail).toBe(
      `workflow run ${draft.workflow_run_id} has never been executed — only finished runs can be copied`
    );

    // Deterministic guards outrank the copyability gate: the same draft parent with a
    // workflow-mismatched revision gets the 422, not the 409.
    const mismatchWins = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow_v2',
      display_name: 'mismatched revision',
      copy_from: draft.workflow_run_id,
      lineage_kind: 'revision',
    });
    expect(mismatchWins.statusCode).toBe(422);
    expect(mismatchWins.json<{ detail: string }>().detail).toBe(
      "a revision must keep the parent's workflow 'tax_demo_workflow' — asking for a different workflow is a copy"
    );

    // Executed and still running: sweat in the waiting room.
    const running = await createWorkflowRun(eng.engagement_id, 'running');
    markExecuted(running.workflow_run_id, 'running');
    const fromRunning = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'copy of running',
      copy_from: running.workflow_run_id,
    });
    expect(fromRunning.statusCode).toBe(409);
    expect(fromRunning.json<{ detail: string }>().detail).toBe(
      `workflow run ${running.workflow_run_id} is still running — wait for it to finish before copying`
    );

    // Frozen-but-idle: executed_at stamped but the dispatch never reached Temporal
    // (describe → null). Distinct message from the running branch.
    const limbo = await createWorkflowRun(eng.engagement_id, 'limbo');
    markExecuted(limbo.workflow_run_id, null);
    const fromLimbo = await createRejected(eng.engagement_id, {
      workflow_id: 'tax_demo_workflow',
      display_name: 'copy of limbo',
      copy_from: limbo.workflow_run_id,
    });
    expect(fromLimbo.statusCode).toBe(409);
    expect(fromLimbo.json<{ detail: string }>().detail).toBe(
      `workflow run ${limbo.workflow_run_id} has not finished executing — wait for it before copying`
    );

    // Completed → copyable. The describe map only knows the parent's EXACT temporal id, so this
    // 200 also proves the route described the right execution.
    const done = await createWorkflowRun(eng.engagement_id, 'done');
    markExecuted(done.workflow_run_id, 'completed');
    const fromDone = await createWorkflowRun(eng.engagement_id, 'copy of done', { copyFrom: done.workflow_run_id });
    expect(fromDone.lineage_kind).toBe('copy');

    // Failed is terminal too: fix-forward from a failed run is deliberate.
    const failed = await createWorkflowRun(eng.engagement_id, 'failed');
    markExecuted(failed.workflow_run_id, 'failed');
    const fromFailed = await createWorkflowRun(eng.engagement_id, 'copy of failed', {
      copyFrom: failed.workflow_run_id,
    });
    expect(fromFailed.lineage_kind).toBe('copy');
  });

  it('freeze over the wire: attach/detach/upload-attach 409; rename, archive, plain upload still 200', async () => {
    const eng = await createEngagement('freeze-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'about to freeze');
    const doc = await upload(eng.engagement_id, 'doc.txt', Buffer.from('FROZEN DOC'), 'brokerage_statement', {
      workflowRunId: run.workflow_run_id,
    });
    const pool = await upload(eng.engagement_id, 'pool.txt', Buffer.from('POOL DOC'), 'payment_slip');
    markExecuted(run.workflow_run_id);

    // Pinned in BOTH places it lives: Db.assertNotFrozen (attach/detach) and the upload route's
    // pre-supply check duplicate this literal — drift in either is a contract break.
    const frozenDetail = `workflow run ${run.workflow_run_id} is frozen (already executed) — attachments can no longer change; create a copy or revision`;

    const attachRes = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/attachments`,
      payload: { artifact_id: pool.artifact.artifact_id },
    });
    expect(attachRes.statusCode).toBe(409);
    expect(attachRes.json<{ detail: string }>().detail).toBe(frozenDetail);

    const detachRes = await app.inject({
      method: 'DELETE',
      url: `/workflow-runs/${run.workflow_run_id}/attachments/${doc.artifact.artifact_id}`,
    });
    expect(detachRes.statusCode).toBe(409);
    expect(detachRes.json<{ detail: string }>().detail).toBe(frozenDetail);

    // The guard is state-based, not row-based: detaching an id that was never attached 409s too.
    const detachGhost = await app.inject({
      method: 'DELETE',
      url: `/workflow-runs/${run.workflow_run_id}/attachments/999999`,
    });
    expect(detachGhost.statusCode).toBe(409);
    expect(detachGhost.json<{ detail: string }>().detail).toBe(frozenDetail);

    // Upload-with-attach is rejected BEFORE the artifact is filed — the pool must not grow.
    const poolBefore = await browseArtifactIds(eng.engagement_id);
    const rejected = await uploadRaw(eng.engagement_id, 'never.txt', Buffer.from('NEVER FILED'), 'payment_slip', {
      workflowRunId: run.workflow_run_id,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ detail: string }>().detail).toBe(frozenDetail);
    expect(await browseArtifactIds(eng.engagement_id)).toEqual(poolBefore);

    // Revive variant: identical bytes already sit in the pool — the frozen 409 must leave the
    // existing artifact untouched (no revive stamp, no new membership).
    const rejectedRevive = await uploadRaw(eng.engagement_id, 'pool.txt', Buffer.from('POOL DOC'), 'payment_slip', {
      workflowRunId: run.workflow_run_id,
    });
    expect(rejectedRevive.statusCode).toBe(409);
    const poolArt = await app.inject({ method: 'GET', url: `/artifacts/${pool.artifact.artifact_id}` });
    expect(poolArt.json<{ artifact: ArtifactMetaOut }>().artifact.updated_at).toBeNull();
    expect((await members(run.workflow_run_id)).map((m) => m.artifact_id)).toEqual([doc.artifact.artifact_id]);

    // Freeze is per-run, not per-engagement: a plain upload still files into the pool.
    const plain = await upload(eng.engagement_id, 'plain.txt', Buffer.from('PLAIN UPLOAD'), 'payment_slip');
    expect(plain.revived).toBe(false);

    // display_name and archive stay editable on a frozen run — and both still stamp updated_*.
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${run.workflow_run_id}`,
      payload: { display_name: 'frozen but renamable' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<WorkflowRunDetailOut>().display_name).toBe('frozen but renamable');
    expect(renamed.json<WorkflowRunDetailOut>().updated_at).toMatch(ISO_RE);

    const archived = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/archive`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<WorkflowRunDetailOut>().archived_at).not.toBeNull();

    // The freeze itself is visible on both read models.
    const detail = await getRun(run.workflow_run_id);
    expect(detail.executed_at).toMatch(ISO_RE);
    const row = (await listRuns(eng.engagement_id)).find((r) => r.workflow_run_id === run.workflow_run_id);
    expect(row?.executed_at).toBe(detail.executed_at);
  });

  it('execute error mapping: RUN_FROZEN code → 409, uncoded RuntimeError → 422', async () => {
    const eng = await createEngagement('exec-map-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'exec-map');
    await upload(eng.engagement_id, 'e.txt', Buffer.from('EXEC DOC'), 'brokerage_statement', {
      workflowRunId: run.workflow_run_id,
    });

    const frozenMsg = `workflow run ${run.workflow_run_id} has already completed — create a copy or revision to run it again`;
    startWorkflowRunImpl = async () => {
      throw new RuntimeError(frozenMsg, { code: 'RUN_FROZEN' });
    };
    const conflict = await app.inject({ method: 'POST', url: `/workflow-runs/${run.workflow_run_id}/execute` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ detail: string }>().detail).toBe(frozenMsg);

    // No code on the context → the default RuntimeError mapping (422) stands.
    startWorkflowRunImpl = async () => {
      throw new RuntimeError('dispatch exploded');
    };
    const uncoded = await app.inject({ method: 'POST', url: `/workflow-runs/${run.workflow_run_id}/execute` });
    expect(uncoded.statusCode).toBe(422);
    expect(uncoded.json<{ detail: string }>().detail).toBe('dispatch exploded');
  });

  it('execute pre-check: engine-only membership counts as empty — 422 and the gateway never called', async () => {
    const eng = await createEngagement('exec-empty-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'engine-only');
    // An engine row must not satisfy the pre-check: the snapshot is user-sourced only.
    const art = await upload(eng.engagement_id, 'r.txt', Buffer.from('ENGINE ROW'), 'ocr_txns');
    engineAttach(run.workflow_run_id, art.artifact.artifact_id);

    const calls: number[] = [];
    startWorkflowRunImpl = async (id) => {
      calls.push(id);
      return runWorkflowId(instance, id);
    };
    const res = await app.inject({ method: 'POST', url: `/workflow-runs/${run.workflow_run_id}/execute` });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toBe(
      'this workflow run has no documents attached — attach at least one before running'
    );
    // A doomed dispatch never reaches the gateway (and so never the freeze path) from the route.
    expect(calls).toEqual([]);
  });

  it('execute happy path: 202 with the temporal id; the retired ?supersede querystring is inert', async () => {
    const eng = await createEngagement('exec-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'runnable');
    await upload(eng.engagement_id, 'go.txt', Buffer.from('GO'), 'brokerage_statement', {
      workflowRunId: run.workflow_run_id,
    });

    const calls: number[] = [];
    startWorkflowRunImpl = async (id) => {
      calls.push(id);
      return runWorkflowId(instance, id);
    };
    // A stale frontend still sending ?supersede=true must get plain execute semantics, not a 400.
    const res = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/execute?supersede=true`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<ExecuteOut>()).toEqual({ temporal_workflow_id: runWorkflowId(instance, run.workflow_run_id) });
    expect(calls).toEqual([run.workflow_run_id]);
  });

  it('frozen-but-idle is observable: status idle while executed_at is on the wire', async () => {
    const eng = await createEngagement('limbo-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'limbo');
    markExecuted(run.workflow_run_id, null);

    // Status derives from Temporal describe alone (idle: no execution exists); the freeze fact
    // derives from executed_at alone. Neither may be conflated into the other.
    const status = await app.inject({ method: 'GET', url: `/workflow-runs/${run.workflow_run_id}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json<StatusOut>()).toEqual({ status: 'idle', error: null });

    const detail = await getRun(run.workflow_run_id);
    expect(detail.executed_at).toMatch(ISO_RE);
  });

  it('root rename flows through lineage_display on both endpoints; children stay unstamped', async () => {
    const eng = await createEngagement('rename-eng');
    const root = await createWorkflowRun(eng.engagement_id, 'January estimate');
    markExecuted(root.workflow_run_id);
    const revision = await createWorkflowRun(eng.engagement_id, 'take two', {
      copyFrom: root.workflow_run_id,
      lineageKind: 'revision',
    });
    expect(revision.lineage_kind).toBe('revision');
    expect(revision.lineage_display).toBe('January estimate/take two');

    const rename = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${root.workflow_run_id}`,
      payload: { display_name: 'January final' },
    });
    expect(rename.statusCode).toBe(200);
    // Depth 0 shows the bare name, never doubled.
    expect(rename.json<WorkflowRunDetailOut>().lineage_display).toBe('January final');

    // Lineage is derived, never stored: the child re-reads the new root name without itself
    // being touched (updated_at stays null).
    const revDetail = await getRun(revision.workflow_run_id);
    expect(revDetail.lineage_display).toBe('January final/take two');
    expect(revDetail.updated_at).toBeNull();

    const rows = await listRuns(eng.engagement_id);
    const revRow = rows.find((r) => r.workflow_run_id === revision.workflow_run_id);
    expect(revRow?.lineage_display).toBe('January final/take two');
    expect(revRow?.updated_at).toBeNull();
    expect(rows.find((r) => r.workflow_run_id === root.workflow_run_id)?.lineage_display).toBe('January final');

    // The inverse: renaming the child changes only its own suffix.
    const renameChild = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${revision.workflow_run_id}`,
      payload: { display_name: 'take three' },
    });
    expect(renameChild.statusCode).toBe(200);
    expect(renameChild.json<WorkflowRunDetailOut>().lineage_display).toBe('January final/take three');
    expect((await getRun(root.workflow_run_id)).lineage_display).toBe('January final');
  });

  it('fan-out: three simulations of one executed root are independent siblings', async () => {
    const eng = await createEngagement('fanout-eng');
    const root = await createWorkflowRun(eng.engagement_id, 'scenario root');
    markExecuted(root.workflow_run_id);

    const sims: WorkflowRunDetailOut[] = [];
    for (const name of ['scenario a', 'scenario b', 'scenario c']) {
      sims.push(
        await createWorkflowRun(eng.engagement_id, name, {
          copyFrom: root.workflow_run_id,
          lineageKind: 'simulation',
        })
      );
    }
    expect(new Set(sims.map((s) => s.workflow_run_id)).size).toBe(3);

    const rows = await listRuns(eng.engagement_id);
    for (const sim of sims) {
      const row = rows.find((r) => r.workflow_run_id === sim.workflow_run_id);
      expect(row?.lineage_kind).toBe('simulation');
      expect(row?.root_workflow_run_id).toBe(root.workflow_run_id);
      // The greppability seed on the wire: every family member's path is '<root>/<child>'.
      expect(row?.lineage_byid).toBe(`${root.workflow_run_id}/${sim.workflow_run_id}`);
    }
  });

  it('hygiene stamps on the wire: created_*/updated_* exposed, deleted_at never', async () => {
    const eng = await createEngagement('hygiene-eng');
    expect(eng.created_by).toBe('user');
    expect(eng.created_at).toMatch(ISO_RE);
    expect(eng.updated_by).toBeNull();
    expect(eng.updated_at).toBeNull();
    expect(eng).not.toHaveProperty('deleted_at');

    const run = await createWorkflowRun(eng.engagement_id, 'run-hygiene');
    expect(run.created_by).toBe('user');
    expect(run.updated_at).toBeNull();
    expect(run).not.toHaveProperty('deleted_at');

    const rows = await listRuns(eng.engagement_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ created_by: 'user', updated_at: null, user_docs: 0, engine_results: 0 });
    expect(rows[0]).not.toHaveProperty('deleted_at');

    const up = await upload(eng.engagement_id, 'h.txt', Buffer.from('HYGIENE'), 'payment_slip');
    expect(up.artifact.updated_by).toBeNull();
    expect(up.artifact.updated_at).toBeNull();
    expect(up.artifact).not.toHaveProperty('deleted_at');

    // Catalog workflows carry publish stamps; this suite publishes exactly once.
    const catalog = (await app.inject({ method: 'GET', url: '/catalog' })).json<CatalogOut>();
    expect(catalog.workflows.length).toBeGreaterThan(0);
    for (const wf of catalog.workflows) {
      expect(wf.created_at).toMatch(ISO_RE);
      expect(wf.updated_at).toBeNull();
    }
  });

  it('member wire keys carry both provenance levels; promotion keeps added_* and list position', async () => {
    const eng = await createEngagement('alias-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'run-alias');
    const a = await upload(eng.engagement_id, 'a.txt', Buffer.from('ALIAS-A'), 'brokerage_statement');
    const b = await upload(eng.engagement_id, 'b.txt', Buffer.from('ALIAS-B'), 'payment_slip');
    engineAttach(run.workflow_run_id, a.artifact.artifact_id);
    engineAttach(run.workflow_run_id, b.artifact.artifact_id);

    // The membership join must not clobber the artifact's own provenance: the uploader (created_by)
    // and the attacher (added_by) arrive side by side.
    const before = await members(run.workflow_run_id);
    expect(before.map((m) => m.artifact_id)).toEqual([a.artifact.artifact_id, b.artifact.artifact_id]);
    expect(before[0].created_by).toBe('user');
    expect(before[0].added_by).toBe('engine');
    expect(before[0].added_at).toMatch(ISO_RE);

    // The member projection is exact too: ArtifactMetaOut's keys plus the membership triple.
    // deleted_at, payload_ref and lineage_depth can never leak into members — a `...row` spread
    // in the member mapper would fail here.
    expect(Object.keys(before[0]).sort()).toEqual([
      'added_at',
      'added_by',
      'artifact_id',
      'byte_size',
      'created_at',
      'created_by',
      'display_name',
      'engagement_id',
      'hash',
      'media_type',
      'nodeparamslot',
      'origin',
      'payload_available',
      'produced_by_node_run',
      'source',
      'updated_at',
      'updated_by',
    ]);

    const promote = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${run.workflow_run_id}/attachments`,
      payload: { artifact_id: a.artifact.artifact_id },
    });
    expect(promote.statusCode).toBe(204);

    // Promotion flips source but keeps first-attach provenance AND first-attach ordering — the
    // promoted member no longer jumps to the end of the list.
    const after = await members(run.workflow_run_id);
    expect(after.map((m) => m.artifact_id)).toEqual([a.artifact.artifact_id, b.artifact.artifact_id]);
    expect(after[0].source).toBe('user');
    expect(after[0].added_by).toBe('engine');
    expect(after[0].added_at).toBe(before[0].added_at);
  });

  it('catalog versioning invariant', async () => {
    const res = await app.inject({ method: 'GET', url: '/catalog' });
    expect(res.statusCode).toBe(200);
    const catalog = res.json<CatalogOut>();
    const byId = new Map(catalog.workflows.map((w) => [w.workflow_id, w]));
    const mustGet = (workflowId: string): CatalogWorkflowOut => {
      const wf = byId.get(workflowId);
      if (wf === undefined) {
        throw new RuntimeError(`workflow ${workflowId} missing from the catalog`);
      }
      return wf;
    };
    const v1 = mustGet('tax_demo_workflow');
    const v2 = mustGet('tax_demo_workflow_v2');
    expect(v1.superseded_by).toBe('tax_demo_workflow_v2');
    expect(v2.superseded_by).toBeNull();

    // THE versioning invariant under name identity: between v1 and v2 exactly calculate_tax and
    // build_report changed behavior, so exactly those two carry new names; the other four keep
    // v1's names (and with them their memoized answers).
    const nodeIds = (wf: CatalogWorkflowOut): string[] => wf.nodes.map((n) => n.node_id).sort();
    expect(nodeIds(v1)).toEqual([
      'append_to_master',
      'build_report',
      'calculate_tax',
      'ocr_brokerage_statement',
      'ocr_payment_slip',
      'verify_txns',
    ]);
    expect(nodeIds(v2)).toEqual([
      'append_to_master',
      'build_report_v2',
      'calculate_tax_v2',
      'ocr_brokerage_statement',
      'ocr_payment_slip',
      'verify_txns',
    ]);

    // Dispatch metadata is gone from the catalog row; node rows carry no code hash.
    expect(v1).not.toHaveProperty('task_queue');
    expect(v1).not.toHaveProperty('temporal_workflow_type');
    for (const node of [...v1.nodes, ...v2.nodes]) {
      expect(node).not.toHaveProperty('code_hash');
    }

    // Nodeparamslots carry the authored source; leaf stays derived (no producer among the workflow's nodes);
    // order is declaration order (the mirrors are rewritten per publish).
    expect(v2.nodeparamslots.map((k) => k.nodeparamslot)).toEqual([
      'brokerage_statement',
      'payment_slip',
      'ocr_txns',
      'verified_txns',
      'master_txn_list',
      'residency_answers',
      'tax_calc',
      'final_report',
    ]);
    const nodeparamslotByName = new Map(v2.nodeparamslots.map((k) => [k.nodeparamslot, k]));
    expect(nodeparamslotByName.get('brokerage_statement')).toMatchObject({ source: 'upload', leaf: true });
    expect(nodeparamslotByName.get('residency_answers')).toMatchObject({
      source: 'questionnaire',
      leaf: true,
      display_name: 'Residency questionnaire',
    });
    expect(nodeparamslotByName.get('ocr_txns')).toMatchObject({ source: 'computed', leaf: false });
    // Nodeparamslots declared without a display fall back to the nodeparamslot string — never an empty badge.
    expect(nodeparamslotByName.get('ocr_txns')?.display_name).toBe('ocr_txns');
    expect(v1.nodeparamslots.map((k) => k.nodeparamslot)).not.toContain('residency_answers');

    // input_nodeparamslots publishes the declared dataflow: param -> consumed nodeparamslot (null = scalar).
    const nodeOf = (wf: CatalogWorkflowOut, nodeId: string) => wf.nodes.find((n) => n.node_id === nodeId);
    expect(nodeOf(v1, 'calculate_tax')?.input_nodeparamslots).toEqual({ master: 'master_txn_list' });
    expect(nodeOf(v2, 'calculate_tax_v2')?.input_nodeparamslots).toEqual({
      master: 'master_txn_list',
      residency: 'residency_answers',
    });
    expect(nodeOf(v1, 'build_report')?.input_nodeparamslots).toEqual({
      statements: 'brokerage_statement',
      slips: 'payment_slip',
      master: 'master_txn_list',
      calc: 'tax_calc',
    });
    // input_nodeparamslots keys arrive in declared param order (node_input_nodeparamslots is rewritten per publish).
    expect(Object.keys(nodeOf(v1, 'build_report')?.input_nodeparamslots ?? {})).toEqual([
      'statements',
      'slips',
      'master',
      'calc',
    ]);

    for (const wf of catalog.workflows) {
      expect(wf.display_name).toBeTruthy();
      for (const nodeparamslot of wf.nodeparamslots) {
        expect(nodeparamslot.display_name).toBeTruthy();
        expect(['upload', 'questionnaire', 'email', 'computed']).toContain(nodeparamslot.source);
      }
      for (const node of wf.nodes) {
        expect(['engine', 'human']).toContain(node.executor);
      }
    }
  });

  it('upload of a nodeparamslot absent from the vocabulary is rejected', async () => {
    const eng = await createEngagement('guard-eng');
    const res = await uploadRaw(eng.engagement_id, 'x.txt', Buffer.from('X'), 'never_published_nodeparamslot');
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toBe(
      "nodeparamslot 'never_published_nodeparamslot' is not in the published nodeparamslot vocabulary"
    );
  });

  it('canonical_json uploads converge: same answers, different formatting, one artifact', async () => {
    const eng = await createEngagement('questionnaire-eng');
    const first = await upload(
      eng.engagement_id,
      'answers.json',
      Buffer.from('{"country": "SG", "resident": true}'),
      'residency_answers',
      { canonicalJson: true, mediaType: 'application/json' }
    );
    expect(first.revived).toBe(false);
    expect(first.artifact.origin).toBe('questionnaire');
    expect(first.artifact.media_type).toBe('application/json');

    // Re-answering identically — different key order and whitespace — lands on the SAME artifact
    // (the revive path), which is what revives downstream memo hits.
    const again = await upload(
      eng.engagement_id,
      'answers-2.json',
      Buffer.from('{\n  "resident": true,\n  "country": "SG"\n}'),
      'residency_answers',
      { canonicalJson: true, mediaType: 'application/json' }
    );
    expect(again.revived).toBe(true);
    expect(again.artifact.artifact_id).toBe(first.artifact.artifact_id);

    const invalid = await uploadRaw(eng.engagement_id, 'bad.json', Buffer.from('{not json'), 'residency_answers', {
      canonicalJson: true,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ detail: string }>().detail).toContain('not valid JSON');

    const floats = await uploadRaw(eng.engagement_id, 'f.json', Buffer.from('{"rate": 0.24}'), 'residency_answers', {
      canonicalJson: true,
    });
    expect(floats.statusCode).toBe(422);
    expect(floats.json<{ detail: string }>().detail).toContain('float');
  });

  it('a produced artifact derives origin=produced and its producer via lineage', async () => {
    const eng = await createEngagement('produced-eng');
    // Executing a workflow is the integration suite's job; here the completion transaction is
    // driven directly against the scratch ledger, then read back through the API.
    const conn = connect(dbPath);
    let artifactId: number;
    try {
      const { ref, fresh } = recordCompletion(conn, storageRoot, {
        engagementId: eng.engagement_id,
        workflowRunId: null,
        workflowId: 'tax_demo_workflow',
        nodeId: 'ocr_brokerage_statement',
        memoKey: 'a'.repeat(64),
        outputNodeparamslot: 'ocr_txns',
        payload: Buffer.from('{"doc_nodeparamslot":"brokerage_statement","transactions":[]}'),
        mediaType: 'application/json',
        createdBy: 'engine',
        temporalId: 'wf/run/act',
        inputArtifactIds: [],
      });
      expect(fresh).toBe(true);
      artifactId = ref.artifact_id;
    } finally {
      conn.close();
    }
    const res = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      artifact: ArtifactMetaOut;
      produced_by: { node_run_id: number; node_id: string } | null;
    }>();
    expect(body.artifact.origin).toBe('produced');
    expect(body.artifact.produced_by_node_run).toBe(body.produced_by?.node_run_id);
    expect(body.produced_by?.node_id).toBe('ocr_brokerage_statement');
  });

  it('artifact content roundtrip and 404', async () => {
    const eng = await createEngagement('content-eng');
    const data = Buffer.from('unicode content — total 120.50\n', 'utf-8');
    const up = await upload(eng.engagement_id, 'c.txt', data, 'brokerage_statement', { displayName: 'content check' });

    const res = await app.inject({ method: 'GET', url: `/artifacts/${up.artifact.artifact_id}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(data)).toBe(true);
    expect(String(res.headers['content-type']).startsWith('text/plain')).toBe(true);
    expect(String(res.headers['content-disposition'])).toContain('content check');

    expect((await app.inject({ method: 'GET', url: '/artifacts/999999/content' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/artifacts/999999' })).statusCode).toBe(404);
  });

  it('status is idle for a never-executed workflow run', async () => {
    const eng = await createEngagement('idle-eng');
    const run = await createWorkflowRun(eng.engagement_id, 'never-run');
    const res = await app.inject({ method: 'GET', url: `/workflow-runs/${run.workflow_run_id}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json<StatusOut>()).toEqual({ status: 'idle', error: null });
  });
});
