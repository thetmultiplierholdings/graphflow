import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getArtifact } from '../../infrastructure/db/Db.js';
import { NotFoundError } from '../../shared/errors/Errors.js';
import { humanTaskIdPrefix } from '../../temporal/Ids.js';
import type { ApiDeps, TaskWorkflowExecution } from '../Deps.js';
import { withConn } from '../Deps.js';
import type { HumanTaskOut } from '../Schemas.js';
import { HumanTaskSubmitSchema, HumanTasksQuerySchema, TaskIdParamsSchema } from '../Schemas.js';
import type { ArtifactMetaOut } from '../Serializers.js';
import { artifactMeta } from '../Serializers.js';

// The inbox is Temporal visibility, not a table: list Running GraphflowHumanTask workflows on the
// task queue, filter by this db instance's id prefix, enrich concurrently via the task_info query.

export function registerHumanTaskRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const prefix = humanTaskIdPrefix(deps.instance);

  const enrich = async (execution: TaskWorkflowExecution): Promise<HumanTaskOut | null> => {
    try {
      const info = await deps.temporal.queryTaskInfo(execution.workflowId);
      // Visibility is eventually consistent; completed tasks can linger as Running.
      if (!info.open) {
        return null;
      }
      return {
        task_id: execution.workflowId,
        engagement_id: info.engagement_id,
        workflow_id: info.workflow_id,
        node_id: info.node_id,
        output_nodeparamslot: info.output_nodeparamslot,
        display_name: info.display_name,
        instructions: info.instructions,
        payload: info.payload,
        result_required_keys: info.result_required_keys,
        requested_by_workflow_run: info.requested_by_workflow_run,
        input_artifact_ids: info.input_artifact_ids,
        start_time: execution.startTime,
      };
    } catch {
      // Raced to completion / transient query failure: drop from this sweep.
      return null;
    }
  };

  r.get(
    '/human-tasks',
    { schema: { querystring: HumanTasksQuerySchema } },
    async (request): Promise<HumanTaskOut[]> => {
      const executions = await deps.temporal.listTaskWorkflows();
      const mine = executions.filter((e) => e.workflowId.startsWith(prefix));
      const enriched = await Promise.all(mine.map(enrich));
      const open = enriched.filter((t): t is HumanTaskOut => t !== null);
      const engagementId = request.query.engagement_id;
      return engagementId === undefined ? open : open.filter((t) => t.engagement_id === engagementId);
    }
  );

  r.post(
    '/human-tasks/:task_id/submit',
    { schema: { params: TaskIdParamsSchema, body: HumanTaskSubmitSchema } },
    async (request): Promise<{ artifact: ArtifactMetaOut }> => {
      const taskId = request.params.task_id;
      // Foreign prefixes are rejected before touching Temporal (shared namespace/queue).
      if (!taskId.startsWith(prefix)) {
        throw new NotFoundError('task not found');
      }
      // The API attributes every submission to a user principal; the body carries the bare name.
      // (A name may itself contain ':' — 'user:' prefixes verbatim, no parsing.)
      const ref = await deps.temporal.executeSubmit(taskId, {
        reviewer: `user:${request.body.reviewer}`,
        result: request.body.result,
      });
      return withConn(deps, (conn) => ({ artifact: artifactMeta(getArtifact(conn, ref.artifact_id)) }));
    }
  );
}
