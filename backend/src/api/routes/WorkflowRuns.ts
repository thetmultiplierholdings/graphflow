import type { OutgoingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attach,
  createWorkflowRun,
  detach,
  getArtifact,
  getEngagement,
  getWorkflowRun,
  listWorkflowRuns,
  nowIso,
  resolveLineageKind,
  userAttachments,
} from '../../infrastructure/db/Db.js';
import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import { runWorkflowId } from '../../temporal/Ids.js';
import type { ApiDeps, ProgressSnapshot } from '../Deps.js';
import { withConn } from '../Deps.js';
import type { ExecuteOut, StatusOut } from '../Schemas.js';
import {
  ArchiveBodySchema,
  AttachBodySchema,
  AttachmentParamsSchema,
  EngagementIdParamsSchema,
  WorkflowRunCreateSchema,
  WorkflowRunIdParamsSchema,
  WorkflowRunPatchSchema,
} from '../Schemas.js';
import type { WorkflowRunDetailOut, WorkflowRunListOut } from '../Serializers.js';
import { workflowRunDetail, workflowRunListOut } from '../Serializers.js';

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
    async (request): Promise<WorkflowRunListOut[]> => {
      return withConn(deps, (conn) => {
        getEngagement(conn, request.params.engagement_id);
        return listWorkflowRuns(conn, request.params.engagement_id).map(workflowRunListOut);
      });
    }
  );

  r.post(
    '/engagements/:engagement_id/workflow-runs',
    { schema: { params: EngagementIdParamsSchema, body: WorkflowRunCreateSchema } },
    async (request): Promise<WorkflowRunDetailOut> => {
      const engagementId = request.params.engagement_id;
      const body = request.body;
      const copyFrom = body.copy_from ?? null;
      const lineageKind = resolveLineageKind(copyFrom, body.lineage_kind);
      // Phase A — deterministic guards, fast-fail (createWorkflowRun re-checks every one inside
      // its own transaction; executed_at is set-once, so the re-check can only reject harder).
      withConn(deps, (conn) => {
        getEngagement(conn, engagementId);
        if (!workflowInCatalog(conn, body.workflow_id)) {
          throw new ValidationError(`workflow '${body.workflow_id}' is not in the catalog`);
        }
        if (copyFrom !== null) {
          const parent = getWorkflowRun(conn, copyFrom);
          if (parent.engagement_id !== engagementId) {
            throw new ValidationError('copy_from must be a workflow run in the same engagement');
          }
          if ((lineageKind === 'revision' || lineageKind === 'simulation') && body.workflow_id !== parent.workflow_id) {
            throw new ValidationError(
              `a ${lineageKind} must keep the parent's workflow '${parent.workflow_id}' — asking for a different workflow is a copy`
            );
          }
          if (parent.executed_at === null) {
            throw new RuntimeError(
              `workflow run ${copyFrom} has never been executed — only finished runs can be copied`,
              { code: 'RUN_NOT_COPYABLE' }
            );
          }
        }
      });
      // The Temporal half of the copyability gate — between the conn scopes, never inside one
      // (withConn is synchronous). Terminality is monotonic, so the describe-then-create TOCTOU
      // only ever rejects conservatively. Completed AND failed both count as terminal:
      // fix-forward from a failed run is deliberate.
      if (copyFrom !== null) {
        const state = await deps.temporal.describeRun(workflowIdFor(copyFrom));
        if (state === 'running') {
          throw new RuntimeError(`workflow run ${copyFrom} is still running — wait for it to finish before copying`, {
            code: 'RUN_NOT_COPYABLE',
          });
        }
        if (state === null) {
          // Frozen-but-idle: the parent froze but its dispatch never reached Temporal.
          throw new RuntimeError(`workflow run ${copyFrom} has not finished executing — wait for it before copying`, {
            code: 'RUN_NOT_COPYABLE',
          });
        }
      }
      // Phase B — the authoritative create.
      return withConn(deps, (conn) => {
        const wfr = createWorkflowRun(conn, engagementId, body.workflow_id, body.display_name, {
          createdBy: 'user',
          copiedFrom: copyFrom,
          lineageKind,
        });
        return workflowRunDetail(conn, wfr);
      });
    }
  );

  r.get(
    '/workflow-runs/:workflow_run_id',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request): Promise<WorkflowRunDetailOut> => {
      return withConn(deps, (conn) => workflowRunDetail(conn, request.params.workflow_run_id));
    }
  );

  r.patch(
    '/workflow-runs/:workflow_run_id',
    { schema: { params: WorkflowRunIdParamsSchema, body: WorkflowRunPatchSchema } },
    async (request): Promise<WorkflowRunDetailOut> => {
      const workflowRunId = request.params.workflow_run_id;
      const body = request.body;
      return withConn(deps, (conn) => {
        getWorkflowRun(conn, workflowRunId);
        const displayName = body.display_name ?? null;
        // PATCH {} changes nothing — skip the UPDATE so updated_* records only real changes.
        // (workflow_id left PATCH entirely: a different DAG is a root-class copy, never a
        // re-point; display_name stays editable on frozen runs — lineage_display derives live.)
        if (displayName === null) {
          return workflowRunDetail(conn, workflowRunId);
        }
        conn.exec('BEGIN IMMEDIATE');
        try {
          conn
            .prepare('UPDATE workflow_runs SET display_name=?, updated_by=?, updated_at=? WHERE workflow_run_id=?')
            .run(displayName, 'user', nowIso(), workflowRunId);
          conn.exec('COMMIT');
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
        return workflowRunDetail(conn, workflowRunId);
      });
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/archive',
    { schema: { params: WorkflowRunIdParamsSchema, body: ArchiveBodySchema } },
    async (request): Promise<WorkflowRunDetailOut> => {
      const workflowRunId = request.params.workflow_run_id;
      return withConn(deps, (conn) => {
        getWorkflowRun(conn, workflowRunId);
        conn.exec('BEGIN IMMEDIATE');
        try {
          // Archive and unarchive are both stamped updates; re-POSTing the same state re-stamps
          // (matches the pre-existing archived_at re-stamp behavior). Archiving a frozen run is
          // legal — archive is display metadata, not membership.
          const at = nowIso();
          conn
            .prepare('UPDATE workflow_runs SET archived_at=?, updated_by=?, updated_at=? WHERE workflow_run_id=?')
            .run(request.body.archived ? at : null, 'user', at, workflowRunId);
          conn.exec('COMMIT');
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
        return workflowRunDetail(conn, workflowRunId);
      });
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/attachments',
    { schema: { params: WorkflowRunIdParamsSchema, body: AttachBodySchema } },
    async (request, reply): Promise<FastifyReply> => {
      withConn(deps, (conn) => {
        const run = getWorkflowRun(conn, request.params.workflow_run_id);
        const art = getArtifact(conn, request.body.artifact_id);
        if (art.engagement_id !== run.engagement_id) {
          throw new ValidationError('artifact belongs to a different engagement');
        }
        // A frozen run rejects inside attach (RUN_FROZEN → 409).
        attach(conn, run.workflow_run_id, art.artifact_id, { source: 'user', createdBy: 'user' });
      });
      return reply.code(204).send();
    }
  );

  r.delete(
    '/workflow-runs/:workflow_run_id/attachments/:artifact_id',
    { schema: { params: AttachmentParamsSchema } },
    async (request, reply): Promise<FastifyReply> => {
      withConn(deps, (conn) => {
        getWorkflowRun(conn, request.params.workflow_run_id);
        // A missing artifact/membership row is NOT an error — the DELETE is a no-op. A frozen
        // run rejects inside detach (RUN_FROZEN → 409).
        detach(conn, request.params.workflow_run_id, request.params.artifact_id);
      });
      return reply.code(204).send();
    }
  );

  r.post(
    '/workflow-runs/:workflow_run_id/execute',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request, reply): Promise<FastifyReply> => {
      const workflowRunId = request.params.workflow_run_id;
      // Fast path only — the authoritative guards (row exists, catalog membership, non-empty
      // snapshot) re-run inside freezeAndLoadDispatch's transaction before the freeze stamp.
      withConn(deps, (conn) => {
        getWorkflowRun(conn, workflowRunId);
        if (userAttachments(conn, workflowRunId).length === 0) {
          throw new ValidationError('this workflow run has no documents attached — attach at least one before running');
        }
      });
      const temporalWorkflowId = await deps.temporal.startWorkflowRun(workflowRunId);
      const body: ExecuteOut = { temporal_workflow_id: temporalWorkflowId };
      return reply.code(202).send(body);
    }
  );

  r.get(
    '/workflow-runs/:workflow_run_id/status',
    { schema: { params: WorkflowRunIdParamsSchema } },
    async (request): Promise<StatusOut> => {
      const workflowRunId = request.params.workflow_run_id;
      withConn(deps, (conn) => getWorkflowRun(conn, workflowRunId));
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
      withConn(deps, (conn) => getWorkflowRun(conn, workflowRunId));

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
