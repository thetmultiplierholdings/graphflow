import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRegistry } from '../domain/registry/Registry.js';
import { CODE_HASHES } from '../generated/CodeHashes.js';
import { attach, connect, initDb, publishCatalog } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { NotFoundError, RuntimeError } from '../shared/errors/Errors.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import { buildApp } from './App.js';
import type { TemporalGateway } from './Deps.js';
import type { CatalogOut, CatalogWorkflowOut, StatusOut, UploadOut } from './Schemas.js';
import type { ArtifactMetaOut, EngagementOut, MemberOut, WorkspaceDetailOut } from './Serializers.js';

// HTTP CRUD over the real app: embedded worker OFF and Temporal replaced by a stub gateway (no
// route below touches Temporal except /status, which the stub answers with NOT_FOUND → idle).
// Scratch db + storage per run, deleted on teardown.

const TASK_QUEUE = 'graphflow-crud-test-queue';

const stubTemporal: TemporalGateway = {
  async describeRun() {
    return null;
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
  async startWorkspace() {
    throw new RuntimeError('startWorkspace is not stubbed in the CRUD suite');
  },
  async executeSubmit() {
    throw new NotFoundError('task not found or already completed');
  },
};

describe('API CRUD (fastify.inject over a scratch ledger, stub Temporal)', () => {
  let scratch: string;
  let dbPath: string;
  let storageRoot: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'graphflow_api_crud_'));
    dbPath = join(scratch, `crud_${randomBytes(4).toString('hex')}.sqlite3`);
    storageRoot = join(scratch, 'store');
    const instance = initDb(dbPath);
    const registry = buildRegistry(ALL_WORKFLOWS, CODE_HASHES);
    const conn = connect(dbPath);
    try {
      publishCatalog(conn, registry, TASK_QUEUE);
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

  afterAll(async () => {
    await app?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  // ---------- helpers ----------

  async function createEngagement(label: string): Promise<EngagementOut> {
    const res = await app.inject({ method: 'POST', url: '/engagements', payload: { label } });
    expect(res.statusCode).toBe(200);
    return res.json<EngagementOut>();
  }

  async function createWorkspace(
    engagementId: number,
    label: string,
    opts: { workflowId?: string; copyFrom?: number } = {}
  ): Promise<WorkspaceDetailOut> {
    const payload: { workflow_id: string; label: string; copy_from?: number } = {
      workflow_id: opts.workflowId ?? 'tax_demo_workflow',
      label,
    };
    if (opts.copyFrom !== undefined) {
      payload.copy_from = opts.copyFrom;
    }
    const res = await app.inject({ method: 'POST', url: `/engagements/${engagementId}/workflow-runs`, payload });
    expect(res.statusCode).toBe(200);
    return res.json<WorkspaceDetailOut>();
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

  async function upload(
    engagementId: number,
    name: string,
    data: Buffer,
    kind: string,
    opts: { label?: string; workflowRunId?: number; mediaType?: string } = {}
  ): Promise<UploadOut> {
    const fields: Record<string, string> = { kind };
    if (opts.label !== undefined) {
      fields.label = opts.label;
    }
    if (opts.workflowRunId !== undefined) {
      fields.workflow_run_id = String(opts.workflowRunId);
    }
    const body = multipartBody(fields, { filename: name, data, contentType: opts.mediaType ?? 'text/plain' });
    const res = await app.inject({
      method: 'POST',
      url: `/engagements/${engagementId}/artifacts`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(200);
    return res.json<UploadOut>();
  }

  // Plants an engine-sourced membership row directly in the scratch db — executing a workflow is
  // the integration suite's job, not this one's.
  function engineAttach(workflowRunId: number, artifactId: number): void {
    const conn = connect(dbPath);
    try {
      attach(conn, workflowRunId, artifactId, { source: 'engine', addedBy: 'engine' });
    } finally {
      conn.close();
    }
  }

  async function members(workflowRunId: number): Promise<MemberOut[]> {
    const res = await app.inject({ method: 'GET', url: `/workflow-runs/${workflowRunId}` });
    expect(res.statusCode).toBe(200);
    return res.json<WorkspaceDetailOut>().members;
  }

  // ---------- tests ----------

  it('engagement create, list, get, 404', async () => {
    const eng = await createEngagement('CRUD Co — FY 2026');
    expect(eng.label).toBe('CRUD Co — FY 2026');
    expect(eng.stats).toEqual({ workspaces: 0, artifacts: 0, node_runs: 0, human_answers: 0 });

    const list = await app.inject({ method: 'GET', url: '/engagements' });
    expect(list.statusCode).toBe(200);
    const mine = list.json<EngagementOut[]>().filter((e) => e.engagement_id === eng.engagement_id);
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe('CRUD Co — FY 2026');
    expect(mine[0].stats.artifacts).toBe(0);

    const got = await app.inject({ method: 'GET', url: `/engagements/${eng.engagement_id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<EngagementOut>().engagement_id).toBe(eng.engagement_id);

    const missing = await app.inject({ method: 'GET', url: '/engagements/999999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ detail: string }>().detail).toContain('not found');
  });

  it('upload, attach, revive and kind scoping', async () => {
    const eng = await createEngagement('upload-eng');
    const ws = await createWorkspace(eng.engagement_id, 'ws-upload');
    const data = Buffer.from('STATEMENT - JAN\n2026-01-05 | DIVIDEND | 10.00\n');

    const up = await upload(eng.engagement_id, 's.txt', data, 'brokerage_statement', {
      label: 'stmt jan',
      workflowRunId: ws.workflow_run_id,
    });
    expect(up.revived).toBe(false);
    const art = up.artifact;
    expect(art.kind).toBe('brokerage_statement');
    expect(art.label).toBe('stmt jan');
    expect(art.byte_size).toBe(data.length);
    expect(art.created_by).toBe('user');
    expect(art.payload_available).toBe(true);
    // ArtifactMeta never carries bytes.
    expect(art).not.toHaveProperty('payload');

    const attached = (await members(ws.workflow_run_id)).filter((m) => m.artifact_id === art.artifact_id);
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
    const ws = await createWorkspace(eng.engagement_id, 'ws-attach');
    const up = await upload(eng.engagement_id, 'd.txt', Buffer.from('DOC-A'), 'brokerage_statement');
    const artifactId = up.artifact.artifact_id;

    engineAttach(ws.workflow_run_id, artifactId);
    const asEngine = (await members(ws.workflow_run_id)).filter((m) => m.artifact_id === artifactId);
    expect(asEngine.map((m) => m.source)).toEqual(['engine']);

    const promote = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${ws.workflow_run_id}/attachments`,
      payload: { artifact_id: artifactId },
    });
    expect(promote.statusCode).toBe(204);
    const asUser = (await members(ws.workflow_run_id)).filter((m) => m.artifact_id === artifactId);
    expect(asUser.map((m) => m.source)).toEqual(['user']);

    const del = await app.inject({
      method: 'DELETE',
      url: `/workflow-runs/${ws.workflow_run_id}/attachments/${artifactId}`,
    });
    expect(del.statusCode).toBe(204);
    expect(await members(ws.workflow_run_id)).toEqual([]);
    const still = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}` });
    expect(still.statusCode).toBe(200);

    const eng2 = await createEngagement('attach-eng-2');
    const foreign = await upload(eng2.engagement_id, 'f.txt', Buffer.from('DOC-B'), 'payment_slip');
    const cross = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${ws.workflow_run_id}/attachments`,
      payload: { artifact_id: foreign.artifact.artifact_id },
    });
    expect(cross.statusCode).toBe(422);
    expect(cross.json<{ detail: string }>().detail).toContain('different engagement');
  });

  it('copy_from takes user rows only', async () => {
    const eng = await createEngagement('copy-eng');
    const src = await createWorkspace(eng.engagement_id, 'January');
    const userArt = await upload(eng.engagement_id, 'doc.txt', Buffer.from('USER DOC'), 'brokerage_statement', {
      workflowRunId: src.workflow_run_id,
    });
    const engineArt = await upload(eng.engagement_id, 'res.txt', Buffer.from('ENGINE RESULT'), 'ocr_txns');
    engineAttach(src.workflow_run_id, engineArt.artifact.artifact_id);
    expect(await members(src.workflow_run_id)).toHaveLength(2);

    const copy = await createWorkspace(eng.engagement_id, 'February', { copyFrom: src.workflow_run_id });
    expect(copy.copied_from_workflow_run).toBe(src.workflow_run_id);
    expect(copy.members.map((m) => m.artifact_id)).toEqual([userArt.artifact.artifact_id]);
    expect(copy.members[0].source).toBe('user');
  });

  it('patch artifact and workspace, archive toggle', async () => {
    const eng = await createEngagement('patch-eng');
    const ws = await createWorkspace(eng.engagement_id, 'before');
    const up = await upload(eng.engagement_id, 'a.txt', Buffer.from('PATCH ME'), 'payment_slip');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/artifacts/${up.artifact.artifact_id}`,
      payload: { label: 'renamed label' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ artifact: ArtifactMetaOut }>().artifact.label).toBe('renamed label');

    const wsPatch = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${ws.workflow_run_id}`,
      payload: { label: 'after', workflow_id: 'tax_demo_workflow_v2' },
    });
    expect(wsPatch.statusCode).toBe(200);
    expect(wsPatch.json<WorkspaceDetailOut>().label).toBe('after');
    expect(wsPatch.json<WorkspaceDetailOut>().workflow_id).toBe('tax_demo_workflow_v2');

    const badPatch = await app.inject({
      method: 'PATCH',
      url: `/workflow-runs/${ws.workflow_run_id}`,
      payload: { workflow_id: 'nope' },
    });
    expect(badPatch.statusCode).toBe(422);
    expect(badPatch.json<{ detail: string }>().detail).toBe("workflow 'nope' is not in the catalog");

    const archived = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${ws.workflow_run_id}/archive`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<WorkspaceDetailOut>().archived_at).not.toBeNull();

    const unarchived = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${ws.workflow_run_id}/archive`,
      payload: { archived: false },
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json<WorkspaceDetailOut>().archived_at).toBeNull();
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

    // THE versioning invariant (locks in the hashWith=[TAX_RATE] fix): between v1 and v2 exactly
    // calculate_tax and build_report re-hash; the other four nodes keep identical code hashes.
    const expectedNodes = [
      'append_to_master',
      'build_report',
      'calculate_tax',
      'ocr_brokerage_statement',
      'ocr_payment_slip',
      'verify_txns',
    ];
    const nodeIds = (wf: CatalogWorkflowOut): string[] => wf.nodes.map((n) => n.node_id).sort();
    expect(nodeIds(v1)).toEqual(expectedNodes);
    expect(nodeIds(v2)).toEqual(expectedNodes);

    const hashOf = (wf: CatalogWorkflowOut, nodeId: string): string => {
      const node = wf.nodes.find((n) => n.node_id === nodeId);
      if (node === undefined) {
        throw new RuntimeError(`node ${nodeId} missing from ${wf.workflow_id}`);
      }
      return node.code_hash;
    };
    const shared = expectedNodes.filter((nodeId) => hashOf(v1, nodeId) === hashOf(v2, nodeId));
    const changed = expectedNodes.filter((nodeId) => hashOf(v1, nodeId) !== hashOf(v2, nodeId));
    expect(shared).toEqual(['append_to_master', 'ocr_brokerage_statement', 'ocr_payment_slip', 'verify_txns']);
    expect(changed).toEqual(['build_report', 'calculate_tax']);

    for (const wf of catalog.workflows) {
      expect(wf.display_name).toBeTruthy();
      for (const kind of wf.kinds) {
        expect(kind.display_name).toBeTruthy();
      }
      for (const node of wf.nodes) {
        expect(['engine', 'human']).toContain(node.executor);
      }
    }
  });

  it('artifact content roundtrip and 404', async () => {
    const eng = await createEngagement('content-eng');
    const data = Buffer.from('unicode content — total 120.50\n', 'utf-8');
    const up = await upload(eng.engagement_id, 'c.txt', data, 'brokerage_statement', { label: 'content check' });

    const res = await app.inject({ method: 'GET', url: `/artifacts/${up.artifact.artifact_id}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(data)).toBe(true);
    expect(String(res.headers['content-type']).startsWith('text/plain')).toBe(true);
    expect(String(res.headers['content-disposition'])).toContain('content check');

    expect((await app.inject({ method: 'GET', url: '/artifacts/999999/content' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/artifacts/999999' })).statusCode).toBe(404);
  });

  it('status is idle for a never-executed workspace', async () => {
    const eng = await createEngagement('idle-eng');
    const ws = await createWorkspace(eng.engagement_id, 'never-run');
    const res = await app.inject({ method: 'GET', url: `/workflow-runs/${ws.workflow_run_id}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json<StatusOut>()).toEqual({ status: 'idle', error: null });
  });
});
