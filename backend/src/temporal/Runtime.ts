import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, type WorkflowHandle, WorkflowNotFoundError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import type { Registry } from '../domain/registry/Registry.js';
import { connect, getWorkspace, instanceId, userAttachments } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { RuntimeError, throwIfStandardError } from '../shared/errors/Errors.js';
import { createActivities } from './Activities.js';
import type { RunInput } from './Context.js';
import { humanTaskIdPrefix, runIdPrefix, runWorkflowId } from './Ids.js';

// Node-side runtime: Temporal Cloud client, the worker, and the execute-workspace path.
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

interface WorkspaceStart {
  engagementId: number;
  workflowId: string;
  attachments: ArtifactRef[];
  instance: string;
  temporalWorkflowType: string;
  taskQueue: string;
  declaredKinds: string[];
}

function loadWorkspaceStart(dbPath: string, workflowRunId: number): WorkspaceStart {
  const conn = connect(dbPath);
  try {
    const ws = getWorkspace(conn, workflowRunId);
    const attachments = userAttachments(conn, workflowRunId);
    const instance = instanceId(conn);
    const wfRow = conn
      .prepare<[string], { temporal_workflow_type: string; task_queue: string }>(
        'SELECT * FROM workflows WHERE workflow_id=?'
      )
      .get(ws.workflow_id);
    if (wfRow === undefined) {
      throw new RuntimeError(`workflow '${ws.workflow_id}' is not in the catalog (run \`init\` first)`);
    }
    const declaredKinds = conn
      .prepare<[string], { kind: string }>('SELECT kind FROM workflow_kinds WHERE workflow_id=?')
      .all(ws.workflow_id)
      .map((r) => r.kind);
    return {
      engagementId: ws.engagement_id,
      workflowId: ws.workflow_id,
      attachments,
      instance,
      temporalWorkflowType: wfRow.temporal_workflow_type,
      taskQueue: wfRow.task_queue,
      declaredKinds,
    };
  } finally {
    conn.close();
  }
}

const sameSnapshot = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((hash, i) => hash === b[i]);

// POST /workflow-runs/{id}/execute — start (or attach to) wfrun-{instance}-{id} with the current
// user-attachment snapshot; returns the handle without awaiting the result. Attaching to an OPEN
// run with an unchanged snapshot is idempotent (double-click safety); an open run with a CHANGED
// snapshot throws RuntimeError with context.code='SNAPSHOT_CHANGED' (the API maps it to 409)
// unless supersede, which terminates it and restarts on the fresh snapshot.
export async function startWorkspace(
  client: Client,
  dbPath: string,
  workflowRunId: number,
  supersede = false
): Promise<WorkflowHandle> {
  const start = loadWorkspaceStart(dbPath, workflowRunId);
  const wfId = runWorkflowId(start.instance, workflowRunId);

  try {
    const prior = client.workflow.getHandle(wfId);
    const desc = await prior.describe();
    if (desc.status.name === 'RUNNING') {
      const running = await prior.query<string[]>('snapshot');
      const current = start.attachments.map((a) => a.hash).sort();
      if (!sameSnapshot(running, current)) {
        if (!supersede) {
          throw new RuntimeError(
            `workspace ${workflowRunId}: attachments changed while a run is open — re-execute with supersede=True to terminate it and restart on the fresh snapshot`,
            { code: 'SNAPSHOT_CHANGED' }
          );
        }
        // Completed facts are already filed; in-flight completion transactions are idempotent.
        await prior.terminate('superseded: attachments changed');
      }
    }
  } catch (e) {
    // ONLY "no prior execution under this id" is swallowed. Our own errors (SNAPSHOT_CHANGED)
    // and anything unexpected (query failures, terminate failures) must propagate, or a
    // supersede silently attaches to the stale run.
    const err = throwIfStandardError(e);
    if (!(err instanceof WorkflowNotFoundError)) {
      throw err;
    }
  }

  const inp: RunInput = {
    engagement_id: start.engagementId,
    workflow_run_id: workflowRunId,
    workflow_id: start.workflowId,
    declared_kinds: start.declaredKinds,
    attachments: start.attachments,
  };
  // Workflow type and task queue come from the CATALOG row, not from code — old workspaces keep
  // their referent.
  return client.workflow.start(start.temporalWorkflowType, {
    args: [inp],
    workflowId: wfId,
    taskQueue: start.taskQueue,
    workflowIdConflictPolicy: 'USE_EXISTING',
  });
}
