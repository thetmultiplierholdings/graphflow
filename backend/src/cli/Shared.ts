import type { Client } from '@temporalio/client';
import type { Registry } from '../domain/registry/Registry.js';
import { buildRegistry } from '../domain/registry/Registry.js';
import { CODE_HASHES } from '../generated/CodeHashes.js';
import { connect, initDb, publishCatalog } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import type { Summary } from '../temporal/Context.js';
import { startWorkspace } from '../temporal/Runtime.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';

export const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// The demo/seed summaries print node-id lists as ['a', 'b'] (single-quoted, comma-space separated).
export const quotedList = (items: readonly string[]): string => `[${items.map((i) => `'${i}'`).join(', ')}]`;

export function buildCliRegistry(): Registry {
  return buildRegistry(ALL_WORKFLOWS, CODE_HASHES);
}

export function publish(env: Env): void {
  const registry = buildCliRegistry();
  const conn = connect(env.dbPath);
  try {
    for (const line of publishCatalog(conn, registry, env.temporalTaskQueue)) {
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

// CLI path of execute_workspace: start (or attach to) the run and await its Ctx summary.
export async function executeWorkspace(client: Client, dbPath: string, workflowRunId: number): Promise<Summary> {
  const handle = await startWorkspace(client, dbPath, workflowRunId, false);
  const summary: Summary = await handle.result();
  return summary;
}
