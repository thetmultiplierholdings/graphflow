import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import { afterAll, describe, expect, it } from 'vitest';
import { startAutoApprover } from '../cli/Inbox.js';
import { buildRegistry } from '../domain/registry/Registry.js';
import { connect, initDb, instanceId, publishCatalog } from '../infrastructure/db/Db.js';
import { parseEnv } from '../infrastructure/env/Env.js';
import { HUMAN_TASK_WORKFLOW_TYPE, humanTaskIdPrefix, RUN_WORKFLOW_TYPE, runIdPrefix } from '../temporal/Ids.js';
import { connectClient, createWorker } from '../temporal/Runtime.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import { parseScenario, runScenario } from './DemoScenario.js';

// The demo-scenario suite: every scenarioN_input.md under backend/demo_tests/ is executed
// against a scratch db + REAL Temporal (embedded worker, auto-approver answering verify tasks,
// a unique task queue per scenario) and its rendered outcome is compared byte-for-byte with
// scenarioN_output.md. This is the black-box e2e proxy without the frontend: the input file is
// the story a human reads, the output file is the db-derived truth a human reviews.
//
// Regenerate outputs after an intentional behavior change:
//   GRAPHFLOW_UPDATE_DEMOS=1 npm run test -- src/demo/DemoScenario.test.ts
// then READ THE DIFF — the whole point of the golden files is that behavior drift shows up as
// legible markdown, not as a stack trace.
//
// Known one-off flake mode (inherent to golden multisets over at-least-once activities): an
// activity retry AFTER its completion committed reports fresh:false, flipping one node from
// EXECUTED to memo HITS for that run only. A red run that differs from its golden by exactly
// such a flip is a transient — rerun before diagnosing.

// Load .env exactly like the app does (tolerate absence, shell wins) BEFORE the skip decision.
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const envFile = join(packageRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const DEMO_DIR = join(packageRoot, 'demo_tests');
const SAMPLE_DOCS = join(packageRoot, 'sample_docs');
const UPDATE = process.env.GRAPHFLOW_UPDATE_DEMOS === '1';
const SCENARIO_TIMEOUT_MS = 240_000;

const hasTemporal = process.env.TEMPORAL_API_KEY !== undefined && process.env.TEMPORAL_API_KEY !== '';

const scenarioInputs = existsSync(DEMO_DIR)
  ? readdirSync(DEMO_DIR)
      .filter((f) => /^scenario\d+_input\.md$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  : [];

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Best-effort teardown of anything a scenario left Running under its scratch instance (a failed
// scenario can strand a parked run or a waiting verify task in the shared namespace). Accepted
// residual: if a scenario HANGS past the vitest timeout, this finally-block sweep never runs and
// the orphans stay Running in the namespace indefinitely — no later sweep matches them (seed
// --fresh and cleanup-temporal.ts are scoped to THEIR db's instance prefix, and the scratch db
// is deleted with the temp dir). They are correctness-inert (every consumer filters by instance
// prefix) but cost every future namespace-wide visibility sweep a listing entry; clean them by
// hand from the Temporal UI if a hang ever happens.
async function terminateInstanceWorkflows(client: Client, instance: string): Promise<void> {
  const prefixes = [runIdPrefix(instance), humanTaskIdPrefix(instance)];
  try {
    for await (const wf of client.workflow.list({
      query: `WorkflowType IN ('${RUN_WORKFLOW_TYPE}', '${HUMAN_TASK_WORKFLOW_TYPE}') AND ExecutionStatus = 'Running'`,
    })) {
      if (!prefixes.some((p) => wf.workflowId.startsWith(p))) {
        continue;
      }
      try {
        await client.workflow.getHandle(wf.workflowId).terminate('demo scenario teardown');
      } catch {
        // already closed, or racing — fine
      }
    }
  } catch {
    // visibility sweep failed — see the accepted residual above
  }
}

describe.skipIf(!hasTemporal)('demo scenarios (black-box e2e over real Temporal)', () => {
  it('demo_tests/ has at least one scenario pair', () => {
    expect(scenarioInputs.length).toBeGreaterThan(0);
  });

  for (const inputFile of scenarioInputs) {
    const outputFile = inputFile.replace('_input.md', '_output.md');
    it(
      `${inputFile} matches ${outputFile}`,
      async () => {
        const scenario = parseScenario(readFileSync(join(DEMO_DIR, inputFile), 'utf8'));

        // Per-scenario isolation: scratch db + store (deterministic ids), unique task queue
        // (no cross-talk with dev workers or other suites), fresh instance prefix.
        const dir = mkdtempSync(join(tmpdir(), 'graphflow-demo-'));
        scratchDirs.push(dir);
        const dbPath = join(dir, 'demo.sqlite3');
        const storageRoot = join(dir, 'store');
        const taskQueue = `graphflow-demo-${randomBytes(4).toString('hex')}`;
        const env = parseEnv({
          ...process.env,
          GRAPHFLOW_DB: dbPath,
          GRAPHFLOW_STORAGE: storageRoot,
          TEMPORAL_TASK_QUEUE: taskQueue,
        });

        initDb(dbPath);
        const conn = connect(dbPath);
        const registry = buildRegistry(ALL_WORKFLOWS);
        publishCatalog(conn, registry);
        const instance = instanceId(conn);

        const client = await connectClient(env);
        const worker = await createWorker(env, client, dbPath, storageRoot, instance, registry);
        const workerRun = worker.worker.run();
        const approver = startAutoApprover({
          client,
          taskQueue,
          instance,
          dbPath,
          storageRoot,
          reviewer: 'agent:auto-approver',
        });

        try {
          const rendered = await runScenario(
            { conn, client, dbPath, storageRoot, sampleDocs: SAMPLE_DOCS, taskQueue },
            scenario
          );
          const outputPath = join(DEMO_DIR, outputFile);
          if (UPDATE) {
            writeFileSync(outputPath, rendered);
            return;
          }
          if (!existsSync(outputPath)) {
            throw new Error(
              `${outputFile} does not exist — generate it with GRAPHFLOW_UPDATE_DEMOS=1, then review the file like a code change`
            );
          }
          expect(rendered).toBe(readFileSync(outputPath, 'utf8'));
        } finally {
          // Each teardown step is guarded: a workerRun rejection (fatal worker error) must not
          // skip the sweep/closes below, and a teardown throw must not mask the scenario error.
          await approver.stop().catch(() => undefined);
          try {
            worker.worker.shutdown();
          } catch {
            // already draining or stopped
          }
          await workerRun.catch(() => undefined);
          await worker.close().catch(() => undefined);
          await terminateInstanceWorkflows(client, instance);
          conn.close();
          await client.connection.close().catch(() => undefined);
        }
      },
      SCENARIO_TIMEOUT_MS
    );
  }
});
