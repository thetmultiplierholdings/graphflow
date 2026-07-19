import type { Client } from '@temporalio/client';
import { WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import type Database from 'better-sqlite3';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import type { Registry } from '../domain/registry/Registry.js';
import type { Env } from '../infrastructure/env/Env.js';
import { NotFoundError, ValidationError } from '../shared/errors/Errors.js';
import { HUMAN_TASK_WORKFLOW_TYPE, runWorkflowId } from '../temporal/Ids.js';
import { startWorkspace } from '../temporal/Runtime.js';

// Status derived from Temporal describe (never stored). null from describeRun = NOT_FOUND = never executed.
export type DerivedRunStatus = 'running' | 'completed' | 'failed';

// Cumulative snapshot from the 'progress' workflow query; a failed query yields {} upstream.
export interface ProgressSnapshot {
  executed?: string[];
  memo_hits?: string[];
  human_waits?: string[];
}

// The 'task_info' workflow query result: open flag + the TaskInput fields (wire snake_case).
export interface TaskInfo {
  open: boolean;
  engagement_id: number;
  workflow_id: string;
  node_id: string;
  memo_key: string;
  output_kind: string;
  display_name: string;
  instructions: string;
  payload: Record<string, JsonValue>;
  result_required_keys: string[];
  requested_by_workflow_run: number;
  input_artifact_ids: number[];
}

export interface TaskWorkflowExecution {
  workflowId: string;
  startTime: string | null;
}

export interface Submission {
  reviewer: string;
  result: Record<string, JsonValue>;
}

// The NARROW Temporal surface the routes need — implemented by createTemporalGateway over the real
// Client; ApiCrud tests inject a stub.
export interface TemporalGateway {
  describeRun(temporalWorkflowId: string): Promise<DerivedRunStatus | null>;
  failureMessage(temporalWorkflowId: string): Promise<string>;
  queryProgress(temporalWorkflowId: string): Promise<ProgressSnapshot>;
  queryTaskInfo(taskWorkflowId: string): Promise<TaskInfo>;
  listTaskWorkflows(): Promise<TaskWorkflowExecution[]>;
  // Starts (or attaches to) the workspace run; resolves to the temporal workflow id. Throws
  // RuntimeError with context.code === 'SNAPSHOT_CHANGED' when a run is open on a stale snapshot.
  startWorkspace(workflowRunId: number, supersede: boolean): Promise<string>;
  // Synchronous workflow update; validator rejections surface as ValidationError (route → 422),
  // unknown/completed tasks as NotFoundError (route → 404).
  executeSubmit(taskWorkflowId: string, submission: Submission): Promise<ArtifactRef>;
}

export interface ApiDeps {
  connect(): Database.Database;
  env: Env;
  temporal: TemporalGateway;
  registry: Registry;
  instance: string;
  storageRoot: string;
  dbPath: string;
}

// Per-request connection scope: open, use synchronously, close — no connection outlives a handler.
export function withConn<T>(deps: ApiDeps, fn: (conn: Database.Database) => T): T {
  const conn = deps.connect();
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

const STATUS_MAP: Readonly<Record<string, DerivedRunStatus>> = {
  RUNNING: 'running',
  CONTINUED_AS_NEW: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TERMINATED: 'failed',
  CANCELLED: 'failed',
  TIMED_OUT: 'failed',
};

// Structural view of the proto history event — only the terminal attributes the mapper reads.
interface TerminalEventLike {
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string | null } | null } | null;
  workflowExecutionTerminatedEventAttributes?: { reason?: string | null } | null;
  workflowExecutionTimedOutEventAttributes?: object | null;
  workflowExecutionCanceledEventAttributes?: object | null;
}

const terminalEventMessage = (ev: TerminalEventLike): string | null => {
  if (ev.workflowExecutionFailedEventAttributes) {
    return ev.workflowExecutionFailedEventAttributes.failure?.message ?? 'run failed';
  }
  if (ev.workflowExecutionTerminatedEventAttributes) {
    const reason = ev.workflowExecutionTerminatedEventAttributes.reason;
    return reason ? `run terminated: ${reason}` : 'run terminated';
  }
  if (ev.workflowExecutionTimedOutEventAttributes) {
    return 'run timed out';
  }
  if (ev.workflowExecutionCanceledEventAttributes) {
    return 'run canceled';
  }
  return null;
};

export interface TemporalGatewayOptions {
  client: Client;
  env: Env;
  dbPath: string;
  instance: string;
}

export function createTemporalGateway(opts: TemporalGatewayOptions): TemporalGateway {
  const { client, env, dbPath, instance } = opts;
  return {
    async describeRun(temporalWorkflowId: string): Promise<DerivedRunStatus | null> {
      try {
        const desc = await client.workflow.getHandle(temporalWorkflowId).describe();
        return STATUS_MAP[desc.status.name] ?? 'running';
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) {
          return null;
        }
        throw e;
      }
    },

    // Newest terminal history event wins; any trouble reading history → generic 'run failed'.
    async failureMessage(temporalWorkflowId: string): Promise<string> {
      try {
        const history = await client.workflow.getHandle(temporalWorkflowId).fetchHistory();
        const events = history.events ?? [];
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const message = terminalEventMessage(events[i]);
          if (message !== null) {
            return message;
          }
        }
        return 'run failed';
      } catch {
        return 'run failed';
      }
    },

    async queryProgress(temporalWorkflowId: string): Promise<ProgressSnapshot> {
      return await client.workflow.getHandle(temporalWorkflowId).query<ProgressSnapshot, []>('progress');
    },

    async queryTaskInfo(taskWorkflowId: string): Promise<TaskInfo> {
      // Bounded deadline: a workflow whose query path is unhealthy (e.g. stickiness pinned to a
      // dead worker after a restart) must cost the inbox 5s, not the default 30s gRPC deadline —
      // the route drops per-task failures, and slow drops make pollers pile up.
      return await client.connection.withDeadline(Date.now() + 5000, () =>
        client.workflow.getHandle(taskWorkflowId).query<TaskInfo, []>('task_info')
      );
    },

    async listTaskWorkflows(): Promise<TaskWorkflowExecution[]> {
      const query = `TaskQueue = '${env.temporalTaskQueue}' AND WorkflowType = '${HUMAN_TASK_WORKFLOW_TYPE}' AND ExecutionStatus = 'Running'`;
      const out: TaskWorkflowExecution[] = [];
      for await (const wf of client.workflow.list({ query })) {
        const startTime: Date | undefined = wf.startTime;
        out.push({ workflowId: wf.workflowId, startTime: startTime === undefined ? null : startTime.toISOString() });
      }
      return out;
    },

    async startWorkspace(workflowRunId: number, supersede: boolean): Promise<string> {
      await startWorkspace(client, dbPath, workflowRunId, env.temporalTaskQueue, supersede);
      return runWorkflowId(instance, workflowRunId);
    },

    async executeSubmit(taskWorkflowId: string, submission: Submission): Promise<ArtifactRef> {
      try {
        return await client.workflow
          .getHandle(taskWorkflowId)
          .executeUpdate<ArtifactRef, [Submission]>('submit', { args: [submission] });
      } catch (e) {
        if (e instanceof WorkflowUpdateFailedError) {
          // The reviewer-facing validator message lives on the cause (ApplicationFailure).
          throw new ValidationError(e.cause instanceof Error ? e.cause.message : e.message);
        }
        if (e instanceof WorkflowNotFoundError) {
          throw new NotFoundError('task not found or already completed');
        }
        throw e;
      }
    },
  };
}
