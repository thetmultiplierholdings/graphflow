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
- Versioning is the filename: copy `workflows/tax_demo_workflow.py` to
  `..._v2.py` and only nodes whose source changed re-execute (per-node
  `code_hash` in the memo key).

## Setup

The Python backend lives in `backend/` (Python 3.11–3.13, managed by
[uv](https://docs.astral.sh/uv/)); the Next.js frontend in `frontend/`
(Node + npm). Credentials live in `backend/.env` (`TEMPORAL_ADDRESS`,
`TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `TEMPORAL_TASK_QUEUE`). Then:

```
cd backend
uv sync
uv run pytest                # tests (see "Testing" below)
uv run python cli.py demo    # full end-to-end story against real Temporal
```

`demo` runs an in-process worker + auto-approver (the mock HITL) and plays
three scenarios: January from scratch (6 human tasks), January re-run
(zero node bodies, zero humans), February = copy + 2 new documents
(only the marginal chains + fold + calculator + report execute).

## Running the API (+ frontend)

The FastAPI service (`api/`) is the HTTP face of the engine. It embeds the
Temporal worker by default and is the only process that talks to Temporal
(the browser never sees credentials):

```
cd backend
uv run python cli.py seed --fresh          # optional: seed the demo dataset
uv run uvicorn api.main:app --port 8000    # the API (+ embedded worker)

# in a second shell, from the repo root:
cd frontend
npm install
npm run dev                                # Next.js on :3000
```

Backend environment (all optional): `GRAPHFLOW_DB` (default
`graphflow.sqlite3`), `GRAPHFLOW_STORAGE` (default `mock_s3_gcs`),
`GRAPHFLOW_EMBED_WORKER` (default `1`; set `0` to run the worker separately
via `cli.py worker`), `GRAPHFLOW_CORS_ORIGINS` (default allows
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

## The mock bucket (`backend/mock_s3_gcs/`)

`mock_s3_gcs/` is a local directory standing in for an S3/GCS bucket
(`engine/storage.py`; path overridable via `GRAPHFLOW_STORAGE`). It is the
payload half of the database: artifact and node-run rows in SQLite hold
content hashes, while the actual bytes live at
`mock_s3_gcs/{engagement_id}/{sha256}`. A run mid-flight may also park
intermediate payloads there that no ledger row references yet — their
references live in durable Temporal state until the run completes, so
"unreferenced" files are not junk.

**Do you need to clear it before testing? No — never clear it by hand.**

- The pytest suites and the Playwright e2e suite each create their own
  scratch db + scratch storage dir (in tmp dirs / `mock_s3_gcs_e2e`) and
  delete them on teardown; they never touch `mock_s3_gcs/`.
- To reset the dev instance, use `uv run python cli.py seed --fresh`, which
  deletes the db and the bucket **together**.
- Deleting `mock_s3_gcs/` alone (or the db alone) leaves the other half
  dangling — ledger rows whose payloads 404, or orphaned bytes. The sqlite
  file and the bucket are one database; always reset them as a pair.

To run CLI pieces separately (all from `backend/`):

```
uv run python cli.py init        # create db + publish catalog
uv run python cli.py worker      # run the Temporal worker (leave running)
uv run python cli.py tasks       # list open human tasks
uv run python cli.py submit <task-workflow-id>   # approve one manually
uv run python cli.py show <workflow_run_id>      # workspace contents
uv run python cli.py download <artifact_id> out.txt
```

## Testing

Backend (from `backend/`):

```
uv run pytest
```

- `tests/test_canonical.py`, `tests/test_db.py` — pure unit tests: canonical
  JSON/hashing and ledger semantics (memoization, revive, attach/detach).
- `tests/test_api_crud.py` — API CRUD over a scratch db (no Temporal).
- `tests/test_api_integration.py` — the full story over **real Temporal
  Cloud**; auto-skipped when `TEMPORAL_API_KEY` is unset. Each run gets its
  own scratch db, storage dir, and a unique task queue, so it never touches
  the dev stack.

Frontend e2e (from `frontend/`, needs real Temporal credentials in
`backend/.env`):

```
npm run test:e2e
```

Playwright walks the whole product story against a **dedicated** stack —
API on :8100, Next dev on :3100, scratch db `graphflow_e2e.sqlite3`, storage
`mock_s3_gcs_e2e`, its own Temporal task queue — so it can run while the
live dev stack on :8000/:3000 is up. See `frontend/playwright.config.ts`.

## Layout

```
backend/                 the Python backend (run uv from here)
  engine/                the engine (no business logic)
    canonical.py         canonical JSON + hashing — the spec for a future TS port
    registry.py          @node / @human_node / @workflow_def, per-node code_hash
    db.py                SQLite ledger/workspace/catalog + completion transaction
    storage.py           payload store (mock_s3_gcs/{engagement}/{hash})
    context.py           Ctx: the memoize-or-execute walk (workflow-side)
    activities.py        every DB/storage/client touch (activity-side)
    temporal_workflows.py  GraphflowRun + GraphflowHumanTask (update-based submit)
    runtime.py           .env -> Temporal Cloud client, worker assembly
  api/                   FastAPI service (HTTP face of the engine)
    main.py              app + lifespan (init db, publish catalog, client, worker)
    deps.py              per-request db conn, ArtifactMeta/NodeRun mappers
    routes/              catalog, engagements, artifacts, workflow-runs, human-tasks
  workflows/             THE PRODUCT: one file per workflow version
    tax_demo_workflow.py   brokerage + payslip flows -> HITL -> fold -> 25% -> report
    tax_demo_workflow_v2.py  v2 = file copy, 24% rate (versioning is the filename)
  sample_docs/           mock "PDFs" (.txt) with transactions
  cli.py                 init / worker / demo / seed / tasks / submit / show / download
  tests/                 unit + API CRUD + real-Temporal integration tests
  .env                   Temporal + Anthropic credentials (never committed)
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
  Same story for the backend: `.venv/` is machine-specific — delete it and
  `uv sync`.
- **Runs hang at "running" forever**: check the Temporal credentials in
  `backend/.env` and that exactly one worker is polling your
  `TEMPORAL_TASK_QUEUE` (the API embeds one by default).
- **Stale state after experiments**: `uv run python cli.py seed --fresh`
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
  (`decimal.Decimal` in node bodies only) — deliberately TS-portable, no pandas.
