// Temporal coordination strings, shared by the runtime, activities, API routes, and CLI.
// Bundle-safe (no node:* imports). All workflow ids carry the instance prefix (random hex minted
// at init) because the namespace may be shared.

export const RUN_WORKFLOW_TYPE = 'GraphflowRun';
export const HUMAN_TASK_WORKFLOW_TYPE = 'GraphflowHumanTask';

export function runWorkflowId(instance: string, workflowRunId: number): string {
  return `wfrun-${instance}-${workflowRunId}`;
}

export function runIdPrefix(instance: string): string {
  return `wfrun-${instance}-`;
}

export function humanTaskWorkflowId(instance: string, engagementId: number, memoKey: string): string {
  return `node-${instance}-${engagementId}-${memoKey}`;
}

export function humanTaskIdPrefix(instance: string): string {
  return `node-${instance}-`;
}
