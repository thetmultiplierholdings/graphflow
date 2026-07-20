import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { JsonValueSchema } from '../domain/json/JsonValue.js';
import { mulDecimals, quantize2HalfUp, sumDecimals } from '../domain/money/DecimalString.js';
import { buildRegistry } from '../domain/registry/Registry.js';
import { connect, initDb, publishCatalog } from '../infrastructure/db/Db.js';
import type { Env } from '../infrastructure/env/Env.js';
import { parseEnv } from '../infrastructure/env/Env.js';
import { errorMessage, RuntimeError } from '../shared/errors/Errors.js';
import { runWorkflowId } from '../temporal/Ids.js';
import { connectClient, createWorker, type WorkerHandle } from '../temporal/Runtime.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import { buildApp } from './App.js';
import type { ApiDeps } from './Deps.js';
import { createTemporalGateway } from './Deps.js';
import type { ExecuteOut, HumanTaskOut, StatusOut, UploadOut } from './Schemas.js';
import type { ArtifactMetaOut, EngagementOut, WorkflowRunDetailOut, WorkflowRunListOut } from './Serializers.js';

// The full story through HTTP over REAL Temporal Cloud:
// create → upload → execute twice concurrently (both 202, ONE execution — USE_EXISTING) → verify
// tasks open → a sequential re-execute of the RUNNING run attaches (202, SAME id, still running)
// → the dispatched run is frozen + a running parent is uncopyable (409, and the refusal files no
// run row) → malformed answers rejected (422, task stays open) → approve via the API → completed
// → report totals exact → re-execute of the completed run refuses (409 RUN_FROZEN, ledger
// untouched — the describe fast path; the start policies themselves are unit-pinned in
// ../temporal/Runtime.test.ts) → freeze probe (attach / upload-with-attach 409, nothing filed) →
// a revision executes as a pure memo replay (0 executed, 7 memo hits) → copy + 1 extra doc → only
// the marginal chain + fold/calc/report execute → frozen-but-idle recovery (hand-stamped
// executed_at reads idle; execute heals it without re-stamping) → terminate-then-retry (a
// TERMINATED execution re-dispatches in place under the SAME id, row still frozen). Real fetch
// against a listening app with the real embedded worker ON; scratch db/storage and a UNIQUE task
// queue per run; every Temporal workflow started under the scratch instance prefix is terminated
// on teardown.

// Load .env exactly like the app does (Env.loadEnv: tolerate absence, shell wins) BEFORE the
// skip decision — CI without credentials skips cleanly.
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const envFile = join(packageRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const SAMPLE_DOCS = join(packageRoot, 'sample_docs');

const TASKS_DEADLINE_MS = 120_000; // tasks appearing in visibility
const RUN_DEADLINE_MS = 180_000; // run completion (human-wait poll backs off up to 30s)

// The one payload shape verify_txns publishes: {ocr: {__artifact__: <ref>}}.
const OcrPayloadSchema = z.object({
  ocr: z.object({ __artifact__: z.object({ artifact_id: z.number().int() }) }),
});
const OcrContentSchema = z.object({ transactions: JsonValueSchema });

interface ProgressData {
  status: string;
  executed: string[];
  memo_hits: string[];
  human_waits: string[];
  error: string | null;
}

interface SseEvent {
  name: string;
  data: ProgressData;
}

interface SseParserState {
  eventName: string | null;
  events: SseEvent[];
  terminal: boolean;
}

// ---------- expected-value helpers (decimal strings end to end, like the engine) ----------

// Same line shape the mock OCR parses: 'YYYY-MM-DD | DESC | 123.45'.
function docAmounts(docPath: string): string[] {
  const amounts: string[] = [];
  for (const line of readFileSync(docPath, 'utf-8').split('\n')) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length === 3 && parts[0].length === 10 && parts[0][4] === '-') {
      amounts.push(parts[2]);
    }
  }
  return amounts;
}

function expectedTotals(docPaths: readonly string[], rate = '0.25'): { total: string; tax: string } {
  const total = sumDecimals(docPaths.flatMap(docAmounts));
  return { total: quantize2HalfUp(total), tax: quantize2HalfUp(mulDecimals(total, rate)) };
}

// Last whitespace-separated token of the stripped line beginning TOTAL / TAX DUE; a line starting
// with TOTAL never reaches the TAX DUE branch (the TOTAL check runs first, so ordering matters).
function reportTotals(reportText: string): { total: string | null; tax: string | null } {
  let total: string | null = null;
  let tax: string | null = null;
  for (const line of reportText.split('\n')) {
    const s = line.trim();
    const tokens = s.split(/\s+/);
    if (s.startsWith('TOTAL')) {
      total = tokens.at(-1) ?? null;
    } else if (s.startsWith('TAX DUE')) {
      tax = tokens.at(-1) ?? null;
    }
  }
  return { total, tax };
}

// ---------- generic HTTP helpers ----------

async function readJson<T>(res: Response): Promise<T> {
  const body: T = JSON.parse(await res.text());
  return body;
}

async function expectStatus(res: Response, want: number): Promise<void> {
  if (res.status !== want) {
    throw new RuntimeError(`expected HTTP ${want}, got ${res.status}: ${await res.text()}`);
  }
}

function feedSseLine(state: SseParserState, line: string): void {
  if (line.startsWith('event: ')) {
    state.eventName = line.slice('event: '.length).trim();
    return;
  }
  if (!(line.startsWith('data: ') && state.eventName !== null)) {
    return;
  }
  const data: ProgressData = JSON.parse(line.slice('data: '.length));
  state.events.push({ name: state.eventName, data });
  if (state.eventName === 'finished' || state.eventName === 'failed') {
    state.terminal = true;
  }
}

// Parse the SSE stream until the terminal finished/failed event (or the server closes it).
async function readSseEvents(res: Response): Promise<SseEvent[]> {
  if (res.status !== 200) {
    throw new RuntimeError(`progress stream: expected HTTP 200, got ${res.status}: ${await res.text()}`);
  }
  if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) {
    throw new RuntimeError(`progress stream: unexpected content-type ${String(res.headers.get('content-type'))}`);
  }
  if (res.body === null) {
    throw new RuntimeError('progress stream has no body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state: SseParserState = { eventName: null, events: [], terminal: false };
  let buffer = '';
  try {
    while (!state.terminal) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        feedSseLine(state, line);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed by the server
    }
  }
  return state.events;
}

describe.skipIf(process.env.TEMPORAL_API_KEY === undefined || process.env.TEMPORAL_API_KEY === '')(
  'API integration (full story over real Temporal Cloud)',
  () => {
    let scratch: string | undefined;
    let dbPath = '';
    let storageRoot = '';
    let taskQueue = '';
    let instance = '';
    let baseUrl = '';
    let env: Env | undefined;
    let client: Client | undefined;
    let worker: WorkerHandle | undefined;
    let workerRun: Promise<void> | undefined;
    let app: FastifyInstance | undefined;

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'graphflow_api_int_'));
      const token = randomBytes(4).toString('hex');
      dbPath = join(scratch, `int_${token}.sqlite3`);
      storageRoot = join(scratch, `store_${token}`);
      // NEVER the .env task queue: the namespace and default queue are shared — a live dev
      // stack's embedded worker polls the same queue against a DIFFERENT db. A unique scratch
      // queue keeps our workflow/activity tasks on OUR worker only.
      taskQueue = `graphflow-it-${token}`;

      env = {
        ...parseEnv(process.env),
        temporalTaskQueue: taskQueue,
        dbPath,
        storageRoot,
        embedWorker: true,
        port: 0,
      };

      instance = initDb(dbPath);
      const registry = buildRegistry(ALL_WORKFLOWS);
      const conn = connect(dbPath);
      try {
        publishCatalog(conn, registry);
      } finally {
        conn.close();
      }

      client = await connectClient(env);
      const deps: ApiDeps = {
        connect: () => connect(dbPath),
        env,
        temporal: createTemporalGateway({ client, env, dbPath, instance }),
        registry,
        instance,
        storageRoot,
        dbPath,
      };
      app = await buildApp(deps);

      worker = await createWorker(env, client, dbPath, storageRoot, instance, registry);
      workerRun = worker.worker.run();
      const running = workerRun;
      const watchWorker = async (): Promise<void> => {
        try {
          await running;
        } catch {
          // a worker crash surfaces again through the retained workerRun promise at teardown
        }
      };
      void watchWorker();

      baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    }, 240_000);

    afterAll(async () => {
      // Teardown order: terminate scratch Temporal workflows FIRST (while the client is alive and
      // the db exists), then close everything.
      if (client !== undefined) {
        await terminateDirectRuns(client);
        await sweepScratchTaskWorkflows(client);
      }
      if (app !== undefined) {
        await app.close();
      }
      if (worker !== undefined) {
        try {
          worker.worker.shutdown();
        } catch {
          // the worker never started polling — nothing to stop
        }
        try {
          await workerRun;
        } catch {
          // worker failure mid-suite already failed the test that depended on it
        }
        await worker.close();
      }
      if (client !== undefined) {
        await client.connection.close();
      }
      if (scratch !== undefined) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 180_000);

    // ---------- teardown helpers ----------

    // Phase 1: the wfrun ids are derivable from the scratch db — no visibility needed.
    async function terminateDirectRuns(temporalClient: Client): Promise<void> {
      let runIds: number[] = [];
      try {
        const conn = connect(dbPath);
        try {
          runIds = conn
            .prepare<[], { workflow_run_id: number }>('SELECT workflow_run_id FROM workflow_runs')
            .all()
            .map((row) => row.workflow_run_id);
        } finally {
          conn.close();
        }
      } catch {
        // scratch db unreadable — the visibility sweeps below still run
      }
      for (const runId of runIds) {
        try {
          await temporalClient.workflow
            .getHandle(runWorkflowId(instance, runId))
            .terminate('vitest integration cleanup');
        } catch {
          // never started or already closed — nothing to terminate
        }
      }
    }

    async function terminateIfScratch(
      temporalClient: Client,
      workflowId: string,
      prefixes: readonly string[]
    ): Promise<void> {
      if (!prefixes.some((prefix) => workflowId.startsWith(prefix))) {
        return;
      }
      try {
        await temporalClient.workflow.getHandle(workflowId).terminate('vitest integration cleanup');
      } catch {
        // raced to completion — fine
      }
    }

    // Phase 2: visibility is eventually consistent, so sweep the node-* human tasks (and any
    // wfrun stragglers) several times with delays.
    async function sweepScratchTaskWorkflows(temporalClient: Client): Promise<void> {
      const prefixes = [`wfrun-${instance}-`, `node-${instance}-`];
      const query = `TaskQueue = '${taskQueue}' AND ExecutionStatus = 'Running'`;
      for (let sweep = 0; sweep < 3; sweep += 1) {
        if (sweep > 0) {
          await delay(4000); // let the visibility index catch up
        }
        try {
          for await (const wf of temporalClient.workflow.list({ query })) {
            await terminateIfScratch(temporalClient, wf.workflowId, prefixes);
          }
        } catch {
          // visibility hiccup — the next sweep retries
        }
      }
    }

    // ---------- HTTP helpers ----------

    async function postJson(path: string, body: JsonValue): Promise<Response> {
      return await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function uploadDoc(
      eng: number,
      docPath: string,
      nodeparamslot: string,
      workflowRunId: number
    ): Promise<ArtifactMetaOut> {
      const form = new FormData();
      form.append('nodeparamslot', nodeparamslot);
      form.append('workflow_run_id', String(workflowRunId));
      form.append('file', new Blob([new Uint8Array(readFileSync(docPath))], { type: 'text/plain' }), basename(docPath));
      const res = await fetch(`${baseUrl}/engagements/${eng}/artifacts`, { method: 'POST', body: form });
      await expectStatus(res, 200);
      return (await readJson<UploadOut>(res)).artifact;
    }

    async function openTasks(eng: number): Promise<HumanTaskOut[]> {
      const res = await fetch(`${baseUrl}/human-tasks?engagement_id=${eng}`);
      await expectStatus(res, 200);
      return await readJson<HumanTaskOut[]>(res);
    }

    async function pollTasks(eng: number, count: number, workflowRunId: number): Promise<HumanTaskOut[]> {
      const deadline = Date.now() + TASKS_DEADLINE_MS;
      let tasks: HumanTaskOut[] = [];
      while (Date.now() < deadline) {
        tasks = (await openTasks(eng)).filter((t) => t.requested_by_workflow_run === workflowRunId);
        if (tasks.length >= count) {
          return tasks;
        }
        await delay(2000);
      }
      throw new RuntimeError(
        `timed out after ${TASKS_DEADLINE_MS / 1000}s waiting for ${count} open verify task(s) of workflow run ${workflowRunId}; last saw ${tasks.length}`
      );
    }

    async function pollStatus(workflowRunId: number, want: StatusOut['status'] = 'completed'): Promise<StatusOut> {
      const deadline = Date.now() + RUN_DEADLINE_MS;
      let last: StatusOut | null = null;
      while (Date.now() < deadline) {
        const res = await fetch(`${baseUrl}/workflow-runs/${workflowRunId}/status`);
        await expectStatus(res, 200);
        last = await readJson<StatusOut>(res);
        if (last.status === want) {
          return last;
        }
        if (last.status === 'failed') {
          throw new RuntimeError(`run failed: ${last.error ?? 'unknown'}`);
        }
        await delay(2000);
      }
      throw new RuntimeError(
        `timed out after ${RUN_DEADLINE_MS / 1000}s waiting for workflow run ${workflowRunId} status '${want}'; last ${JSON.stringify(last)}`
      );
    }

    // The API-driven reviewer: fetch the OCR extraction through the API, approve it unchanged
    // (exactly what the frontend's auto-approval does).
    async function approveTask(task: HumanTaskOut, reviewer = 'Test Reviewer'): Promise<ArtifactMetaOut> {
      const payload = OcrPayloadSchema.parse(task.payload);
      const contentRes = await fetch(`${baseUrl}/artifacts/${payload.ocr.__artifact__.artifact_id}/content`);
      await expectStatus(contentRes, 200);
      expect(String(contentRes.headers.get('content-type')).startsWith('application/json')).toBe(true);
      const ocr = OcrContentSchema.parse(JSON.parse(await contentRes.text()));
      const res = await postJson(`/human-tasks/${task.task_id}/submit`, {
        reviewer,
        result: { approved: true, transactions: ocr.transactions },
      });
      await expectStatus(res, 200);
      return (await readJson<{ artifact: ArtifactMetaOut }>(res)).artifact;
    }

    // Read the SSE stream until the terminal event; return the final snapshot. A transient query
    // failure yields an empty snapshot on the finished tick — a genuinely finished run always has
    // executed or memo_hits, so retry then. Timeouts/network errors also retry; anything else
    // (non-200, failed terminal event, no events) fails fast.
    async function readProgress(workflowRunId: number, attempts = 3): Promise<ProgressData> {
      let lastError = 'none';
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let events: SseEvent[];
        try {
          const res = await fetch(`${baseUrl}/workflow-runs/${workflowRunId}/progress`, {
            signal: AbortSignal.timeout(RUN_DEADLINE_MS),
          });
          events = await readSseEvents(res);
        } catch (e) {
          if (e instanceof RuntimeError) {
            throw e;
          }
          lastError = errorMessage(e);
          await delay(2000);
          continue;
        }
        const last = events.at(-1);
        if (last === undefined) {
          throw new RuntimeError('progress stream closed without any event');
        }
        if (last.name !== 'finished') {
          throw new RuntimeError(`terminal event '${last.name}': ${JSON.stringify(last.data)}`);
        }
        if (last.data.executed.length > 0 || last.data.memo_hits.length > 0) {
          return last.data;
        }
        await delay(2000); // empty snapshot: the progress query raced — retry the whole stream
      }
      throw new RuntimeError(
        `no usable progress snapshot for workflow run ${workflowRunId} after ${attempts} attempts (last error: ${lastError})`
      );
    }

    // ---------- the story ----------

    it('full story over real Temporal', { timeout: 600_000 }, async () => {
      // 1. engagement + workflow run (born a root, unfrozen) + 1 brokerage statement + 1 payment slip
      const engRes = await postJson('/engagements', { display_name: 'vitest — API integration' });
      await expectStatus(engRes, 200);
      const eng = (await readJson<EngagementOut>(engRes)).engagement_id;

      const wsRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'March estimate',
      });
      await expectStatus(wsRes, 200);
      const wsDetail = await readJson<WorkflowRunDetailOut>(wsRes);
      const ws = wsDetail.workflow_run_id;
      expect(wsDetail.lineage_kind).toBe('root');
      expect(wsDetail.executed_at).toBeNull();

      const docs = [join(SAMPLE_DOCS, 'morgan_stanley.txt'), join(SAMPLE_DOCS, 'payslip_jan.txt')];
      const stmt = await uploadDoc(eng, docs[0], 'brokerage_statement', ws);
      const slip = await uploadDoc(eng, docs[1], 'payment_slip', ws);
      const userDocIds = [stmt.artifact_id, slip.artifact_id].sort((a, b) => a - b);

      // 2. execute twice CONCURRENTLY -> both 202 with the SAME temporal id. Only this suite can
      // pin workflowIdConflictPolicy USE_EXISTING: the real server dedupes the double-click into
      // one execution (a FAIL policy would bounce the second request as AlreadyStarted -> 409).
      const [execRes, execAgainRes] = await Promise.all([
        fetch(`${baseUrl}/workflow-runs/${ws}/execute`, { method: 'POST' }),
        fetch(`${baseUrl}/workflow-runs/${ws}/execute`, { method: 'POST' }),
      ]);
      await expectStatus(execRes, 202);
      await expectStatus(execAgainRes, 202);
      const execOut = await readJson<ExecuteOut>(execRes);
      expect(execOut.temporal_workflow_id.startsWith('wfrun-')).toBe(true);
      expect((await readJson<ExecuteOut>(execAgainRes)).temporal_workflow_id).toBe(execOut.temporal_workflow_id);

      const tasks = await pollTasks(eng, 2, ws);
      expect(tasks).toHaveLength(2);
      for (const t of tasks) {
        expect(t.engagement_id).toBe(eng);
        expect(t.node_id).toBe('verify_txns');
        expect(t.output_nodeparamslot).toBe('verified_txns');
        expect(t.result_required_keys).toEqual(['approved', 'transactions']);
        expect(OcrPayloadSchema.safeParse(t.payload).success).toBe(true);
        expect(t.instructions).toBeTruthy();
      }

      // The RUNNING → proceed branch, sequentially: while the run is parked on humans, a plain
      // re-execute attaches to the LIVE execution (describe says RUNNING → no 409; USE_EXISTING
      // finds it) — 202, the SAME temporal id, and the run keeps waiting. A gate that refused
      // ANY found execution (not just COMPLETED) would bounce this request.
      const attachExecRes = await fetch(`${baseUrl}/workflow-runs/${ws}/execute`, { method: 'POST' });
      await expectStatus(attachExecRes, 202);
      expect((await readJson<ExecuteOut>(attachExecRes)).temporal_workflow_id).toBe(execOut.temporal_workflow_id);
      const stillRunningRes = await fetch(`${baseUrl}/workflow-runs/${ws}/status`);
      await expectStatus(stillRunningRes, 200);
      expect((await readJson<StatusOut>(stillRunningRes)).status).toBe('running');

      // The dispatch froze the row: executed_at stamps at FIRST dispatch, not at completion…
      const midDetailRes = await fetch(`${baseUrl}/workflow-runs/${ws}`);
      await expectStatus(midDetailRes, 200);
      expect((await readJson<WorkflowRunDetailOut>(midDetailRes)).executed_at).not.toBeNull();

      // …and a RUNNING parent is uncopyable — the copyability gate consults the REAL describe.
      const runsBeforeCopyRes = await fetch(`${baseUrl}/engagements/${eng}/workflow-runs`);
      await expectStatus(runsBeforeCopyRes, 200);
      const runsBeforeCopy = (await readJson<WorkflowRunListOut[]>(runsBeforeCopyRes)).length;
      const eagerCopyRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'too eager',
        copy_from: ws,
      });
      await expectStatus(eagerCopyRes, 409);
      expect((await readJson<{ detail: string }>(eagerCopyRes)).detail).toBe(
        `workflow run ${ws} is still running — wait for it to finish before copying`
      );
      // The refusal filed NOTHING: the gate answers before Phase B's create, so no phantom row
      // may appear in the engagement's run list (pins against a create-before-gate reorder).
      const runsAfterCopyRes = await fetch(`${baseUrl}/engagements/${eng}/workflow-runs`);
      await expectStatus(runsAfterCopyRes, 200);
      expect((await readJson<WorkflowRunListOut[]>(runsAfterCopyRes)).length).toBe(runsBeforeCopy);

      // 3. NEGATIVE — the answer contract. Malformed rows -> 422, task stays open.
      const badRes = await postJson(`/human-tasks/${tasks[0].task_id}/submit`, {
        reviewer: 'Test Reviewer',
        result: {
          approved: true,
          transactions: [{ date: 'bad', description: '', amount: '12,00' }],
        },
      });
      await expectStatus(badRes, 422);
      const badDetail = (await readJson<{ detail: string }>(badRes)).detail;
      expect(typeof badDetail).toBe('string'); // reviewer-facing message, not a validation array
      expect(badDetail.length).toBeGreaterThan(0);
      expect(badDetail).toContain('date'); // first violation reported: date must be YYYY-MM-DD

      // missing required keys -> 422 too
      const missingRes = await postJson(`/human-tasks/${tasks[0].task_id}/submit`, {
        reviewer: 'Test Reviewer',
        result: { approved: true },
      });
      await expectStatus(missingRes, 422);
      expect((await readJson<{ detail: string }>(missingRes)).detail).toContain('transactions');

      // Rejection never closes the task. A single sweep of /human-tasks may transiently drop a
      // task (the route skips tasks whose task_info query blips), so poll: a genuinely completed
      // task can never come back as open, so reappearing proves the rejected task is still waiting.
      const stillOpen = await pollTasks(eng, 2, ws);
      expect(stillOpen.map((t) => t.task_id)).toContain(tasks[0].task_id);

      // 4. approve both properly (OCR content fetched via the API)
      for (const t of tasks) {
        const answer = await approveTask(t);
        expect(answer.nodeparamslot).toBe('verified_txns');
        // The API wraps the submitted bare name as a 'user:*' principal.
        expect(answer.created_by).toBe('user:Test Reviewer');
      }

      // 5. run completes; the report's TOTAL and TAX DUE are exact
      await pollStatus(ws, 'completed');

      // a second submit to an already-completed task -> 404
      const closedRes = await postJson(`/human-tasks/${tasks[0].task_id}/submit`, {
        reviewer: 'Test Reviewer',
        result: { approved: true, transactions: [] },
      });
      await expectStatus(closedRes, 404);

      const detailRes = await fetch(`${baseUrl}/workflow-runs/${ws}`);
      await expectStatus(detailRes, 200);
      const reports = (await readJson<WorkflowRunDetailOut>(detailRes)).members.filter(
        (m) => m.nodeparamslot === 'final_report'
      );
      const lastReport = reports.at(-1);
      if (lastReport === undefined) {
        throw new RuntimeError('workflow run members must contain the final_report');
      }
      const reportRes = await fetch(`${baseUrl}/artifacts/${lastReport.artifact_id}/content`);
      await expectStatus(reportRes, 200);
      const expected = expectedTotals(docs); // decimal strings, ROUND_HALF_UP
      const got = reportTotals(await reportRes.text());
      expect(got.total).toBe(expected.total);
      expect(got.tax).toBe(expected.tax);

      // 6. the completed run refuses to re-execute: 409 RUN_FROZEN — a business run happens at
      // most once. This pins the describe FAST PATH only: it answers before the start call, so
      // the reuse policy is never consulted here. RUN_START_POLICIES + rethrowStartError (the
      // atomic arbiter behind the fast path) are unit-pinned in ../temporal/Runtime.test.ts, and
      // the server's start-after-FAILED half is pinned by the terminate-then-retry step below.
      // The ledger must not move: a 409 that still re-dispatched would shift engagement stats.
      const statsBeforeRes = await fetch(`${baseUrl}/engagements/${eng}`);
      await expectStatus(statsBeforeRes, 200);
      const statsBefore = (await readJson<EngagementOut>(statsBeforeRes)).stats;

      const rerunRes = await fetch(`${baseUrl}/workflow-runs/${ws}/execute`, { method: 'POST' });
      await expectStatus(rerunRes, 409);
      expect((await readJson<{ detail: string }>(rerunRes)).detail).toBe(
        `workflow run ${ws} has already completed — create a copy or revision to run it again`
      );

      const statsAfterRes = await fetch(`${baseUrl}/engagements/${eng}`);
      await expectStatus(statsAfterRes, 200);
      expect((await readJson<EngagementOut>(statsAfterRes)).stats).toEqual(statsBefore);

      // Freeze probe: user attach of an existing member -> 409; upload-with-attach -> 409 AND the
      // rejected upload files NOTHING (the route checks frozen BEFORE supplyArtifact).
      const frozenDetail = `workflow run ${ws} is frozen (already executed) — attachments can no longer change; create a copy or revision`;
      const frozenAttachRes = await postJson(`/workflow-runs/${ws}/attachments`, { artifact_id: stmt.artifact_id });
      await expectStatus(frozenAttachRes, 409);
      expect((await readJson<{ detail: string }>(frozenAttachRes)).detail).toBe(frozenDetail);

      const poolBeforeRes = await fetch(`${baseUrl}/engagements/${eng}/artifacts`);
      await expectStatus(poolBeforeRes, 200);
      const poolBefore = (await readJson<ArtifactMetaOut[]>(poolBeforeRes)).length;
      const frozenForm = new FormData();
      frozenForm.append('nodeparamslot', 'brokerage_statement');
      frozenForm.append('workflow_run_id', String(ws));
      frozenForm.append('file', new Blob(['2026-03-03 | REJECTED | 1.00'], { type: 'text/plain' }), 'rejected.txt');
      const frozenUploadRes = await fetch(`${baseUrl}/engagements/${eng}/artifacts`, {
        method: 'POST',
        body: frozenForm,
      });
      await expectStatus(frozenUploadRes, 409);
      expect((await readJson<{ detail: string }>(frozenUploadRes)).detail).toBe(frozenDetail);
      const poolAfterRes = await fetch(`${baseUrl}/engagements/${eng}/artifacts`);
      await expectStatus(poolAfterRes, 200);
      expect((await readJson<ArtifactMetaOut[]>(poolAfterRes)).length).toBe(poolBefore);

      // 7. more work on a frozen run is a copy — here a REVISION: same workflow, extends the
      // root's family. Executing it is a pure memo replay — zero node bodies, zero humans
      // disturbed (lineage_kind must never leak into memo keys).
      const revRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'March estimate — second pass',
        copy_from: ws,
        lineage_kind: 'revision',
      });
      await expectStatus(revRes, 200);
      const revDetail = await readJson<WorkflowRunDetailOut>(revRes);
      const rev = revDetail.workflow_run_id;
      expect(revDetail.lineage_kind).toBe('revision');
      expect(revDetail.copied_from_workflow_run).toBe(ws);
      expect(revDetail.root_workflow_run_id).toBe(ws);
      expect(revDetail.lineage_byid).toBe(`${ws}/${rev}`);
      expect(revDetail.lineage_display).toBe('March estimate/March estimate — second pass');
      expect(revDetail.executed_at).toBeNull(); // born unfrozen — the parent's freeze is not inherited
      expect(revDetail.members).toHaveLength(2);
      expect(revDetail.members.every((m) => m.source === 'user')).toBe(true);
      expect(revDetail.members.map((m) => m.artifact_id).sort((a, b) => a - b)).toEqual(userDocIds);

      const revExecRes = await fetch(`${baseUrl}/workflow-runs/${rev}/execute`, { method: 'POST' });
      await expectStatus(revExecRes, 202);
      const progress = await readProgress(rev);
      expect(progress.status).toBe('completed');
      expect(progress.executed).toEqual([]);
      expect(progress.human_waits).toEqual([]);
      // 7 memo hits: 2 ocr + 2 verify + fold + calc + report
      expect(progress.memo_hits).toHaveLength(7);
      expect([...new Set(progress.memo_hits)].sort()).toEqual([
        'append_to_master',
        'build_report',
        'calculate_tax',
        'ocr_brokerage_statement',
        'ocr_payment_slip',
        'verify_txns',
      ]);
      expect(progress.memo_hits.filter((nodeId) => nodeId === 'verify_txns')).toHaveLength(2);

      // Engine attach-back refilled the revision's own pinboard; both user sets stay the copies.
      const revAfterRes = await fetch(`${baseUrl}/workflow-runs/${rev}`);
      await expectStatus(revAfterRes, 200);
      const revAfter = await readJson<WorkflowRunDetailOut>(revAfterRes);
      expect(revAfter.executed_at).not.toBeNull();
      expect(revAfter.members.filter((m) => m.source === 'engine').length).toBeGreaterThan(0);
      expect(
        revAfter.members
          .filter((m) => m.source === 'user')
          .map((m) => m.artifact_id)
          .sort((a, b) => a - b)
      ).toEqual(userDocIds);
      const wsAfterRes = await fetch(`${baseUrl}/workflow-runs/${ws}`);
      await expectStatus(wsAfterRes, 200);
      const wsAfter = await readJson<WorkflowRunDetailOut>(wsAfterRes);
      expect(
        wsAfter.members
          .filter((m) => m.source === 'user')
          .map((m) => m.artifact_id)
          .sort((a, b) => a - b)
      ).toEqual(userDocIds);

      // 8. copy the run + ONE extra statement: only the marginal work runs
      const copyRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'April estimate',
        copy_from: ws,
      });
      await expectStatus(copyRes, 200);
      const copyDetail = await readJson<WorkflowRunDetailOut>(copyRes);
      const ws2 = copyDetail.workflow_run_id;
      // copy_from without an explicit kind defaults to 'copy' — family-STARTING: own-rooted with
      // parenthood preserved (unlike the revision above, which extends the parent's family).
      expect(copyDetail.lineage_kind).toBe('copy');
      expect(copyDetail.copied_from_workflow_run).toBe(ws);
      expect(copyDetail.root_workflow_run_id).toBe(ws2);
      expect(copyDetail.lineage_byid).toBe(String(ws2));
      expect(copyDetail.lineage_display).toBe('April estimate');
      expect(copyDetail.executed_at).toBeNull();
      expect(copyDetail.members).toHaveLength(2);
      expect(copyDetail.members.every((m) => m.source === 'user')).toBe(true);

      const extra = join(SAMPLE_DOCS, 'extra_ubs.txt');
      await uploadDoc(eng, extra, 'brokerage_statement', ws2);

      const exec2Res = await fetch(`${baseUrl}/workflow-runs/${ws2}/execute`, { method: 'POST' });
      await expectStatus(exec2Res, 202);

      // exactly ONE new verify task (the extra statement's chain)
      const newTasks = await pollTasks(eng, 1, ws2);
      expect(newTasks).toHaveLength(1);
      expect(newTasks[0].engagement_id).toBe(eng);
      await approveTask(newTasks[0]);
      await pollStatus(ws2, 'completed');

      const progress2 = await readProgress(ws2);
      // Marginal execution: the new document's OCR (engine) + its verify (the 1 human answered)
      // + the 3 downstream engine nodes fold/calc/report. The two OLD chains are pure memo hits.
      expect([...progress2.executed].sort()).toEqual([
        'append_to_master',
        'build_report',
        'calculate_tax',
        'ocr_brokerage_statement',
        'verify_txns',
      ]);
      expect(progress2.human_waits).toEqual(['verify_txns']); // exactly 1 human answered
      expect([...progress2.memo_hits].sort()).toEqual([
        'ocr_brokerage_statement',
        'ocr_payment_slip',
        'verify_txns',
        'verify_txns',
      ]);

      // and the new report total includes the extra document
      const detail2Res = await fetch(`${baseUrl}/workflow-runs/${ws2}`);
      await expectStatus(detail2Res, 200);
      const reports2 = (await readJson<WorkflowRunDetailOut>(detail2Res)).members.filter(
        (m) => m.nodeparamslot === 'final_report'
      );
      const lastReport2 = reports2.at(-1);
      if (lastReport2 === undefined) {
        throw new RuntimeError('workflow run members must contain the final_report');
      }
      const report2Res = await fetch(`${baseUrl}/artifacts/${lastReport2.artifact_id}/content`);
      await expectStatus(report2Res, 200);
      const expected2 = expectedTotals([...docs, extra]);
      const got2 = reportTotals(await report2Res.text());
      expect(got2.total).toBe(expected2.total);
      expect(got2.tax).toBe(expected2.tax);
      expect(got2.total).not.toBe(got.total); // the extra document moved the number

      // 9. frozen-but-idle recovery: a crash between the freeze COMMIT and the Temporal start
      // leaves executed_at set with NO execution behind it. The wire shows exactly that split
      // (status 'idle', executed_at set), and a plain re-execute heals it (describe -> not-found
      // -> freeze no-op -> start) WITHOUT re-stamping: executed_at is write-once, so the hand
      // sentinel must survive the successful dispatch.
      const recRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'Recovery estimate',
      });
      await expectStatus(recRes, 200);
      const rec = (await readJson<WorkflowRunDetailOut>(recRes)).workflow_run_id;
      for (const artifactId of userDocIds) {
        const attachRes = await postJson(`/workflow-runs/${rec}/attachments`, { artifact_id: artifactId });
        await expectStatus(attachRes, 204);
      }
      const sentinel = '2020-01-01T00:00:00+00:00';
      const conn = connect(dbPath);
      try {
        conn.prepare('UPDATE workflow_runs SET executed_at=? WHERE workflow_run_id=?').run(sentinel, rec);
      } finally {
        conn.close();
      }
      const idleStatusRes = await fetch(`${baseUrl}/workflow-runs/${rec}/status`);
      await expectStatus(idleStatusRes, 200);
      expect(await readJson<StatusOut>(idleStatusRes)).toEqual({ status: 'idle', error: null });
      const idleDetailRes = await fetch(`${baseUrl}/workflow-runs/${rec}`);
      await expectStatus(idleDetailRes, 200);
      expect((await readJson<WorkflowRunDetailOut>(idleDetailRes)).executed_at).toBe(sentinel);

      const healRes = await fetch(`${baseUrl}/workflow-runs/${rec}/execute`, { method: 'POST' });
      await expectStatus(healRes, 202);
      const recProgress = await readProgress(rec);
      expect(recProgress.status).toBe('completed');
      expect(recProgress.executed).toEqual([]);
      expect(recProgress.human_waits).toEqual([]);
      expect(recProgress.memo_hits).toHaveLength(7); // same doc set as the root -> full replay
      const healedRes = await fetch(`${baseUrl}/workflow-runs/${rec}`);
      await expectStatus(healedRes, 200);
      expect((await readJson<WorkflowRunDetailOut>(healedRes)).executed_at).toBe(sentinel);

      // 10. terminate → retry IN PLACE: an execution closed in a non-completed terminal state
      // re-dispatches under the SAME temporal id (describe sees TERMINATED → proceed;
      // workflowIdReusePolicy ALLOW_DUPLICATE_FAILED_ONLY admits a fresh execution over a failed
      // id) — the server-side half the rerun-409 above never reaches. A REJECT_DUPLICATE
      // regression, or a fast path broadened to refuse any closed state, would 409/500 the
      // retry. A never-before-seen document guarantees a genuinely waiting run to kill, and the
      // row must stay frozen through failure and retry (executed_at is write-once).
      const termRes = await postJson(`/engagements/${eng}/workflow-runs`, {
        workflow_id: 'tax_demo_workflow',
        display_name: 'Terminated estimate',
      });
      await expectStatus(termRes, 200);
      const term = (await readJson<WorkflowRunDetailOut>(termRes)).workflow_run_id;
      await uploadDoc(eng, join(SAMPLE_DOCS, 'goldman_sachs.txt'), 'brokerage_statement', term);

      const termExecRes = await fetch(`${baseUrl}/workflow-runs/${term}/execute`, { method: 'POST' });
      await expectStatus(termExecRes, 202);
      const termWfId = (await readJson<ExecuteOut>(termExecRes)).temporal_workflow_id;
      await pollTasks(eng, 1, term); // parked on its own verify task — genuinely waiting
      await pollStatus(term, 'running');
      const termFrozenRes = await fetch(`${baseUrl}/workflow-runs/${term}`);
      await expectStatus(termFrozenRes, 200);
      const termExecutedAt = (await readJson<WorkflowRunDetailOut>(termFrozenRes)).executed_at;
      expect(termExecutedAt).not.toBeNull();

      if (env === undefined) {
        throw new RuntimeError('env is assigned in beforeAll');
      }
      // A dedicated client for the out-of-band kill — the API must never offer such a path.
      const directClient = await connectClient(env);
      try {
        await directClient.workflow.getHandle(termWfId).terminate('test: simulated infra failure');
        await pollStatus(term, 'failed');
        const termFailedRes = await fetch(`${baseUrl}/workflow-runs/${term}`);
        await expectStatus(termFailedRes, 200);
        expect((await readJson<WorkflowRunDetailOut>(termFailedRes)).executed_at).toBe(termExecutedAt);

        const retryRes = await fetch(`${baseUrl}/workflow-runs/${term}/execute`, { method: 'POST' });
        await expectStatus(retryRes, 202);
        expect((await readJson<ExecuteOut>(retryRes)).temporal_workflow_id).toBe(termWfId);
        // A FRESH execution under the SAME id: memo-replays to the still-open verify task and
        // waits there again — infra noise never minted a business revision.
        await pollStatus(term, 'running');

        await directClient.workflow.getHandle(termWfId).terminate('test cleanup');
      } finally {
        await directClient.connection.close();
      }
      const termAfterRes = await fetch(`${baseUrl}/workflow-runs/${term}`);
      await expectStatus(termAfterRes, 200);
      expect((await readJson<WorkflowRunDetailOut>(termAfterRes)).executed_at).toBe(termExecutedAt);
    });
  }
);
