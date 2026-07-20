import { ApplicationFailure } from '@temporalio/common';
import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import { canonicalBytes } from '../domain/canonical/Canonical.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { isPrincipal } from '../domain/principal/Principal.js';
import { buildRegistry } from '../domain/registry/Registry.js';
import { errorMessage } from '../shared/errors/Errors.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import type { Acts } from './Activities.js';
import { Ctx, type RunInput, type Summary, type TransportValue } from './Context.js';

// Bundle entry. The exported function names ARE the Temporal workflow types: startWorkflowRun
// (Runtime.ts) starts 'GraphflowRun' via the RUN_WORKFLOW_TYPE constant and ensure_human_task
// starts 'GraphflowHumanTask' by string — the catalog stores no dispatch metadata.
//
// GraphflowRun        wfrun-{instance}-{workflow_run_id}: executes a registered workflow file over
//                     the user-attachment snapshot; the code IS the DAG.
// GraphflowHumanTask  node-{instance}-{engagement}-{memo_key}: one waiting task per distinct human
//                     question per engagement. First step re-checks the memo (self-completes if
//                     already answered). Submission is a workflow UPDATE with synchronous validation.

// Module scope: deterministic and pure; the manifest statically pulls every workflow version into
// the bundle, so the registry is identical in every process.
const REGISTRY = buildRegistry(ALL_WORKFLOWS);

const short = proxyActivities<Acts>({ startToCloseTimeout: '30s' });
const completion = proxyActivities<Acts>({ startToCloseTimeout: '60s' });

// TaskInput is GraphflowHumanTask's input AND the shape echoed by its task_info query.
export interface TaskInput {
  engagement_id: number;
  workflow_id: string;
  node_id: string;
  memo_key: string;
  output_nodeparamslot: string;
  display_name: string;
  instructions: string;
  payload: TransportValue;
  result_required_keys: string[];
  requested_by_workflow_run: number;
  input_artifact_ids: number[];
}

export type TaskInfo = { open: boolean } & TaskInput;

export interface Submission {
  reviewer?: string;
  result: Record<string, JsonValue>;
}

export const progressQuery = defineQuery<Summary | Record<string, never>>('progress');
export const taskInfoQuery = defineQuery<TaskInfo>('task_info');
export const submitUpdate = defineUpdate<ArtifactRef, [Submission]>('submit');

export async function GraphflowRun(inp: RunInput): Promise<Summary> {
  // Handlers registered before the first await (the @workflow.init guarantee): queries delivered
  // in the first workflow-task backlog see initialized state. (The old 'snapshot' query died with
  // the supersede machinery: the run row freezes at dispatch, so a snapshot can never drift under
  // an open execution.)
  let ctx: Ctx | undefined;
  setHandler(progressQuery, () => (ctx === undefined ? {} : ctx.summary()));

  const wd = REGISTRY.workflows.get(inp.workflow_id);
  if (wd === undefined) {
    throw ApplicationFailure.nonRetryable(
      `workflow '${inp.workflow_id}' is not registered on this worker (catalog/worker deploy order?)`
    );
  }
  // An empty snapshot is legal (all-optional workflows): per-nodeparamslot cardinality is enforced by the
  // ctx accessors, not a blanket guard.
  const runCtx = new Ctx(inp, REGISTRY);
  ctx = runCtx;
  await wd.run(runCtx);
  return runCtx.summary();
}

// Runs synchronously BEFORE the submit handler; a throw rejects the update, returning the error
// to the reviewer (the API maps it to a 422) while the task keeps waiting. An accepted answer is
// memoized forever, so malformed answers must be rejected here — never filed.
function validateSubmission(submission: Submission, inp: TaskInput): void {
  if (
    typeof submission !== 'object' ||
    submission === null ||
    Array.isArray(submission) ||
    typeof submission.result !== 'object' ||
    submission.result === null ||
    Array.isArray(submission.result)
  ) {
    throw ApplicationFailure.create({ message: "submission must be {'reviewer'?: principal, 'result': dict}" });
  }
  // The API route and CLI wrap reviewer names as 'user:<name>' before submitting; this check only
  // fires for out-of-contract direct Temporal clients. Rejecting here (synchronously, to the
  // submitter) is what keeps a bare name from reaching recordCompletion's assertPrincipal and
  // spinning the completion activity in a retry loop.
  if (submission.reviewer !== undefined && !isPrincipal(submission.reviewer)) {
    throw ApplicationFailure.create({
      message: `reviewer '${submission.reviewer}' is not a principal — expected '<type>[:<name>]' with type user|engine|system|agent`,
    });
  }
  // Own-property check — `in` would see Object.prototype names and validate vacuously.
  const missing = inp.result_required_keys.filter((k) => !Object.hasOwn(submission.result, k));
  if (missing.length > 0) {
    throw ApplicationFailure.create({
      message: `result is missing required keys: [${missing.map((k) => `'${k}'`).join(', ')}]`,
    });
  }
  try {
    // Floats etc. are rejected HERE, synchronously, to the reviewer.
    canonicalBytes(submission.result);
  } catch (e) {
    throw ApplicationFailure.create({ message: `result is not canonicalizable: ${errorMessage(e)}` });
  }
  const registered = REGISTRY.tryNodeForWorkflow(inp.workflow_id, inp.node_id);
  if (registered === undefined) {
    // Node no longer registered on this worker; required keys were still enforced above.
    return;
  }
  const validator = registered.resultValidator;
  if (validator === undefined) {
    return;
  }
  try {
    validator(submission.result);
  } catch (e) {
    throw ApplicationFailure.create({ message: `result rejected: ${errorMessage(e)}` });
  }
}

export async function GraphflowHumanTask(inp: TaskInput): Promise<ArtifactRef> {
  let ref: ArtifactRef | null = null;
  let done = false;

  setHandler(taskInfoQuery, () => ({ open: !done, ...inp }));
  setHandler(
    submitUpdate,
    async (submission: Submission): Promise<ArtifactRef> => {
      if (done) {
        // Idempotent re-submit: the answer is already filed.
        if (ref === null) {
          throw ApplicationFailure.nonRetryable('human task is done but holds no filed result');
        }
        return ref;
      }
      const filed = await completion.record_human_completion(inp, submission.result, submission.reviewer ?? 'user');
      ref = filed;
      done = true;
      return filed;
    },
    { validator: (submission: Submission): void => validateSubmission(submission, inp) }
  );

  // First step: the answer may already exist (start-after-completion race) — self-complete.
  const existing = await short.memo_lookup(inp.engagement_id, inp.memo_key);
  if (existing !== null) {
    ref = existing;
    done = true;
    // A legitimate submit may already be in flight (it saw open=true before our memo check
    // landed): let it finish so the reviewer gets a response instead of a workflow-completed error.
    await condition(allHandlersFinished);
    return existing;
  }
  await condition(() => done);
  await condition(allHandlersFinished);
  if (ref === null) {
    throw ApplicationFailure.nonRetryable('human task closed without a filed result');
  }
  return ref;
}
