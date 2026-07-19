import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@temporalio/client';
import type Database from 'better-sqlite3';
import { canonicalBytes } from '../domain/canonical/Canonical.js';
import {
  attach,
  connect,
  createEngagement,
  createWorkspace,
  getEngagement,
  instanceId,
  readArtifactPayload,
  renameArtifact,
  stats,
  supplyArtifact,
  workspaceArtifacts,
} from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { RuntimeError } from '../shared/errors/Errors.js';
import type { Summary } from '../temporal/Context.js';
import { HUMAN_TASK_WORKFLOW_TYPE, humanTaskIdPrefix, RUN_WORKFLOW_TYPE, runIdPrefix } from '../temporal/Ids.js';
import type { WorkerHandle } from '../temporal/Runtime.js';
import { connectClient, createWorker, startWorkspace } from '../temporal/Runtime.js';
import { Kind as V1Kind } from '../workflows/tax_demo_workflow/enums.js';
import { Kind as V2Kind } from '../workflows/tax_demo_workflow_v2/enums.js';
import type { AutoApprover } from './Inbox.js';
import { listOpenHumanTasks, startAutoApprover } from './Inbox.js';
import { buildCliRegistry, cmdInit, executeWorkspace, out, quotedList } from './Shared.js';

const BROKERAGE = ['morgan_stanley.txt', 'goldman_sachs.txt', 'fidelity.txt'];
const SLIPS = ['payslip_jan.txt', 'payslip_feb.txt', 'payslip_mar.txt'];
const EXTRA: readonly (readonly [string, string])[] = [
  ['extra_ubs.txt', V1Kind.BrokerageStatement],
  ['extra_payslip_apr.txt', V1Kind.PaymentSlip],
];

// Reads sample_docs cwd-relative; the CLI must run from backend/.
function supplyAndAttach(
  conn: Database.Database,
  storageRoot: string,
  engagementId: number,
  workflowRunId: number,
  filename: string,
  kind: string
): void {
  const data = readFileSync(join('sample_docs', filename));
  const ref = supplyArtifact(conn, storageRoot, engagementId, kind, data, {
    label: filename.replaceAll('.txt', ''),
    createdBy: 'user:demo-user',
  });
  attach(conn, workflowRunId, ref.artifact_id, { source: 'user', createdBy: 'user:demo-user' });
  out(`  [upload] ${filename} -> ${kind} artifact#${ref.artifact_id} (${ref.hash.slice(0, 10)})`);
}

function printSummary(tag: string, summary: Summary): void {
  const pad = (n: number): string => String(n).padStart(2);
  out(`\n  [${tag}] run finished:`);
  out(`    node bodies EXECUTED : ${pad(summary.executed.length)}  ${quotedList(summary.executed)}`);
  out(`    memo HITS            : ${pad(summary.memo_hits.length)}  ${quotedList(summary.memo_hits)}`);
  out(`    human questions asked: ${pad(summary.human_waits.length)}  ${quotedList(summary.human_waits)}`);
}

function printReport(conn: Database.Database, storageRoot: string, workflowRunId: number, tag: string): void {
  const reports = workspaceArtifacts(conn, workflowRunId).filter((a) => a.kind === V1Kind.FinalReport);
  const latest = reports.at(-1);
  if (latest === undefined) {
    out(`  [${tag}] no final_report artifact in workspace`);
    return;
  }
  const text = new TextDecoder().decode(readArtifactPayload(conn, storageRoot, latest.artifact_id));
  out(`\n  [${tag}] final report (artifact#${latest.artifact_id}, label=${latest.label}):\n`);
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop(); // drop the trailing empty segment from the final newline
  }
  out(`  ${lines.join('\n  ')}`);
}

async function shutdownWorker(handle: WorkerHandle, run: Promise<void>): Promise<void> {
  try {
    handle.worker.shutdown();
  } catch {
    // already draining or stopped
  }
  await run;
  await handle.close();
}

// ---------- demo: the end-to-end acceptance story against real Temporal ----------

export async function cmdDemo(env: Env): Promise<void> {
  cmdInit(env);
  const client = await connectClient(env);
  out(`  [temporal] connected (task queue: ${env.temporalTaskQueue})`);

  const conn = connect(env.dbPath);
  const instance = instanceId(conn);
  const worker = await createWorker(env, client, env.dbPath, env.storageRoot, instance, buildCliRegistry());
  const workerRun = worker.worker.run();
  const approver = startAutoApprover({
    client,
    taskQueue: env.temporalTaskQueue,
    instance,
    dbPath: env.dbPath,
    storageRoot: env.storageRoot,
    reviewer: 'agent:auto-approver',
  });

  try {
    const eng = createEngagement(conn, `acme-demo-${instance}`, { createdBy: 'user:demo-user' });
    out(`\n== SCENARIO 1: January from scratch (engagement ${eng}) ==`);
    const jan = createWorkspace(conn, eng, 'tax_demo_workflow', 'January estimate', { createdBy: 'user:demo-user' });
    for (const f of BROKERAGE) {
      supplyAndAttach(conn, env.storageRoot, eng, jan, f, V1Kind.BrokerageStatement);
    }
    for (const f of SLIPS) {
      supplyAndAttach(conn, env.storageRoot, eng, jan, f, V1Kind.PaymentSlip);
    }
    const summary = await executeWorkspace(client, env.dbPath, jan, env.temporalTaskQueue);
    printSummary('January #1', summary);
    printReport(conn, env.storageRoot, jan, 'January');

    out('\n== SCENARIO 2: run January AGAIN (everything memo-hits) ==');
    const summary2 = await executeWorkspace(client, env.dbPath, jan, env.temporalTaskQueue);
    printSummary('January #2', summary2);
    if (summary2.executed.length !== 0) {
      throw new RuntimeError('re-run must execute zero node bodies');
    }
    out('    -> zero node bodies executed, zero humans disturbed. The memo held.');

    out('\n== SCENARIO 3: February = copy of January + 2 new documents ==');
    const feb = createWorkspace(conn, eng, 'tax_demo_workflow', 'February estimate', {
      createdBy: 'user:demo-user',
      copiedFrom: jan,
    });
    for (const [f, kind] of EXTRA) {
      supplyAndAttach(conn, env.storageRoot, eng, feb, f, kind);
    }
    const summary3 = await executeWorkspace(client, env.dbPath, feb, env.temporalTaskQueue);
    printSummary('February', summary3);
    printReport(conn, env.storageRoot, feb, 'February');

    const s = stats(conn, eng);
    out(
      `\n  [ledger] engagement ${eng}: ${s.node_runs} node_runs (${s.human_answers} human answers), ` +
        `${s.artifacts} artifacts, ${s.workspaces} workspaces`
    );
    out('  [done] demo complete.');
  } finally {
    await approver.stop();
    await shutdownWorker(worker, workerRun);
    conn.close();
    await client.connection.close();
  }
}

// ---------- seed: the demo dataset the frontend e2e suite depends on ----------

// Terminate any open Temporal workflows carrying the OLD instance prefix so orphaned runs don't
// linger in the shared namespace forever. Scoped by WORKFLOW TYPE + instance-id prefix, never by
// TaskQueue: the old runs live on whatever queue was configured when they STARTED, so a
// TEMPORAL_TASK_QUEUE rename between resets would hide them from a queue-scoped sweep (which is
// exactly how three runs got stranded on 2026-07-20).
async function terminateStaleRuns(client: Client, oldInstance: string): Promise<void> {
  const prefixes = [runIdPrefix(oldInstance), humanTaskIdPrefix(oldInstance)];
  try {
    for await (const wf of client.workflow.list({
      query: `WorkflowType IN ('${RUN_WORKFLOW_TYPE}', '${HUMAN_TASK_WORKFLOW_TYPE}') AND ExecutionStatus = 'Running'`,
    })) {
      if (!prefixes.some((p) => wf.workflowId.startsWith(p))) {
        continue;
      }
      try {
        await client.workflow.getHandle(wf.workflowId).terminate('graphflow seed --fresh');
        out(`  [fresh] terminated ${wf.workflowId}`);
      } catch {
        // already closed, or racing — ignore
      }
    }
  } catch {
    // visibility sweep failed — nothing to terminate
  }
}

// --fresh teardown: terminate the old instance's open runs FIRST (needs the old instance_id from
// the db), THEN delete the db (+wal/+shm) and the payload store.
async function freshTeardown(client: Client, env: Env): Promise<void> {
  if (!existsSync(env.dbPath)) {
    return;
  }
  let oldInstance: string | null = null;
  try {
    const old = connect(env.dbPath);
    try {
      oldInstance = instanceId(old);
    } finally {
      old.close();
    }
  } catch {
    // unreadable db — nothing to terminate
  }
  if (oldInstance !== null) {
    await terminateStaleRuns(client, oldInstance);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${env.dbPath}${suffix}`, { force: true });
  }
  rmSync(env.storageRoot, { recursive: true, force: true });
  out(`  [fresh] deleted ${env.dbPath} and ${env.storageRoot}/`);
}

// Wait for the run's verify tasks to open (visibility is eventually consistent — completed tasks
// can linger as Running, so each candidate is confirmed via task_info: genuinely open AND
// belonging to the given engagement). Polls every 2s up to a 180s deadline.
async function waitForOpenVerifyTasks(
  client: Client,
  env: Env,
  instance: string,
  engagementId: number
): Promise<string[]> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const open = await listOpenHumanTasks(client, env.temporalTaskQueue, instance);
    const ids = open.filter((t) => t.info.engagement_id === engagementId).map((t) => t.workflowId);
    if (ids.length >= 2) {
      return ids;
    }
    await delay(2000);
  }
  throw new RuntimeError("timed out waiting for Blue Harbour's verify tasks to open");
}

function printSeedTotals(conn: Database.Database, engagementIds: readonly number[], openTaskCount: number): void {
  out('\n  [seed] done:');
  for (const engId of engagementIds) {
    const e = getEngagement(conn, engId);
    const s = stats(conn, engId);
    out(
      `    ${e.label}: ${s.workspaces} workspaces, ${s.artifacts} artifacts, ` +
        `${s.node_runs} node_runs (${s.human_answers} human answers)`
    );
  }
  out(`    open human tasks (Blue Harbour, durable in Temporal): ${openTaskCount}`);
}

export async function cmdSeed(env: Env, fresh: boolean): Promise<void> {
  const client = await connectClient(env);
  out(`  [temporal] connected (task queue: ${env.temporalTaskQueue})`);
  try {
    if (fresh) {
      await freshTeardown(client, env);
    }

    cmdInit(env);
    const conn = connect(env.dbPath);
    const instance = instanceId(conn);
    const worker = await createWorker(env, client, env.dbPath, env.storageRoot, instance, buildCliRegistry());
    const workerRun = worker.worker.run();
    let approver: AutoApprover | null = startAutoApprover({
      client,
      taskQueue: env.temporalTaskQueue,
      instance,
      dbPath: env.dbPath,
      storageRoot: env.storageRoot,
      reviewer: 'user:Priya Sharma',
    });

    try {
      // -- Acme: January executed to completion (Priya approves the six verifies)
      const acme = createEngagement(conn, 'Acme Ltd — UK Tax FY 2025/26', { createdBy: 'user:thet' });
      out(`\n  [seed] engagement ${acme}: Acme Ltd — UK Tax FY 2025/26`);
      const jan = createWorkspace(conn, acme, 'tax_demo_workflow', 'January estimate', { createdBy: 'user:thet' });
      for (const f of BROKERAGE) {
        supplyAndAttach(conn, env.storageRoot, acme, jan, f, V1Kind.BrokerageStatement);
      }
      for (const f of SLIPS) {
        supplyAndAttach(conn, env.storageRoot, acme, jan, f, V1Kind.PaymentSlip);
      }
      const summary = await executeWorkspace(client, env.dbPath, jan, env.temporalTaskQueue);
      printSummary('seed/January', summary);

      const reports = workspaceArtifacts(conn, jan).filter((a) => a.kind === V1Kind.FinalReport);
      const lastReport = reports.at(-1);
      if (lastReport !== undefined) {
        renameArtifact(conn, lastReport.artifact_id, 'January estimate — sent to client', 'user:thet');
        out("  [seed] renamed final report -> 'January estimate — sent to client'");
      }

      // -- Acme: February = copy of January + 2 extra docs, NOT executed
      const feb = createWorkspace(conn, acme, 'tax_demo_workflow', 'February estimate', {
        createdBy: 'user:thet',
        copiedFrom: jan,
      });
      for (const [f, kind] of EXTRA) {
        supplyAndAttach(conn, env.storageRoot, acme, feb, f, kind);
      }
      out(`  [seed] workspace ${feb} 'February estimate' staged (not executed)`);

      // Auto-approver OFF from here: Blue Harbour's verify tasks must stay open.
      await approver.stop();
      approver = null;

      // -- Blue Harbour: run started, left waiting on its 2 verify tasks
      const bh = createEngagement(conn, 'Blue Harbour LLP — UK Tax FY 2025/26', { createdBy: 'user:thet' });
      out(`\n  [seed] engagement ${bh}: Blue Harbour LLP — UK Tax FY 2025/26`);
      const q1 = createWorkspace(conn, bh, 'tax_demo_workflow_v2', 'Q1 estimate', { createdBy: 'user:thet' });
      supplyAndAttach(conn, env.storageRoot, bh, q1, 'bh_schwab.txt', V2Kind.BrokerageStatement);
      supplyAndAttach(conn, env.storageRoot, bh, q1, 'bh_payslip_feb.txt', V2Kind.PaymentSlip);
      // The questionnaire channel: answers are canonical JSON so a re-answered identical form
      // converges on the same artifact (the API route canonicalizes via canonical_json=true; the
      // seed canonicalizes directly).
      const residency = supplyArtifact(
        conn,
        env.storageRoot,
        bh,
        V2Kind.ResidencyAnswers,
        canonicalBytes({ country: 'SG' }),
        { label: 'residency-questionnaire', mediaType: 'application/json', createdBy: 'user:thet' }
      );
      attach(conn, q1, residency.artifact_id, { source: 'user', createdBy: 'user:thet' });
      out(`  [upload] residency questionnaire -> ${V2Kind.ResidencyAnswers} artifact#${residency.artifact_id}`);
      const handle = await startWorkspace(client, env.dbPath, q1, env.temporalTaskQueue, false);
      out(`  [seed] started ${handle.workflowId} — leaving it waiting on human review`);

      const openTaskIds = await waitForOpenVerifyTasks(client, env, instance, bh);

      // -- summary (labels + counts, no secrets)
      printSeedTotals(conn, [acme, bh], openTaskIds.length);
    } finally {
      if (approver !== null) {
        await approver.stop();
      }
      await shutdownWorker(worker, workerRun);
      conn.close();
    }
  } finally {
    await client.connection.close();
  }
}
