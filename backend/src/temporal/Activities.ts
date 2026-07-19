import { activityInfo } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { ArtifactHandle, type PayloadLoader } from '../domain/artifact/ArtifactHandle.js';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import { canonicalBytes } from '../domain/canonical/Canonical.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import type { HumanTask, NodeArgValue, NodeResult, Registry } from '../domain/registry/Registry.js';
import { attach, connect, memoLookup, readArtifactPayload, recordCompletion } from '../infrastructure/db/Db.js';
import { errorMessage } from '../shared/errors/Errors.js';
import type { NodeRequest, TransportValue } from './Context.js';
import { HUMAN_TASK_WORKFLOW_TYPE, humanTaskWorkflowId } from './Ids.js';
import type { TaskInput } from './Workflows.js';

// Node-side: every DB / storage / client touch. Engine node bodies execute here. Human tasks are
// standalone Temporal workflows started here with hard id-dedupe
// ('node-{instance}-{engagement}-{memo_key}', conflict policy USE_EXISTING).

export interface ActivityDeps {
  dbPath: string;
  storageRoot: string;
  client: Client;
  taskQueue: string;
  instance: string;
  registry: Registry;
}

const textEncoder = new TextEncoder();

// A dict is an artifact marker ONLY if __artifact__ is its sole key.
const isArtifactMarker = (value: object): value is { __artifact__: ArtifactRef } => {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '__artifact__';
};

function decodeTransport(value: TransportValue, loader: PayloadLoader): NodeArgValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => decodeTransport(item, loader));
  }
  if (isArtifactMarker(value)) {
    return new ArtifactHandle(value.__artifact__, loader);
  }
  const out: { [key: string]: NodeArgValue } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = decodeTransport(v, loader);
  }
  return out;
}

function decodeArgs(transport: TransportValue, loader: PayloadLoader): Record<string, NodeArgValue> {
  const decoded = decodeTransport(transport, loader);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || decoded instanceof ArtifactHandle) {
    throw ApplicationFailure.nonRetryable('args_transport must be an object of named arguments');
  }
  return decoded;
}

// Inverse of decodeTransport, used for HumanTask.payload.
function encodePayloadValue(value: NodeArgValue): TransportValue {
  if (value instanceof ArtifactHandle) {
    return { __artifact__: { ...value.ref } };
  }
  if (Array.isArray(value)) {
    return value.map(encodePayloadValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: TransportValue } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodePayloadValue(v);
    }
    return out;
  }
  return value;
}

// Node return-value contract: bytes -> octet-stream; string -> UTF-8 text/plain; anything else
// must be canonical-JSON-safe (canonicalBytes throws on floats etc.).
function toOutputBytes(result: NodeResult): { payload: Uint8Array; mediaType: string } {
  if (result instanceof Uint8Array) {
    return { payload: result, mediaType: 'application/octet-stream' };
  }
  if (typeof result === 'string') {
    return { payload: textEncoder.encode(result), mediaType: 'text/plain' };
  }
  return { payload: canonicalBytes(result as JsonValue), mediaType: 'application/json' };
}

// Structural type guard: HumanTask crosses the activity boundary as plain data, never as a class
// instance, so a shape check (not instanceof) is the only way to recognize one.
function isHumanTask(value: NodeResult): value is HumanTask {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    return false;
  }
  return (
    typeof value.instructions === 'string' &&
    Array.isArray(value.resultRequiredKeys) &&
    value.payload !== null &&
    typeof value.payload === 'object' &&
    !Array.isArray(value.payload)
  );
}

function schedulingWorkflow(): { workflowId: string; runId: string } {
  const execution = activityInfo().workflowExecution;
  if (execution === undefined) {
    throw ApplicationFailure.nonRetryable('activity was not scheduled by a workflow');
  }
  return execution;
}

// Build the HumanTask (question) from the node body; the DB connection is closed before the
// caller talks to Temporal.
async function buildTaskInput(deps: ActivityDeps, req: NodeRequest): Promise<TaskInput> {
  const conn = connect(deps.dbPath);
  try {
    const registered = deps.registry.nodeForWorkflow(req.workflow_id, req.node_id);
    const loader: PayloadLoader = async (artifactId) => readArtifactPayload(conn, deps.storageRoot, artifactId);
    const args = decodeArgs(req.args_transport, loader);
    let task: NodeResult;
    try {
      task = await registered.run(args);
    } catch (e) {
      // A crashing question-builder is deterministic: fail the run visibly instead of retrying forever.
      throw ApplicationFailure.create({
        message: `human node ${registered.nodeId} failed building its task: ${errorMessage(e)}`,
        type: 'NodeError',
        nonRetryable: true,
      });
    }
    if (!isHumanTask(task)) {
      throw ApplicationFailure.nonRetryable(`human node ${registered.nodeId} must return a HumanTask`);
    }
    return {
      engagement_id: req.engagement_id,
      workflow_id: req.workflow_id,
      node_id: req.node_id,
      memo_key: req.memo_key,
      output_nodeparamslot: registered.outputNodeparamslot,
      display_name: registered.displayName,
      instructions: task.instructions,
      payload: encodePayloadValue(task.payload),
      result_required_keys: task.resultRequiredKeys,
      requested_by_workflow_run: req.workflow_run_id,
      input_artifact_ids: req.input_artifact_ids,
    };
  } finally {
    conn.close();
  }
}

// The returned object IS the worker registration payload; keys are the wire activity names.
export function createActivities(deps: ActivityDeps) {
  return {
    async memo_lookup(engagementId: number, memoKey: string): Promise<ArtifactRef | null> {
      const conn = connect(deps.dbPath);
      try {
        return memoLookup(conn, engagementId, memoKey);
      } finally {
        conn.close();
      }
    },

    async attach_artifact(workflowRunId: number, artifactId: number): Promise<void> {
      const conn = connect(deps.dbPath);
      try {
        attach(conn, workflowRunId, artifactId, { source: 'engine', createdBy: 'engine' });
      } finally {
        conn.close();
      }
    },

    async run_engine_node(req: NodeRequest): Promise<{ ref: ArtifactRef; fresh: boolean }> {
      const conn = connect(deps.dbPath);
      try {
        // Idempotency on activity retry: the completion may already be filed (no attach here —
        // Ctx attaches on non-fresh).
        const existing = memoLookup(conn, req.engagement_id, req.memo_key);
        if (existing !== null) {
          return { ref: existing, fresh: false };
        }
        const registered = deps.registry.nodeForWorkflow(req.workflow_id, req.node_id);
        const loader: PayloadLoader = async (artifactId) => readArtifactPayload(conn, deps.storageRoot, artifactId);
        const args = decodeArgs(req.args_transport, loader);
        // Node-body exceptions propagate as ordinary (retryable) activity failures — the
        // 5-attempt policy absorbs transients; authors throw type 'NodeError' for bad inputs.
        const result = await registered.run(args);
        let output: { payload: Uint8Array; mediaType: string };
        try {
          output = toOutputBytes(result);
        } catch (e) {
          throw ApplicationFailure.create({
            message: `node ${registered.nodeId} produced a non-canonical payload: ${errorMessage(e)}`,
            type: 'NodeError',
            nonRetryable: true,
          });
        }
        const execution = schedulingWorkflow();
        const temporalId = `${execution.workflowId}/${execution.runId}/${activityInfo().activityId}`;
        return recordCompletion(conn, deps.storageRoot, {
          engagementId: req.engagement_id,
          workflowRunId: req.workflow_run_id,
          workflowId: req.workflow_id,
          nodeId: req.node_id,
          memoKey: req.memo_key,
          outputNodeparamslot: registered.outputNodeparamslot,
          payload: output.payload,
          mediaType: output.mediaType,
          createdBy: 'engine',
          temporalId,
          inputArtifactIds: req.input_artifact_ids,
        });
      } finally {
        conn.close();
      }
    },

    async ensure_human_task(req: NodeRequest): Promise<string> {
      const taskInput = await buildTaskInput(deps, req);
      const taskWfId = humanTaskWorkflowId(deps.instance, req.engagement_id, req.memo_key);
      // No exception handling on purpose: with USE_EXISTING an existing or completed task never
      // raises — a start after completion spawns a run that self-completes via its first-step
      // memo check. Anything that DOES raise is a genuine failure and must surface so the
      // activity retries instead of leaving the requester polling for a task never created.
      await deps.client.workflow.start(HUMAN_TASK_WORKFLOW_TYPE, {
        args: [taskInput],
        workflowId: taskWfId,
        taskQueue: deps.taskQueue,
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
      return taskWfId;
    },

    async record_human_completion(
      taskInput: TaskInput,
      result: Record<string, JsonValue>,
      reviewer: string
    ): Promise<ArtifactRef> {
      let payload: Uint8Array;
      try {
        // Deterministic — retrying cannot help; the submit validator rejects this earlier
        // (belt-and-braces).
        payload = canonicalBytes(result);
      } catch (e) {
        throw ApplicationFailure.nonRetryable(`submission is not canonicalizable: ${errorMessage(e)}`);
      }
      const execution = schedulingWorkflow();
      // Two segments only, no activity_id (unlike run_engine_node).
      const temporalId = `${execution.workflowId}/${execution.runId}`;
      const conn = connect(deps.dbPath);
      try {
        const completion = recordCompletion(conn, deps.storageRoot, {
          engagementId: taskInput.engagement_id,
          workflowRunId: taskInput.requested_by_workflow_run,
          workflowId: taskInput.workflow_id,
          nodeId: taskInput.node_id,
          memoKey: taskInput.memo_key,
          outputNodeparamslot: taskInput.output_nodeparamslot,
          payload,
          mediaType: 'application/json',
          createdBy: reviewer,
          temporalId,
          inputArtifactIds: taskInput.input_artifact_ids,
        });
        return completion.ref;
      } finally {
        conn.close();
      }
    },
  };
}

export type Acts = ReturnType<typeof createActivities>;
