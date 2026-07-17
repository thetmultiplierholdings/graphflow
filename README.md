# graphflow v0

Engagement-scoped, memoized workflow engine: **SQLite ledger + real Temporal
execution + workflows baked in code.**

## What it guarantees

- Within an engagement, the same question — same node code, same input bytes —
  is **never computed twice and never asked of a human twice**
  (`UNIQUE (engagement_id, memo_key)`).
- Across engagements, **nothing is ever shared**.
- The ledger (`artifacts`, `node_runs`, `node_run_inputs`) is insert-only;
  the only user-facing delete is detaching an artifact from a workspace, and
  reintroducing the same bytes **revives** all prior work (human reviews included).
- Versioning is the filename: copy `workflows/tax_demo_workflow.ts` to
  `..._v2.ts` and only nodes whose source changed re-execute (per-node
  `code_hash` in the memo key, from build-time hashing of the authored source).

## Setup

The TypeScript backend lives in `backend_typescript/` (Node 22+, npm); the
Next.js frontend in `frontend/` (Node + npm). Credentials live in
`backend_typescript/.env` (`TEMPORAL_ADDRESS`,
`TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `TEMPORAL_TASK_QUEUE`). Then:

```
cd backend_typescript
npm install
npm run check          # typecheck + tests + lint + code-hash freshness
npm run cli -- demo    # full end-to-end story against real Temporal
```

`demo` runs an in-process worker + auto-approver (the mock HITL) and plays
three scenarios: January from scratch (6 human tasks), January re-run
(zero node bodies, zero humans), February = copy + 2 new documents
(only the marginal chains + fold + calculator + report execute).

## Running the API (+ frontend)

The Fastify service (`src/api/`) is the HTTP face of the engine. It embeds
the Temporal worker by default and is the only process that talks to
Temporal (the browser never sees credentials):

```
cd backend_typescript
npm run seed -- --fresh    # optional: seed the demo dataset
npm run dev                # the API on :8000 (+ embedded worker)

# in a second shell, from the repo root:
cd frontend
npm install
npm run dev                # Next.js on :3000
```

Backend environment (all optional): `GRAPHFLOW_DB` (default
`graphflow.sqlite3`), `GRAPHFLOW_STORAGE` (default `mock_s3_gcs`),
`GRAPHFLOW_EMBED_WORKER` (default `1`; set `0` to run the worker separately
via `npm run worker`), `GRAPHFLOW_CORS_ORIGINS` (default allows
`http://localhost:3000`).

Frontend environment: `NEXT_PUBLIC_GRAPHFLOW_API` (default
`http://localhost:8000`; see `frontend/.env.example`). No frontend `.env` is
needed when the backend runs on the default port.

`seed` builds the demo dataset: engagement "Acme Ltd" with an executed
January workspace (human reviews auto-approved as "Priya Sharma", report
renamed) plus a staged, unexecuted February copy; and engagement
"Blue Harbour LLP" whose Q1 run is started and left durably waiting on its
2 verify tasks — they appear in the inbox and are served by the API's
embedded worker. `--fresh` first terminates the old instance's open Temporal
runs, then deletes the db (+ `-wal`/`-shm`) and the payload store
(`mock_s3_gcs/`), re-creates the schema, and reseeds.

## The mock bucket (`backend_typescript/mock_s3_gcs/`)

`mock_s3_gcs/` is a local directory standing in for an S3/GCS bucket
(`src/infrastructure/storage/Storage.ts`; path overridable via `GRAPHFLOW_STORAGE`). It is the
payload half of the database: artifact and node-run rows in SQLite hold
content hashes, while the actual bytes live at
`mock_s3_gcs/{engagement_id}/{sha256}`. A run mid-flight may also park
intermediate payloads there that no ledger row references yet — their
references live in durable Temporal state until the run completes, so
"unreferenced" files are not junk.

**Do you need to clear it before testing? No — never clear it by hand.**

- The Vitest suites and the Playwright e2e suite each create their own
  scratch db + scratch storage dir (in tmp dirs / `mock_s3_gcs_e2e`) and
  delete them on teardown; they never touch `mock_s3_gcs/`.
- To reset the dev instance, use `npm run seed -- --fresh`, which
  deletes the db and the bucket **together**.
- Deleting `mock_s3_gcs/` alone (or the db alone) leaves the other half
  dangling — ledger rows whose payloads 404, or orphaned bytes. The sqlite
  file and the bucket are one database; always reset them as a pair.

To run CLI pieces separately (all from `backend_typescript/`):

```
npm run cli -- init        # create db + publish catalog
npm run worker             # run the Temporal worker (leave running)
npm run cli -- tasks       # list open human tasks
npm run cli -- submit <task-workflow-id>   # approve one manually
npm run cli -- show <workflow_run_id>      # workspace contents
npm run cli -- download <artifact_id> out.txt
```

## Testing

Backend (from `backend_typescript/`):

```
npm run test
```

- `Canonical.test.ts`, `DecimalString.test.ts`, `Db.test.ts`,
  `Registry.test.ts`, `Storage.test.ts`, `Env.test.ts` — pure unit tests:
  canonical JSON/hashing, decimal-string arithmetic, and ledger semantics
  (memoization, revive, attach/detach).
- `ApiCrud.test.ts` — API CRUD over a scratch db (stub Temporal gateway).
- `ApiIntegration.test.ts` — the full story over **real Temporal Cloud**;
  auto-skipped when `TEMPORAL_API_KEY` is unset. Each run gets its own
  scratch db, storage dir, and a unique task queue, so it never touches the
  dev stack.

Frontend e2e (from `frontend/`, needs real Temporal credentials in
`backend_typescript/.env`):

```
npm run test:e2e
```

Playwright walks the whole product story against a **dedicated** stack —
API on :8100, Next dev on :3100, scratch db `graphflow_e2e.sqlite3`, storage
`mock_s3_gcs_e2e`, its own Temporal task queue — so it can run while the
live dev stack on :8000/:3000 is up. See `frontend/playwright.config.ts`.

## Layout

```
backend_typescript/      the TypeScript backend (run npm from here)
  src/domain/            pure, bundle-safe engine core (no node:*, no framework)
    canonical/           canonical JSON + hashing — the memoization contract
    registry/            defineNode / defineHumanNode / defineWorkflow + buildRegistry
    money/               BigInt decimal-string arithmetic (no floats, ever)
    artifact/            ArtifactRef + ArtifactHandle (loader-injected payload access)
  src/workflows/         THE PRODUCT: one file per workflow version
    tax_demo_workflow.ts   brokerage + payslip flows -> HITL -> fold -> 25% -> report
    tax_demo_workflow_v2.ts  v2 = file copy, 24% rate (versioning is the filename)
  src/temporal/          Context (the walk) + Workflows (bundle entry) + Activities + Runtime
  src/infrastructure/    env, SQLite ledger + completion transaction, payload store
  src/api/               Fastify service (HTTP face of the engine)
  src/cli/               init / worker / demo / seed / tasks / submit / show / download
  src/generated/         CodeHashes.ts — emitted by `npm run gen:hashes`, checked in
  scripts/               generate-code-hashes.ts (ts-morph) + cleanup-temporal.ts (e2e)
  sample_docs/           mock "PDFs" (.txt) with transactions
  .env                   Temporal credentials (never committed)
frontend/                Next.js 16 UI (talks to the API over HTTP only)
  src/app/               pages: engagements, workspaces, inbox, catalog
  src/lib/               api client (the wire boundary), zod schemas, zustand stores
  e2e/                   Playwright suite + scratch-stack cleanup helpers
```

## Troubleshooting

- **Frontend 500s on every page with `Cannot find module
  '../lightningcss.darwin-arm64.node'`** (or `next: Permission denied`):
  the `node_modules/` tree was built on a different machine/platform.
  Delete `frontend/node_modules` and `frontend/.next`, then `npm install`.
  Same story for the backend: `node_modules/` is machine-specific — delete it
  and `npm install` (native modules like better-sqlite3 rebuild).
- **Runs hang at "running" forever**: check the Temporal credentials in
  `backend_typescript/.env` and that exactly one worker is polling your
  `TEMPORAL_TASK_QUEUE` (the API embeds one by default).
- **Stale state after experiments**: `npm run seed -- --fresh`
  resets db + payload store and terminates the old instance's open runs.

## Notes / deliberate v0 deviations

- Object storage is a local directory; Postgres is SQLite (deferred circular
  FK works the same way; `BEGIN IMMEDIATE` + MAX+1 replaces `nextval`).
- The requester waits for human answers with a short-capped poll
  (1s → 30s) instead of subscribe/notify — fine at demo scale,
  swap in signal-with-start notification before month-long review queues.
- The human-task inbox is a Temporal visibility query filtered by
  `TaskQueue` + workflow-id instance prefix (the namespace may be shared).
- Re-executing a workspace while a run is open: unchanged attachments attach
  idempotently (double-click safety); changed attachments error unless you
  pass `supersede=True` to `execute_workspace`, which terminates the stale
  run and restarts on the fresh snapshot.
- No floats anywhere in payloads; money is decimal strings end to end
  (BigInt-backed `DecimalString` helpers in node bodies only).
