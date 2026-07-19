import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@temporalio/client';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { assertPrincipal } from '../domain/principal/Principal.js';
import { connect, readArtifactPayload } from '../infrastructure/db/Db.js';
import { HUMAN_TASK_WORKFLOW_TYPE, humanTaskIdPrefix } from '../temporal/Ids.js';
import type { TaskInfo } from '../temporal/Workflows.js';
import { submitUpdate, taskInfoQuery } from '../temporal/Workflows.js';
import { out } from './Shared.js';

// The human-task inbox is Temporal visibility (no db table): list Running GraphflowHumanTask
// workflows on the shared queue, filter by this db's instance prefix, confirm via the task_info
// query (visibility is eventually consistent — completed tasks can linger as Running).

const humanTaskListQuery = (taskQueue: string): string =>
  `TaskQueue = '${taskQueue}' AND WorkflowType = '${HUMAN_TASK_WORKFLOW_TYPE}' AND ExecutionStatus = 'Running'`;

export interface OpenTask {
  workflowId: string;
  info: TaskInfo;
}

export async function listOpenHumanTasks(client: Client, taskQueue: string, instance: string): Promise<OpenTask[]> {
  const prefix = humanTaskIdPrefix(instance);
  const ids: string[] = [];
  for await (const wf of client.workflow.list({ query: humanTaskListQuery(taskQueue) })) {
    if (wf.workflowId.startsWith(prefix)) {
      ids.push(wf.workflowId);
    }
  }
  const tasks = await Promise.all(
    ids.map(async (id): Promise<OpenTask | null> => {
      try {
        // 5s deadline: an unhealthy query path must not stall the whole sweep (see api/Deps.ts).
        const info = await client.connection.withDeadline(Date.now() + 5000, () =>
          client.workflow.getHandle(id).query(taskInfoQuery)
        );
        return info.open ? { workflowId: id, info } : null;
      } catch {
        return null; // raced to completion, or transient — drop from this sweep
      }
    })
  );
  return tasks.filter((t): t is OpenTask => t !== null);
}

// The one payload shape the auto-approver understands: verify_txns' {ocr: <artifact ref>}.
const ApprovalPayloadSchema = z.object({
  ocr: z.object({ __artifact__: z.object({ artifact_id: z.number().int() }) }),
});

// A 'reviewer' that opens the task payload, reads the OCR extraction from the local payload
// store, and approves it unchanged. Returns null when the payload has no ocr artifact ref.
export function buildApproval(
  conn: Database.Database,
  storageRoot: string,
  info: TaskInfo
): Record<string, JsonValue> | null {
  const parsed = ApprovalPayloadSchema.safeParse(info.payload);
  if (!parsed.success) {
    return null;
  }
  const raw = readArtifactPayload(conn, storageRoot, parsed.data.ocr.__artifact__.artifact_id);
  const ocr: JsonValue = JSON.parse(new TextDecoder().decode(raw));
  if (ocr === null || typeof ocr !== 'object' || Array.isArray(ocr)) {
    return null;
  }
  const transactions: JsonValue | undefined = ocr.transactions;
  if (transactions === undefined) {
    return null;
  }
  return { approved: true, transactions };
}

export interface AutoApprover {
  stop(): Promise<void>;
}

export interface AutoApproverOptions {
  client: Client;
  taskQueue: string;
  instance: string;
  dbPath: string;
  storageRoot: string;
  reviewer: string;
}

function approvalFor(opts: AutoApproverOptions, info: TaskInfo): Record<string, JsonValue> | null {
  const conn = connect(opts.dbPath);
  try {
    return buildApproval(conn, opts.storageRoot, info);
  } finally {
    conn.close();
  }
}

async function approveOpenTasks(opts: AutoApproverOptions, isStopped: () => boolean): Promise<void> {
  const tasks = await listOpenHumanTasks(opts.client, opts.taskQueue, opts.instance);
  for (const task of tasks) {
    if (isStopped()) {
      return;
    }
    try {
      const result = approvalFor(opts, task.info);
      if (result === null) {
        continue;
      }
      await opts.client.workflow
        .getHandle(task.workflowId)
        .executeUpdate(submitUpdate, { args: [{ reviewer: opts.reviewer, result }] });
      out(`  [HITL] auto-approved ${task.info.node_id} (task ...${task.workflowId.slice(-10)})`);
    } catch {
      // task raced to completion, or transient — next sweep
    }
  }
}

// The mock HITL: every ~2s sweep the inbox and submit an unchanged approval for each open verify
// task. Per-task and per-sweep errors are swallowed (races/transients — the next sweep retries).
export function startAutoApprover(opts: AutoApproverOptions): AutoApprover {
  // Tripwire before the loop starts: a bare-name reviewer would otherwise fail asynchronously,
  // task by task, inside the swallowed-error sweep.
  assertPrincipal(opts.reviewer);
  let stopped = false;
  let wake: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      try {
        await approveOpenTasks(opts, () => stopped);
      } catch {
        // transient visibility error — next sweep
      }
      await Promise.race([delay(2000), stopRequested]);
    }
  })();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      wake();
      await loop;
    },
  };
}
