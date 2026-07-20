import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowHandle,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { Registry } from '../domain/registry/Registry.js';
import { connect, freezeAndLoadDispatch, instanceId, type WorkflowRunDispatch } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { RuntimeError, throwIfStandardError } from '../shared/errors/Errors.js';
import { createActivities } from './Activities.js';
import type { RunInput } from './Context.js';
import { humanTaskIdPrefix, RUN_WORKFLOW_TYPE, runIdPrefix, runWorkflowId } from './Ids.js';

// Node-side runtime: Temporal Cloud client, the worker, and the execute-workflow-run path.
// Workflow-id helpers live in Ids.ts (shared with activities, API routes, and the CLI).

// API key present => Temporal Cloud (TLS + API-key auth); absent => plain local connection.
export async function connectClient(env: Env): Promise<Client> {
  const connection =
    env.temporalApiKey === undefined
      ? await Connection.connect({ address: env.temporalAddress })
      : await Connection.connect({ address: env.temporalAddress, tls: true, apiKey: env.temporalApiKey });
  return new Client({ connection, namespace: env.temporalNamespace });
}

// The bundle ENTRY path must exist on disk: Workflows.ts under tsx/vitest, Workflows.js in the
// compiled output (in-bundle .js imports resolve to .ts via the bundler's extensionAlias).
function workflowsEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const ts = join(here, 'Workflows.ts');
  return existsSync(ts) ? ts : join(here, 'Workflows.js');
}

export interface WorkerHandle {
  readonly worker: Worker;
  // Closes the worker's NativeConnection. Call after worker.shutdown() + run() resolve, or the
  // open connection keeps the Temporal Core runtime (and the Node process) alive.
  close(): Promise<void>;
}

// D17: the worker owns its own NativeConnection (the Client's Connection is a different type and
// cannot be reused); the handle's close() releases it after shutdown.
export async function createWorker(
  env: Env,
  client: Client,
  dbPath: string,
  storageRoot: string,
  instance: string,
  registry: Registry
): Promise<WorkerHandle> {
  const connection =
    env.temporalApiKey === undefined
      ? await NativeConnection.connect({ address: env.temporalAddress })
      : await NativeConnection.connect({ address: env.temporalAddress, tls: true, apiKey: env.temporalApiKey });
  try {
    const worker = await Worker.create({
      connection,
      namespace: env.temporalNamespace,
      taskQueue: env.temporalTaskQueue,
      workflowsPath: workflowsEntry(),
      activities: createActivities({
        dbPath,
        storageRoot,
        client,
        taskQueue: env.temporalTaskQueue,
        instance,
        registry,
      }),
    });
    return { worker, close: () => connection.close() };
  } catch (e) {
    await connection.close();
    throw e;
  }
}

// After a worker restart, parked workflows' stickiness still points at the DEAD worker's sticky
// queue; queries then stall on sticky dispatch (observed 5-30s per task_info) until the server
// gives up, wedging the inbox. A no-op signal forces one normal workflow task, which the new
// worker completes — transferring stickiness (and the workflow cache) to it. Best-effort sweep
// over this instance's open workflows; failures are logged nowhere on purpose (next poll heals).
export async function adoptOpenWorkflows(client: Client, env: Env, instance: string): Promise<number> {
  const prefixes = [runIdPrefix(instance), humanTaskIdPrefix(instance)];
  let adopted = 0;
  try {
    const query = `TaskQueue = '${env.temporalTaskQueue}' AND ExecutionStatus = 'Running'`;
    for await (const wf of client.workflow.list({ query })) {
      if (!prefixes.some((p) => wf.workflowId.startsWith(p))) {
        continue;
      }
      try {
        await client.workflow.getHandle(wf.workflowId).signal('__graphflow_worker_handover');
        adopted += 1;
      } catch {
        // completed/terminated in the meantime — fine
      }
    }
  } catch {
    // visibility sweep failed — queries will just pay the sticky-timeout latency until re-polled
  }
  return adopted;
}

const frozenCompletedError = (workflowRunId: number): RuntimeError =>
  new RuntimeError(`workflow run ${workflowRunId} has already completed — create a copy or revision to run it again`, {
    code: 'RUN_FROZEN',
  });

// The dispatch policies, exported ONLY for the unit pin in Runtime.test.ts: the reuse policy is
// the server-side arbiter that a COMPLETED business run never re-executes (race F1) while any
// other closed state may retry in place — the describe fast path above it is advisory, so a
// silent regression here would be invisible to every deterministic test. Do NOT copy the reuse
// policy to ensure_human_task: its start-after-completion self-complete path needs
// ALLOW_DUPLICATE.
export const RUN_START_POLICIES = {
  workflowIdConflictPolicy: 'USE_EXISTING',
  workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
} as const;

// The start-error translation (the other half of the race-F1 fix), exported for the unit pin:
// the server refusing a restart over a COMPLETED execution must surface as RUN_FROZEN (409),
// never a raw 500; everything else propagates untouched.
export function rethrowStartError(e: Error, workflowRunId: number): never {
  const err = throwIfStandardError(e);
  if (err instanceof WorkflowExecutionAlreadyStartedError) {
    throw frozenCompletedError(workflowRunId);
  }
  throw err;
}

// POST /workflow-runs/{id}/execute — start (or attach to) wfrun-{instance}-{id}; returns the
// handle without awaiting the result. The row freezes at first dispatch (freezeAndLoadDispatch:
// stamp + snapshot in ONE transaction), so the snapshot can never drift under an open run — the
// old SNAPSHOT_CHANGED/supersede machinery is gone. Per prior-execution state: RUNNING attaches
// idempotently (USE_EXISTING — double-click safety); COMPLETED refuses with RUN_FROZEN (a
// business run happens at most once — copy/revise instead); any other closed state (or none)
// re-dispatches under the SAME id — the retry-in-place path, so infra noise never mints a
// business revision. Benign race, accepted: describe says RUNNING, the run completes before
// start — the fresh execution memo-replays to completion with zero executed node bodies
// (frozen snapshot ⇒ identical memo keys).
export async function startWorkflowRun(
  client: Client,
  dbPath: string,
  workflowRunId: number,
  taskQueue: string
): Promise<WorkflowHandle> {
  // Short-lived conn for the id prefix — never hold a connection across an await.
  const idConn = connect(dbPath);
  let wfId: string;
  try {
    wfId = runWorkflowId(instanceId(idConn), workflowRunId);
  } finally {
    idConn.close();
  }

  // Fast-path courtesy 409 — advisory only; the atomic arbiter is the reuse policy on the start
  // call below (describe is strongly consistent, but the run could complete in the gap).
  try {
    const desc = await client.workflow.getHandle(wfId).describe();
    if (desc.status.name === 'COMPLETED') {
      throw frozenCompletedError(workflowRunId);
    }
  } catch (e) {
    // ONLY "no prior execution under this id" is swallowed (first dispatch, or a retry after a
    // dispatch that froze the row but never reached Temporal). Everything else must propagate.
    const err = throwIfStandardError(e);
    if (!(err instanceof WorkflowNotFoundError)) {
      throw err;
    }
  }

  const conn = connect(dbPath);
  let start: WorkflowRunDispatch;
  try {
    start = freezeAndLoadDispatch(conn, workflowRunId);
  } finally {
    conn.close();
  }

  const inp: RunInput = {
    engagement_id: start.engagementId,
    workflow_run_id: workflowRunId,
    workflow_id: start.workflowId,
    declared_nodeparamslots: start.declaredNodeparamslots,
    attachments: start.attachments,
  };
  // Dispatch is the constant workflow type on the caller's (env) task queue — the same value the
  // recovery sweeps filter on, so a run can never start somewhere the sweeps don't look. A retired
  // workflow id fails loud inside GraphflowRun ("not registered on this worker") instead of
  // hanging on a stale queue.
  try {
    return await client.workflow.start(RUN_WORKFLOW_TYPE, {
      args: [inp],
      workflowId: wfId,
      taskQueue,
      ...RUN_START_POLICIES,
    });
  } catch (e) {
    rethrowStartError(e as Error, workflowRunId);
  }
}
