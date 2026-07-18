# ELI5 — Why the graphflow database looks the way it does

This document answers nine "is this column even needed?" questions about the schema in
[backend/src/infrastructure/db/Db.ts](backend/src/infrastructure/db/Db.ts), in plain business
language, using the project's **real** workflow and seed data — no invented examples. Each answer
ends with a verdict: keep, rename, or candidate to drop. A smell report at the end collects the
verdicts, because the ledger tables are permanent by design and deserve to be settled *before*
they fill up with facts.

---

## The cast (real data from `graphflow seed`)

- **Engagement:** "Acme Ltd — UK Tax FY 2025/26" — the year-long client relationship.
- **Workspaces:** "January estimate", and "February estimate" (created as a copy of January).
- **Workflow:** `tax_demo_workflow` — the recipe for one estimate:
  1. You upload **brokerage statements** (Morgan Stanley, Goldman Sachs, Fidelity) and **payment slips**.
  2. `ocr_brokerage_statement` / `ocr_payment_slip` extract the transactions.
  3. `verify_txns` — a **human** (reviewer Priya Sharma) checks each extraction.
  4. `append_to_master` folds all verified batches into one master transaction list.
  5. `calculate_tax` applies 25%.
  6. `build_report` produces the final report.
- There is also `tax_demo_workflow_v2`, identical except the tax rate is corrected to 24% — only
  the calculator and report nodes changed; the OCR and verify nodes are byte-for-byte the same.

The database has three groups of tables, and each group answers to a different boss:

| Group | Tables | Nature | Who owns the truth |
|---|---|---|---|
| **Catalog** | `workflows`, `workflow_kinds`, `nodes` | The menu: what services exist | The deployed code; re-published into the DB on every boot |
| **Ledger** | `artifacts`, `node_runs`, `node_run_inputs` | The permanent case file: every document and every computed answer, never edited, never deleted | The database — this is the real record |
| **Workspace** | `workflow_runs`, `workflow_run_artifacts` | The desk: what's pinned to "January estimate" right now | The user; freely editable |

One consequence worth internalizing before the answers: **catalog mistakes are free** (the table is
rebuilt from the binary at every publish), **workspace mistakes are cheap** (rows are editable),
but **ledger mistakes are forever** (insert-only). So schema-tightness anxiety should concentrate
on questions 6, 7, and 9 below — those are ledger columns.

---

## Part 1 — The trivial ones

### Q1. `workflows.temporal_workflow_type` — what is this?

When you press **Run** on "January estimate", the system hands the job to the job-runner
(Temporal) and must name which registered entry function to start. This column stores that name.

Here is the punchline: **every row in every database always contains the same constant,
`'GraphflowRun'`.** There is exactly one entry function; the tax workflow isn't its own entry
function — it's *data passed into* the one generic entry function. The publish step literally
stamps the same constant into every row, and exactly one line of code ever reads it back.

**Verdict: your suspicion is correct — speculative.** It exists in case a second entry function
ever ships (so old workspaces would keep pointing at the old one). Until that day it is a constant
photocopied into every row. Dropping it is a one-line code change.

### Q2. `workflows.task_queue` — what is this?

The name of the **worker fleet** that jobs get handed to — "which office handles this work." It is
genuinely read at dispatch time, so it is not dead. But:

- Every publish re-stamps **all** rows from a single environment variable, and publish re-runs on
  every API boot — so in practice every row always equals the env var. It's a per-row photocopy of
  one setting.
- Worse, the abstraction is only half-kept: **human review tasks ignore this column** and use the
  env var directly. If a row ever *did* differ from the env var, a run and its own human review
  tasks would be dispatched to two different offices.

**Verdict: half-committed.** Either commit (make human tasks route through it too, so per-workflow
fleets actually work) or simplify (read the env var at dispatch and drop the column). The current
state is the worst of both: the flexibility is paid for but not usable.

### Q4. `workflow_kinds.leaf` — why does this exist, and why is it an integer?

`leaf` answers one product question: **"is this a document the user is expected to upload, or
something the engine produces?"**

- `brokerage_statement`, `payment_slip` → `leaf = 1`: nothing in the workflow produces them, so
  they must come from you. The upload dialog offers exactly these by default.
- `ocr_txns`, `verified_txns`, `master_txn_list`, `tax_calc`, `final_report` → `leaf = 0`:
  engine-made. The UI shows them as "Intermediate (override attach)" and hides them behind an
  advanced toggle.

It is computed mechanically at publish time: a kind is a leaf if no node's output is that kind.

Why INTEGER: SQLite has no boolean type; 0/1 is the standard convention. (Mild inconsistency: it
is the schema's *only* int-boolean — the other two-state facts use text values like
`'user'`/`'engine'`.)

**Verdict: the fact is needed (it drives the upload dialog), the name is the problem.** "Leaf" is
graph vocabulary; the business meaning is `is_user_input`. Fun footnote: the name is actually
consistent with how the system runs — you pull the final report at the root, and your uploaded
documents are the leaves of that tree — but nobody staring at an upload dialog thinks in trees.
Also note it's derivable (declared kinds minus produced kinds), so it's a convenience cache, not
an independent fact.

### Q8. `workflow_runs.copied_from_workflow_run` — why record this?

"February estimate" was created as a copy of "January estimate" (the copy carries over only *your
uploaded documents* — never computed results, which February re-derives or reuses automatically).
This column is the sticky note recording *where the copy came from*.

After creation it participates in **zero logic** — verified: no query filters on it, no branch
reads it. Its one job is the "copied from January estimate" backlink the UI renders.

**Verdict: a breadcrumb.** Cheap, harmless, non-derivable (nothing else records the source), and
the UI does display it. Keep it; just don't expect it to *do* anything.

---

## Part 2 — The medium ones

### Q3. Is the `workflows` table needed at all?

Think of it as the **restaurant menu**. The kitchen (the deployed worker binary) knows how to cook
every dish; the menu exists so the front-of-house — the API, the UI, the database's own integrity
rules — can know what's offered *without asking the kitchen*.

Its four real jobs:

1. **Referential anchor.** Every workspace row and (through `nodes`) every ledger fact points into
   it. A typo'd workflow name physically cannot enter the database.
2. **Serves the catalog screen.** The new-workspace dialog and the attach dialog are built from
   this table's contents.
3. **Dispatch.** Pressing Run reads this row to know how to start the job (see Q1/Q2).
4. **Memory of retired versions.** Rows are published but never deleted. When
   `tax_demo_workflow` v1 is eventually removed from the code, workspaces built on it still render
   with proper names in the UI instead of pointing at an id nothing can describe.

**Verdict: keep.** The table is needed; the *suspicious part* is two of its four columns (Q1, Q2).
Job 4 is the only thing the binary alone genuinely cannot provide.

### Q5. Why does `nodes` also have a `code_hash`? What is it?

Every node's code gets a build-time fingerprint (a hash of its authored source). This catalog
column is the record of **"which version of each calculator is currently deployed."**

Its two actual uses:

1. **In-place-edit tripwire.** At publish, the new fingerprint is compared with the previously
   published one; if it changed under the same workflow id, a warning prints: *"in-place edit
   detected for tax_demo_workflow/calculate_tax — consider copying to _v2."* That check inherently
   needs the DB (only the DB remembers what was published *last time*).
2. **Version-diff display.** The catalog UI badges which nodes changed between v1 and v2. In the
   real demo: only `calculate_tax` and `build_report` differ; the OCR and verify nodes are
   identical — which is exactly why January's OCR work and Priya's verifications survive an
   upgrade to v2 untouched.

What it is **not**: the fingerprint used when running. Execution and answer-reuse use the
fingerprint compiled into the binary, never this column. Drop it and nothing about computation
changes.

**Verdict: audit/UX only — fine to keep, but it has a naming collision** with `node_runs.code_hash`
(Q6), which is a *different* fact. This one means "currently deployed"; that one means "actually
ran at the time." Same name, two meanings, one rename overdue (e.g. `deployed_code_hash`).

---

## Part 3 — The deep ones (ledger columns — the permanent record)

### Q6. Why does `node_runs` have both `code_hash` AND `memo_key`?

Because they record **two different facts about the same computation**:

- **`memo_key` is the question.** A fingerprint of *"calculate_tax, version X, applied to exactly
  this master transaction list."* It works like a sealed envelope: the system only ever asks "have
  I seen this exact envelope before?" (that's the uniqueness rule that makes reruns free). You
  cannot open the envelope — a fingerprint is one-way.
- **`code_hash` is the sworn statement on the answer:** *"the code that actually executed was
  version Y."*

Why can X and Y differ? Because the question is composed in one place (the coordinator deciding
what January needs) and the work executes in another (whichever worker picks up the task). During
a deployment, those can briefly be different versions of the software. Concretely: mid-rollout of
the 24% fix, a rerun of January could file a row whose *question* was fingerprinted by the 25%
build while the 24% code actually executed. The row stores both sides, so that story is on the
record forever. Neither column can be derived from the other — the envelope can't be opened, and
the executing worker never sees the version that minted the question.

**Verdict: principled — keep both.** Today nothing queries `code_hash` (it's a pure audit trail),
but it is the only durable record of *what actually ran*, and the only witness if a deployment
ever races a rerun.

### Q7. Why does `artifacts` need to know which run produced it?

The visible reason: every document in the case file states its own origin. The UI's Origin column
— **"Uploaded by thet"** vs **"Engine · calculate_tax"** — is rendered from this column;
`NULL` means user-uploaded.

But your smell is half right, and it's the best catch of the nine. There is *already* an arrow in
the other direction: each run records `output_artifact_id` ("I produced that"). So this column is
*almost* a convenience copy of information the ledger already has. Almost — one corner is genuinely
its own: when a user uploads a file and an engine computation later produces **byte-identical
output**, both are filed as the *same* stored row (identical bytes are deduplicated), and only
this column remembers that the row was *born* as an upload rather than computed.

Now the cost side, which is where the over-engineering lives: this single column is the **sole
reason** for the schema's two most exotic mechanisms —

1. the **circular reference** between `artifacts` and `node_runs` (each points at the other),
   which requires deferred constraint checking, and
2. the **id pre-allocation trick** (computing `MAX+1` by hand inside the transaction) so an
   artifact can point at a run that doesn't exist yet.

Replace the column with a plain `origin` text field (`'user'` / `'engine'`) and both mechanisms
evaporate, while the UI keeps its Origin column intact. What you'd give up: the direct link *which
specific run* created the row (still reconstructable from the runs' own output pointers for the
common case).

One latent wrinkle the audit surfaced: in the upload-then-converged corner, today's API can
already disagree with itself — the artifact's metadata says "user-uploaded" (`NULL`) while the
lineage view names a producing run. That's a symptom of storing the same relationship twice.

**Verdict: the FACT is required, the FORM is the smell.** This is the one ledger design decision
worth settling *now*, before the ledger fills up — exactly your "we don't want to migrate later"
concern, aimed at the right column.

### Q9. Why does `node_runs` need `node_run_inputs`?

Short version: **the envelope again.** `memo_key` *contains* the inputs the way a sealed envelope
contains a letter — present, but unreadable and unlistable. `node_run_inputs` is the readable
list: "this run consumed artifacts 12, 17, and 31."

That list is what answers the questions your business actually asks:

- **Impact analysis.** "The Goldman Sachs statement was wrong — what did it touch?" Walk the
  edges: statement → the OCR run that consumed it → its extraction → Priya's verification → the
  master list → the tax calculation → the January report. Every hop is a row in this table (or the
  producer pointer). Without it, that question is *unanswerable* — you cannot run fingerprints
  backwards.
- **Reviewer navigation.** When Priya opens a verify task, the app walks this edge to show her the
  original brokerage statement *behind* the OCR extraction she's checking. That's application
  logic sitting directly on this table, not just display.

The two structures are complementary, and neither derives the other: `memo_key` answers *"is this
the same question?"* in one indexed lookup; `node_run_inputs` answers *"what fed what?"* as a
walkable graph.

**Verdict: unambiguously keep.** This table is the reason the ledger is an audit trail rather than
just a cache.

---

## The smell report

Your overall instinct — "some of this is over-done" — is validated in three places and refuted in
four. The table, ordered by how much you should care:

| # | Element | Verdict | Action for a tight ERD |
|---|---|---|---|
| 7 | `artifacts.produced_by_node_run` | Fact needed, form costly — sole cause of the circular FK **and** the id pre-allocation trick | **Decide now** (it's a ledger column): keep as-is, or replace with an `origin` flag and delete both mechanisms |
| 1 | `workflows.temporal_workflow_type` | Speculative — the same constant in every row | Drop (one-line code change) unless a second entry function is truly planned |
| 2 | `workflows.task_queue` | Degenerate copy of one env var; human tasks bypass it | Commit fully (route human tasks through it) or drop to env — the half-state is the worst option |
| 5 | `nodes.code_hash` | Audit/UX only; name collides with `node_runs.code_hash` (a different fact) | Keep; rename (`deployed_code_hash`) to end the collision |
| 4 | `workflow_kinds.leaf` | Needed by the upload UI; jargon name; derivable | Keep; rename `is_user_input` (or compute it in the API and drop the column) |
| 8 | `workflow_runs.copied_from_workflow_run` | Harmless breadcrumb; UI renders it | Keep |
| 3 | `workflows` table | Load-bearing (FK anchor, catalog UI, dispatch, retired-version memory) | Keep |
| 6 | `node_runs.code_hash` + `memo_key` | Principled — two different facts that legitimately diverge | Keep both |
| 9 | `node_run_inputs` | Load-bearing — the only readable input edge; powers impact analysis and reviewer navigation | Keep |

And the migration-risk lens that should drive priorities: the **catalog** tables are re-published
from the binary on every boot, so changing them is nearly free; the **workspace** tables are
ordinary editable rows, so changes there are routine migrations; the **ledger** tables are
insert-only and accumulate the permanent record, so they are the ones you get one good chance at.
Of the nine questions, only Q6, Q7, and Q9 live in the ledger — Q6 and Q9 are already right, which
leaves **Q7 as the single decision genuinely worth making before this system accumulates history.**
