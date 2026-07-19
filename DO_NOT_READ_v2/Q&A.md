### Q1

i see, it starts pulling at the root and goes "up" , not "down". Workflows only have 1 start point and thats the "pull_root" call, all the nodes are on the same machine. BUT some of the nodes can have hardcoded temporal calls OR API calls, whatever they want. Right?

Mostly right, with one mechanical correction that makes the picture even cleaner — and your last claim is *yes, but the "but" is the most important thing in the system*.

**"Pulls at the root, goes up":** right at the system level, worth sharpening at the mechanical level. Right: there is zero reactivity — attaching a document triggers nothing, no node ever runs because data arrived. The run button demands the whole answer once; that's batch pull, not push propagation. The sharpening: nothing ever *walks a graph*. There's no scheduler, no topological sort, no recursive descent from a declared root. The workflow function simply executes **forward, in program order** — first statement to last — and each `await ctx.node(...)` is a question asked at that call site. Dependency ordering isn't enforced by an engine; it's enforced by the host language, because you literally cannot pass `b = node(f, {a})` an artifact handle you don't hold yet. The JS event loop under Temporal's deterministic replay *is* the scheduler. Memoization is what makes this forward execution *cost* like a pull system — unchanged prefixes of the computation collapse to memo lookups. One consequence of "no root-driven pruning": if the workflow author computes something the final estimate never uses, it still runs. The demanded set is the code path, not the root's transitive needs.

**"One start point":** correct, and strictly so. One workflow type per catalog row, invoked once with the full user snapshot, returning the summary. There is no "just run node X" entry point anywhere in the system — the only way to ask a smaller question is to author a smaller workflow. Node-level granularity exists only *inside* the ledger, never at the dispatch surface.

**"All nodes on the same machine":** refine to *same build, any machine in the fleet*. Temporal load-balances each activity task independently, so one run's nodes can land on different workers polling the queue — and the workflow itself can migrate between workers mid-run (that's the sticky-queue handover dance in [Runtime.ts:78](backend/src/temporal/Runtime.ts:78)). What's guaranteed identical is the *binary*, not the host. That said — this particular embodiment runs on better-sqlite3 with a local payload directory, so every worker needs the same filesystem, which pins the "fleet" to one box in practice. That's a constraint of the SQLite port, not the architecture; the schema comments are explicit that this was translated from Postgres, where the fleet genuinely spreads.

**"Nodes can call whatever they want":** yes — and here's the sharp boundary. The sandbox comment at [Context.ts:10](backend/src/temporal/Context.ts:10) applies only to the *workflow* side (imports limited, no I/O). Node bodies run inside **activities**, which are ordinary Node.js — hit APIs, call LLMs, read disk, even drive Temporal itself. The codebase already does that last one: activities receive a Temporal `client` in their deps, and human tasks are separate Temporal workflows that an activity starts ([Runtime.ts:62](backend/src/temporal/Runtime.ts:62), and `adoptOpenWorkflows` sweeps the `humanTaskIdPrefix` workflows that result).

But "whatever they want" collides with the memo contract, in three ways node authors must respect:

1. **First answer wins, forever.** The ledger assumes a node is a pure function of (code_hash, args). Call a live FX-rate API and the first response is frozen as *the* answer to that question for the whole engagement — reruns memo-hit it eternally. The only refresh is changing the question: an `asOfDate` arg, or a code bump. (This is exactly Nix's fixed-output-derivation problem: impurity must be keyed into the question or accepted as frozen.)
2. **At-least-once execution.** Engine nodes retry up to 5 times ([Context.ts:112](backend/src/temporal/Context.ts:112)), and a worker can crash after the API call but before `recordCompletion`. The completion transaction is idempotent; the external side effect is not covered by it. A node that sends an email may send it three times while the ledger records one fact.
3. **Invisibility.** Whatever happens inside the node body is below fact granularity — the ledger sees bytes-in → bytes-out and nothing else. Sub-calls, external workflows, retries: none of it exists in the provenance record.

So the honest phrasing of your last claim: nodes may do anything, but the ledger's semantics stay truthful only for nodes that behave like functions — idempotent, with all nondeterminism either canonicalized away or declared in the args. A node that mutates the world isn't forbidden; it's just *lying in a vocabulary that can only state facts*.

### Q2

I am a bit suspicious of the following elements on whether or not they are needed - or that maybe they are poorly named:

1. workflows.temporal_workflow_type
2. workflows.task_queue
3. is the workflows table even needed at all?
4. why does workflow_kinds have "leaf" and its an integer?
5. why does nodes also have a code_hash? what is it?
6. why does node_runs have a code_hash and a memo_key at the same time? what are these?
7. why does artifacts need to know which node_run its produced by?
8. why does workflow_runs need to know "copied_from_workflow_run" ?
9. why does node_runs need node_run_inputs

So all in all you can see I am terribly misunderstood about the whole application and need an ELI5. I think you should run some sub agents and craft a strong, ELI5 narrative using business examples (meaning use real node examples) and not technical "basel, salsa" compiler language. AFter you are done, produce a final file called ELI5.md . You should also have good sections that separate out the different confusing things I am asking about - because obviously some are trivial questions and others are deep questions. 

At the same time I dont "get it", there are also parts where I smell like some over-done stuff by the previous agent to be slightly overzealous. Theres some code smell here and there. ERDs have to be really tight due to the fact that we dont want to migrate later, and this is an inversion workflow graph - so its even more mission critical.

You're asking exactly the right kind of question — some of these are one-line answers, some are load-bearing design decisions, and at least two of your suspicions have real teeth. Since the verdicts need evidence (who actually *reads* each column, not what the comments claim), I'll run two audit agents in parallel — one over the catalog cluster (your questions 1–5), one over the ledger/workspace cluster (6–9) — then write the ELI5 from their findings plus everything we've established in this conversation.

The file is written. One genuine latent bug surfaced during the audit that's worth tracking separately from this documentation work — flagging it as a background task:

Done — [ELI5.md](ELI5.md) is at the repo root, built from two parallel audit agents that traced every read and write site of each column you flagged (with file:line evidence), plus the repo's real demo data, so every example uses the actual nodes: `ocr_brokerage_statement`, `verify_txns` with reviewer Priya Sharma, `calculate_tax` at 25% vs the v2 fix at 24%, and the seeded "Acme Ltd — UK Tax FY 2025/26" engagement with its January/February workspaces.

The file is organized the way you asked — trivial questions (1, 2, 4, 8), medium (3, 5), deep ledger questions (6, 7, 9) — each with a business explanation and a keep/rename/drop verdict, closing with a smell report table. The headline verdicts:

**Your suspicions that scored:**
- **`temporal_workflow_type` (Q1) — fully validated.** Every row in every database holds the same constant, `'GraphflowRun'`; there is exactly one Temporal entry function and the tax workflow is data passed into it. Pure speculation, droppable with a one-line change.
- **`task_queue` (Q2) — validated as a half-abstraction.** It is genuinely read at dispatch, but every boot re-stamps all rows from one env var, and human-task workflows *bypass the column entirely* — so if a row ever diverged, a run and its own review tasks would land on different fleets. Commit or drop; the middle is the worst state.
- **`produced_by_node_run` (Q7) — your best catch.** It's ~99% derivable from `node_runs.output_artifact_id`, and it is the *sole* reason the schema needs the deferred circular FK and the MAX+1 id-preallocation trick. The one non-derivable bit ("was this row born as an upload?") could live in a simple `origin` flag, deleting both mechanisms. Since it's a ledger column — the insert-only, migrate-never part — this is the one decision worth making before history accumulates.

**Where the schema is tighter than it smells:** `node_run_inputs` (Q9) is the only readable input edge — the memo fingerprint is a sealed envelope, and impact analysis plus the reviewer's source-document navigation sit directly on this table. The `code_hash`/`memo_key` pair (Q6) records two different facts — the question asked vs the code that actually executed — which legitimately diverge during a rolling deploy. The `workflows` table (Q3) earns its keep as FK anchor, catalog source, and the only memory of retired workflow versions. `leaf` (Q4) drives the upload dialog's "documents vs intermediates" split and just deserves the name `is_user_input`; `copied_from` (Q8) is a harmless breadcrumb the UI renders.

One bonus finding: the audit confirmed a real latent inconsistency — an uploaded file whose bytes an engine run later reproduces makes the artifact API contradict itself (metadata says user-uploaded, lineage names a producer). I've flagged that as a background task chip you can spin off with one click, since it's a code fix rather than documentation.

### Q4

It feels like some of the tables could just have been columns of type array in postgres (the eventual target). The reason we use relational DBs with FKs is that there is a query direction from Orders -> Customers. But if the query direction is only ever Customers.Orders[], then there's kinda no point in creating an extra table. How wrong am I for our code base?

Calibrated answer: you're about half right — right for the catalog, wrong for the ledger and workspace — and your *rule* needs one amendment before it gives the right answers on this schema. All the evidence below is from the audits we just ran, so I can score each table concretely.

First the amendment. "Only ever queried parent → children[]" is a good first filter, but in Postgres it's not the decisive one, because arrays *can* be reverse-queried (`WHERE input_artifact_ids @> ARRAY[x]` with a GIN index). The dealbreakers that actually force a table are:

1. **Per-edge attributes** — an array of scalars can't carry `(source, added_by, added_at)` per element; JSONB can, but then you've lost typing and constraints.
2. **Per-edge mutation** — updating or deleting *one* element means rewriting the whole array value, with lost-update races under concurrent writers; a row is updated or deleted atomically per edge.
3. **Element-level referential integrity** — Postgres famously cannot put a foreign key on array elements. A join table gets FK-validated edges for free.
4. **Per-edge uniqueness** — a composite PK prevents double-attach declaratively; arrays need app logic.

Now table by table:

**`workflow_kinds` — you're right.** Every read is parent-scoped (the catalog snapshot, and `loadWorkspaceStart` pulling declared kinds for one workflow). No FK points *at* it, no reverse query exists, no per-edge mutation — and the whole thing is rebuilt from the binary on every boot anyway. This could be a `kinds jsonb` column on `workflows` and nothing would notice. Textbook case for your heuristic.

**`nodes` — half right.** Access is also purely parent-scoped (catalog display, plus the publish-time code-hash tripwire doing a point lookup). But it's the FK anchor for the ledger: `node_runs (workflow_id, node_id)` is validated against it. Fold it into JSONB and every node reference in the *permanent, insert-only* ledger becomes an unvalidated string. That's the trade: arrayable if you accept unvalidated node ids in the one part of the database you can never fix later. I'd keep it, but it's a judgment call, not a slam dunk.

**`node_run_inputs` — wrong, and it's your own Q9 answer.** The reverse direction isn't incidental here — it's the product. `idx_consumer` exists precisely for "which computations consumed the Goldman statement?" (impact analysis), and the reviewer dialog navigates the same edge. Yes, GIN-on-array could technically serve that query — but this is the ledger, and point 3 bites: you'd lose FK integrity on every edge of the audit trail. An audit trail with potentially dangling references isn't an audit trail. Keep the table.

**`workflow_run_artifacts` — most wrong, on all four criteria at once.** It's reverse-queried (`idx_impact`: which workspaces contain this artifact). Its edges carry attributes (`source`, `added_by`, `added_at`). And it's the *only* place in the system with per-edge mutation — promote is an UPDATE of one row, detach is the system's one DELETE. There's also a concurrency argument specific to this codebase: during a run, engine attaches arrive from parallel activity completions, each an idempotent single-row `INSERT ... ON CONFLICT DO NOTHING`. As an array column on `workflow_runs`, every one of those concurrent attaches would rewrite the same array value — contention and lost updates exactly where the system currently needs none.

(`node_runs` itself never qualifies for the question — it's not a child list but the memo store, whose whole job is the indexed point lookup `UNIQUE(engagement_id, memo_key)`.)

So the scorecard: **catalog children are arrayable (one cleanly, one arguably) because the catalog is disposable, republished data; the ledger and workspace tables are genuinely relational** — reverse-queried, edge-attributed, per-edge-mutated, or integrity-anchored. Which lines up with the grain running through this whole conversation: the closer a table sits to the permanent record, the more the relational machinery is doing real work; the closer it sits to "menu the binary reprints every boot," the more it's just ceremony.

### Q5

from now on assume I am not talking about my 9 questions, but the entire design as a whole! Did you find any other such tables that can be "consumed" into a parent?

Short answer: no — the sweep of the remaining tables comes up empty, and the reason it comes up empty is itself the most useful thing I can tell you about the design. `workflow_kinds` (clean yes) and `nodes` (arguable) were the only two, and it's not a coincidence they're both catalog tables.

The remaining five, quickly, against the four criteria:

- **`meta`** — the opposite problem: it has no parent to be consumed *into*. It's a global singleton holding exactly one key in practice (`instance_id`). Not consumable, but worth noting as the schema's other non-pulling-its-weight table: a scalar wearing a table costume. Harmless and conventional, but if you're counting ceremony, count it.
- **`engagements`** — it's a root, and its ID is the identity/memo scope, so there's nothing above it to fold it into.
- **`workflow_runs`** — child of engagements, but individually PATCHed (label, archive), point-looked-up by id, FK target of the membership table and of its own self-reference, and its primary key is what the Temporal run ID is derived from. Embedding a mutable, individually-addressed row into a parent array fails criteria 2–4 simultaneously.
- **`node_runs`** — the memo store. Its entire job is the hot-path point lookup `UNIQUE(engagement_id, memo_key)`, it grows unboundedly for the life of an engagement, and it's an FK target from two directions. An unbounded, insert-only, index-critical fact log is the least consumable thing in a database.
- **`artifacts`** — the definitive counter-case, for a reason deeper than query patterns: **shared ownership**. Consuming a child into a parent array only works when the child belongs to *exactly one* parent (exclusive composition). An artifact row is deliberately shared — one row referenced by many `node_runs` (as input and as converged output), many workspaces (membership), and the lineage graph. That sharing isn't incidental; it *is* the design: deduplicating identical bytes into one row is what makes reuse, convergence, and impact analysis work. Embed artifacts anywhere and you must duplicate them everywhere else they're referenced — which un-invents the system's core idea.

Which reveals the structural pattern your question was actually probing:

**Embedding works for trees; this schema is only a tree at the edges.** The catalog (`workflows` → `workflow_kinds`, `nodes`) is genuinely tree-shaped — exclusive composition, parent-scoped reads, rebuilt wholesale every publish — so it's document-shaped data, and both of your consumable candidates live there. The middle of the schema is not a tree: `artifacts` ↔ `node_runs` form a many-to-many *graph* (the provenance DAG), and `artifacts` ↔ `workflow_runs` form a second many-to-many with per-edge attributes (membership). Graphs with shared nodes are irreducibly relational — not by habit, but because non-duplication of the shared nodes is the point.

A blunt way to state the whole finding: if you tried to move graphflow into a document database, the catalog would collapse happily into one document per workflow, and the ledger is precisely the part that would break. The relational machinery in this schema is concentrated exactly where the product's guarantees live — which is the answer to "how wrong am I about the entire design": your heuristic correctly identifies all the ceremony, and everything it *can't* consume turns out to be load-bearing.


### Q6

I also have other comments I would like your review on:

1. it should be workflow_slot_kind not workflow_kind as immediately people start thinking this is a KIND of workflow
2. workflow_run needs help where every run (even 3 runs in January) produces lineage and provenance without a pollution of the artifacts.
   1. hack workflow_run with jsonb to isolate artifacts for each run
   2. expand the idea of a workflow to not that of January, february - but of ANY string path the application wishes to assign. It is loosey goosey, no fk.
   3. practically engagement is a client job - so its not camille but more like camille_2026_quarterly-tax-estimate . Then the paths look like camille_2026_quarterly-tax-estimate/jan_2026/run_1 - or more complicated like jan_2026/run_different_US_PFIC_treatment_1 . Of course, the actual path will be uuids, the metadata provides the commentary of the change. This opens up the way to simulations which was always the ultimate goal.

Review of both, and the second one deserves a strong verdict up front: **2 isn't a hack — it's the design the ledger has been waiting for**, and you've independently drawn the cut line in exactly the right place. Details below.

**1. `workflow_kinds` → `workflow_slot_kinds`: agreed, and your diagnosis is the right one.** "Workflow_kinds" parses as *taxonomy of workflows*; the table actually declares *the artifact kinds a workflow deals in* — its interface. "Slot" is a genuinely good word because it also fixes the `leaf` confusion from your earlier question: leaf kinds are exactly the *user-fillable slots* (brokerage statement goes in this slot), non-leaf kinds are internally-produced. One naming system, two problems solved: `workflow_slot_kinds` with `is_user_input` reads as "the slots this workflow exposes, and which ones you fill." Note the `workflow_` prefix has this ambiguity everywhere (`workflow_runs` isn't a kind of workflow either), but `kinds` is the only place it's actively misleading, because "kind" is itself a classifier word.

**2. Per-run lineage without pollution — right goal, and the architecture already agrees with you.** Recall the two facts we established: run presses are recorded *nowhere* (memo hits insert nothing), and reruns *pollute* the workspace (stale and fresh engine results accumulate side by side, nothing auto-detaches). Your proposal fixes both by adding the missing middle layer. The system currently has facts (ledger) and presentation (workspaces) but no record of *executions*. You're adding it.

On the specific sub-ideas:

**2.1 — JSONB isolation per run: yes, but put the JSONB on the right object.** Apply your own arrays-vs-tables criteria from earlier: JSONB is safe for *immutable, written-once, read-whole* data and dangerous for *mutable, concurrently-written* data. A **run manifest** — "this execution consumed inputs {a,b,c} and touched outputs {x,y,z}, these nodes executed, these were reused" — is immutable once the run completes, and the workflow already computes exactly this (its `summary()` of executed vs memo-hit nodes, currently returned to Temporal and thrown away). Have the workflow file one sealed manifest at completion: single writer, one write, JSONB array is perfectly fine. What you should *not* JSONB is the branch's **staging area** (the user's attached documents) — that's mutable, per-edge audited (added_by/added_at), and edited over time: keep those as rows. The mutability boundary decides the representation, and it happens to split cleanly along user-docs vs run-results.

**2.2 — free-form paths, no FK: survivable, and it deletes real complexity.** Two FKs are at stake and they resolve differently. The path hierarchy itself carries *nothing* load-bearing — we proved workspace identity participates in no memo key, no artifact identity, nothing the compute layer reads after launch — so it can be as loosey-goosey as you like; hierarchy is presentation. The artifact references inside manifests lose element-level FK enforcement (Postgres can't FK into arrays), but here's the mitigating fact specific to this system: **the ledger never deletes artifacts**, so dangling references can only arise from bugs, never from data lifecycle — FK integrity there is nice-to-have, not load-bearing. And there's an unexpected bonus: the entire `SNAPSHOT_CHANGED`/supersede machinery in [Runtime.ts:170](backend/src/temporal/Runtime.ts:170) exists *only* because run identity equals workspace identity — one mutex per workspace, conflict when attachments change under an open run. Give each run its own leaf (`run_1`, `run_2`) with its own frozen input snapshot, and that whole conflict class dissolves: concurrent scenario runs under one branch become a feature instead of a 409.

**2.3 — engagement as client job, UUID paths, metadata commentary: this is the architecturally correct cut, and it has a famous name.** You're keeping exactly one hard boundary — the engagement, which *is* load-bearing (it's inside the memo key and artifact identity; `camille_2026_quarterly-tax-estimate` is the dedup/confidentiality scope) — and making everything beneath it soft. What you've designed is git's object/ref split: the engagement is the repository, the ledger is the object store (content-addressed, immutable, shared), run manifests are commits (immutable snapshots pointing into the object store, with commentary), and paths like `jan_2026/run_different_US_PFIC_treatment_1` are refs — cheap, renamable, plentiful, carrying no identity. Simulations are branches, and they're cheap for the same reason git branches are: the shared prefix of computation is deduplicated by content, so `run_PFIC_A` vs `run_PFIC_B` pay only for where they diverge.

Two invariants to hold onto as you loosen everything else, because each one, violated, quietly kills a core property:

1. **Paths must never enter memo keys or artifact identity.** The moment a path string leaks into a hash, reuse across branches dies and simulations get expensive. The path layer must stay write-only commentary from the ledger's point of view.
2. **Scenario deltas must enter through the front door — as node args or attached artifacts — never as ambient config.** "Different US PFIC treatment" has to be an election artifact or an argument so it lands *inside* the memo key; then upstream work is shared and downstream work forks automatically. If it's environment or metadata, two branches would memo-hit each other's contradictory results.

One product decision your model surfaces (git has it too): with runs as immutable commits, "what does the January branch show?" needs an answer — a HEAD. Latest run, or a pinned/blessed run per branch ("run_3 is the one we sent to the client"). That's a small metadata pointer, and it's also the honest replacement for today's polluted membership list, which was trying to be all runs' results at once.

Feasibility note to close: everything this touches lives in the workspace layer — the tables we established are the *cheap* ones to reshape (editable rows, no permanent record). The ledger needs zero changes to support any of this. Which is the strongest possible sign the original layering was right: the ambitious feature lands entirely in the disposable layer.


### Q7

this is a fork question unrelated to the previous one.

imagine a world in which accounting, tax, legal etc. run random workflows on our graphflow system. we are using "workflow" and "engagement" to make sure we can scope namespace of the "kinds" (which will soon be slots or whatever). First off is this correct and what else are we doing to scope?

Second we said "temporal_workflow_type" is always GraphflowRun. but is there a situation where we want to separate this based on some other type of scope?


Both questions have crisp answers, and the first one exposes a real gap worth knowing about before the multi-practice world arrives.

## Q1: What actually scopes what

Your statement is half correct, and the half that's wrong is the interesting part. **Workflow and engagement scope different things, and neither of them scopes the kind *vocabulary*.**

The full scoping inventory as the code actually enforces it:

| Scope | What it namespaces | Enforcement |
|---|---|---|
| **Engagement** | Artifact *identity* (`engagement, kind, hash`), memo answers, payload storage paths | Hard — UNIQUE constraints, every memo lookup filters on it |
| **Workflow** | The kind *interface* (which kinds it declares, which are user-input) and the *node namespace* (`node_id` is unique only per workflow) | Medium — `ctx.attached(kind)` validates against declared kinds at run time; the attach API does *not* check |
| **Instance** (`meta.instance_id`) | Temporal workflow IDs (`wfrun-{instance}-…`) so multiple graphflow databases can share one Temporal namespace | Hard — baked into every ID |
| **Task queue** | Which worker fleet executes | Hard at dispatch |
| **The binary/registry** | Which workflows and nodes exist at all | Absolute — code is the universe |
| **Kind strings themselves** | **Nothing scopes them.** | None — free text, no FK, no registry |

That last row is your gap. `artifacts.kind` is un-FK'd free text; `workflow_kinds` is each workflow's *declaration* of which global strings it uses, not a namespace. So when tax declares kind `engagement_letter` and legal declares kind `engagement_letter`, those are **the same string in one flat, instance-wide vocabulary**. Within a shared engagement (one client job with tax and legal workstreams), that means: identical bytes filed under that kind are *the same artifact row* across both practices, browsing the engagement pool by kind mixes both practices' documents, and — the sharpest edge — the kind is the type system between nodes, so two practices using one string for two different payload schemas is silent type confusion. Nothing anywhere validates payload shape against kind.

Two things to know before you fix it. First, the flatness is partly a *feature*: shared kind strings are the only mechanism for cross-workflow document flow — tax's `master_txn_list` can feed a legal workflow precisely because the string is global. Second, the enforcement is thinner than the schema suggests: server-side you can attach an artifact of *any* kind to *any* workspace (the leaf/declared filtering lives in the UI and in run-time validation only). So in the random-workflows world, your realistic options are a naming convention (`tax.verified_txns`, `legal.hold_notice` — cheap, preserves interop, relies on discipline) or a first-class kinds registry — a table that doesn't exist today — mapping each kind to an owning practice, a description, and ideally a payload schema. That registry would be a *catalog* table, i.e. in the cheap-to-change layer.

One more scope that's conspicuously **absent** for the multi-practice world: authorization. `created_by`/`added_by` are annotations, not access control — there is no practice, team, or permission concept anywhere. Engagement is currently doing double duty as the only confidentiality wall. If legal's engagements must be invisible to accounting, that's a whole missing dimension, not a column.

## Q2: When would `temporal_workflow_type` stop being a constant?

The precise rule: **the workflow type answers "which orchestration *program* runs," and it should vary only by execution *shape or engine version* — never by business domain.** The system itself already proves this rule: there is in fact a second type in the binary, `GraphflowHumanTask` — a different shape (park a question, wait for an answer) than `GraphflowRun` (pull the root through the memo walk). Different shape → different type. Tax vs legal is not a different shape; that distinction already rides in `workflow_id` as data.

Legitimate futures where the column earns its keep:

1. **Engine versioning** — the scenario the code comment ("old workspaces keep their referent") was actually written for. If you ever change the `GraphflowRun` interpreter's replay logic incompatibly, you ship `GraphflowRunV2` as a new type; open and old workspaces keep dispatching to the old one. The column is insurance on *the interpreter*, not the workflows.
2. **New orchestration shapes from your own roadmap** — a simulation coordinator ("fan out N scenario runs, gather, compare") is a genuinely different program and would be a `GraphflowSimulation` type launching `GraphflowRun` children; likewise a scheduled/recurring-estimate driver, or a long-lived always-open "engagement entity" workflow that receives signals.

And the scopes people usually reach for here belong to *other* knobs: practice, region, resource class, priority, noisy-neighbor isolation → **task queue** (which fleet executes — e.g., legal-only workers, an EU-residency fleet, a GPU OCR pool); hard tenancy isolation with separate history and visibility → **Temporal namespace**. Type selects the program; queue selects the machines; namespace selects the tenancy universe.

So the honest posture toward that column: it's speculative today, but the thing it anticipates (interpreter versioning) is real and cheap insurance — the mistake would be reaching for it to encode *business* scope, which is what queues and namespaces are for.


### Q8


So whats the conclusion to this general problem of scoping? I am just worried the previous agent was overwhelmed by the word "tax". But this is a general purpose engine. You could even use it for cooking dishes in multiple restaurants

The conclusion comes in two parts: a verdict on your worry, and a general principle the whole conversation has been converging on.

**First, the worry: the audits say the engine is clean — with exactly one funny exception.** Across everything we traced, "tax" appears only in the two workflow definitions under `backend/src/workflows/` and the seed data — which is precisely where domain *belongs* (workflows are content, not engine). The ledger, workspace, and catalog tables contain zero domain vocabulary; the naming problems we did find (`workflow_kinds`, `leaf`, the `code_hash` collision) are *plumbing* jargon problems, not tax bleed-through. The one place domain leaked into the engine is a good catch waiting for you: **the root scope itself is named `engagement`** — pure professional-services vocabulary. Accountants and lawyers have engagements; restaurants don't. The *concept* is fully generic ("the unit within which facts may be shared"), but its *name* is the single most load-bearing identifier in the system and it's wearing a suit. If tax-brain infected anything, it's that one word.

**Second, the general conclusion about scoping.** A general-purpose engine has to answer four different questions, and it's a category error to answer them with one mechanism:

| Scope question | Mechanism in graphflow today | State |
|---|---|---|
| **Identity** — within what boundary may facts be shared, deduplicated, reused? | Engagement | **Solved, and elegantly** |
| **Vocabulary** — what does a name (`kind`) mean, and who governs it? | Global flat strings, convention only | Unsolved — fine for one team |
| **Placement** — whose code runs, where, on what release cadence? | One binary, one registry, one queue | Monolithic — seams exist (`task_queue`, catalog referent), unexercised |
| **Permission** — who may see and do what? | Nothing | Absent |

The solved row is the one that makes the engine genuinely general: graphflow's deep design decision is that **the reuse boundary and the confidentiality boundary are the same boundary**. Inside an engagement, identical bytes revive prior work; across engagements, never — even for identical bytes — so provenance can't cross-contaminate. That property is domain-free. Run it as restaurants: each restaurant (or each banquet, depending on how you cut trust) is an "engagement" — yesterday's identical prep memo-hits within the kitchen, and Restaurant A's mise en place never leaks into Restaurant B's lineage. Kinds are `diced_onion`, `brown_stock`, `plated_dish`; nodes are `reduce_stock` and a human `taste_check`; the leaf kinds are what the supplier delivers. Nothing in the schema resists this reading — which is the proof of generality.

The three unsolved rows are what actually breaks in the "random workflows from accounting, tax, legal" world — and note that *none of them is a schema deficiency in the ledger*. Vocabulary breaks first (two practices minting `report` with different payload shapes — silent type collision in a flat namespace); placement breaks second (every practice's nodes ship in one binary on one deploy cadence, shared blast radius); permission breaks whenever the org chart does. And the general principle for the first one: **vocabulary should be governed at the boundary where meaning is shared, and the engine shouldn't pick that boundary** — it should provide a kinds registry and let the deployment decide whether `stock` is one shared kind (same suppliers, same meaning) or `thai.stock` and `italian.stock` (different meanings). Today the engine forces "shared" by having no mechanism at all.

So the priority order when the multi-domain day comes, sorted by the cost model we established: a **kinds registry** (catalog layer — republished from config, nearly free), **per-practice task queues** (config plus the existing column, with the human-task bypass fixed), then **authz** (real work, new dimension), and — the punchline that has ended every thread in this conversation — **zero changes to the ledger**. The permanent layer is already domain-free and scope-correct; every generalization lands in the disposable layers. The previous agent didn't over-fit the engine to tax. They just named the tenant after their first customer.


