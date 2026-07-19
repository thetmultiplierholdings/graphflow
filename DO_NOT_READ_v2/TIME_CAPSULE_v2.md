# TIME_CAPSULE_v2 — graphflow design record, re-verified

Date: 2026-07-19. Supersedes TIME_CAPSULE.md (2026-07-18).

Provenance: every claim below was re-verified against the source on disk in `backend/src` and
`frontend/src` — five parallel audit agents over disjoint claim clusters, plus direct re-reads of
Db.ts, Context.ts, Workflows.ts, Activities.ts, Runtime.ts, Ids.ts, Canonical.ts, Storage.ts, and
WorkflowRuns.ts. `legacy/`, `Q&A.md`, and the deleted ELI5 documents were not consulted. Anchors
are file path + symbol name, not line numbers, because line numbers rot with every edit. Where a
v1 claim initially failed verification, the resolution is recorded inline. Revised on 2026-07-19
after commit e2493cf restored the env module; every claim below is checkable against source on
disk.

## What changed since v1

Everything v1 claimed about the code was confirmed unchanged except the two items below; wording
corrections are applied inline where v1 was imprecise.

1. `backend/src/infrastructure/env/Env.ts` was missing when this audit began — and had never
   been committed in the repository's entire history (`git log --all -- '*Env.ts'` was empty):
   the repo-root .gitignore carried an unanchored `env/` pattern, aimed at Python virtualenvs,
   which also matched `backend/src/infrastructure/env/` and silently excluded the module from
   every commit, including the monorepo port (commit 1a755eb). With the file absent, the ten
   files importing `Env`/`loadEnv`/`parseEnv` failed `npm run typecheck` with eleven TS2307
   errors — no fresh clone of this repository could ever build the backend; the module existed
   only in working copies. Fixed in commit e2493cf: the pattern is anchored to the repo root
   (`/env/`), Env.ts and Env.test.ts are tracked, and typecheck passes clean. Recorded here
   because the v1 claims anchored to Env.ts were unverifiable in the interim; all are re-verified
   below (P1.7, P7.1, P9.4).
2. `backend/src/workflows/tax_demo_workflow_v2.ts` is new (it arrived with the monorepo port,
   commit 1a755eb): a copy of tax_demo_workflow.ts with
   `TAX_RATE` changed from '0.25' to '0.24' and a new workflow id, node bodies byte-identical —
   its header comment says the copy-paste is deliberate so unchanged nodes keep their memo hits.
   It is registered in `ALL_WORKFLOWS`
   (backend/src/workflows/index.ts) as a second catalog workflow. It is not a new Temporal
   workflow type — its catalog row still dispatches as `GraphflowRun`. This is the exact
   copy-to-_v2 flow that the in-place-edit warning in `publishCatalog` (Db.ts) recommends, now
   exercised for real.

## The data model

The database is one SQLite file (`connect`/`initDb` in backend/src/infrastructure/db/Db.ts),
ten tables, in three layers with three different costs of being wrong:

| Layer | Tables | Write discipline | Cost of schema mistakes |
|---|---|---|---|
| Catalog | `workflows`, `workflow_kinds`, `nodes` | Republished from the binary by `publishCatalog` (Db.ts) on every boot/publish — upsert, never delete | Normal migrations — the catalog is an FK parent of the ledger and keeps retired rows the binary cannot regenerate, so it cannot be dropped and rebuilt (P2.0) |
| Workspace | `workflow_runs`, `workflow_run_artifacts` | Editable rows; `detach` (Db.ts) is the only DELETE statement in the backend | Normal migrations |
| Ledger | `artifacts`, `node_runs`, `node_run_inputs` | Insert-only; `renameArtifact` (Db.ts) — artifacts.label — is the only UPDATE that touches a ledger table | Permanent once real engagements accumulate |

The remaining two tables: `engagements` (the boundary object) and `meta`, which holds a single
key, `instance_id` (`initDb`/`instanceId` in Db.ts).

Core mechanics, each re-verified:

- Questions and answers. `node_runs.memo_key` is the fingerprint of a question:
  `memoKey(codeHash, inputHash)` in backend/src/domain/canonical/Canonical.ts computes
  sha256 over the code hash concatenated with the hash of the canonicalized argument map.
  The argument map is built by `encodeArgs` in backend/src/temporal/Context.ts, where an
  artifact-valued argument appears as `{$artifact: <content hash>}` — its id, path, and history
  never enter the hash. `artifacts.hash` is the fingerprint of an answer: sha256 over the payload
  bytes (`supplyArtifact` and `recordCompletion` in Db.ts).
- The next question is built from the previous answer's content, not its history. That is why
  reruns are free (same bytes in, same memo key out), why different questions converge on one
  stored answer (`recordCompletion` inserts the output artifact with
  `ON CONFLICT(engagement_id, kind, hash) DO NOTHING`), and why an upstream code change whose
  output is byte-identical does not invalidate downstream work. Provenance is recorded in columns
  only — `node_run_inputs` rows and `artifacts.produced_by_node_run` — never inside a hash; there
  is no Merkle or parent-hash chaining anywhere in Canonical.ts or Db.ts.
- A `workflow_run` is a workspace, not an execution. Executions exist only in Temporal. Running
  an unchanged workspace inserts zero SQLite rows: every node memo-hits (`memoLookup` in Db.ts)
  and the re-attach is `ON CONFLICT DO NOTHING` (`ATTACH_ENGINE_SQL` in Db.ts). The one
  exception is the P1.3 bug: a detached engine member gets its membership row re-inserted. The per-run
  `Summary` (executed / memo_hits / human_waits lists, accumulated in `Ctx` in Context.ts) is
  returned as the `GraphflowRun` result and exposed by the `progress` query (Workflows.ts),
  which the SSE endpoint `GET /workflow-runs/:id/progress` polls (`pumpProgress` in
  backend/src/api/routes/WorkflowRuns.ts). It is never written to the database — `workflow_runs`
  has no columns for it, and the execute route returns only `{temporal_workflow_id}`.
- The engagement is the single hard boundary. Artifact identity is
  `UNIQUE (engagement_id, kind, hash)` and memo identity is `UNIQUE (engagement_id, memo_key)`
  (the `SCHEMA` constant in Db.ts); payload storage paths are `{engagement_id}/{content hash}`
  (`payloadRef` in backend/src/infrastructure/storage/Storage.ts). Reuse and confidentiality
  share this one boundary on purpose. Workspaces scope nothing the compute layer reads after
  launch: `userAttachments` (Db.ts) feeds the launch snapshot, and from then on identity and
  memoization see only the engagement.
- Dispatch is data, not addressing. Exactly two Temporal workflow types exist: `GraphflowRun` and
  `GraphflowHumanTask` (the two exported workflow functions in backend/src/temporal/Workflows.ts;
  the string constants live in Ids.ts). `startWorkspace` (Runtime.ts) reads both the workflow
  type and the task queue from the catalog row, not from code. Nodes execute as generic
  activities carrying `node_id` in the `NodeRequest` payload, resolved against the registry
  compiled into the worker (`run_engine_node` in Activities.ts). Real fan-out exists: the demo
  workflows run their OCR chains under `Promise.all` (`taxDemoWorkflow.run` in
  backend/src/workflows/tax_demo_workflow.ts, likewise in tax_demo_workflow_v2.ts).
- The target end-state named in the v1 conversation is git's object/ref split: the ledger as
  object store, immutable per-run manifests as commits, path-labeled workspace refs as branches,
  a blessed pointer per branch, simulations as branches. None of this exists in the current code;
  it is the P5/P6 plan. Two invariants protect it and hold today: paths never enter memo keys or
  artifact identity (verified in the hash constructions above), and scenario deltas enter only as
  node args or artifacts.

Domain purity, re-verified: the engine directories (api/, domain/, infrastructure/, temporal/,
excluding tests) contain no tax vocabulary — a sweep for tax/PFIC/txn/1040/brokerage/client
names returns only the English word "form" in two Context.ts comments. `engagements` is the sole
professional-services noun in the schema. Two leaks in engine tooling proper: the CLI
auto-approver understands exactly one payload shape, the demo's `verify_txns` `{ocr: <artifact>}`
(`buildApproval` in backend/src/cli/Inbox.ts), and the CLI usage text names the demo clients Acme
and Blue Harbour (`USAGE` in backend/src/cli/Cli.ts). Seed data and engine test fixtures also
carry demo vocabulary — exempted as demo tooling by decision, listed so the exemption stays a
decision rather than an oversight.

## Project sequence

Dependency spine: P1 → P2 → (P3, P4) → P5 → P6, with P7 an independent parallel track that must
land before any real exposure, P8 demand-gated, and P9 gated on P2 plus P5's schema decisions.
Rationale: bugs first (P1); then the decisions that become permanent (P2 — the ledger); then the
cheap catalog cleanups (P3, P4) so nothing about to be removed gets polished; then the large
build (P5) and what it unlocks (P6). Renaming comes after structural decisions, which is why P4
is catalog-only and workspace vocabulary lives in P5.

### P1 — Critical engine integrity

Correctness defects that are wrong under any future design. Small, independent, do now.

1. Origin-signal divergence plus nondeterministic lineage. Upload bytes, then let an engine run
   produce identical bytes: the artifact row keeps `produced_by_node_run` NULL (the
   `ON CONFLICT ... DO NOTHING` insert in `recordCompletion`, Db.ts), so the serializer reports
   it as user-supplied (`artifactMeta` in api/Serializers.ts) — while the lineage endpoint names
   an engine producer, because `artifactLineage` (Db.ts) finds the node_run through
   `output_artifact_id`. That producer query is a `.get()` with no ORDER BY, so when several
   node_runs converge on one artifact, which producer it returns is nondeterministic. P2.1 fixes
   the model at the root; the fragment actionable now is the determinism fix (ORDER BY, or return
   all producers).
2. Wedged-run detection. `startWorkspace` (Runtime.ts) starts the run on the catalog row's
   `task_queue`. If that differs from the env queue — possible for retired workflows, since
   `publishCatalog` upserts and never deletes — the run starts on a queue no worker polls and
   hangs invisibly: the adoption sweep (`adoptOpenWorkflows` in Runtime.ts), the human-task
   listing (`listTaskWorkflows` in api/Deps.ts), and the inbox (`humanTaskListQuery` in
   cli/Inbox.ts) all filter `TaskQueue = <env queue>`. Supersede cannot rescue it either:
   `startWorkspace` must first read the running workflow's `snapshot` query, and answering a
   query needs a live worker on that queue. P1 scope: warn or fail at execute when catalog queue
   differs from env, and broaden the recovery sweeps. The queue-authority decision stays in P3.2.
   (v1's refuted theory stays refuted: human tasks always start on the executing worker's own
   queue — `ensure_human_task` in Activities.ts passes `deps.taskQueue`.)
3. Rerun resurrects detached engine results. Detach a stale engine artifact and press run: the
   memo-hit path in `Ctx.node` (Context.ts) unconditionally calls `attach`, which reaches
   `ATTACH_ENGINE_SQL` (Db.ts) and re-inserts the membership row. Because that insert is
   `ON CONFLICT DO NOTHING`, a still-attached artifact keeps its old `added_at`; the fresh
   `added_at` appears precisely in the detached case this bug is about. Committed decision: no
   interim guard — a real guard needs a tombstone on the membership table that P5.2 deletes.
   P1 delivers a regression test plus a known-issue note; the root cause lands in P5.2. Escape
   hatch: build the tombstone guard only if P5 slips past an agreed date.
4. Archived workspaces are not read-only. In api/routes/WorkflowRuns.ts, the PATCH, attach,
   detach, and execute handlers all call `getWorkspace` and proceed; none reads `archived_at`
   (only the archive route writes it). Cheap guard now: reject mutations and execute on archived
   workspaces. P5.10 refines the semantics for the branch era.
5. `PATCH /workflow-runs/:id` can swap `workflow_id` under an open run. The handler's only guard
   is `workflowInCatalog` (WorkflowRuns.ts); there is no open-run check and no kind-compatibility
   check. A subsequent execute with an unchanged snapshot then silently attaches to the
   old-workflow execution, because dispatch uses `workflowIdConflictPolicy: 'USE_EXISTING'`
   (`startWorkspace` in Runtime.ts).
6. Undeclared-kind attachments churn run identity. The attach route validates only
   same-engagement (WorkflowRuns.ts). An attachment of a kind the workflow never declared still
   enters the user snapshot (`userAttachments` in Db.ts takes every user-sourced row) and
   therefore its hash set — triggering SNAPSHOT_CHANGED noise on open runs — while being
   unreadable by the workflow (`Ctx.attached` throws for undeclared kinds) and never affecting
   memo keys. Fix at attach time, written against a declared-kinds accessor rather than the
   `workflow_kinds` table directly, so the fix survives P3.3's absorption and P8.1's registry.
7. Cwd-relative environment defaults. `GRAPHFLOW_DB` defaults to `'graphflow.sqlite3'` and
   `GRAPHFLOW_STORAGE` to `'mock_s3_gcs'` (`EnvSchema` in backend/src/infrastructure/env/Env.ts)
   — both relative strings, opened as given (`connect` in Db.ts) or joined against directly
   (`writePayload`/`readPayload` in Storage.ts), so both resolve against the process cwd;
   `loadEnv` (Env.ts) also reads `.env` from cwd. Two processes started from different
   directories silently operate on different ledgers today. Resolve to absolute paths or refuse
   relative ones.

### P2 — Ledger hardening (decide-once columns)

The ledger is insert-only and permanent. These decisions have a deadline: before real
engagements accumulate, and before the Postgres port freezes the shape.

0. Build the migration mechanism first. The codebase's only DDL is the `SCHEMA` constant in
   Db.ts (`CREATE TABLE IF NOT EXISTS` plus five `CREATE INDEX IF NOT EXISTS`); there is no
   ALTER, no schema version, no migration runner anywhere in backend/src. Deliver: a
   `meta.schema_version` key, an ordered migration runner, and the P2.1 backfill
   (`origin := produced_by_node_run IS NULL ? 'user' : 'engine'`). One idea was reviewed out,
   recorded so it does not come back: a catalog drop-and-recreate-on-boot path does not work —
   `node_runs` references `nodes` and `workflow_runs` references `workflows` (the `SCHEMA` in
   Db.ts), so dropping catalog tables violates ledger FKs under `PRAGMA foreign_keys = ON`, and
   retired rows exist only in the database (the referent pinning in `startWorkspace`, Runtime.ts,
   depends on them; the binary cannot regenerate them). Catalog changes go through the runner
   like everything else. Hard gate for every schema-touching item in P2/P3/P4.
1. Replace `artifacts.produced_by_node_run` with an `origin` flag — or explicitly recommit.
   Re-verified: the deferred circular FK pair (`artifacts.produced_by_node_run` and
   `node_runs.output_artifact_id`, both `DEFERRABLE INITIALLY DEFERRED` in the `SCHEMA`) and the
   MAX+1 id preallocation in `recordCompletion` exist solely so an artifact can point at a
   not-yet-inserted node_run; only that direction ever engages deferral. An
   `origin TEXT CHECK ('user','engine')` column preserves the one non-derivable bit (row born as
   upload vs computation); the creating run stays derivable for engine-born rows via
   MIN(node_run_id) over `node_runs.output_artifact_id`. Dropping the column kills both
   Postgres-isms and retires the circular-pair test (Db.test.ts, "completion links producer").
   Consumers needing rework, complete list re-verified: the `produced` alias in
   `workspaceArtifacts` (Db.ts); `artifactMeta` (api/Serializers.ts); `RawArtifact` and
   `mapArtifact` (frontend/src/lib/api/client.ts); `ArtifactSchema.producedByNodeRunId`
   (frontend/src/lib/schemas/artifact.ts); the `workspaceMembers` selector
   (frontend/src/lib/stores/ledger-store.ts); `cmdShow`'s produced/supplied origin tag
   (cli/Cli.ts); and the two views that resolve the producing run's display name through the id —
   the artifact-pool origin column (frontend/src/app/engagements/[id]/page.tsx) and
   `ArtifactPreviewSheet` (frontend/src/app/components/artifact-preview-sheet.tsx). Those two
   need the MIN derivation exposed via the lineage endpoint. Prerequisite: characterization
   tests before the refactor — memo race winner-resolution (the constraint-error recovery path in
   `recordCompletion`), retry idempotency, and the upload-then-engine-identical-bytes origin
   matrix. `recordCompletion` is the most safety-critical function in the system and its direct
   coverage is thin.
2. Add the minting code hash as a second column. Re-verified: `NodeRequest` (Context.ts) carries
   `memo_key` but not the code hash that minted it; `run_engine_node` (Activities.ts) files its
   own registry's `registered.codeHash`, so `node_runs.code_hash` can disagree with the hash
   inside `memo_key` during a rolling deploy, and the minting hash is unrecoverable. Overwriting
   the existing column would destroy the code-that-actually-ran fact that item 4 affirms — so:
   a second column (`minted_code_hash`), threaded through `NodeRequest` and the human path
   (`TaskInput.code_hash` is frozen in `buildTaskInput` at task creation and filed by
   `record_human_completion` possibly days later), with an absent-field fallback for in-flight
   workflows. Historical rows are unfixable — hence the deadline.
3. Reviewer identity: `created_by` is display text, never authorization input. Nullable additive
   ledger columns remain permitted (via P2.0's mechanism), which is why the reviewer-principal
   column can safely wait for P7's auth model (P7.4).
4. Affirmations, recorded so nobody simplifies them later: `memo_key` and the executed
   `code_hash` are two different facts (question asked vs code executed) — keep both.
   `node_run_inputs` is the only enumerable input edge (impact analysis, reviewer navigation) —
   memo keys cannot be inverted to replace it. Content-hashing artifacts is what makes reruns
   free and convergence possible — never fold provenance into identity.

Exit criterion for P2 and every schema-changing project after it: schema.dbml updated in the
same change. (v1 also named ELI5.md; that file has been deleted from the working tree — if a
plain-language schema walkthrough is still wanted, recreate it, otherwise drop it from the
criterion.)

### P3 — Catalog diet (removal and absorption)

Small tables, few rows — cheap changes through P2.0's runner. But the catalog cannot be dropped
and rebuilt from the binary: it is an FK parent of the ledger and keeps retired rows the binary
cannot regenerate (see P2.0).

1. `workflows.temporal_workflow_type`: default KEEP, reason documented. Re-verified: every
   publish writes the constant `RUN_WORKFLOW_TYPE` (`publishCatalog` in Db.ts), and the sole
   behavioral read is dispatch (`loadWorkspaceStart`/`startWorkspace` in Runtime.ts). But the
   per-row pinning it provides — old workspaces keep their referent, per the comment at the
   dispatch site — is precisely the cutover mechanism if P5 ships as a `GraphflowRunV2` Temporal
   type. Final decision belongs to P5 planning (P5.8); do not drop in one project the mechanism a
   later project may need.
2. `workflows.task_queue`: pick a single source of authority. Either env-only (drop the column)
   or catalog-authoritative (then make the P1.2 sweeps and the worker honor it). Re-verified:
   rows converge to the env queue on every publish except retired workflows, whose stale pinning
   is the same mechanism as the P1.2 wedging — deciding one decides the other.
3. Absorb `workflow_kinds` into a JSON column on `workflows`. Re-verified: zero inbound FKs,
   both reads parent-scoped (`loadWorkspaceStart` in Runtime.ts and `catalogSnapshot` in Db.ts),
   declaration order preserved naturally by a JSON array. Whole-array overwrite per publish also
   closes the declared-kinds monotonic-loosening gap (upsert without delete means kinds only ever
   accumulate) as a free by-product. Supersedes renaming that table in P4.
4. Keep `nodes` as a table. It is the ledger's FK anchor (`node_runs` has a composite FK to it),
   it serves a genuine relational read — the stats human-answers JOIN filtering
   `executor='human'` (`stats` in Db.ts) — and it carries the publish-time code-hash drift
   tripwire (the in-place-edit warning in `publishCatalog`, whose recommended copy-to-_v2
   pattern tax_demo_workflow_v2 follows).
5. Make retired-version retention an explicit, documented policy. Today it is an emergent
   property of upsert-never-delete that P3.1 and P3.2 both quietly depend on.

### P4 — Vocabulary reset (catalog only)

After P2/P3 decisions. P5 does not touch the catalog, so these renames cannot be invalidated
by it.

1. `workflow_kinds` becomes slots vocabulary: `workflows.slots` (JSON, per P3.3) or
   `workflow_slot_kinds` if kept relational. Fixes the kind-of-workflow misreading.
2. `leaf` becomes `is_user_input` — the business meaning (document the user uploads vs engine
   intermediate); it drives the upload dialog's default kind list.
3. `nodes.code_hash` becomes `deployed_code_hash` — ends the collision with
   `node_runs.code_hash` (currently-deployed vs actually-ran), which P2.2's `minted_code_hash`
   turns into a three-way distinction worth naming precisely.
4. `engagement` stays for now. The concept (unit of trust and reuse) is generic; only the name is
   professional-services. Renaming touches `engagement_id` across ledger tables — a real
   migration — so if it ever renames, it piggybacks the P9 port window. Parked, not lost.
5. Doc-sync per the P2 exit criterion.

### P5 — Runs as first-class (the ref/object overhaul)

The workspace layer rebuilt on the git object/ref model. The ledger needs zero changes
(re-verified: nothing in `artifacts`/`node_runs`/`node_run_inputs` references workspaces). This
is the largest project in the plan; the database changes are the cheap part, the API contract and
frontend are the real cost.

1. Immutable run manifests, sealed at completion. Persist what today evaporates: the input
   snapshot, the touched artifact set, and the `Summary`. Single writer (the workflow at
   completion), so a JSON document is safe. The existing SSE progress path is built on the
   one-run-per-workspace model that item 5 deletes — it gets re-keyed in item 6, not reused
   as-is.
2. Split staging from results. The branch (workspace) holds the user's staged input documents as
   editable rows with per-edge audit and promote/detach semantics; engine results stop living in
   the membership table and move to manifests. This fixes P1.3 at the root and ends stale and
   fresh results accumulating side by side — today the seed script picks the newest final report
   with `reports.at(-1)` (`printReport` and `cmdSeed` in cli/Seed.ts) to cope, and the workspace
   page already splits members into a Documents card and a Results card by `source`
   (frontend/src/app/workspaces/[id]/page.tsx), so stale results surface in the Results card.
3. Free-form paths as refs. Workspaces become UUID-identified refs with a path-like label
   (`jan_2026/run_pfic_scenario_1`) and metadata commentary; hierarchy is presentation, no FK.
   Safe because workspace identity participates in no memo key and no artifact identity
   (re-verified in the hash constructions).
4. A blessed pointer per branch — "run_3 is the one we sent to the client." The honest
   replacement for reading the membership list.
5. Dissolve the supersede machinery. The SNAPSHOT_CHANGED error and terminate-and-restart
   (`startWorkspace` in Runtime.ts) exist only because run identity equals workspace identity —
   `runWorkflowId` (Ids.ts) mints one Temporal id per workspace. Per-run identities with frozen
   snapshots make concurrent scenario runs a feature instead of a 409.
6. Re-key the execution API. Execute, status, and progress/SSE are all keyed by the workspace id
   today (routes in WorkflowRuns.ts; `runWorkflowId` in Ids.ts). Per-run identity makes "the run
   for this workspace" non-unique — a breaking, versioned API change.
7. Frontend rebuild. The run store and SSE subscription are keyed one-per-workspace
   (`attachProgressStream` in frontend/src/lib/api/operations.ts enforces one EventSource per
   workspace; frontend/src/lib/stores/run-store.ts keys runs by workspace id), and the workspace
   page's membership model changes meaning (engine rows leave membership). New run-history,
   manifest, and blessed-pointer views.
8. In-flight Temporal migration strategy. Item 2 changes mid-walk behavior inside `Ctx.node`;
   open runs replaying old histories against new code fail with nondeterminism, and runs park on
   human tasks for days. Decide: drain, `patched()`, or a new `GraphflowRunV2` workflow type —
   and if V2, the P3.1 column is the referent-pinning mechanism that makes the cutover safe.
   This is where P3.1's final decision lands.
9. Unify the workspace vocabulary (branch/ref, staged input, member, manifest) once, in the new
   model's terms, instead of renaming the old model first.
10. Branch-era archived semantics, refining P1.4's guard.
11. Invariants, enforced in review: paths never enter memo keys or artifact identity; scenario
    deltas enter only as node args or attached artifacts.

### P6 — Simulation engine (the stated ultimate goal; gated on P5)

1. Scenario branches as refs sharing the ledger — identical prefixes memo-hit; only divergence
   computes. The delta-as-artifact pattern (for example a PFIC-treatment election document) is
   what makes an assumption enter the memo key.
2. Compare/diff views across sibling runs' manifests.
3. A `GraphflowSimulation` coordinator workflow type (fan out N scenario runs, gather, rank) — a
   genuinely new orchestration shape, the only correct reason to mint a new Temporal type.
4. Scale trigger: wide fan-outs serialize on SQLite's single writer with a 15-second busy timeout
   (`connect` in Db.ts sets `busy_timeout = 15000`; every write is `BEGIN IMMEDIATE`). If
   simulations exceed a handful of concurrent scenario runs or surface busy-timeout retries,
   P9 jumps ahead of further P6 breadth.

### P7 — Access and exposure (parallel track; must land before real-world exposure)

The verification finding stands: the engagement boundary only gates writes. Reads are global.

1. No authentication or authorization exists anywhere — no auth middleware or hook in `buildApp`
   (api/App.ts), no principal, no permission table in the schema (re-verified by exhaustive grep
   over api/, temporal/, infrastructure/). The only credential in the codebase is the outbound
   Temporal Cloud API key (`connectClient` in Runtime.ts). The sole guard is loopback-by-default
   binding: `GRAPHFLOW_HOST` defaults to `'127.0.0.1'` (`EnvSchema` in
   backend/src/infrastructure/env/Env.ts, applied at `app.listen` in api/Bootstrap.ts), and the
   schema's own comment states that `0.0.0.0` exposes the unauthenticated API to the network.
2. Cross-engagement reads via enumerable integer ids: `GET /artifacts/:id`, `PATCH
   /artifacts/:id`, and `GET /artifacts/:id/content` (api/routes/Artifacts.ts) call
   `getArtifact` with no engagement scoping, and `artifact_id` is a sequential INTEGER PRIMARY
   KEY — full-corpus exfiltration is a for-loop.
3. Anyone can answer any human task: the submit route's only check is that the task id starts
   with this instance's prefix (api/routes/HumanTasks.ts). Human answers are memoized forever
   (`record_human_completion` files through the same `recordCompletion` as engine nodes), so a
   spoofed answer becomes a permanent ledger fact.
4. Reviewer identity: decide the principal representation here, with the auth model in hand, and
   add it as a nullable additive ledger column (always safe via P2.0). Until then `created_by`
   remains unverified display text.
5. The SSE progress and status endpoints are unauthenticated like everything else; decide the
   intended posture per deployment mode.
6. Exit criterion: the surface audit re-runs after any project that adds endpoints (P5 and P6
   both do).

### P8 — General-purpose scoping (multi-practice readiness; demand-gated)

The engine's data model is domain-free (re-verified above); its governance model is single-team.

1. Vocabulary: kind strings are one flat, unenforced, instance-wide namespace. Multi-practice
   needs a kinds registry (ownership, description, payload schema) or dotted namespacing —
   governed at the boundary where meaning is shared; the engine provides the mechanism, not the
   boundary choice.
2. Placement: per-practice worker fleets via task queues (after P3.2 settles queue authority);
   Temporal namespaces for hard tenancy isolation.
3. Permission: P7's dimension, extended to practice/team scoping.
4. Naming: the `engagement` generic-term decision, parked in P4.4.
5. Generalize the submitter: the CLI auto-approver is hardwired to the demo's `verify_txns`
   payload shape (`ApprovalPayloadSchema`/`buildApproval` in cli/Inbox.ts). The strategic fix is
   pluggable submitters per node kind, which belongs here, not in the bug list.

### P9 — Postgres port and fleet unpinning (the declared eventual target)

Gates: P2 decided, and P5's schema decisions final (manifests plus the staging split — even if
not fully shipped), so the port's concurrency analysis is done once. P4 preferred but not
gating; renames are redoable post-port.

1. Schema mapping carries the JSON verdicts: catalog children may collapse to JSONB (tree-shaped,
   exclusively owned); ledger and membership stay relational (shared ownership, per-edge
   attributes, per-edge mutation, element-level FKs).
2. If P2.1 landed: no DEFERRABLE constraints, no MAX+1 — identity columns and plain FKs; the
   port's two hardest translations disappear.
3. `BEGIN IMMEDIATE` single-writer discipline becomes an MVCC review of every transaction —
   especially the idempotent completion transaction (`recordCompletion`), the attach upserts,
   and the MIN(node_run_id) creating-run derivation, which is sound under SQLite's single writer
   but not automatically under MVCC commit reordering.
4. Fleet unpinning: today every worker must open the same SQLite file and local storage root, and
   WAL does not survive network filesystems — effectively one machine. Postgres plus object
   storage (the storage layout in Storage.ts is already an object-store shape, and the storage
   root's default name is `mock_s3_gcs` — `EnvSchema` in Env.ts) unlocks multi-machine fleets,
   per-practice pools (P8), and dissolves the P6 contention ceiling.

## Small quirks and chores, no project warranted

- Engagement labels are immutable: `createEngagement` (Db.ts) is the sole writer and
  api/routes/Engagements.ts registers no PATCH. A feature gap, not an integrity defect.
- The execute route refuses a workspace with zero user attachments (WorkflowRuns.ts), while
  `GraphflowRun` (Workflows.ts) explicitly treats an empty snapshot as legal for all-optional
  workflows. The API forbids what the engine allows; harmless until an all-optional workflow
  ships. (New observation in v2.)
- `meta` is a one-key table (`instance_id` only). Harmless.
- `workflow_kinds.leaf` is the schema's only integer-as-boolean; dissolves with P3.3/P4.2.
- Temporal visibility queries interpolate the task-queue env value into single-quoted query
  strings with no escaping (`adoptOpenWorkflows` in Runtime.ts, `listTaskWorkflows` in
  api/Deps.ts, `humanTaskListQuery` in cli/Inbox.ts) — a quote character in the value breaks
  them. Config-controlled input.
- The sticky-queue handover sweep (`adoptOpenWorkflows` signaling the deliberately-unhandled
  `__graphflow_worker_handover`) remains a restart requirement.
- The frontend's `SourceBadge` component (frontend/src/app/components/source-badge.tsx) is
  defined but referenced nowhere; the workspace page distinguishes user vs engine members by
  card placement instead. Delete or adopt. (New observation in v2.)
- `TEMPORAL_TASK_QUEUE` defaults to `'thet-temporal-dev-ignore'` (`EnvSchema` in Env.ts) — a
  dev-specific default; deployments that forget to set it all land on that one shared-namespace
  queue. (New observation in v2.)
- Engine test files are saturated with tax vocabulary; acceptable as fixtures, sweep if P8 ships.

## Standing invariants

1. Identity is content, never provenance: artifact identity is (engagement, kind, payload hash);
   question identity is (engagement, code hash, canonical-args hash) — the engagement enters at
   lookup via `UNIQUE (engagement_id, memo_key)`, never inside the hash. Provenance lives in
   columns (`node_run_inputs`, `produced_by_node_run`).
2. The engagement is the reuse boundary and the confidentiality boundary — one boundary, on
   purpose.
3. The ledger is insert-only; workspace detach is the only DELETE; `artifacts.label` the only
   ledger UPDATE. Nullable additive columns are permitted, via P2.0's migration mechanism.
4. Paths, refs, and workspaces never enter memo keys or artifact identity.
5. Scenario and config deltas enter computations only as args or artifacts — never ambient.
6. New Temporal workflow types only for new orchestration shapes, never business domains; queues
   select fleets; namespaces select tenancy.
