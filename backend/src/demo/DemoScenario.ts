import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import type Database from 'better-sqlite3';
import { executeWorkflowRun, quotedList } from '../cli/Shared.js';
import { canonicalBytes } from '../domain/canonical/Canonical.js';
import {
  attach,
  createEngagement,
  createWorkflowRun,
  detach,
  getWorkflowRun,
  type LineageKind,
  listWorkflowRuns,
  readArtifactPayload,
  stats,
  supplyArtifact,
  workflowRunArtifacts,
} from '../infrastructure/db/Db.js';
import { RuntimeError, ValidationError } from '../shared/errors/Errors.js';
import type { Summary } from '../temporal/Context.js';

// The demo-scenario harness: black-box e2e without the frontend. A scenario is a pair of
// markdown files under backend/demo_tests/ — scenarioN_input.md holds prose for humans plus
// fenced ```steps blocks the runner executes (same moves as `cli demo`: create, upload, copy,
// execute against real Temporal with the auto-approver answering verify tasks); the runner then
// reads the scratch DB DIRECTLY and renders everything a reviewer would want to check into a
// deterministic markdown document, compared byte-for-byte against scenarioN_output.md
// (DemoScenario.test.ts; regenerate with GRAPHFLOW_UPDATE_DEMOS=1). Determinism contract: a
// fresh SQLite db assigns the same ids for the same step sequence, artifact hashes are content
// hashes of fixed sample docs, and the renderer emits no timestamps and no Temporal ids.

// ---------- the steps grammar ----------

// One line per step inside a ```steps fence. Blank lines and #-comments are ignored. Verbs:
//   engagement <alias> "<display name>"
//   run <alias> = create <workflow_id> "<display name>" in <engagementAlias>
//   run <alias> = copy <parentAlias> <copy|revision|simulation|root> "<display name>" [workflow=<id>]
//     ('root' is a legal token only so a `fail` step can demonstrate resolveLineageKind's
//      root-cannot-carry-copy_from refusal; a non-fail root copy always throws)
//   upload <runAlias> <nodeparamslot> <file-in-sample_docs>
//   answers <runAlias> <nodeparamslot> <inline JSON>       (the questionnaire channel)
//   detach <runAlias> <nodeparamslot>                      (all USER members of that slot)
//   execute <runAlias>
//   report <runAlias>                                      (include its final report in the output)
// Any line may be prefixed with `fail ` — the command must then be REFUSED BY THE PRODUCT, and
// the refusal message is recorded in the output under "Rejected commands". Harness-level errors
// (unrecognized step, unknown alias, missing sample doc — all prefixed 'demo harness:') do NOT
// satisfy `fail`: they rethrow, so a typo'd step can never mint a golden that documents a parse
// error as a product guardrail.

export interface ScenarioStep {
  raw: string;
  expectFail: boolean;
  command: string;
}

export interface ParsedScenario {
  title: string;
  steps: ScenarioStep[];
}

const TITLE_RE = /^#\s+(.+)$/m;
const FILE_EXT_RE = /\.[^.]+$/;
const TRAILING_NEWLINE_RE = /\n$/;

export function parseScenario(inputMarkdown: string): ParsedScenario {
  const titleMatch = inputMarkdown.match(TITLE_RE);
  const title = titleMatch?.[1]?.trim() ?? 'untitled scenario';
  const steps: ScenarioStep[] = [];
  const fence = /```steps\n([\s\S]*?)```/g;
  let block = fence.exec(inputMarkdown);
  while (block !== null) {
    for (const rawLine of (block[1] ?? '').split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) {
        continue;
      }
      const expectFail = line.startsWith('fail ');
      steps.push({ raw: line, expectFail, command: expectFail ? line.slice('fail '.length).trim() : line });
    }
    block = fence.exec(inputMarkdown);
  }
  if (steps.length === 0) {
    throw new ValidationError(`scenario '${title}' has no \`\`\`steps blocks`);
  }
  return { title, steps };
}

// ---------- running ----------

export interface ScenarioContext {
  conn: Database.Database;
  client: Client;
  dbPath: string;
  storageRoot: string;
  sampleDocs: string;
  taskQueue: string;
}

interface Execution {
  alias: string;
  summary: Summary;
}

interface Rejection {
  command: string;
  message: string;
  code: string | null;
}

interface ReportRequest {
  alias: string;
  text: string;
}

interface RunnerState {
  engagements: Map<string, number>;
  runs: Map<string, number>;
  executions: Execution[];
  rejections: Rejection[];
  reports: ReportRequest[];
}

const ENGAGEMENT_RE = /^engagement (\w+) "(.+)"$/;
const CREATE_RE = /^run (\w+) = create (\S+) "(.+)" in (\w+)$/;
// 'root' is accepted by the grammar so a `fail run x = copy parent root "..."` step demonstrates
// resolveLineageKind's real pairing refusal instead of a parse error.
const COPY_RE = /^run (\w+) = copy (\w+) (copy|revision|simulation|root) "(.+)"(?: workflow=(\S+))?$/;
const UPLOAD_RE = /^upload (\w+) (\S+) (\S+)$/;
const ANSWERS_RE = /^answers (\w+) (\S+) (.+)$/;
const DETACH_RE = /^detach (\w+) (\S+)$/;
const EXECUTE_RE = /^execute (\w+)$/;
const REPORT_RE = /^report (\w+)$/;

const ACTOR = 'user:demo';

// Every error the HARNESS itself raises carries this prefix, so the `fail` verb can tell a
// product refusal from a scenario-authoring mistake (see runScenario).
const HARNESS = 'demo harness:';

const harnessError = (message: string): ValidationError => new ValidationError(`${HARNESS} ${message}`);

function need<T>(value: T | undefined, what: string, line: string): T {
  if (value === undefined) {
    throw harnessError(`${what} in step '${line}' — declare it first`);
  }
  return value;
}

function userMembersOfSlot(conn: Database.Database, workflowRunId: number, nodeparamslot: string): number[] {
  return conn
    .prepare<[number, string], { artifact_id: number }>(`
      SELECT wra.artifact_id FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id)
      WHERE wra.workflow_run_id=? AND wra.source='user' AND a.nodeparamslot=? ORDER BY wra.artifact_id`)
    .all(workflowRunId, nodeparamslot)
    .map((r) => r.artifact_id);
}

async function runStep(ctx: ScenarioContext, state: RunnerState, line: string): Promise<void> {
  let m = line.match(ENGAGEMENT_RE);
  if (m !== null) {
    state.engagements.set(m[1] as string, createEngagement(ctx.conn, m[2] as string, { createdBy: ACTOR }));
    return;
  }
  m = line.match(CREATE_RE);
  if (m !== null) {
    const [, alias, workflowId, name, engAlias] = m as unknown as [string, string, string, string, string];
    const eng = need(state.engagements.get(engAlias), `unknown engagement '${engAlias}'`, line);
    state.runs.set(alias, createWorkflowRun(ctx.conn, eng, workflowId, name, { createdBy: ACTOR }));
    return;
  }
  m = line.match(COPY_RE);
  if (m !== null) {
    const [, alias, parentAlias, kind, name, workflowOverride] = m as unknown as [
      string,
      string,
      string,
      LineageKind,
      string,
      string | undefined,
    ];
    const parent = need(state.runs.get(parentAlias), `unknown run '${parentAlias}'`, line);
    const parentRow = getWorkflowRun(ctx.conn, parent);
    state.runs.set(
      alias,
      createWorkflowRun(ctx.conn, parentRow.engagement_id, workflowOverride ?? parentRow.workflow_id, name, {
        createdBy: ACTOR,
        copiedFrom: parent,
        lineageKind: kind,
      })
    );
    return;
  }
  m = line.match(UPLOAD_RE);
  if (m !== null) {
    const [, runAlias, slot, file] = m as unknown as [string, string, string, string];
    const run = need(state.runs.get(runAlias), `unknown run '${runAlias}'`, line);
    const engagementId = getWorkflowRun(ctx.conn, run).engagement_id;
    // Deliberately NO frozen pre-check here: this harness drives the Db layer, so a frozen run
    // is refused by Db.attach's guard AFTER supplyArtifact files the bytes into the engagement
    // pool. (The API's upload-with-attach route checks frozen BEFORE filing — that ordering is
    // route-owned and pinned in ApiCrud/ApiIntegration; re-implementing it here would make the
    // golden assert the harness's own code.)
    const path = join(ctx.sampleDocs, file);
    if (!existsSync(path)) {
      throw harnessError(`sample doc '${file}' not found in step '${line}'`);
    }
    const data = readFileSync(path);
    const ref = supplyArtifact(ctx.conn, ctx.storageRoot, engagementId, slot, data, {
      displayName: file.replace(FILE_EXT_RE, ''),
      createdBy: ACTOR,
    });
    attach(ctx.conn, run, ref.artifact_id, { source: 'user', createdBy: ACTOR });
    return;
  }
  m = line.match(ANSWERS_RE);
  if (m !== null) {
    const [, runAlias, slot, json] = m as unknown as [string, string, string, string];
    const run = need(state.runs.get(runAlias), `unknown run '${runAlias}'`, line);
    const engagementId = getWorkflowRun(ctx.conn, run).engagement_id;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw harnessError(`answers in step '${line}': not valid JSON`);
    }
    const ref = supplyArtifact(ctx.conn, ctx.storageRoot, engagementId, slot, canonicalBytes(parsed as never), {
      displayName: `${slot}-answers`,
      mediaType: 'application/json',
      createdBy: ACTOR,
    });
    attach(ctx.conn, run, ref.artifact_id, { source: 'user', createdBy: ACTOR });
    return;
  }
  m = line.match(DETACH_RE);
  if (m !== null) {
    const [, runAlias, slot] = m as unknown as [string, string, string];
    const run = need(state.runs.get(runAlias), `unknown run '${runAlias}'`, line);
    const members = userMembersOfSlot(ctx.conn, run, slot);
    if (members.length === 0) {
      throw harnessError(`detach in step '${line}': run has no user member of nodeparamslot '${slot}'`);
    }
    for (const artifactId of members) {
      detach(ctx.conn, run, artifactId);
    }
    return;
  }
  m = line.match(EXECUTE_RE);
  if (m !== null) {
    const alias = m[1] as string;
    const run = need(state.runs.get(alias), `unknown run '${alias}'`, line);
    const summary = await executeWorkflowRun(ctx.client, ctx.dbPath, run, ctx.taskQueue);
    state.executions.push({ alias, summary });
    return;
  }
  m = line.match(REPORT_RE);
  if (m !== null) {
    const alias = m[1] as string;
    const run = need(state.runs.get(alias), `unknown run '${alias}'`, line);
    const reports = workflowRunArtifacts(ctx.conn, run).filter((a) => a.nodeparamslot === 'final_report');
    const latest = reports.at(-1);
    if (latest === undefined) {
      throw harnessError(`report in step '${line}': run '${alias}' has no final_report member`);
    }
    const text = new TextDecoder().decode(readArtifactPayload(ctx.conn, ctx.storageRoot, latest.artifact_id));
    state.reports.push({ alias, text });
    return;
  }
  throw harnessError(`unrecognized step: '${line}'`);
}

export async function runScenario(ctx: ScenarioContext, scenario: ParsedScenario): Promise<string> {
  const state: RunnerState = {
    engagements: new Map(),
    runs: new Map(),
    executions: [],
    rejections: [],
    reports: [],
  };
  for (const step of scenario.steps) {
    if (!step.expectFail) {
      await runStep(ctx, state, step.command);
      continue;
    }
    let failed: Error | null = null;
    try {
      await runStep(ctx, state, step.command);
    } catch (e) {
      failed = e as Error;
    }
    if (failed === null) {
      throw new ValidationError(`step 'fail ${step.command}' was expected to throw, but succeeded`);
    }
    // A scenario-authoring mistake is not a product refusal: rethrow it so a typo'd fail step
    // can never mint a golden documenting a harness error as a guardrail.
    if (failed.message.startsWith(HARNESS)) {
      throw failed;
    }
    state.rejections.push({
      command: step.command,
      message: failed.message,
      code: failed instanceof RuntimeError && typeof failed.context?.code === 'string' ? failed.context.code : null,
    });
  }
  return render(ctx, scenario, state);
}

// ---------- rendering (everything below reads the db directly) ----------

const aliasOf = (state: RunnerState, workflowRunId: number | null): string => {
  if (workflowRunId === null) {
    return '—';
  }
  for (const [alias, id] of state.runs) {
    if (id === workflowRunId) {
      return alias;
    }
  }
  return `#${workflowRunId}`;
};

function render(ctx: ScenarioContext, scenario: ParsedScenario, state: RunnerState): string {
  const lines: string[] = [];
  const push = (s = ''): void => {
    lines.push(s);
  };

  push(`# ${scenario.title} — expected outcome`);
  push();
  push('> Generated by `DemoScenario.test.ts` from the matching `_input.md`. Do not hand-edit —');
  push('> regenerate with `GRAPHFLOW_UPDATE_DEMOS=1 npm run test -- src/demo/DemoScenario.test.ts`.');

  if (state.executions.length > 0) {
    push();
    push('## Executions');
    push();
    push('Node lists are SORTED here: `Summary` reports them in activity-completion order, and the');
    push('workflows run their document chains through `Promise.all`, so the live order varies run to');
    push('run — the multiset (which node ids, how many times) is the contract, not the order.');
    for (const e of state.executions) {
      push();
      push(`### execute ${e.alias}`);
      push();
      push('```');
      const pad = (n: number): string => String(n).padStart(2);
      const sorted = (ids: readonly string[]): string[] => [...ids].sort();
      push(`node bodies EXECUTED : ${pad(e.summary.executed.length)}  ${quotedList(sorted(e.summary.executed))}`);
      push(`memo HITS            : ${pad(e.summary.memo_hits.length)}  ${quotedList(sorted(e.summary.memo_hits))}`);
      push(`human questions asked: ${pad(e.summary.human_waits.length)}  ${quotedList(sorted(e.summary.human_waits))}`);
      push('```');
    }
  }

  push();
  push('## Workflow runs (read straight from the db)');
  push();
  push(
    '| run | id | workflow | lineage_kind | state | copied_from | root | lineage_byid | lineage_display | user docs | engine results |'
  );
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const engagementIds = [...state.engagements.values()].sort((a, b) => a - b);
  for (const engId of engagementIds) {
    for (const row of listWorkflowRuns(ctx.conn, engId)) {
      push(
        `| ${aliasOf(state, row.workflow_run_id)} | ${row.workflow_run_id} | ${row.workflow_id} ` +
          `| ${row.lineage_kind} | ${row.executed_at === null ? 'draft' : 'frozen'} ` +
          `| ${aliasOf(state, row.copied_from_workflow_run)} | ${aliasOf(state, row.root_workflow_run_id)} ` +
          `| ${row.lineage_byid} | ${row.lineage_display} | ${row.user_docs} | ${row.engine_results} |`
      );
    }
  }

  push();
  push('## Engagements');
  push();
  push('| engagement | workflow runs | artifacts | node runs | human answers |');
  push('| --- | --- | --- | --- | --- |');
  for (const [alias, engId] of state.engagements) {
    const s = stats(ctx.conn, engId);
    push(`| ${alias} | ${s.workflow_runs} | ${s.artifacts} | ${s.node_runs} | ${s.human_answers} |`);
  }

  if (state.rejections.length > 0) {
    push();
    push('## Rejected commands');
    for (const r of state.rejections) {
      push();
      push(`### fail ${r.command}`);
      push();
      push('```');
      push(r.message);
      if (r.code !== null) {
        push(`code: ${r.code}`);
      }
      push('```');
    }
  }

  for (const r of state.reports) {
    push();
    push(`## Final report — ${r.alias}`);
    push();
    push('```');
    for (const reportLine of r.text.replace(TRAILING_NEWLINE_RE, '').split('\n')) {
      push(reportLine);
    }
    push('```');
  }

  push();
  return lines.join('\n');
}
