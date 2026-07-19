// Terminate every open Temporal workflow belonging to a scratch graphflow db.
//
// The Temporal namespace is SHARED: every workflow id carries the db instance prefix
// ('wfrun-{instance}-' / 'node-{instance}-'), so termination is scoped to exactly the given
// database's workflows and nothing else.
//
// Usage (with cwd = backend, so .env resolves there):
//   npx tsx scripts/cleanup-temporal.ts graphflow_e2e.sqlite3
// Called by the Playwright e2e suite (config-load cleanup + afterAll teardown).

import { setTimeout as delay } from 'node:timers/promises';
import { connect, instanceId } from '../src/infrastructure/db/Db.js';
import { loadEnv } from '../src/infrastructure/env/Env.js';
import { HUMAN_TASK_WORKFLOW_TYPE, humanTaskIdPrefix, RUN_WORKFLOW_TYPE, runIdPrefix } from '../src/temporal/Ids.js';
import { connectClient } from '../src/temporal/Runtime.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(dbPath: string): Promise<void> {
  const conn = connect(dbPath);
  let instance: string;
  try {
    instance = instanceId(conn);
  } finally {
    conn.close();
  }

  const env = loadEnv();
  const client = await connectClient(env);
  try {
    const prefixes = [runIdPrefix(instance), humanTaskIdPrefix(instance)];
    // Scoped by workflow TYPE + instance prefix, never by TaskQueue: stale runs sit on whatever
    // queue was configured when they started, so a queue rename would hide them from this sweep.
    const query = `WorkflowType IN ('${RUN_WORKFLOW_TYPE}', '${HUMAN_TASK_WORKFLOW_TYPE}') AND ExecutionStatus = 'Running'`;

    // Visibility is eventually consistent (a task workflow started moments ago may not be listed
    // yet), so sweep until a pass finds nothing.
    let terminated = 0;
    for (let sweep = 0; sweep < 4; sweep++) {
      if (sweep > 0) {
        await delay(2000);
      }
      let found = 0;
      for await (const wf of client.workflow.list({ query })) {
        if (!prefixes.some((p) => wf.workflowId.startsWith(p))) {
          continue;
        }
        found += 1;
        try {
          await client.workflow.getHandle(wf.workflowId).terminate('graphflow e2e cleanup');
          terminated += 1;
          out(`  [e2e-cleanup] terminated ${wf.workflowId}`);
        } catch {
          // already closed, or racing another cleanup — fine
        }
      }
      if (found === 0 && sweep > 0) {
        break;
      }
    }
    out(`  [e2e-cleanup] instance ${instance}: terminated ${terminated} open workflow(s)`);
  } finally {
    await client.connection.close();
  }
}

const dbPath = process.argv.at(2);
if (dbPath === undefined) {
  process.stderr.write('usage: cleanup-temporal.ts <db_path>\n');
  process.exit(2);
}
await main(dbPath);
