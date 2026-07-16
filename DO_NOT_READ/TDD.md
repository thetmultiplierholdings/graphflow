# Graphflow — Technical Design Document

*Status: draft v1 · 16 Jul 2026 · Companion schema: [`graphflow_v7.dbml`](graphflow_v7.dbml). The schema file is the precise definition; if this document disagrees with it, the DBML wins. `tax_engine_v3_3.dbml` and `tax_engine_explained.md` are historical and superseded.*

---

## 0. What this system is

Graphflow is a memoized computation engine for professional-service firms. Firms open **engagements**; inside an engagement they create **workspaces** (`workflow_runs`), attach documents, press Run, watch it execute, and download the results. Workflows themselves are **code files** written by engineers and deployed like any other software — users can never author or edit a graph.

Everything the engine has ever seen or computed is an immutable, content-addressed **artifact**. Every completed step is a **node_run** — a memo entry saying *this exact question produced this exact answer*, unique per engagement. That memo is the entire product, in one sentence: within an engagement, the same question — same node code, same input bytes — is never computed twice and never asked of a human twice; across engagements, nothing is ever shared.

### Design tenets (settled in prior design rounds; not up for casual re-litigation)

| # | Tenet |
|---|---|
| T1 | **Ledger vs workspace.** Facts (`artifacts`, `node_runs`, `node_run_inputs`) are insert-only forever. Workspaces (`workflow_runs`, `workflow_run_artifacts`) are editable intent. Nothing a workspace does can erase a fact. |
| T2 | **Hard engagement isolation.** The memo is `UNIQUE (engagement_id, memo_key)`; artifacts are `UNIQUE (engagement_id, kind, hash)`. No memo sharing, no artifact sharing, no lineage edges across engagements — ever. |
| T3 | **Memo sharing inside an engagement.** February reuses January's answers. A human reviewer is structurally unaskable twice for the same question in one engagement. |
| T4 | **The code is the DAG.** No wiring tables. A workflow file walks its own steps; the database records what actually happened. |
| T5 | **Versioning by filename.** A new workflow version is a new code file → a new `workflow_id`. No version tables. The memo keys on per-node `code_hash`, so unchanged nodes carry their answers across file copies. |
| T6 | **No workflow-level inputs/outputs.** Nodes have inputs and outputs. A workspace holds a flat set of artifacts, consumed or produced. Users rename, download, detach at will. |
| T7 | **Delete-and-revive.** User delete = detach from workspace. Reintroducing identical bytes lands on the same artifact row, so all prior work (including human reviews) revives via the memo with zero rework. |
| T8 | **Nothing pending in the database.** In-flight state lives in Temporal only. If a row exists in the ledger, the work is finished. |

### Glossary

| Business word | System object |
|---|---|
| Engagement | `engagements` row — the isolation boundary |
| "The January estimate" | a `workflow_runs` row (a workspace) plus the artifacts it holds |
| Document, statement, result, estimate | `artifacts` row (+ payload bytes in object storage) |
| A step ran / a reviewer answered | `node_runs` row |
| "Copy January into February" | new workspace with `copied_from_workflow_run` + copies of its *user-sourced* attachments |
| "Regenerate January" | re-run the same workspace (after swapping an attachment, or repointing `workflow_id` at a v2 file) |
| "Delete this document" | detach a `workflow_run_artifacts` row |

---

## 1. Architecture overview

```
                ┌─────────────────────────────────────────────────────┐
                │                       UI (React/TS)                 │
                │  engagements · attach/detach · run · watch · inbox  │
                └──────────────────────────┬──────────────────────────┘
                                           │ HTTPS
                ┌──────────────────────────▼──────────────────────────┐
                │                  API service (FastAPI)              │
                │  uploads/downloads · workspace ops · start runs ·   │
                │  human-task inbox (Temporal visibility) · signals   │
                └───────┬──────────────────┬──────────────────┬───────┘
                        │                  │                  │
              ┌─────────▼─────┐   ┌────────▼────────┐   ┌─────▼──────────┐
              │  PostgreSQL   │   │ Object storage  │   │   Temporal     │
              │ ledger +      │   │ payload bytes   │   │ everything     │
              │ workspace +   │   │ keyed by        │   │ in-flight;     │
              │ catalog mirror│   │ engagement/hash │   │ history=audit  │
              └─────────▲─────┘   └────────▲────────┘   └─────▲──────────┘
                        │                  │                  │
                ┌───────┴──────────────────┴──────────────────┴───────┐
                │            Workers (Temporal, per task queue)       │
                │  run workflow files · execute nodes · host human    │
                │  tasks · write completion transactions              │
                └──────────────────────────▲──────────────────────────┘
                                           │ deploy: migrate → publish
                ┌──────────────────────────┴──────────────────────────┐
                │   CI: tests → alembic migrate → catalog publish →   │
                │   deploy workers → deploy API                       │
                └─────────────────────────────────────────────────────┘
```

**Exactly one home per fact:**

| Store | Holds | Never holds |
|---|---|---|
| PostgreSQL | completed facts (ledger), current intent (workspace), deploy-time catalog mirror | anything pending or in-flight |
| Object storage | payload bytes, addressed by `{engagement_id}/{hash}` | metadata, lineage |
| Temporal | everything with a pulse: open runs, waiting human tasks, retries, timings, per-execution argument bindings | completed business facts |

---

## 2. Data model (ERD v7)

The full schema is [`graphflow_v7.dbml`](graphflow_v7.dbml) — nine tables: `engagements`; catalog mirror `workflows`, `workflow_kinds`, `nodes`; ledger `artifacts`, `node_runs`, `node_run_inputs`; workspace `workflow_runs`, `workflow_run_artifacts`.

### 2.1 Invariants

| # | Invariant |
|---|---|
| I1 | Ledger tables are insert-only. Sole carve-out: `artifacts.label` may be updated (display rename; never hashed). |
| I2 | A `node_run` is recorded only when complete, in ONE atomic transaction together with its output artifact, its input list, and its workspace attachment. The transaction is idempotent (unique constraints + `ON CONFLICT DO NOTHING`; retried safely). |
| I3 | One node_run produces exactly one artifact. A step whose outputs are consumed independently downstream is two steps. |
| I4 | Nothing pending is stored in Postgres. Open work exists only as Temporal workflows. |
| I5 | Memo lookups are always `(engagement_id, memo_key)`. No query path ever reads another engagement's rows. |
| I6 | Workspace edits (attach/detach/relabel/archive/repoint) never touch the ledger. |
| I7 | Only user-sourced attachments feed kind resolution when a run starts. Engine-sourced attachments are results on display. |

### 2.2 What changed from v6, and why (items 1–6 found while writing this TDD; 7–8 by the adversarial design review)

1. **`workflow_run_artifacts.source` (`user`/`engine`).** v6 had a latent bug: after a first run, the engine attaches produced intermediates to the workspace; on re-run, kind resolution would have seen those intermediates and short-circuited on stale values — every re-run would frozen-replay itself. Likewise copying a workspace would have carried January's *results* into February as if a user supplied them. Fix: resolution and copying consider `source = 'user'` rows only. A user attaching an artifact the engine already attached promotes the row to `user` (that's the "reintroduce as override" gesture); engine attaches never demote.
2. **`workflow_kinds.leaf`.** The UI needs to know which kinds belong on the default attach form (documents) versus which are intermediates a power user may attach deliberately as an override. CI derives it: leaf = consumed by the workflow, produced by none of its nodes.
3. **`nodes.output_kind`** (informational) — re-added so CI can derive `leaf` mechanically and the UI can label progress and results. The engine never reads it.
4. **`workflow_runs.archived_at`** — workspaces are never deleted (copied_from provenance must survive); archiving hides them.
5. **`artifacts.media_type`, `artifacts.byte_size`** — you cannot serve a download without a content type. Descriptive only, never hashed.
6. **Deferrable circular FK.** `artifacts.produced_by_node_run` and `node_runs.output_artifact_id` reference each other. Both are `DEFERRABLE INITIALLY DEFERRED` so the completion transaction can insert the pair atomically (§3.5).
7. **Content addressing now includes kind: `UNIQUE (engagement_id, kind, hash)`.** With `(engagement_id, hash)` alone, byte-identical content needed under two different kinds (a re-upload under the correct kind after a mislabel; two nodes producing identical degenerate output like `{"rows": []}` under different output kinds) silently landed on the first row's kind, and `ctx.attached(kind)` misrouted or missed it with no error. Same bytes under two kinds are now two rows. Delete-and-revive is unchanged: a revive re-supplies the same bytes under the same kind.
8. **The produced-by lineage edge existed only in a note.** `artifacts.produced_by_node_run` claimed an FK in prose but declared no `ref`; the DBML now declares it. Also added `idx_workspaces` on `workflow_runs (engagement_id, created_at)` — the engagement landing screen's query had no index.

---

## 3. Building the engine

### 3.1 Stack

| Choice | What | Why |
|---|---|---|
| Python 3.12 | engine SDK, workflow files, workers, API | matches how workflow authors already write (`.py` files copied to `_v2`); Temporal Python SDK is mature. A TypeScript SDK can follow — the canonicalization spec (§3.6) is deliberately language-neutral |
| Temporal | durable execution | survives crashes/deploys mid-run; human tasks that wait for days; dedupe by workflow id |
| PostgreSQL 16 | ledger + workspace + catalog | unique constraints ARE the memo; deferrable FKs for the completion transaction |
| S3-compatible object storage | payload bytes | ledger rows stay tiny; per-engagement prefixes ease retention and legal holds |
| FastAPI | API service | thin; all real logic lives in the SDK |
| Alembic | migrations | boring, standard |
| React + TypeScript | UI | out of scope for this document beyond the API it consumes |

### 3.2 Repository layout

```
graphflow/
├── pyproject.toml               # one Python project: engine, workflows, workers, api, catalog
├── engine/                      # THE ENGINE (SDK + runtime) — the only package with real logic
│   ├── __init__.py              # public API: workflow, node, human_node, Ctx, Artifact, HumanTask, Kind
│   ├── registry.py              # decorators + in-process registry (shared by CI publisher and workers)
│   ├── canonical.py             # canonical bytes + hashing — the most-tested file in the repo (§3.6)
│   ├── context.py               # Ctx: attached(), node(), user_supplied(); the memo-or-execute walk (§3.4)
│   ├── memo.py                  # activities: memo_lookup, record_completion, attach_to_workspace
│   ├── db.py                    # connections + the completion transaction (deferred FKs, §3.5)
│   ├── storage.py               # object storage IO ({engagement_id}/{hash})
│   ├── human.py                 # the human-task workflow, signal handling, poll helper (§3.7)
│   └── testing.py               # WorkflowHarness: Temporal test env + throwaway Postgres, for authors
├── workflows/                   # THE PRODUCT: one file per workflow version — copy file = new version
│   ├── uk_tax_workflow.py
│   ├── uk_tax_workflow_v2.py
│   └── shared/                  # helpers; a node folds these into its code_hash via hash_with=[...]
├── workers/
│   ├── compute_worker.py        # serves engine-node task queues (uk-tax, ocr-workers, ...)
│   └── human_worker.py          # hosts human-task workflows (queue: human-tasks)
├── catalog/
│   └── publish.py               # CI: import workflows/, extract nodes+kinds+hashes, upsert catalog mirror
├── api/
│   ├── main.py
│   └── routes/                  # engagements.py, artifacts.py, workflow_runs.py, human_tasks.py
├── db/
│   ├── graphflow_v7.dbml           # the ERD, source of truth for the diagram
│   └── migrations/              # alembic revisions
├── ui/                          # React/TS app
└── ops/
    ├── docker-compose.dev.yml   # postgres + temporal dev server + minio, one command to run locally
    └── deploy/                  # pipeline definition: test → migrate → publish catalog → workers → api
```

Two deliberate properties: **`workflows/` contains no engine logic** (a workflow file must stay copy-pasteable as a whole — that is the versioning mechanism), and **`engine/` contains no business logic** (the engine must stay generic; tax knowledge lives only in workflow files).

### 3.3 The SDK surface

```python
from engine import workflow, node, human_node, Ctx, Artifact, HumanTask, Kind
```

- `@node(output_kind=..., task_queue=None, hash_with=[], code_salt="", dedupe="none")` — registers an engine node. The function body is an ordinary async Python function executed inside a Temporal **activity** (it may do IO, call OCR services, etc.). `hash_with` lists the node's *value dependencies*, folded into its `code_hash`: helper **functions** (by dedented source) and **constants** — schemas, lookup tables, config values (by canonical JSON). `code_salt` forces a new hash when behavior changes outside anything the SDK can see (e.g. a backing model upgrade). `dedupe="hard"` opts an expensive node into the human-node start-dedupe mechanism (§3.4).
- `@human_node(output_kind=..., title=...)` — registers a human node. The function returns a `HumanTask` (instructions, payload to render, result schema); the engine turns it into a waiting Temporal workflow and an inbox entry.
- `@workflow(id=..., task_queue=..., kinds=[Kind("brokerage_statement", display="Brokerage statement"), ...])` — registers the workflow entrypoint. `id` must equal the filename stem (CI enforces). `kinds` declares the attachable vocabulary published to `workflow_kinds`; `ctx.attached()` on an undeclared kind raises at runtime.
- `Ctx` — handed to the workflow entrypoint:
  - `ctx.attached(kind) -> list[Artifact]` — the **user-sourced** attachments of that kind, sorted by content hash (deterministic).
  - `ctx.attached_one(kind) -> Artifact` — sugar; raises unless exactly one. `ctx.attached_one_or_none(kind)` — one or `None` (an absent optional attachment is a legitimate, memoizable question — §3.6 rule 7).
  - `ctx.user_supplied(kind)` / `ctx.user_supplied_one(kind)` — **pure aliases** of the `attached*` accessors (same user-sourced rows; an engine-produced artifact a user re-attached counts, because promotion marks it `source = user`). They exist so the override pattern (§4.5) reads as intent, not mechanism.
  - Contract errors from these accessors (undeclared kind, cardinality violation, zero attachments where one is required) raise **non-retryable `ApplicationError`s**: the run fails visibly (§3.7 run lifecycle) instead of retrying forever.
  - `await ctx.node(fn, *args, **kwargs) -> Artifact` — the heart of the engine: memoize-or-execute (§3.4).
- `Artifact` — an immutable handle `{artifact_id, hash, kind, label, media_type, payload_ref}`. Payload access (`await a.bytes()`, `await a.json()`) is only legal inside node bodies (activities), never in workflow code — the SDK enforces this, which keeps workflow code deterministic and Temporal payloads tiny (references only, never bytes).

### 3.4 `ctx.node()` — the memoize-or-execute walk

Runs inside the (deterministic) workflow; every DB/IO touch is an activity.

```
async def ctx.node(fn, *args, **kwargs):
    arg_map     = bind_signature(fn, args, kwargs)      # deterministic, in-workflow
    input_hash  = canonical_hash(arg_map)               # artifacts → their content hash (§3.6)
    memo_key    = H(fn.code_hash || input_hash)         # fn.code_hash baked in at deploy

    ref = await act.memo_lookup(engagement_id, memo_key)         # (engagement_id, memo_key) index
    if ref is None:
        if fn.executor == ENGINE:
            out = await act.execute_node(fn.node_id, arg_map)    # runs the node body; Temporal retries
            ref = await act.record_completion(                   # §3.5 — idempotent; returns the
                engagement_id, workflow_run_id, fn, memo_key,    # WINNING row on races
                out, input_artifact_ids)
        else:  # HUMAN
            await act.ensure_human_task(engagement_id, memo_key, fn, arg_map, workflow_run_id)
            #   signal-with-start: creates the task workflow (or attaches to it) AND subscribes this run
            ref = await wait_for_answer(engagement_id, memo_key)
            #   awaits the task's completion signal; 6-hour fallback memo poll as belt-and-braces (§3.7)
    await act.attach_to_workspace(workflow_run_id, ref.artifact_id, source='engine')  # idempotent
    return ref
```

Points that matter:

- **Memo hits also attach.** February memo-hitting January's OCR output still attaches that artifact to February's workspace — the workspace shows the full closure of what the run consumed or produced. Since each node's inputs are either user attachments (already members) or upstream outputs (attached as the walk reaches them), attaching each `ctx.node` result gives the closure inductively.
- **Engine nodes are plain activities, not dedicated workflows.** If two workspaces in one engagement ask the same *new* engine question concurrently, both may execute; the completion transaction lets exactly one become the fact and the other resolves to it (§3.5). Wasted effort at worst, never a wrong or duplicate fact. Nodes expensive enough to justify hard concurrent dedupe can opt into the human-node mechanism (`dedupe="hard"`, §3.3), which serializes by Temporal id.
- **Human nodes get hard dedupe always** — a duplicate ask is a correctness bug, not an efficiency bug. `ensure_human_task` signal-with-starts a standalone Temporal workflow with `workflow_id = 'node-{engagement_id}-{memo_key}'` and conflict policy *use-existing*: concurrent asks from any number of workspaces collapse into one waiting task. Because conflict policies only see *running* executions, the task workflow's **first step re-checks the memo** and self-completes instantly if the answer already exists — closing the race where a start lands just after the original task completed (§3.7). No reviewer can ever be shown an already-answered question.
- **Dynamic fan-out is a loop — or `asyncio.gather` for parallel chains.** Each `ctx.node` call is its own memo entry (one per statement), which is exactly what makes per-statement revival (T7) work. Independent chains (per-statement ocr → verify → income) should be *gathered* so human waits overlap instead of serializing the whole run behind each reviewer; Temporal's workflow event loop keeps `gather` deterministic (§4.2).

### 3.5 The completion transaction

The single most important write in the system (invariant I2). One transaction, safe to run twice, safe to race:

```sql
BEGIN;                                   -- FKs artifacts↔node_runs are DEFERRABLE INITIALLY DEFERRED

-- 1. Fast path: someone already answered this exact question.
SELECT nr.output_artifact_id INTO existing
  FROM node_runs nr WHERE nr.engagement_id = $eng AND nr.memo_key = $memo;
IF FOUND THEN
  INSERT INTO workflow_run_artifacts (...) ON CONFLICT (workflow_run_id, artifact_id) DO NOTHING;
  COMMIT; RETURN existing;
END IF;

-- 2. Slow path: file the fact.
next_id := nextval('node_runs_node_run_id_seq');

INSERT INTO artifacts (engagement_id, hash, kind, label, media_type, byte_size,
                       payload_ref, produced_by_node_run, created_by, created_at)
VALUES ($eng, $out_hash, $kind, $auto_label, ..., next_id, $actor, now())
ON CONFLICT (engagement_id, kind, hash) DO NOTHING;    -- byte-identical output of the SAME kind
SELECT artifact_id INTO out_id                         --   ⇒ share the row; produced_by keeps the
  FROM artifacts WHERE engagement_id = $eng            --   FIRST producer
   AND kind = $kind AND hash = $out_hash;

INSERT INTO node_runs (node_run_id, engagement_id, workflow_id, node_id,
                       code_hash, memo_key, output_artifact_id, temporal_id)
VALUES (next_id, $eng, $wf, $node, $code_hash, $memo, out_id, $temporal_id);
       -- no ON CONFLICT here: losing the memo race must ABORT (see below)

INSERT INTO node_run_inputs (node_run_id, artifact_id)
  SELECT next_id, unnest($input_artifact_ids) ON CONFLICT DO NOTHING;

INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at)
VALUES ($wfr, out_id, 'engine', 'engine', now())
ON CONFLICT (workflow_run_id, artifact_id) DO NOTHING;  -- never demotes an existing user row

COMMIT;
```

**Race analysis.** Two executions of the same new question commit concurrently: the second hits the unique violation on `(engagement_id, memo_key)` at commit, the whole transaction (including any artifact row it staged) rolls back, the activity retries, takes the fast path, and returns the winner's artifact. The deferred FKs exist precisely so the artifact→node_run→artifact cycle can be staged inside one transaction and judged only at commit. A crash between node execution and this transaction is a plain Temporal activity retry — idempotent by construction. If a nondeterministic node produced different bytes on the losing side, those bytes are discarded with the rollback; the engagement's fact remains singular.

**Auto-labels.** `$auto_label` is `{kind}_{ddmmyy}_{hhmmss}` (e.g. `uk_estimate_160726_143512`) — friendly enough to browse, and the user renames at will (the one mutable ledger column).

**`$temporal_id` format.** `{temporalWorkflowId}/{temporalRunId}/{activityId}` for engine nodes; `{temporalWorkflowId}/{temporalRunId}` for human tasks. The run id is mandatory: `wfrun-{id}` executes many times over a workspace's life, and the audit join from ledger to Temporal history (§3.7 retention) must land on the right execution.

### 3.6 Hashing and canonicalization (normative)

`H` = SHA-256, hex-encoded. Three fingerprints:

| Fingerprint | Definition |
|---|---|
| `artifacts.hash` | `H(payload bytes)`. For binary uploads: the raw file bytes. For structured node outputs: the canonical JSON bytes (below). |
| `code_hash` | `H(canonical decorator metadata (node_id, output_kind, executor) ‖ dedented source of the decorated function ‖ hash_with entries in declaration order — functions by dedented source, constants by canonical JSON ‖ code_salt)`. Renaming a kind or editing a schema constant therefore changes the hash even when the function body does not. Computed by the CI publisher **and** by workers at startup from the same registry code — they cannot drift. |
| `memo_key` | `H(code_hash ‖ input_hash)` where `input_hash = H(canonical JSON of the argument map)`. |

**Canonical JSON rules** (`engine/canonical.py`; language-neutral on purpose):

1. UTF-8; object keys sorted bytewise; no insignificant whitespace.
2. Strings NFC-normalized.
3. **Floats are banned** in hashed payloads; money and rates are decimal strings (`"34.50"`). The serializer rejects `float` outright — silent precision drift is a memo-killer.
4. Dates are `YYYY-MM-DD` strings; **wall-clock timestamps are banned inside payloads** (volatile ⇒ never byte-identical ⇒ memoization silently dies). Creation times belong in ledger columns, not in hashed bytes.
5. An artifact-valued argument serializes as `{"$artifact": "<content hash>"}` — never its id (ids differ across revives), never its label.
6. A list of artifacts serializes sorted by content hash. A node that genuinely needs order (rare) declares `ordered=True` on the parameter and the order is preserved and therefore hashed.
7. Empty/absent optional arguments serialize as `null` explicitly — "no payslip attached" is a legitimate, memoizable question.

Golden test vectors for all of the above live next to `canonical.py` and are the acceptance gate for any future TypeScript SDK.

### 3.7 Temporal topology

| Workflow | Temporal id | Policies | Purpose |
|---|---|---|---|
| Workspace run | `wfrun-{workflow_run_id}` | conflict: **use-existing**; reuse: allow-duplicate | double-clicking Run attaches to the running execution; re-running after completion starts fresh |
| Human task | `node-{engagement_id}-{memo_key}` | conflict: **use-existing**; reuse: allow-duplicate + **first-step memo check** | the same human question, asked from any workspace at any time, is one waiting task; a start landing after the answer already exists self-completes unseen |

- **Workspace run** (`temporal_workflow_type` from the catalog, on the workflow's `task_queue`): receives the snapshot of user-sourced attachments as references, then executes the author's code, which is just `ctx.node()` calls (§3.4).
- **Engine node execution** is an activity on the node's task queue with standard exponential retries.
- **Human task workflow** (queue `human-tasks`): its **first step re-checks the memo** and self-completes if the answer already exists (§3.4 — closes the start-after-completion race). Otherwise it registers search attributes (`EngagementId`, `NodeId`, `WorkflowId`, `Kind`, requesting `WorkflowRunId`) and waits. Submission is a **Temporal workflow update, not a signal** — updates are synchronous request/response, which schema validation needs: the handler validates the payload against the node's declared result schema and either *rejects* (the reviewer gets the error immediately, HTTP 422, and the task keeps waiting — nothing is silently discarded) or *accepts* (runs the completion transaction with `created_by = reviewer`, notifies subscribers, completes). Requesting runs **subscribe** at `ensure_human_task` time (signal-with-start) and await the completion signal, with a 6-hour fallback memo poll as belt-and-braces — a wait costs O(1) history events regardless of duration. (A naive 10-minute poll loop would burn ~720 history events per pending node per day and could cross Temporal's 50K-event hard limit during a long review backlog; notification is the primary mechanism for exactly that reason.)
- **The inbox is Temporal visibility, not a table** (invariant I4): "list open workflows of type `human-task` where EngagementId = …" *is* the task list. Assignment/claiming, if needed later, is an `assignee` search attribute updated by signal — still no table.
- **Payload discipline:** workflow histories carry artifact references only ({artifact_id, hash, kind}); bytes move between object storage and activities. Histories stay small; the 2MB Temporal payload ceiling stays distant.
- **Run lifecycle contract.** A workspace's status is derived, never stored (I4): `idle` (no execution yet) / `running` / `completed` / `failed`, from Temporal describe on `wfrun-{id}`. Runs fail visibly in exactly two ways: SDK contract errors (undeclared kind, cardinality violations, zero required attachments) raise non-retryable `ApplicationError`s that fail the run immediately; engine-node activities carry a default retry policy (exponential, max 5 attempts) plus a `NodeError` escape for permanently-bad inputs (a corrupt PDF should fail the run, not spin forever). Progress for watch-it-run is a Temporal **query**: `Ctx` maintains per-node counters (executed / memo-hit / waiting-on-human) inside the workflow; the SSE endpoint polls the query and terminates the stream with `finished` or `failed{error}`. Facts filed before a failure stay filed — fix the input, re-run, and the completed prefix memo-hits.
- **Re-run concurrency.** `POST /execute` while a run is open: if the user-attachment snapshot is unchanged, the call is idempotent (attaches to the running execution — double-click safety); if the snapshot differs, the API returns 409 with the option `?supersede=true`, which terminates the open run and starts fresh on the new snapshot. Termination is safe: completed facts are already filed (I2) and in-flight completion transactions are idempotent. A superseded run's human tasks stay open — another run may still want them; see §5.7 for the orphan case.
- **Retention:** Temporal history holds per-execution detail the ledger deliberately omits (who clicked, when, retries, argument bindings per keyword). Set namespace retention ≥ the audit horizon, or enable Temporal archival to object storage. `node_runs.temporal_id` is the join key from ledger to that detail.

### 3.8 API service

Thin translation layer; all invariants are enforced in the SDK/database, not in routes.

| Endpoint | Effect |
|---|---|
| `POST /engagements` | create engagement |
| `GET /engagements/{id}/artifacts?kind=&q=` | browse the pool (idx_browse) |
| `POST /engagements/{id}/artifacts` | upload: store bytes → `H(bytes)` → insert or land on the existing `(engagement, kind, hash)` row (the revive path); identical bytes under a *different* kind are a new row. Optional `workflow_run_id` attaches in the same call (source=user) |
| `GET /artifacts/{id}/download` · `PATCH /artifacts/{id} {label}` | download (media_type) · rename (the one mutable column) |
| `POST /engagements/{id}/workflow-runs {workflow_id, label, copy_from?}` | create workspace; `copy_from` copies **user-sourced** attachments only |
| `POST /workflow-runs/{id}/attachments {artifact_id}` · `DELETE .../attachments/{artifact_id}` | attach (insert or promote to user) · detach (the only DELETE in the system) |
| `PATCH /workflow-runs/{id} {label?, workflow_id?}` · `POST /workflow-runs/{id}/archive` | rename · repoint at v2 · hide |
| `POST /workflow-runs/{id}/execute` | 202 + temporal run id; StartWorkflow `wfrun-{id}` with the current user-attachment snapshot. Open run + same snapshot ⇒ idempotent; open run + changed snapshot ⇒ 409, retry with `?supersede=true` to terminate-and-restart (§3.7) |
| `GET /workflow-runs/{id}` · `GET /workflow-runs/{id}/progress` (SSE) | membership + derived status (`idle`/`running`/`completed`/`failed`); progress = the run's progress query joined with catalog `nodes` for display; stream ends with `finished`/`failed{error}` |
| `GET /human-tasks?engagement_id=` | Temporal visibility query (assignment/claiming deferred — §6 Q1) |
| `POST /human-tasks/{temporal_id}/submit {payload}` | **workflow update** (synchronous): 200 accepted · 422 schema-rejected (task keeps waiting; error returned to the reviewer) · 404 task already completed. Reviewer identity from the session |

Authentication/authorization is deliberately out of scope here (app-level; engagement-scoped permissions enforced at this layer).

### 3.9 The catalog publisher

`python -m catalog.publish workflows/` runs in CI on every deploy:

1. Imports every module in `workflows/`; the decorators populate the registry.
2. Verifies `@workflow(id=…)` equals the filename stem; verifies every `ctx.attached` kind is declared.
3. Computes each node's `code_hash` (§3.6); derives `workflow_kinds.leaf` (declared kinds minus the set of `output_kind`s in this file).
4. Upserts `workflows`, `workflow_kinds`, `nodes`. **Never deletes** — removed files simply stop receiving new runs; history keeps its referents.
5. **Guardrail:** if an existing `workflow_id` re-publishes with any changed `code_hash`, CI emits a loud warning: *in-place edit detected; consider copying to `_v2` — old workspaces pointing at this file will regenerate under different code.* The memo stays correct either way (changed hash ⇒ new memo keys); what in-place edits break is reproducibility-by-name.

Deploy order is mandatory: **migrate → publish catalog → deploy workers → deploy API** (the `node_runs → nodes` FK makes a worker running ahead of its catalog fail fast rather than file unattributable facts).

### 3.10 Object storage layout

`{bucket}/{engagement_id}/{hash}` — write-once objects (bucket policy denies overwrite), per-engagement prefix so retention, legal hold, and regulatory scrubbing operate on one prefix. A scrub deletes bytes but never rows: the ledger keeps hash, kind, lineage; `payload_ref` dangles by design and the API reports "payload destroyed per policy".

### 3.11 Build plan

| Milestone | Scope | Exit test |
|---|---|---|
| **M0 — walking skeleton** | schema migration; `canonical.py` + golden vectors; minimal SDK (`@node`, `@workflow`, `ctx.node` without memo); one toy workflow; compute worker; CLI to create engagement/workspace/run | toy workflow runs end-to-end locally via `docker-compose.dev.yml` |
| **M1 — the memo** | `memo_lookup`, completion transaction (deferred FKs), attach rules, auto-labels | run twice ⇒ second run executes **zero node bodies** (memo/attach activities still run); race test passes (§3.12) |
| **M2 — workspace & API** | upload/download/rename, attach/detach/promote, copy (user rows only), execute, SSE progress | February scenario (§5.3) green in integration tests |
| **M3 — humans** | human-node workflow, poll loop, visibility inbox, submit signal + schema validation | Priya scenario: HITL answered once, memo-hit from a copied workspace |
| **M4 — catalog & versioning** | CI publisher, leaf derivation, code_hash drift guardrail, deploy pipeline ordering | `_v2` copy of the toy workflow reuses all unchanged nodes' memo entries |
| **M5 — UI** | engagement browser, workspace screen, watch-it-run, inbox, downloads | pilot firm walkthrough |

### 3.12 Testing strategy

- **Canonicalization goldens** — byte-exact vectors (nesting, unicode, decimals, artifact refs, sorted lists, nulls); the contract for any second-language SDK.
- **Determinism/memo** — Temporal test environment (time-skipping): run a workflow twice, assert zero node-body executions on the second pass (memo/attach activities are expected); mutate one input artifact, assert exactly the affected suffix re-executes; assert early cutoff when a recomputed intermediate is byte-identical.
- **Isolation** — same workflow + same bytes in two engagements ⇒ two disjoint sets of rows, zero shared artifact_ids/node_run_ids.
- **Revive** — detach, re-run, re-upload same bytes, re-run ⇒ all original node_runs reused, including the human node; assert zero new `node_runs` rows in the final pass.
- **Crash/idempotency** — kill the worker between `execute_node` and `record_completion`; retry must yield exactly one fact set. Run `record_completion` twice deliberately; second call is a no-op returning the same ref.
- **Race** — two workspaces ask the same new question concurrently; assert one `node_runs` row, both workspaces attached to the same output.
- **Author-facing harness** (`engine.testing.WorkflowHarness`) — spins up throwaway Postgres + Temporal test env + fake human auto-approver; a workflow author builds a workspace with `h.workspace(attach=[...])`, calls `h.run(ws)`, and asserts on produced artifacts (§4.8).

---

## 4. How a workflow builder builds a workflow

### 4.1 The rules of the game

Workflow *types* are fixed software. Engineers write them, CI ships them, firms use them. A firm's users can create engagements and workspaces, attach data, run, watch, download, rename, detach — nothing else. If a firm needs a different graph, that is a feature request that ends in a new code file, not a UI gesture.

### 4.2 Anatomy of a workflow file

One file **is** one workflow version. Everything the file needs must live in the file or in `workflows/shared/` helpers explicitly folded into node hashes. The whole file must survive copy-paste-to-`_v2` intact — that is the versioning mechanism.

```python
# workflows/uk_tax_workflow.py
import asyncio
from engine import workflow, node, human_node, Ctx, Artifact, HumanTask, Kind
from workflows.shared import ocr_client, money

# ---------- nodes ----------

@node(output_kind="ocr_text", task_queue="ocr-workers", hash_with=[ocr_client.extract])
async def ocr_statement(statement: Artifact) -> dict:
    """Extract raw rows from one brokerage statement PDF."""
    pdf = await statement.bytes()
    return ocr_client.extract(pdf)                    # returns plain dict → canonical JSON artifact

@human_node(output_kind="verified_ocr", title="Verify OCR extraction",
            hash_with=[VERIFIED_OCR_SCHEMA])        # the schema is a value dependency: hash it
def verify_ocr(ocr: Artifact) -> HumanTask:
    return HumanTask(
        instructions="Compare extracted rows against the source PDF; correct any misreads.",
        payload={"ocr": ocr},                          # what the reviewer UI renders
        result_schema=VERIFIED_OCR_SCHEMA,             # submissions validated before acceptance
    )

@node(output_kind="investment_income", hash_with=[money.sum_dividends])
async def compute_income(verified: Artifact) -> dict:
    rows = await verified.json()
    return {"income": money.sum_dividends(rows)}       # decimals as strings — floats are rejected

@node(output_kind="uk_estimate")
async def compute_estimate(incomes: list[Artifact], payslip: Artifact | None,
                           rates: Artifact) -> dict:
    ...

# ---------- the workflow: plain code IS the DAG ----------

@workflow(
    id="uk_tax_workflow",                              # must equal the filename stem (CI enforces)
    task_queue="uk-tax",
    kinds=[
        Kind("brokerage_statement", display="Brokerage statement"),
        Kind("payslip",             display="Payslip"),
        Kind("rate_table",          display="Rate table"),
        Kind("investment_income"),                     # declared ⇒ attachable as an override (non-leaf)
    ],
)
async def run(ctx: Ctx):
    statements = ctx.attached("brokerage_statement")   # user-sourced, sorted by hash
    payslip    = ctx.attached_one_or_none("payslip")
    rates      = ctx.attached_one("rate_table")

    async def statement_chain(s):                      # dynamic fan-out: one memo entry per call
        text     = await ctx.node(ocr_statement, s)
        verified = await ctx.node(verify_ocr, text)    # human step — memoized like any other
        return await ctx.node(compute_income, verified)

    # parallel chains: reviewer waits overlap instead of serializing the run;
    # Temporal's workflow event loop keeps gather deterministic
    incomes = list(await asyncio.gather(*(statement_chain(s) for s in statements)))

    # override pattern (§4.5): a hand-built income supplied by a specialist wins
    supplied = ctx.user_supplied("investment_income")
    if supplied:
        incomes = supplied

    await ctx.node(compute_estimate, incomes, payslip, rates)
```

No return value, no "workflow outputs": every `ctx.node()` result is already attached to the workspace with an auto-label (T6). The user downloads whatever they care about.

### 4.3 Nodes: engine and human

- A node body is ordinary async Python running in an activity — do IO there freely; never in workflow code.
- **Granularity (invariant I3):** one node, one artifact. If two downstream consumers need different parts of a result, split the node (or add cheap extractor nodes) — otherwise editing either part disturbs consumers of the other.
- **Human nodes** define the *question* (payload + instructions) and the *acceptable answer* (result schema). The engine guarantees each distinct question is asked at most once per engagement — forever. Write instructions accordingly: they must make sense months later when a copied workspace surfaces the memoized answer instead of a fresh task.

### 4.4 Kinds

Kinds are strings owned by this file. They are namespaced by the workflow implicitly (T5) — `brokerage_statement` in `uk_tax_workflow_v2` shares nothing with any other file's `brokerage_statement`, even though copy-paste keeps them textually identical (which is what makes copied workspaces line up naturally). Declare every kind a user may attach; CI derives which are leaf (default attach form) versus intermediate (advanced/override form).

### 4.5 Resolution, fan-out, overrides

- `ctx.attached(kind)` sees **user-sourced attachments only** (invariant I7) — never the engine's own previous results, which is what makes re-running a workspace safe.
- Fan-out is a loop, or an `asyncio.gather` of per-item chains (§4.2); each `ctx.node` call is its own memo entry. Attach a third statement to a copied workspace and only its chain executes. Prefer `gather` whenever chains contain human steps, so reviews wait in parallel rather than gating one another.
- **Overrides are an authored pattern, not engine magic.** The engine will happily hand you a user-attached intermediate (`ctx.user_supplied(kind)`); *you* decide what it replaces, because only the author knows whether "a supplied investment_income" replaces all computed incomes, one of them, or nothing. Keep override semantics explicit and simple; if matching a specific item matters, match on payload content and document it in the node docstring.

### 4.6 The determinism checklist (memoization dies quietly without it)

1. No wall clock, no randomness, no environment reads inside node outputs — same inputs must yield byte-identical outputs, or memo hits and early cutoff evaporate.
2. No floats; decimals as strings (the serializer enforces).
3. No volatile fields (timestamps, uuids) inside payloads; provenance lives in ledger columns.
4. Workflow code (the `@workflow` body) does no IO — only `ctx.*` calls and pure logic; the Temporal sandbox enforces the rest.
5. Model/service-backed nodes (OCR, LLM calls) are honest about nondeterminism: pin model versions and bump `code_salt` when the backing service changes behavior. A nondeterministic node does not corrupt the ledger (the completion transaction keeps facts singular) but it forfeits early cutoff.
6. Declare value dependencies. A schema, lookup table, or config constant your node's behavior depends on must be listed in `hash_with` — the SDK hashes function sources and listed values, nothing else. If it is not in the hash, changing it will **not** invalidate old answers, and stale results will be served as current with no error anywhere.

### 4.7 Versioning: copy the file

1. `cp uk_tax_workflow.py uk_tax_workflow_v2.py`; change `id=` to match; edit what you must.
2. Deploy. CI publishes the new catalog rows; nothing else changes.
3. Nodes you did not touch keep their `code_hash` ⇒ existing memo entries in every engagement keep matching ⇒ regenerating a workspace under `_v2` re-executes **only** the changed nodes' questions. Human answers survive file copies.
4. Never edit a shipped file in place for behavior changes — CI will warn (§3.9). Old files are never deleted; they stop being offered for *new* workspaces (UI policy) while old workspaces keep their referent.

### 4.8 The author's dev loop

```python
def test_uk_tax_workflow():
    h = WorkflowHarness(uk_tax_workflow, human_answers={"verify_ocr": approve_as_is})
    ws = h.workspace(attach=[pdf("s1.pdf", kind="brokerage_statement"),
                             json_artifact(RATES_2026, kind="rate_table")])
    h.run(ws)
    est = ws.artifact("uk_estimate")
    assert est.json()["total"] == "11200.00"
    h.run(ws)                                  # second run:
    assert h.executed_nodes == []              # everything memo-hits
```

`docker-compose.dev.yml` gives authors real Postgres + Temporal + MinIO locally; the harness gives them fast in-memory tests with auto-answered human tasks.

---

## 5. How actual runs look

Cast: engagement **7** (*Acme Ltd — UK tax 2025/26*), workflow `uk_tax_workflow` (§4.2). Hashes are abbreviated symbolically (`h_s1`, …); memo keys as `mk(node, inputs)`.

### 5.1 January, from scratch

**Setup.** User creates workspace `wfr-1` (label *January estimate*), uploads statements S1, S2, rate table R1 (payslip arrives late — the workflow tolerates its absence). Rows after setup:

| artifacts | kind | produced_by | | workflow_run_artifacts (wfr-1) | source |
|---|---|---|---|---|---|
| a1 `h_s1` | brokerage_statement | NULL | | a1 | user |
| a2 `h_s2` | brokerage_statement | NULL | | a2 | user |
| a3 `h_r1` | rate_table | NULL | | a3 | user |

Uploading changed **nothing else** — no invalidation, no evaluation, no pending rows (T8).

**Run.** `POST /workflow-runs/1/execute` → 202, Temporal `wfrun-1`. The two statement chains proceed in parallel (`gather`, §4.2); per `ctx.node`:

| step | memo_key | lookup | action |
|---|---|---|---|
| ocr(S1) | `mk(ocr, h_s1)` | miss | activity runs → completion tx → `nr1` → artifact a4 (`ocr_text_150126_091412`) |
| verify(a4) | `mk(verify, h_a4)` | miss | human task `node-7-mk(verify,h_a4)` opens; workflow polls |
| ocr(S2) | `mk(ocr, h_s2)` | miss | → `nr2`, a5; second human task opens |

Priya opens her inbox (a Temporal visibility query), corrects a misread digit on S1's extraction, submits. The signal validates, the completion tx files `nr3` (output a6, `created_by = priya`), her task workflow completes; the poll loop finds the memo row. Same for S2 (`nr4`, a7). Then:

| step | result |
|---|---|
| income(a6) → `nr5`, a8 · income(a7) → `nr6`, a9 | |
| estimate([a8,a9], null, R1) → `nr7`, a10 `uk_estimate_150126_161203` | |

Workspace `wfr-1` now holds a1–a3 (user) and a4–a10 (engine). The user renames a10 to *"January estimate — sent to client"* and downloads it. Note what the ledger recorded about "January" as a period: **nothing**. It is a label on a workspace.

### 5.2 Watching it run

Progress = Temporal state of `wfrun-1` joined with catalog `nodes` for display names, streamed over SSE: *ocr_statement ✓ ✓ · verify_ocr ✓ ⏳ (waiting on human) · …* Artifacts pop into the workspace as each completion transaction lands. Nothing about progress is persisted in Postgres (I4).

### 5.3 February = copy of January + two PDFs

User copies January → `wfr-2` (*February estimate*, `copied_from = wfr-1`). The copy takes **user-sourced rows only**: a1, a2, a3. They upload payslip P1 (a11) and statement S3 (a12) into `wfr-2` and run:

| step | memo_key | result |
|---|---|---|
| ocr(S1), ocr(S2) | `mk(ocr,h_s1)`, `mk(ocr,h_s2)` | **hit** (`nr1`, `nr2`) — attach a4, a5 |
| verify × 2 | unchanged | **hit** (`nr3`, `nr4`) — *Priya is not asked; there is no task* |
| income × 2 | unchanged | **hit** (`nr5`, `nr6`) |
| ocr(S3) → verify → income | new keys | miss → `nr8`, `nr9` (human answers once), `nr10` |
| estimate([a8,a9,a15], **a11**, a3) | new key | miss → `nr11`, a16 |

The February estimate cost exactly the marginal work: one statement chain plus the final aggregate. T3 held not by policy but by the unique index: the verify questions for S1/S2 *cannot* be re-created in engagement 7.

### 5.4 Regenerate January — wrong statement

S2 was the wrong document. User uploads corrected S2′ (a17), and in `wfr-1` detaches a2, attaches a17, runs again:

- ocr(S2′) → miss → `nr12`, a18. verify(a18) → miss → a genuinely **new** question; the reviewer answers it (`nr13`, a19). Her January answer about the *old* S2 sits untouched in the ledger.
- income(a19) → suppose the late dividend was on page 3 and the corrected numbers happen to produce **byte-identical** income to a9 → same content hash → the artifact insert lands on the existing row → estimate's input set is unchanged → `mk(estimate, [a8,a9], null, h_r1)` → **hit** (`nr7`). **Early cutoff:** the change was absorbed the moment an intermediate came out identical; nothing downstream stirred.
- If income *did* change: only the estimate re-executes, producing a new `uk_estimate` artifact that appears beside the old one; the user renames/detaches as they see fit. The previously issued estimate remains in the workspace and the ledger, forever explainable via `node_run_inputs`.
- February still holds old a2 — untouched (T1). If February also needs the correction, the user makes the same swap there — a deliberate act, with its own audit trail.

### 5.5 Regenerate January — wrong code

The estimate node had a bug. Engineer copies the file → `uk_tax_workflow_v2.py`, fixes `compute_estimate`, deploys. Only that node's `code_hash` differs in the catalog. User repoints `wfr-1` to `uk_tax_workflow_v2`, runs:

- Every ocr/verify/income question carries an **unchanged** `code_hash` and unchanged inputs ⇒ all hit. Nobody re-reviews anything.
- `mk(estimate_v2_code, …)` ⇒ miss ⇒ one node re-executes ⇒ corrected estimate lands beside the old one.

One node re-ran to fix a code bug across an engagement's history. That is the entire payoff of keying the memo on code content instead of version labels.

### 5.6 Delete and revive

User detaches S1 from `wfr-1` and re-runs: the loop sees one statement (S2′), estimate recomputes over [income(S2′)] — new question, new artifact. Weeks later they re-upload the identical S1 PDF: `H(bytes) = h_s1` lands on **existing row a1**; attach; re-run: ocr(S1) hit (`nr1`), verify hit (`nr3` — Priya undisturbed), income hit, and the estimate question over both incomes is *the original* `mk(estimate, [a8,a9], …)` — **hit**. Every step, including the final aggregate, revived from the ledger. Zero new node_runs in the whole pass.

### 5.7 Failures and races

| Scenario | Outcome |
|---|---|
| Worker dies between node execution and completion tx | Temporal retries the activity; the tx is idempotent; exactly one fact set |
| Completion tx loses the memo race | unique violation ⇒ full rollback ⇒ retry takes the fast path ⇒ resolves to the winner (§3.5) |
| Two users double-click Run | same snapshot ⇒ idempotent attach to the running execution: one run |
| Re-run requested while a run is open, attachments changed | 409; explicit `?supersede=true` terminates the open run and restarts on the fresh snapshot (§3.7). An orphaned human task a reviewer answers anyway becomes a memoized fact that may never be consumed — accepted v1 cost; a janitor that cancels waiting tasks referenced by no open run is a later nicety |
| Engine node exhausts retries (corrupt PDF, dead OCR service) | run status `failed`; error surfaced via progress query / SSE terminal event; facts already filed stay filed — fix the input and re-run, the completed prefix memo-hits |
| Two workspaces ask the same new human question concurrently | `node-{eng}-{memo}` collapses to one waiting task; both runs are subscribed and notified once |
| Human task started just after its question was answered (race) | the task workflow's first-step memo check self-completes it before any reviewer sees it (§3.4) |
| Reviewer submits twice / stale tab | first accepted update completes the task; later updates hit a completed workflow → 404 at the API |
| Reviewer submits invalid payload | the workflow update is rejected synchronously → 422 with the validation error; task keeps waiting |
| Worker deployed before catalog publish | completion tx fails on the `nodes` FK — loud, immediate; fix the deploy order (§3.9) |
| In-place edit of a shipped workflow file | CI warns; memo stays correct (new code_hash ⇒ new questions); reproducibility-by-name degrades — the reason for the `_v2` convention |
| Temporal history pruned before audit horizon | ledger facts (question→answer, lineage) survive; per-execution detail (timings, retries, who clicked) is lost — set retention/archival accordingly (§3.7) |
| Regulatory scrub of payload bytes | object deleted under `{eng}/{hash}`; ledger row and lineage intact; downloads report "payload destroyed per policy" |

---

## 6. Operational notes and open questions

**Operations.** Postgres: PITR backups; the ledger is small (references, not bytes) — millions of node_runs is a modest database. Object storage: versioning off, overwrite denied, per-engagement prefixes for retention/holds. Temporal: retention ≥ audit horizon or archival on; visibility store sized for inbox queries. Metrics worth first-class dashboards: memo hit rate per workflow, human-task queue age (the v3.3 "stale for three days" question is now a Temporal visibility query), completion-tx retry rate (races), canonicalization rejects (float/timestamp violations caught in prod).

**Open questions** (deliberately small):

1. **Human task assignment** — v1 ships an unassigned pool per engagement (any authorized reviewer submits). Claiming/assignment via search attribute when a pilot firm asks.
2. **Payload inlining** — all payloads go to object storage in v1, even 200-byte JSON. If read latency ever matters, an inline-below-N-bytes column is a backward-compatible add.
3. **TypeScript workflow SDK** — deferred until a real TS workflow exists; the canonicalization goldens (§3.6) are the porting contract.
4. **Cross-workflow reuse inside one engagement** — two different workflow files never share memo entries (different `workflow_id` ⇒ nodes are distinct declarations with their own code_hash… unless the source is textually identical, in which case they *do* share, harmlessly and correctly). Flagged for awareness, not action.
