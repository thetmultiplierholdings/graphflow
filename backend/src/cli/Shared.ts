import type { Client } from '@temporalio/client';
import type { Registry } from '../domain/registry/Registry.js';
import { buildRegistry } from '../domain/registry/Registry.js';
import { connect, initDb, publishCatalog } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import type { Summary } from '../temporal/Context.js';
import { startWorkflowRun } from '../temporal/Runtime.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';

export const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// The demo/seed summaries print node-id lists as ['a', 'b'] (single-quoted, comma-space separated).
export const quotedList = (items: readonly string[]): string => `[${items.map((i) => `'${i}'`).join(', ')}]`;

export function buildCliRegistry(): Registry {
  return buildRegistry(ALL_WORKFLOWS);
}

export function publish(env: Env): void {
  const registry = buildCliRegistry();
  const conn = connect(env.dbPath);
  try {
    for (const line of publishCatalog(conn, registry)) {
      out(`  [catalog] ${line}`);
    }
  } finally {
    conn.close();
  }
}

export function cmdInit(env: Env): void {
  const instance = initDb(env.dbPath);
  out(`  [init] db=${env.dbPath} instance_id=${instance}`);
  publish(env);
}

// CLI execute path: start (or attach to) the run's execution and await its Ctx summary.
export async function executeWorkflowRun(
  client: Client,
  dbPath: string,
  workflowRunId: number,
  taskQueue: string
): Promise<Summary> {
  const handle = await startWorkflowRun(client, dbPath, workflowRunId, taskQueue);
  const summary: Summary = await handle.result();
  return summary;
}
