# Graphflow frontend ⇄ backend integration plan

*Working document, 16 Jul 2026. This file is the durable source of truth for the
integration work — implementation agents and future sessions execute from here.
Companion docs: [TDD.md](TDD.md) (§3.8 API design), [graphflow_v7.dbml](graphflow_v7.dbml).*

## Goal

Replace the frontend's client-side TypeScript engine simulation with real HTTP
calls to a new FastAPI service over the existing Python engine (`engine/` +
SQLite ledger + real Temporal Cloud via `.env`). Fix defects on both sides as
found. Finish with integration tests: pytest (API end-to-end through real
Temporal) and Playwright (browser end-to-end).

**Never print or commit the values in `.env`** (real Anthropic + Temporal keys).
Only the API process talks to Temporal; the browser never sees credentials.

## Topology (dev)

```
Next.js dev server (:3000)  ──HTTP──▶  FastAPI (:8000, uvicorn)
                                          │  embeds the Temporal worker by default
                                          │  (GRAPHFLOW_EMBED_WORKER=1)
                                          ├─▶ SQLite  (GRAPHFLOW_DB, default graphflow.sqlite3)
                                          ├─▶ mock_s3_gcs/ (GRAPHFLOW_STORAGE)
                                          └─▶ Temporal Cloud (.env creds; ids carry the
                                              instance prefix from the db meta table)
```

Run (backend commands from `backend/`): `uv run uvicorn api.main:app --port
8000`, then `cd frontend && npm run dev` from the repo root.
Optional seed (from `backend/`): `uv run python cli.py seed --fresh`.

## API contract (frozen — build against this)

Conventions: JSON, snake_case, integer ids (frontend client stringifies).
CORS allows http://localhost:3000. Errors: `{ "detail": string }`.
`ArtifactMeta` = `{artifact_id, engagement_id, hash, kind, label, media_type,
byte_size, produced_by_node_run, created_by, created_at, payload_available}` —
never the payload bytes.

| Endpoint | Behaviour |
|---|---|
| `GET /catalog` | `{workflows: [{workflow_id, display_name, task_queue, superseded_by, kinds: [{kind, display_name, leaf}], nodes: [{node_id, display_name, executor, output_kind, code_hash}]}]}`. `superseded_by` derived by filename convention: `X` is superseded by `X_v2` (highest `_vN` wins). |
| `GET /engagements` | `[{engagement_id, label, created_at, stats: {workspaces, artifacts, node_runs, human_answers}}]` |
| `POST /engagements {label}` | create → engagement row |
| `GET /engagements/{id}` | engagement + stats |
| `GET /engagements/{id}/artifacts?kind=&q=` | `[ArtifactMeta]`, newest first; `q` matches label/kind/hash substring |
| `POST /engagements/{id}/artifacts` | multipart: `file` (bytes), `kind`, `label?`, `workflow_run_id?` (attach source=user in same call). → `{artifact: ArtifactMeta, revived: bool}` (revived = landed on existing (engagement, kind, hash) row) |
| `GET /engagements/{id}/workflow-runs` | `[{workflow_run_id, engagement_id, workflow_id, label, copied_from_workflow_run, archived_at, created_by, created_at, user_docs, engine_results}]` (member counts; status fetched separately) |
| `GET /engagements/{id}/node-runs` | ledger facts, newest first: `[{node_run_id, workflow_id, node_id, code_hash, memo_key, temporal_id, input_artifact_ids, output: ArtifactMeta}]` (answered-by/when come from the output artifact) |
| `GET /artifacts/{id}` | `{artifact: ArtifactMeta, produced_by: NodeRunOut\|null, consumed_by: [NodeRunOut]}` (lineage for the preview drawer) |
| `GET /artifacts/{id}/content` | raw payload, `Content-Type` = media_type, Content-Disposition filename from label; **410** if payload destroyed |
| `PATCH /artifacts/{id} {label}` | rename (the one mutable ledger column) |
| `POST /engagements/{id}/workflow-runs {workflow_id, label, copy_from?}` | create workspace; copy takes user-sourced rows only |
| `GET /workflow-runs/{id}` | `{workspace fields..., members: [ArtifactMeta + {source, added_by, added_at}]}` |
| `PATCH /workflow-runs/{id} {label?, workflow_id?}` | rename / repoint |
| `POST /workflow-runs/{id}/archive {archived: bool}` | hide/unhide |
| `POST /workflow-runs/{id}/attachments {artifact_id}` | attach or promote to user → 204 |
| `DELETE /workflow-runs/{id}/attachments/{artifact_id}` | detach (the only delete) → 204 |
| `POST /workflow-runs/{id}/execute` | **202** `{temporal_workflow_id}`; StartWorkflow `wfrun-{instance}-{id}` conflict=USE_EXISTING with the current user snapshot; **422** if the workspace has no user attachments |
| `GET /workflow-runs/{id}/status` | `{status: "idle"\|"running"\|"completed"\|"failed", error: string\|null}` from Temporal describe (idle = never executed / not found) |
| `GET /workflow-runs/{id}/progress` | **SSE**. Every ~1s: `event: progress`, `data: {status, executed: [node_id], memo_hits: [], human_waits: [], error}` (cumulative arrays from the GraphflowRun `progress` query). Terminal event `finished` or `failed` then close. Frontend diffs snapshots to synthesise the event feed. |
| `GET /human-tasks?engagement_id=` | open tasks from Temporal visibility (`WorkflowType = 'GraphflowHumanTask'`, Running, id prefix `node-{instance}-`), each enriched via the `task_info` query: `{task_id (temporal wf id), engagement_id, workflow_id, node_id, output_kind, display_name, instructions, payload (artifact values as {__artifact__: ref}), result_required_keys, requested_by_workflow_run, input_artifact_ids, start_time}` |
| `POST /human-tasks/{task_id}/submit {reviewer, result}` | Temporal workflow **update**: 200 `{artifact: ArtifactMeta}` · **422** on validator rejection (message in detail; task keeps waiting) · **404** if task not found/already completed |

## Backend work

1. **Bug fix — `hash_with=[TAX_RATE]` on `calculate_tax`** in
   `workflows/tax_demo_workflow.py`. Without it, a copied file with a changed
   rate keeps the same code hash and v2 silently memo-hits v1's answers
   (violates TDD §4.6 #6). This changes v1's hash — acceptable, it is a bug fix.
2. **`workflows/tax_demo_workflow_v2.py`** — literal file copy per §4.7:
   `id="tax_demo_workflow_v2"`, `TAX_RATE = "0.24"`, report line says `24%`.
   With fix (1), only `calculate_tax` (rate in hash_with) and `build_report`
   (edited literal in source) get new hashes — all other nodes share memo.
3. **`workflows/__init__.py` → `load_all()`** importing every workflow module;
   used by `cli._publish`, `runtime.build_worker`, API startup (registry must
   contain both versions everywhere).
4. **`engine/runtime.py`**: split `start_workspace(client, db_path, id) -> handle`
   (fire-and-forget, USE_EXISTING) out of `execute_workspace` (CLI keeps awaiting).
5. **`engine/db.py` read helpers**: `list_engagements`, `get_engagement`,
   `list_workspaces(eng)` (+user/engine member counts), `list_node_runs(eng)`
   (+input ids), `artifact_lineage(artifact_id)`, `catalog_snapshot()` (from
   mirror tables), and `supply_artifact` gains an `existed` flag in its return.
6. **`api/` package** (FastAPI): `main.py` (lifespan: init_db + publish catalog +
   Temporal client + optional embedded worker; CORS), `deps.py` (db conn per
   request, client, instance, env config), `routes/` per the contract,
   `schemas.py` (pydantic). Env: `GRAPHFLOW_DB`, `GRAPHFLOW_STORAGE`,
   `GRAPHFLOW_EMBED_WORKER` (default 1). No secrets in logs.
7. **`cli.py seed [--fresh]`**: `--fresh` deletes db+mock_s3_gcs. Then:
   engagement "Acme Ltd — UK Tax FY 2025/26" → January workspace + 6 docs →
   execute via in-process worker + auto-approver (reviewer "Priya Sharma") →
   rename report → February = copy + `extra_ubs` + `extra_payslip_apr` (not run)
   → engagement "Blue Harbour LLP — UK Tax FY 2025/26" + workspace + 2 new
   sample docs (`bh_schwab.txt`, `bh_payslip_feb.txt`, add to `sample_docs/`) →
   START its run and leave it waiting on the 2 verify tasks (durable in
   Temporal; they appear in the inbox — real, not staged).
8. **pyproject**: add `fastapi`, `uvicorn`, `python-multipart`; dev group adds
   `httpx`, `pytest-asyncio`.

## Frontend work

Source of truth moves to the API. Delete the TS engine simulation:
`src/lib/graphflow/{engine,walk,canonical,sha256,ledger-ops}.ts`,
`src/lib/seed/graphflow-seed.ts`, `GraphflowHydrator`, all zustand persistence, and
the sidebar "Reset Demo Data" (reset = `cli.py seed --fresh`). Keep
`sample-docs.ts` (attach dialog uploads them via API) and `format.ts`.

1. **`src/lib/api/client.ts`** — typed fetch wrapper, base URL
   `NEXT_PUBLIC_GRAPHFLOW_API` (default `http://localhost:8000`); converts ids to
   strings and snake_case → camelCase into the existing schema shapes.
   `Artifact.payload` is gone → `payloadAvailable: boolean`; content fetched via
   `fetchArtifactContent(id): Promise<string>`.
2. **Stores become server mirrors** (same state shapes so pages survive):
   - `ledger-store`: no persist/seed; async refreshers `refreshEngagements()`,
     `refreshEngagement(id)` (engagement + workspaces + pool + node runs),
     `refreshWorkspace(id)` (workspace + members). Mutating actions call the
     API then refresh the affected slice. Workspace statuses cached in-store
     from `/status` / progress stream.
   - `human-task-store`: `refreshTasks()` from `GET /human-tasks`; polled
     (sidebar badge ~5s, inbox ~3s).
   - `catalog-store` (new): hydrated once from `GET /catalog`; `getWorkflow`,
     `kindDisplay`, `leafKinds` helpers move here (kind-badge, attach dialog,
     catalog page consume it).
   - `run-store`: same shape. Fed by an `EventSource` on
     `/workflow-runs/{id}/progress`: tallies from cumulative arrays, event feed
     synthesised from snapshot deltas. On workspace mount: `GET /status`; if
     running, re-attach the stream (runs now survive reloads — better than the
     prototype).
3. **`src/lib/api/operations.ts`** replaces `engine.ts` exports:
   `executeWorkspace(id)` (POST execute + attach progress stream + refresh
   members on ticks/terminal), `submitHumanTask(taskId, result, reviewer)`
   (maps 422 to `{ok:false,error}`), `buildAutoApproval(task)` (fetches OCR
   content via API).
4. **Component/page adjustments**: preview sheet + review dialog fetch payload
   content async (loading states); downloads hit `/artifacts/{id}/content`;
   engagement entity is now `{id, label, createdAt}` (drop clientName/createdBy;
   New Engagement dialog = one label field); pages fetch on mount + poll while
   runs are active; async actions await API before navigating.
5. Keep the review-dialog validation and the New-Workspace superseded filter
   (now driven by catalog-store data).

## Integration tests

1. **`tests/test_api_crud.py`** (no Temporal): CRUD + revive on identical
   upload + promote/detach + copy-user-rows-only + catalog endpoint, and the
   versioning assertion: v2 shares every node hash with v1 EXCEPT
   `calculate_tax` and `build_report` (locks in the hash_with fix).
2. **`tests/test_api_integration.py`** (`@pytest.mark.integration`, skips
   without `TEMPORAL_API_KEY`): httpx ASGI client + embedded worker + an
   API-driven auto-approver (list tasks → fetch OCR content → submit). Story:
   create → upload → execute (202) → tasks appear → approve → completed →
   report totals correct → **re-execute: progress shows 0 executed** → copy +
   extra doc → execute → only marginal chains execute. Temp db/storage via env.
3. **Playwright `frontend/e2e/graphflow.spec.ts`**: `webServer` starts uvicorn
   (temp db) + next dev. Browser story: create engagement → workspace → attach
   sample docs → Run → inbox task appears → approve → report renders → re-run
   shows all memo hits.

## Execution order

Phase A (inline): backend fixes 1–5 + pyproject + `uv sync` + existing pytest green. **DONE.**
Phase B (parallel agents): B1 = `api/` package + seed command; B2 = frontend swap.
Phase B.5 (user-requested): adversarial review dedicated to **backend responsibilities
leaking into the frontend** — any remaining client-side hashing/memo/ledger/engine
logic, invented data the API should own, business rules living in components.
Verified findings get fixed before Phase C.
Phase C: wire together, run everything live in the browser, fix as needed.
Phase D: tests (pytest suites + Playwright), then a review pass over the diff.

## Standing directives (from the user, 16 Jul 2026)

- **The SQLite db is disposable** — nuke freely (`cli.py seed --fresh`), never
  spend effort on data migration. This is the 0→1 lead-up.
- Frontend must have **no smell of doing the backend's job**: no hashing, no
  memo keys, no ledger writes, no engine walks, no seed fabrication client-side.

## Feature: Workflow Catalogue graph view (user request, 16 Jul 2026 — runs AFTER Phase D)

Rework `/catalog`: a **workflow dropdown** (from catalog-store) replaces the
all-workflows list; below it, for the selected workflow: a **graph view** of
the DAG plus the existing nodes/kinds tables (keep the superseded/current
badges and the code-hash comparison column).

Graph = a **hand-crafted static SVG**, not a graph library (explicitly: demo
only; the future is probably ReactFlow — do not build for it). Authored by a
design subagent, stored as a React component wrapping inline SVG at
`frontend/src/app/components/workflow-graphs/tax-demo-workflow.tsx` so it can
use the semantic CSS tokens (dark mode works); parameterised only by the rate
label ("25%" / "24%") so v1/v2 share one file; the calculate_tax node gets a
"changed in v2" visual accent when rendering v2. A registry maps workflow_id →
graph component, with a graceful "No diagram available for this workflow yet"
empty state for unknown ids.

The diagram depicts the real DAG shape (from workflows/tax_demo_workflow.py):
brokerage statements (×N) and payment slips (×N) → per-document OCR (engine) →
Verify OCR extraction (HUMAN — visually distinct) → all chains converge into
Append to master list (FOLD) → Calculator (rate label) → Combined report.
Annotate executor type per node and leaf-document vs intermediate kinds on the
edges; show the fan-out with stacked cards + "×N".
