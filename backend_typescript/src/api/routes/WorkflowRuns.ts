import type { OutgoingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { WorkspaceListRow } from '../../infrastructure/db/Db.js';
import {
  attach,
  createWorkspace,
  detach,
  getArtifact,
  getEngagement,
  getWorkspace,
  listWorkspaces,
  nowIso,
  userAttachments,
} from '../../infrastructure/db/Db.js';
import { ValidationError } from '../../shared/errors/Errors.js';
import { runWorkflowId } from '../../temporal/Ids.js';
import type { ApiDeps, ProgressSnapshot } from '../Deps.js';
import { withConn } from '../Deps.js';
import type { ExecuteOut, StatusOut } from '../Schemas.js';
import {
  ArchiveBodySchema,
  AttachBodySchema,
  AttachmentParamsSchema,
  EngagementIdParamsSchema,
  ExecuteQuerySchema,
  isSupersede,
  WorkflowRunIdParamsSchema,
  WorkspaceCreateSchema,
  WorkspacePatchSchema,
} from '../Schemas.js';
import type { WorkspaceDetailOut } from '../Serializers.js';
import { workspaceDetail } from '../Serializers.js';

const workflowInCatalog = (conn: Database.Database, workflowId: string): boolean =>
  conn.prepare<[string], { '1': number }>('SELECT 1 FROM workflows WHERE workflow_id=?').get(workflowId) !== undefined;

interface ProgressEventData {
  status: string;
  executed: string[];
  memo_hits: string[];
  human_waits: string[];
  error: string | null;
}

const IDLE_DATA: ProgressEventData = { status: 'idle', executed: [], memo_hits: [], human_waits: [], error: null };

type SendEvent = (event: string, data: ProgressEventData) => void;

async function snapshotData(
  temporal: ApiDeps['temporal'],
  temporalWorkflowId: string,
  status: 'running' | 'completed' | 'failed'
): Promise<ProgressEventData> {
  let progress: ProgressSnapshot;
  try {
    progress = await temporal.queryProgress(temporalWorkflowId);
  } catch {
    progress = {};
  }
  return {
    status,
    executed: progress.executed ?? [],
    memo_hits: progress.memo_hits ?? [],
    human_waits: progress.human_waits ?? [],
    error: status === 'failed' ? await temporal.failureMessage(temporalWorkflowId) : null,
  };
}

// ~1s cadence, cumulative snapshots re-sent whole each tick; terminal finished/failed carry the
// same data as the final progress frame; idle streams close silently after 10s.
async function pumpProgress(
  temporal: ApiDeps['temporal'],
  temporalWorkflowId: string,
  closed: () => boolean,
  send: SendEvent
): Promise<void> {
  const idleDeadline = Date.now() + 10_000;
  while (!closed()) {
    const status = await temporal.describeRun(temporalWorkflowId);
    if (status === null) {
      if (Date.now() >= idleDeadline) {
        return;
      }
      send('progress', IDLE_DATA);
      await delay(1000);
      continue;
    }
    const data = await snapshotData(temporal, temporalWorkflowId, status);
    send('progress', data);
    if (status === 'completed') {
      send('finished', data);
      return;
    }
    if (status === 'failed') {
      send('failed', data);
      return;
    }
    await delay(1000);
  }
}

export function registerWorkflowRunRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const workflowIdFor = (workflowRunId: number): string => runWorkflowId(deps.instance, workflowRunId);

  r.get(
    '/engagements/:engagement_id/workflow-runs',
    { schema: { params: EngagementIdParamsSchema } },
    async (request): Promise<WorkspaceListRow[]> => {
      return withConn(deps, (conn) => {
        getEngagement(conn, request.params.engagement_id);
        return listWorkspaces(conn, request.params.engagement_id);
      });
    }
  );

  r.post(
    '/engagements/:engagement_id/workflow-runs',
    { schema: { params: EngagementIdParamsSchema, body: WorkspaceCreateSchema } },
    async (request): Promise<WorkspaceDetailOut> => {
      const engagementId = request.params.engagement_id;
      const body = request.body;
      return withConn(deps, (conn) => {
        getEngagement(conn, engagementId);
        if (!workflowInCatalog(conn, body.workflow_id)) {
          throw new ValidationError(`workflow '${body.workflow_id}' is not in the catalog`);
        }
        const copyFrom = body.copy_from ?? null;
        if (copyFrom !== null) {
          const src = getWorkspace(conn, copyFrom);
          if (src.engagement_id !== engagementId) {
            throw new ValidationError('copy_from must be a workspace in the same engagement');
          }
        }
        const wfr = createWorkspace(conn, engagementId, body.workflow_id, body.label, {
          createdBy: 'user',
          copiedFrom: copyFrom,
        });
        return workspaceDetail(conn, wfr);
      });
    }
  );

  r.get(
    '/workflow-runs/:workflow_run_id',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request): Promise<WorkspaceDetailOut> => {
      return withConn(deps, (conn) => workspaceDetail(conn, request.params.workflow_run_id));
    }
  );

  r.patch(
    '/workflow-runs/:workflow_run_id',
    { schema: { params: WorkflowRunIdParamsSchema, body: WorkspacePatchSchema } },
    async (request): Promise<WorkspaceDetailOut> => {
      const workflowRunId = request.params.workflow_run_id;
      const body = request.body;
      return withConn(deps, (conn) => {
        getWorkspace(conn, workflowRunId);
        const workflowId = body.workflow_id ?? null;
        if (workflowId !== null && !workflowInCatalog(conn, workflowId)) {
          throw new ValidationError(`workflow '${workflowId}' is not in the catalog`);
        }
        conn.exec('BEGIN IMMEDIATE');
        try {
          conn
            .prepare(
              'UPDATE workflow_runs SET label=COALESCE(?, label), workflow_id=COALESCE(?, workflow_id) WHERE workflow_run_id=?'
            )
            .run(body.label ?? null, workflowId, workflowRunId);
          conn.exec('COMMIT');
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
        return workspaceDetail(conn, workflowRunId);
      });
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/archive',
    { schema: { params: WorkflowRunIdParamsSchema, body: ArchiveBodySchema } },
    async (request): Promise<WorkspaceDetailOut> => {
      const workflowRunId = request.params.workflow_run_id;
      return withConn(deps, (conn) => {
        getWorkspace(conn, workflowRunId);
        conn.exec('BEGIN IMMEDIATE');
        try {
          conn
            .prepare('UPDATE workflow_runs SET archived_at=? WHERE workflow_run_id=?')
            .run(request.body.archived ? nowIso() : null, workflowRunId);
          conn.exec('COMMIT');
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
        return workspaceDetail(conn, workflowRunId);
      });
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/attachments',
    { schema: { params: WorkflowRunIdParamsSchema, body: AttachBodySchema } },
    async (request, reply): Promise<FastifyReply> => {
      withConn(deps, (conn) => {
        const ws = getWorkspace(conn, request.params.workflow_run_id);
        const art = getArtifact(conn, request.body.artifact_id);
        if (art.engagement_id !== ws.engagement_id) {
          throw new ValidationError('artifact belongs to a different engagement');
        }
        attach(conn, ws.workflow_run_id, art.artifact_id, { source: 'user', addedBy: 'user' });
      });
      return reply.code(204).send();
    }
  );

  r.delete(
    '/workflow-runs/:workflow_run_id/attachments/:artifact_id',
    { schema: { params: AttachmentParamsSchema } },
    async (request, reply): Promise<FastifyReply> => {
      withConn(deps, (conn) => {
        getWorkspace(conn, request.params.workflow_run_id);
        // A missing artifact/membership row is NOT an error — the DELETE is a no-op.
        detach(conn, request.params.workflow_run_id, request.params.artifact_id);
      });
      return reply.code(204).send();
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/execute',
    { schema: { params: WorkflowRunIdParamsSchema, querystring: ExecuteQuerySchema } },
    async (request, reply): Promise<FastifyReply> => {
      const workflowRunId = request.params.workflow_run_id;
      withConn(deps, (conn) => {
        getWorkspace(conn, workflowRunId);
        if (userAttachments(conn, workflowRunId).length === 0) {
          throw new ValidationError('this workspace has no documents attached — attach at least one before running');
        }
      });
      const temporalWorkflowId = await deps.temporal.startWorkspace(
        workflowRunId,
        isSupersede(request.query.supersede)
      );
      const body: ExecuteOut = { temporal_workflow_id: temporalWorkflowId };
      return reply.code(202).send(body);
    }
  );

  r.get(
    '/workflow-runs/:workflow_run_id/status',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request): Promise<StatusOut> => {
      const workflowRunId = request.params.workflow_run_id;
      withConn(deps, (conn) => getWorkspace(conn, workflowRunId));
      const temporalWorkflowId = workflowIdFor(workflowRunId);
      const status = await deps.temporal.describeRun(temporalWorkflowId);
      if (status === null) {
        return { status: 'idle', error: null };
      }
      const error = status === 'failed' ? await deps.temporal.failureMessage(temporalWorkflowId) : null;
      return { status, error };
    }
  );

  // SSE progress stream. hijack + writeHead spreading reply.getHeaders() is load-bearing: raw writes
  // bypass Fastify serialization and would otherwise ship WITHOUT the CORS headers @fastify/cors
  // already set, hard-blocking the frontend's cross-origin EventSource.
  r.get(
    '/workflow-runs/:workflow_run_id/progress',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request, reply): Promise<void> => {
      const workflowRunId = request.params.workflow_run_id;
      withConn(deps, (conn) => getWorkspace(conn, workflowRunId));

      reply.hijack();
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          headers[name] = value;
        }
      }
      headers['content-type'] = 'text/event-stream';
      headers['cache-control'] = 'no-cache';
      headers['x-accel-buffering'] = 'no';
      reply.raw.writeHead(200, headers);
      const send: SendEvent = (event, data) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const closed = (): boolean => request.raw.destroyed || reply.raw.writableEnded;
      try {
        await pumpProgress(deps.temporal, workflowIdFor(workflowRunId), closed, send);
      } finally {
        reply.raw.end();
      }
    }
  );
}
