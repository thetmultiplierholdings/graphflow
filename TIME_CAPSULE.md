# TIME CAPSULE — graphflow design review, verbatim state and sequenced projects

Date: 2026-07-18. Provenance: a long design conversation over the live codebase. Every factual
claim was verified against `backend/` by three independent audit agents (file:line evidence
throughout; `legacy/` never consulted), then the document was adversarially reviewed by two more
agents and amended. Review trail: fact-check verdict — 0 false claims, 0 drifted citations across
~45 spot-checks, 2 completeness overstatements (fixed below); structure verdict — "sound with
amendments" (all applied, noted inline as *[amended]*). Companion documents:
[ELI5.md](ELI5.md) (plain-language schema walkthrough) and [schema.dbml](schema.dbml) (validated
ERD transcription).

---

## The mental model (read this first; everything else hangs off it)

The database is three layers with three different costs of being wrong:

| Layer | Tables | Discipline | Cost of schema mistakes |
|---|---|---|---|
| **Catalog** | `workflows`, `workflow_kinds`, `nodes` | Republished from the binary on every boot/publish (upsert, never delete) | Near zero — rebuilt from code (once a drop-and-recreate path exists, see P2.0) |
| **Workspace** | `workflow_runs`, `workflow_run_artifacts` | Editable rows | Normal migrations |
| **Ledger** | `artifacts`, `node_runs`, `node_run_inputs` | Insert-only, forever (only mutation: `artifacts.label`; only DELETE in the system: workspace detach) | **Permanent once real data accumulates** |

Core mechanics, all verified:

- **Questions and answers.** `node_runs.memo_key = sha256(code_hash ‖ sha256(canonical args))` is the
  fingerprint of a *question* (artifact inputs appear as content hashes — Context.ts:83,208;
  Canonical.ts:135-139). `artifacts.hash = sha256(payload bytes)` is the fingerprint of an *answer*.
  The next question is built from the previous answer's *content*, not its history — which is what
  makes reruns free, lets different questions converge on one stored answer, and stops upstream
  code changes from invalidating downstream work when outputs are byte-identical. (It is
  deliberately NOT a Merkle/provenance-committed structure; provenance is recorded in columns —
  `node_run_inputs`, `produced_by_node_run` — never in hashes.)
- **A `workflow_run` is a workspace (folder/pinboard), not an execution.** Executions live only in
  Temporal. Pressing run on an unchanged workspace inserts zero rows in SQLite; the per-run
  `Summary` (executed / memo-hit / human-wait node lists) is returned via Temporal and the SSE
  progress query but never persisted (Workflows.ts:64,84; WorkflowRuns.ts:250-251).
- **The engagement is the single hard boundary** — identity (`UNIQUE(engagement_id, kind, hash)`),
  memoization (`UNIQUE(engagement_id, memo_key)`), and payload storage prefix (Storage.ts:10) all
  scope to it. It is where reuse and confidentiality coincide. Workspaces scope nothing the compute
  layer reads; they are named saved queries over the ledger.
- **Dispatch is data, not addressing.** One generic Temporal workflow type (`GraphflowRun`) plus
  one human-task type (`GraphflowHumanTask`) — verified as the only two (Workflows.ts:64,130).
  Nodes execute as generic activities with `node_id` in the payload, resolved against the registry
  compiled into the worker binary. Real fan-out exists: the demo workflows run their OCR chains
  under `Promise.all` (tax_demo_workflow.ts:227-228).
- **The target end-state named in this conversation:** git's object/ref split. Ledger = object
  store; immutable per-run manifests = commits; cheap path-like workspace refs = branches; a
  HEAD/blessed pointer per branch; simulations as branches. Two invariants protect it: paths never
  enter memo keys or artifact identity, and scenario deltas enter only as node args or artifacts.

Domain purity, verified *[amended for precision]*: engine schema, types, and API contain **no**
tax vocabulary; `engagements` is the sole professional-services noun in the schema. Two leaks in
engine code proper: the CLI auto-approver is hardwired to the demo's `verify_txns` payload shape
(Inbox.ts:48-74), and CLI help text names demo clients (Cli.ts:25). The seed/demo commands and
engine test fixtures also carry demo vocabulary — exempted here as demo tooling by design, but
listed so the exemption is a stated decision rather than an oversight. The engine is
general-purpose; the tenant is named after the first customer.

---

## Project sequence

Dependency spine: **P1 → P2 → (P3, P4) → P5 → P6**, with **P7** an independent parallel track that
must land before any real exposure, **P8** demand-gated, and **P9** gated on P2 plus P5's schema
decisions. Rationale: bugs first (P1); then the decisions that become permanent (P2 — ledger); then
the free and cheap cleanups (P3 catalog, P4 catalog names) so nothing doomed gets polished; then
the big build (P5) and what it unlocks (P6). Renaming comes AFTER structural decisions — which is
also why P4 is now catalog-only and workspace vocabulary moved into P5 *[amended]*.

---

### P1 — Critical Engine Integrity

*Correctness defects that are wrong under any future design. Small, independent, do now. Items
that turned out to be bug reports for later projects have been rescoped to what is genuinely
actionable now [amended].*

1. **Origin-signal divergence + nondeterministic lineage.** Upload bytes, then let an engine run
   produce identical bytes: artifact meta says "user-uploaded" (`produced_by_node_run` NULL) while
   the lineage endpoint names an engine producer (Db.ts:603 convergence; Db.ts:756-768 lineage).
   The lineage producer query is `.get()` with no ORDER BY — nondeterministic under multi-run
   convergence (Db.ts:757-759). P2.1 fixes the reconciliation at the root; the fragment that is
   P1-actionable now is the ORDER BY / return-all-producers determinism fix. *A background task
   chip exists (task_2edff0c1); scope it to the determinism fragment if P2.1 is accepted.*
2. **Wedged-run detection.** If a catalog row's `task_queue` differs from env (possible for
   retired workflows — publish never deletes), the run starts on a queue no worker polls and hangs
   forever — invisible to every recovery mechanism, because the adoption sweep, inbox, and task
   listing all filter `TaskQueue = env` (Runtime.ts:87, Deps.ts:173, Inbox.ts:16-17). Even
   supersede can't rescue it (the snapshot query needs a worker). P1 scope: *detect and surface* —
   warn or fail at execute when catalog queue ≠ env, and broaden the recovery sweeps' filter. The
   queue-authority decision stays in P3.2. (Note: the earlier "run and its human tasks land on
   different queues" theory was REFUTED — human tasks always follow the executing worker's own
   queue, Activities.ts:229-235.)
3. **Rerun resurrects detached engine results.** Detach a stale engine artifact, press run: the
   memo-hit path unconditionally re-attaches it with a fresh `added_at` (Context.ts:210-214 →
   Activities.ts:167-174). *Committed decision [amended]:* no interim guard — a real guard needs a
   tombstone marker on the membership table that P5.2 deletes. P1 delivers a regression test plus
   a known-issue note; root cause lands in P5.2. Escape hatch: build the tombstone guard only if
   P5 slips beyond an agreed date.
4. **Archived workspaces are not read-only.** Attach, detach, PATCH, and execute all ignore
   `archived_at` (WorkflowRuns.ts:155-253). Cheap guard now: reject mutations and execute on
   archived workspaces. P5.10 refines semantics for the branch era; the guard survives in spirit.
5. **`PATCH /workflow-runs/:id` can swap `workflow_id` under an open run** — no open-run check, no
   kind-compatibility warning; a subsequent execute with unchanged snapshot silently attaches to
   the old-workflow execution (WorkflowRuns.ts:163-173 + USE_EXISTING).
6. **Undeclared-kind attachments churn run identity.** Attach validates only same-engagement
   (WorkflowRuns.ts:213-215); an attachment of a kind the workflow never reads still enters the
   user snapshot and its hash — triggering SNAPSHOT_CHANGED/supersede noise while never being
   consumable and never affecting memo keys. Fix at attach time, written against a declared-kinds
   accessor (not the table directly) so it survives P3.3's absorption and P8.1's registry.
7. **Cwd-relative environment defaults** *(moved from P9 [amended])*: `GRAPHFLOW_DB` and the
   storage root default to relative paths resolved against cwd (Env.ts:24-25) — two processes
   started from different directories silently operate on different ledgers *today*. Resolve to
   absolute or refuse relative paths.

*(Moved out: declared-kinds monotonic loosening → P3.3, where absorption fixes it as a by-product;
the auto-approver domain leak → P8; the missing engagement-label PATCH → chores list at the end.)*

---

### P2 — Ledger Hardening (decide-once columns)

*The ledger is insert-only and permanent. These decisions have a deadline: before real engagements
accumulate, and before the Postgres port freezes the shape.*

0. **Build the migration mechanism first** *[amended — the plan was unimplementable without it]*:
   the codebase's only DDL is `CREATE TABLE IF NOT EXISTS` in `initDb`; no ALTER, no versioning.
   Deliver: `meta.schema_version` + an ordered migration runner + the P2.1 backfill
   (`origin := produced_by_node_run IS NULL ? 'user' : 'engine'`), plus a catalog
   drop-and-recreate-on-boot path (which is what makes P3's "near-zero cost" true). **Hard gate
   for every schema-touching item in P2/P3/P4.**
1. **Replace `artifacts.produced_by_node_run` with an `origin` flag — or explicitly recommit.**
   Verified: the deferred circular FK pair AND the MAX+1 id-preallocation exist *solely* so an
   artifact can point at a not-yet-inserted node_run (Db.ts:595-635; the reverse FK never engages
   deferral). An `origin TEXT CHECK ('user','engine')` column preserves the one non-derivable bit
   (row born as upload vs computation), while the creating run stays derivable for engine-born
   rows via `MIN(node_run_id)` over `node_runs.output_artifact_id`. Deleting the column kills both
   Postgres-isms and retires the circular-pair test (Db.test.ts:93-101). Consumers needing rework
   *[amended — complete list]*: `produced` flag (Db.ts:523), serializer (Serializers.ts:64),
   frontend store/schema/mapper (ledger-store.ts:320, artifact.ts:16, client.ts:68), CLI show
   (Cli.ts:104), and the two frontend views that resolve the producing run's *name* through the id
   (engagements/[id]/page.tsx:451-452, artifact-preview-sheet.tsx:152-153) — those two need the
   MIN derivation exposed via the lineage endpoint. Prerequisite sub-item *[amended]*:
   **characterization tests before refactor** — memo race winner-resolution (Db.ts:647-661), retry
   idempotency, and the upload-then-engine-identical-bytes origin matrix; `recordCompletion` is
   the most safety-critical function in the system and current direct coverage is thin.
2. **Add the minting code hash as a second column** *[amended — committed; overwrite option
   deleted]*: today `NodeRequest` carries `memo_key` but not the hash that minted it; the activity
   files its *own* registry's hash, so `node_runs.code_hash` can disagree with the hash inside
   `memo_key` during a rolling deploy, and the minting hash is unrecoverable. Overwriting the
   existing column would destroy the "code that actually ran" fact that item 4 affirms — so:
   second column (`minted_code_hash`), threaded through `NodeRequest` and the human path
   (`TaskInput.code_hash` is frozen at task-creation and filed days later — Activities.ts:140,261),
   with an absent-field fallback for in-flight workflows. Historical rows are unfixable — hence
   the deadline.
3. **Affirmation** *[amended — the column decision moved to P7.4]*: `created_by` is display text,
   never authorization input. Nullable additive columns remain permitted on the ledger — which is
   exactly why the reviewer-principal column can safely wait for P7's auth model.
4. **Affirmations (recorded so nobody "simplifies" them later):** `memo_key` + executed
   `code_hash` are two different facts (question asked vs code executed) — keep both;
   `node_run_inputs` is the only enumerable input edge (impact analysis, reviewer navigation) —
   memo keys cannot be inverted to replace it; content-hashing artifacts in advance is what makes
   reruns free and convergence possible — never "optimize" identity into provenance.

*Exit criterion for P2 and every schema-changing project after it [amended]:*
[schema.dbml](schema.dbml) and [ELI5.md](ELI5.md) updated in the same change.

---

### P3 — Catalog Diet (removal and absorption)

*Near-zero migration cost once P2.0's drop-and-recreate path exists.*

1. **`workflows.temporal_workflow_type`: default KEEP, with the reason documented** *[amended —
   default flipped]*: verified constant `'GraphflowRun'` in every row, sole behavioral read at
   dispatch (Runtime.ts:138,200) — but the per-row pinning it provides ("old workspaces keep their
   referent," Runtime.ts:198-205) is precisely the cutover mechanism if P5 ships as a
   `GraphflowRunV2` workflow type. Final decision belongs to P5 planning (see P5.8); do not drop
   one project before the event that justifies it.
2. **`workflows.task_queue`: pick a single source of authority.** Either env-only (drop the
   column) or catalog-authoritative (then make the P1.2 sweeps and worker config honor it).
   Verified: rows converge to env on every boot *except* retired workflows, whose stale pinning is
   intentional — the pinning and the wedging are the same mechanism; decide which you want.
3. **Absorb `workflow_kinds` into a JSON column on `workflows`.** Verified: zero inbound FKs, both
   reads parent-scoped, declaration order preserved naturally by a JSON array. Whole-array
   overwrite per publish **also closes the declared-kinds monotonic-loosening bug** (formerly a P1
   item [amended]) as a free by-product. Supersedes renaming that table (P4).
4. **Keep `nodes` as a table.** Besides being the ledger's FK anchor, it serves a genuine
   relational read — the stats human-answers JOIN filtering `executor='human'` (Db.ts:678-681) —
   plus the publish-time code-hash drift tripwire (Db.ts:346-355).
5. **Make retired-version retention an explicit, documented policy** — it is currently an emergent
   property of "upsert, never delete" that P3.1 and P3.2 both quietly depend on.

---

### P4 — Vocabulary Reset (catalog only) *[amended — workspace vocabulary moved to P5]*

*After P2/P3 decisions. P5 does not touch the catalog, so these renames cannot be doomed by it.*

1. `workflow_kinds` → **slots** vocabulary: `workflows.slots` (JSON, per P3.3) or
   `workflow_slot_kinds` if kept relational. Fixes the "kind of workflow" misreading.
2. `leaf` → **`is_user_input`** — the business meaning ("document the user uploads" vs "engine
   intermediate"); it drives the upload dialog's default kind list.
3. `nodes.code_hash` → **`deployed_code_hash`** — ends the collision with `node_runs.code_hash`
   ("currently deployed" vs "actually ran"), which P2.2's `minted_code_hash` makes a three-way
   distinction worth naming precisely.
4. **`engagement` stays for now** — the concept (unit of trust and reuse) is generic, only the
   name is professional-services. Renaming touches `engagement_id` across ledger tables — a real
   migration — so if it ever renames, it piggybacks the P9 port window. Parked, not lost.
5. Doc-sync per the P2 exit criterion.

---

### P5 — Runs as First-Class (the ref/object overhaul)

*The workspace layer rebuilt on the git object/ref model. The ledger needs zero changes
(verified). [Amended: re-priced — this is the LARGEST project in the plan; the database changes
are the cheap part, the API contract and frontend are the real cost.]*

1. **Immutable run manifests, sealed at completion.** Persist what today evaporates: the input
   snapshot, the touched artifact set, and the Summary (executed vs memo-hit vs human-wait).
   Single writer (the workflow at completion) → a JSON document is safe. Note the existing SSE
   progress path is built on the one-run-per-workspace model that item 5 deletes — it gets
   re-keyed in item 6, not reused as-is.
2. **Split staging from results.** The branch (workspace) holds the user's staged input documents
   as editable rows (per-edge audit, promote/detach semantics); engine results stop polluting the
   staging list and live in manifests. Fixes P1.3 at the root and ends the stale+fresh
   side-by-side display (the seed script itself works around it with `reports.at(-1)`).
3. **Free-form paths as refs.** Workspaces become UUID-identified refs with a path-like label
   (`jan_2026/run_pfic_scenario_1`) and metadata commentary; hierarchy is presentation, no FK.
   Verified safe: workspace identity participates in no memo key, no artifact identity, nothing
   the compute layer reads after launch.
4. **HEAD/blessed pointer per branch** — "run_3 is the one we sent to the client." The honest
   replacement for the polluted membership list.
5. **Dissolve the supersede machinery.** SNAPSHOT_CHANGED/terminate-and-restart exists only
   because run identity == workspace identity (one Temporal ID per workspace). Per-run leaves with
   frozen snapshots make concurrent scenario runs a feature instead of a 409.
6. **Re-key the execution API** *[amended — was unpriced]*: execute/status/progress/SSE are all
   keyed by workspace ID today (Ids.ts:8-10; WorkflowRuns.ts:107,246-301). Per-run identity makes
   "the run for this workspace" non-unique — a breaking, versioned API change.
7. **Frontend rebuild** *[amended — was unpriced]*: the workspace page's membership model changes
   meaning (engine rows leave membership), plus new run-history, manifest, and HEAD views.
8. **In-flight Temporal migration strategy** *[amended — was missing]*: item 2 changes mid-walk
   behavior inside `Ctx.node`; open runs replaying old histories against new code fail with
   nondeterminism, and runs park on human tasks for days. Decide: drain, `patched()`, or a new
   `GraphflowRunV2` workflow type — and if V2, the P3.1 column is the referent-pinning mechanism
   that makes the cutover safe. This is where P3.1's final decision lands.
9. **Unify the workspace vocabulary** (moved from P4 [amended]): branch/ref, staged input, member,
   manifest — named once, in the new model's terms, instead of renaming the old model first.
10. **Branch-era archived semantics** (refining P1.4's guard).
11. **Invariants, enforced in review:** paths never enter memo keys or artifact identity; scenario
    deltas enter only as node args or attached artifacts.

---

### P6 — Simulation Engine (the stated ultimate goal; gated on P5)

1. Scenario branches as refs sharing the ledger — identical prefixes memo-hit; only divergence
   computes. The delta-as-artifact pattern (e.g. a PFIC-treatment election document) is what makes
   an assumption enter the memo key.
2. Compare/diff views across sibling runs' manifests.
3. A `GraphflowSimulation` coordinator workflow type (fan out N scenario runs, gather, rank) — a
   legitimately *new orchestration shape*, the only correct reason to mint a new Temporal type.
4. Scale trigger *[amended — threshold stated]*: wide fan-outs serialize on SQLite's single writer
   with a 15s busy timeout (Db.ts:250-251). If simulations exceed a handful of concurrent scenario
   runs or surface busy-timeout retries, **P9 jumps ahead of further P6 breadth.**

---

### P7 — Access & Exposure (parallel track; must land before real-world exposure)

*Verification finding: the engagement boundary only gates writes. Reads are global.*

1. **No authentication or authorization exists anywhere** — no middleware, no principal, no
   permission table (App.ts:58-63; verified by exhaustive grep). Loopback-by-default is the only
   guard (Env.ts:29).
2. **Cross-engagement reads via enumerable integer ids:** `GET/PATCH /artifacts/:id` and
   `/content` have no engagement scoping — full-corpus exfiltration is a for-loop
   (Artifacts.ts:169-217).
3. **Anyone can answer any human task** (instance prefix is the only check, HumanTasks.ts:65-68) —
   and human answers are memoized *forever*, so a spoofed answer becomes a permanent ledger fact.
4. **Reviewer identity** *[amended — moved from P2.3]*: decide the principal representation here,
   with the auth model in hand, and add it as a nullable additive ledger column (always safe);
   until then `created_by` remains unverified display text.
5. Unauthenticated SSE progress/status streams; decide intended posture per deployment mode.
6. Exit criterion *[amended]*: the surface audit re-runs after any project that adds endpoints
   (P5 and P6 both do).

---

### P8 — General-Purpose Scoping (multi-practice readiness; demand-gated)

*The engine's data model is domain-free (verified); its governance model is single-team.*

1. **Vocabulary:** kind strings are one flat, unenforced, instance-wide namespace. Multi-practice
   needs a kinds registry (ownership, description, payload schema) or dotted namespacing —
   governed at the boundary where meaning is shared; the engine provides the mechanism, not the
   boundary choice.
2. **Placement:** per-practice worker fleets via task queues (after P3.2 settles queue authority);
   Temporal namespaces for hard tenancy isolation.
3. **Permission:** P7's dimension, extended to practice/team scoping.
4. **Naming:** the `engagement` → generic-term decision (parked in P4.4).
5. **Generalize the submitter** *[amended — moved from P1]*: the CLI auto-approver is hardwired to
   the demo's `verify_txns` payload shape (Inbox.ts:48-74) — the strategic fix is pluggable
   submitters per node kind, which belongs to the multi-domain project, not the bug list.

---

### P9 — Postgres Port & Fleet Unpinning (the declared eventual target)

*Gates [amended]: P2 decided AND P5's schema decisions final (manifests + staging split — even if
not fully shipped), so the port's concurrency analysis is done once, not twice. P4 preferred but
not gating (renames are redoable post-port).*

1. Schema mapping carries the arrays/JSONB verdicts: catalog children may collapse to JSONB
   (tree-shaped, exclusively owned); ledger and membership stay relational (shared ownership,
   per-edge attributes, per-edge mutation, element-level FKs).
2. If P2.1 landed: no DEFERRABLE constraints, no MAX+1 — identity columns and plain FKs; the
   port's two hardest translations disappear.
3. `BEGIN IMMEDIATE` single-writer discipline → MVCC review of every transaction — especially the
   idempotent completion transaction, attach upserts, **and the `MIN(node_run_id)`
   "creating run" derivation** *[amended]*, which is sound under SQLite's single writer but not
   automatically under MVCC commit reordering.
4. **Fleet unpinning:** today every worker must open the same SQLite file and local storage root;
   WAL does not survive network filesystems — effectively one machine. Postgres + object storage
   (the storage root is already named `mock_s3_gcs`) unlocks multi-machine fleets, per-practice
   pools (P8), and dissolves the P6 contention ceiling.

---

## Small quirks and chores, no project warranted

- **Engagement labels are immutable** (no PATCH endpoint; sole writer Db.ts:376-386) — a feature
  gap, not an integrity defect *[amended — demoted from P1]*.
- `meta` is a one-key table (`instance_id` only): a scalar in a table costume. Harmless.
- `workflow_kinds.leaf` is the schema's only int-boolean; dissolves with P3.3/P4.2.
- Temporal visibility queries interpolate the task-queue env var into query strings — a quote
  character breaks them (Deps.ts:173 et al.). Config-controlled.
- Engine test files are saturated with tax vocabulary; acceptable as fixtures, sweep if P8 ships.
- The sticky-queue handover sweep (`adoptOpenWorkflows`) remains a restart requirement.

## Standing invariants (violate these and the system's core properties die)

1. Identity is content, never provenance: artifact identity = (engagement, kind, bytes-hash);
   question identity = (code-hash, input content hashes). Provenance lives in columns.
2. The engagement is the reuse *and* confidentiality boundary — one boundary, on purpose.
3. The ledger is insert-only; workspace detach is the only DELETE; `artifacts.label` the only
   ledger UPDATE (nullable additive columns permitted, via P2.0's migration mechanism).
4. Paths/refs/workspaces must never enter memo keys or artifact identity.
5. Scenario/config deltas enter computations only as args or artifacts — never ambient.
6. New Temporal workflow types only for new orchestration *shapes* (never business domains);
   queues select fleets; namespaces select tenancy.
