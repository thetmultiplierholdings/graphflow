import { writeFileSync } from 'node:fs';
import {
  connect,
  getWorkflowRun,
  initDb,
  instanceId,
  readArtifactPayload,
  workflowRunArtifacts,
} from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { loadEnv } from '../infrastructure/env/Env.js';
import { errorMessage, ValidationError } from '../shared/errors/Errors.js';
import { adoptOpenWorkflows, connectClient, createWorker } from '../temporal/Runtime.js';
import { submitUpdate, taskInfoQuery } from '../temporal/Workflows.js';
import { buildApproval, listOpenHumanTasks } from './Inbox.js';
import { cmdDemo, cmdSeed } from './Seed.js';
import { buildCliRegistry, cmdInit, out, publish } from './Shared.js';

const USAGE = `usage: graphflow <command> [args]

commands:
  init                                create db + publish catalog
  worker                              run the Temporal worker
  demo                                run the end-to-end demo
  seed [--fresh]                      seed the demo dataset (Acme + Blue Harbour)
  tasks                               list open human tasks
  submit <task_id> [--reviewer NAME]  approve a human task (recorded as principal 'user:NAME')
  show <workflow_run_id>              show a workflow run's artifacts
  download <artifact_id> <out>        download an artifact payload
`;

async function cmdWorker(env: Env): Promise<void> {
  const instance = initDb(env.dbPath);
  publish(env);
  const client = await connectClient(env);
  const handle = await createWorker(env, client, env.dbPath, env.storageRoot, instance, buildCliRegistry());
  out(`  [worker] running on task queue '${env.temporalTaskQueue}' (Ctrl+C to stop)`);
  try {
    const run = handle.worker.run(); // resolves after the SDK's default SIGINT/SIGTERM shutdown drains the worker
    const adopted = await adoptOpenWorkflows(client, env, instance);
    if (adopted > 0) {
      out(`  [worker] adopted ${adopted} open workflow(s) from previous worker`);
    }
    await run;
  } finally {
    await handle.close();
    await client.connection.close();
  }
}

async function cmdTasks(env: Env): Promise<void> {
  const client = await connectClient(env);
  try {
    const conn = connect(env.dbPath);
    let instance: string;
    try {
      instance = instanceId(conn);
    } finally {
      conn.close();
    }
    const tasks = await listOpenHumanTasks(client, env.temporalTaskQueue, instance);
    tasks.forEach((task, i) => {
      out(`  [${i + 1}] ${task.workflowId}`);
      out(`      node: ${task.info.node_id}  (${task.info.display_name})`);
      out(`      instructions: ${task.info.instructions}`);
    });
    if (tasks.length === 0) {
      out('  no open human tasks');
    }
  } finally {
    await client.connection.close();
  }
}

async function cmdSubmit(env: Env, taskId: string, reviewer: string): Promise<void> {
  const client = await connectClient(env);
  try {
    const handle = client.workflow.getHandle(taskId);
    const info = await handle.query(taskInfoQuery);
    const conn = connect(env.dbPath);
    let result: ReturnType<typeof buildApproval>;
    try {
      result = buildApproval(conn, env.storageRoot, info);
    } finally {
      conn.close();
    }
    if (result === null) {
      out('  cannot build an auto-approval for this task payload');
      return;
    }
    // Wrap the WHOLE flag value (default included): the submit validator rejects bare names, and
    // a bare name slipping through would spin the completion activity in a retry loop.
    const ref = await handle.executeUpdate(submitUpdate, { args: [{ reviewer: `user:${reviewer}`, result }] });
    out(`  submitted; answer artifact#${ref.artifact_id}`);
  } finally {
    await client.connection.close();
  }
}

function cmdShow(env: Env, workflowRunId: number): void {
  const conn = connect(env.dbPath);
  try {
    const run = getWorkflowRun(conn, workflowRunId);
    out(
      `  workflow run ${run.workflow_run_id}: ${run.lineage_display} (${run.workflow_id}, engagement ${run.engagement_id})`
    );
    for (const a of workflowRunArtifacts(conn, workflowRunId)) {
      out(
        `    #${String(a.artifact_id).padEnd(4)} ${a.nodeparamslot.padEnd(20)} [${a.source}/${a.origin}] ` +
          `${a.display_name ?? ''}  ${a.hash.slice(0, 10)}`
      );
    }
  } finally {
    conn.close();
  }
}

function cmdDownload(env: Env, artifactId: number, outPath: string): void {
  const conn = connect(env.dbPath);
  try {
    const data = readArtifactPayload(conn, env.storageRoot, artifactId);
    writeFileSync(outPath, data);
    out(`  wrote ${data.length} bytes to ${outPath}`);
  } finally {
    conn.close();
  }
}

// ---------- argv parsing (manual dispatch, no CLI framework) ----------

function requireNoArgs(command: string, rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new ValidationError(`${command} takes no arguments`);
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new ValidationError(`missing required argument: ${name}`);
  }
  return value;
}

const INT_RE = /^-?\d+$/;

function intArg(value: string | undefined, name: string): number {
  const raw = requireArg(value, name);
  if (!INT_RE.test(raw)) {
    throw new ValidationError(`${name} must be an integer, got '${raw}'`);
  }
  return Number.parseInt(raw, 10);
}

function parseSeedArgs(rest: readonly string[]): boolean {
  let fresh = false;
  for (const arg of rest) {
    if (arg === '--fresh') {
      fresh = true;
    } else {
      throw new ValidationError(`unexpected argument: ${arg}`);
    }
  }
  return fresh;
}

function parseSubmitArgs(rest: readonly string[]): { taskId: string; reviewer: string } {
  let taskId: string | undefined;
  let reviewer = 'cli-reviewer';
  const args = [...rest];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) {
      break;
    }
    if (arg === '--reviewer') {
      reviewer = requireArg(args.shift(), '--reviewer');
    } else if (arg.startsWith('--reviewer=')) {
      reviewer = arg.slice('--reviewer='.length);
    } else if (taskId === undefined) {
      taskId = arg;
    } else {
      throw new ValidationError(`unexpected argument: ${arg}`);
    }
  }
  return { taskId: requireArg(taskId, 'task_id'), reviewer };
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const env = loadEnv();
  switch (command) {
    case 'init':
      requireNoArgs('init', rest);
      cmdInit(env);
      return;
    case 'worker':
      requireNoArgs('worker', rest);
      await cmdWorker(env);
      return;
    case 'demo':
      requireNoArgs('demo', rest);
      await cmdDemo(env);
      return;
    case 'seed':
      await cmdSeed(env, parseSeedArgs(rest));
      return;
    case 'tasks':
      requireNoArgs('tasks', rest);
      await cmdTasks(env);
      return;
    case 'submit': {
      const { taskId, reviewer } = parseSubmitArgs(rest);
      await cmdSubmit(env, taskId, reviewer);
      return;
    }
    case 'show':
      requireNoArgs('show', rest.slice(1));
      cmdShow(env, intArg(rest[0], 'workflow_run_id'));
      return;
    case 'download':
      requireNoArgs('download', rest.slice(2));
      cmdDownload(env, intArg(rest[0], 'artifact_id'), requireArg(rest[1], 'out'));
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      process.exitCode = 2;
      return;
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`error: ${errorMessage(e)}\n`);
  process.exitCode = 1;
}
