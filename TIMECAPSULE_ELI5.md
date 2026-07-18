# TIME CAPSULE — the plain-English edition

The plain-language twin of [TIME_CAPSULE.md](TIME_CAPSULE.md): same review, same nine projects,
same item numbers — P2.2 here is P2.2 there. This file tells the story; that file holds the code
evidence, so no file or line references appear here — each project ends with a "chapter and
verse" pointer back instead. Every claim was verified against the running code by independent
reviewers; where checking changed our minds, the item says so. Companions: [ELI5.md](ELI5.md)
(the database, same style) and [schema.dbml](schema.dbml) (the diagram).

## The world in one page

**The three-drawer cabinet.** The database is three drawers, each forgiving mistakes differently:

- **The menu** (the code says "catalog"): what services exist. Reprinted from the deployed code
  at every boot, so mistakes are nearly free (fully free once P2.0 ships a wipe-and-rebuild path).
- **The desk** (the code says "workspace"): what's pinned to "January estimate" right now.
  Editable rows; mistakes cost a routine fix.
- **The case file** (the code says "ledger"): every document and computed answer, written once,
  kept forever. Only two changes are ever allowed — renaming a document's display label, and
  unpinning something from a desk. So **the case file is the only place where design mistakes are
  forever** — that is why P2 exists and has a deadline. (The system's own word for any stored
  document or result is "artifact"; this document says "document or result.")

**Questions and answers.** Every computation is a *question* with a fingerprint: "calculator
version X applied to exactly these documents." Every document or result is an *answer* with a
fingerprint of its bytes. Ask a question the engagement has asked before and the stored answer is
reused — nothing recomputes. So rerunning January costs nothing (every question is a repeat), and
the v2 rate fix (25% → 24%) redoes only the calculator and report — the OCR steps and Priya
Sharma's verifications are the same questions word-for-word, so their answers carry over
untouched. Deliberate subtlety: each next question is built from the previous answer's *content*,
not its history — so different routes producing byte-identical output converge on one stored
answer, and a harmless upstream code change never invalidates finished downstream work. "Who made
this" — the paper trail — lives in ordinary columns, never inside the fingerprints (rule 1).

**A workspace is a folder, not an execution.** Pressing Run on an unchanged January adds zero
rows to the database. The running happens inside Temporal (the job-runner service), and the live
tally you watch — six computed, two reused, one waiting on Priya — evaporates when the run ends;
it is never stored. (P5 fixes that with run receipts.)

**The engagement is the wall.** "Acme Ltd — UK Tax FY 2025/26" is the one hard boundary: what
counts as the same document, which answers may be reused, even where raw files sit on disk. Reuse
and confidentiality share one wall on purpose — inside Acme everything is shared freely; nothing
of Acme's is ever reused for Blue Harbour LLP. Workspaces scope nothing the engine reads; they
are just named views over the case file.

**One engine, many recipes.** Exactly one generic job program plus one human-task program are
registered with the job-runner — verified as the only two. The tax workflow is *data fed into*
that program; each step is looked up by name in a registry compiled into the worker. The
parallelism is real: the demo's OCR-then-verify chains run side by side, so Priya's waits overlap.

**Where this is going: think "saved versions,"** like the way programmers keep versions of code.
The case file keeps everything ever computed. Each run gets a **receipt** — a sealed record of
what went in and what came out. Workspaces become **cheap labeled folders** (a label like
`jan_2026/scenario_1` costs nothing), each carrying **the pin that says: this is the one we sent
the client.** Simulations are just more folders sharing one case file. Two rules protect that
future: folder names never enter question fingerprints or document identity, and what-if changes
enter only as inputs — never as ambient configuration.

**The engine has no idea it does tax.** Verified: no tax vocabulary in the engine's schema,
types, or API; "engagement" is the only professional-services word. Two leaks in the engine
proper: the command-line auto-approver only understands the demo's verification answers, and the
command-line help names demo clients. Seed commands and engine test fixtures also speak tax —
accepted as demo tooling, recorded so the exemption is a decision, not an oversight. The engine
is general-purpose; the tenant is named after its first customer.

## How the nine projects are ordered

**P1 → P2 → (P3, P4) → P5 → P6**, with **P7** a parallel track that must land before anyone
outside the team can reach the system, **P8** waiting for real demand, and **P9** waiting on P2
plus P5's schema decisions. The logic: outright bugs first (P1); then the decisions that become
permanent (P2 — the case file); then the free and cheap cleanups (P3, P4 — the menu) so nothing
doomed gets polished; then the big build (P5) and what it unlocks (P6). Renaming comes *after*
structural decisions — why P4 now covers only the menu, with desk vocabulary moved into P5.

## P1 — Critical engine integrity

Bugs that are wrong under any future design: small, independent, do now. Fact-checking rescoped a
few — where a "bug" is really something a later project removes at the root, P1 keeps only the
piece worth doing today.

1. **Two screens disagree about where a document came from — and the tie-break is luck of the
   draw.** Upload a file, then let an engine step produce byte-identical output: both are filed
   as one row, so one screen says "uploaded by you" while the paper-trail screen names an engine
   producer — and with several runs converged on those bytes, *which* producer gets named is
   random-ish (the lookup takes whichever row comes first, no order promised). P2.1 fixes the
   root — one fact stored two ways. The P1 piece: make the paper trail always the same, on
   purpose — order the lookup or return every producer. (The existing to-do chip, task_2edff0c1,
   rescopes to just this if P2.1 is accepted.)
2. **A job sent to an office nobody staffs: it waits forever, and no dashboard shows it.** Menu
   rows name the worker office that handles them; publishing never deletes rows, so a retired
   workflow's row can keep an office no worker polls — and every recovery mechanism (sweep,
   inbox, task list) watches only the currently staffed office; even the stale-run protection
   needs a worker to answer. P1 scope: warn or refuse at Run when the row's office differs from
   the live one, and widen the sweeps; office ownership is P3.2's call. Correction on record: the
   theory that a run and its human review tasks could land in two different offices was refuted —
   human tasks always follow the worker executing the run.
3. **Rerun resurrects unpinned engine results.** Unpin an engine result from February's desk,
   press Run: the engine re-asks the same question, the answer cache finds the stored answer and
   quietly pins it back, fresh timestamp and all. Committed decision: no interim patch — a real
   guard needs a "removed on purpose" marker on the desk's pin list, which P5.2 deletes outright.
   P1 ships an automated test documenting the behavior plus a known-issue note; root fix in P5.2;
   escape hatch: build the marker only if P5 slips past an agreed date.
4. **Archived workspaces are not actually read-only.** Archiving January stops nothing — pin,
   unpin, edit, even Run still work. Cheap guard now: reject changes and runs on archived
   workspaces. P5.10 revisits "archived" for the folder era; the guard survives in spirit.
5. **You can swap a workspace's recipe underneath an open run.** The workspace-edit call lets you
   repoint February from v1 to v2 while a run is open — no check, no compatibility warning — and
   the next Run, if inputs are unchanged, silently latches onto the *old* recipe's still-running
   execution. You believe you ran v2; you're watching v1.
6. **Pinning a document the recipe can never use still churns the run's identity.** Pinning
   checks only same-engagement. Pin January's final report onto February's desk: the recipe never
   *reads* final reports, so it can never be consumed and never affects any question — yet it
   enters the run's input snapshot and its fingerprint, so the engine thinks inputs changed and
   the double-click and stale-run protection fires for nothing. Fix at pin time, written against
   a "what kinds does this recipe declare" accessor, not the underlying table — so the fix
   survives P3.3 (absorbs that table) and P8.1 (replaces it with a registry).
7. **Where you start the app decides which database you get.** The database path and storage
   folder default to *relative* paths resolved against the launch directory — two processes
   started from different folders silently operate on two different case files, today. Resolve to
   absolute paths or refuse relative ones. (Moved up from P9 because it bites now.)

Moved out during review: the declared-kinds list that only ever gets looser, never tighter → P3.3
fixes it as a by-product; the auto-approver's tax hardwiring → P8.5; the missing "rename an
engagement" feature → the chores list.

*Chapter and verse: TIME_CAPSULE.md §P1.*

## P2 — Hardening the case file (decide-once columns)

The case file is written once and kept forever, so these decisions have a deadline: before real
engagements accumulate history, and before the Postgres port freezes the shape.

0. **First, build a safe way to renovate the database without losing what's in it.** Review found
   the plan unbuildable without this: today the code can only create tables that don't exist yet
   — it cannot change one that does, and nothing records which schema version a database is on.
   Deliver: a schema version number, an ordered runner of renovation steps, the P2.1 backfill
   (stamp every document "user" or "engine" from the pointer it already carries), and a
   wipe-and-rebuild-the-menu-at-boot path — what makes P3 "nearly free" in fact. **Hard gate for
   every schema-touching item in P2, P3, and P4.**
1. **Replace "which run produced this document" with a simple born-as flag — or explicitly
   recommit to the pointer.** Verified: two tables pointing at each other, which forces two
   awkward workarounds, exists *solely* so a document row can point at a run row not yet written.
   A plain born-as column ("user"/"engine") keeps the one unreconstructable fact — born as an
   upload, or as a computation? — while "which run created it" stays derivable for engine-born
   rows (the earliest run listing it as output). Delete the pointer and both workarounds
   disappear, plus their dedicated test. The complete rework list, so nobody under-prices it: the
   API's "produced" flag and response formatting, the frontend store/schema/mapper, the CLI show
   command, and two frontend views that display the producing step's name — those two need the
   earliest-creating-run fact from the paper-trail endpoint instead. Prerequisite: safety-net
   tests pinning today's behavior — who wins when two runs finish the same answer at once;
   retries (a step may run more than once, so recording completion must be safe to do twice); the
   upload-then-identical-engine-bytes corner. Completion recording is the most safety-critical
   code in the system; its direct coverage is thin.
2. **Record which code version composed each question — a second column, committed.** A work
   order carries the question fingerprint but not the code fingerprint that composed it; the
   worker files its *own* code's fingerprint. Mid-rollout of the 24% fix — half the workers still
   on 25% — the recorded "code that ran" can disagree with the version sealed inside the
   question, and the composing version is lost forever. Overwriting the existing column is dead:
   it would destroy the "code that actually ran" fact item 4 protects. So: a second column, on
   the work order and down the human path too (a review task freezes its code fingerprint at
   creation; Priya may answer days later, after a deploy), with a fallback for jobs already
   running when the change lands. Rows written before this ships are unfixable — the deadline.
3. **Affirmation, decision deliberately deferred.** "Created by" is display text, never something
   the system trusts for permissions. Optional new case-file columns remain allowed (via P2.0's
   renovation tool) — exactly why the *verified* reviewer-identity column can safely wait for P7,
   where an identity model will actually exist.
4. **Affirmations, written down so nobody "simplifies" them later.** The question fingerprint and
   the executed-code fingerprint are two different facts (question asked vs code that ran) — keep
   both. The readable list of what each run consumed is the only walkable input trail — impact
   analysis ("the Goldman Sachs statement was wrong; what did it touch?") and Priya's view of the
   source document behind an extraction depend on it; fingerprints cannot be run backwards to
   replace it. Fingerprinting answers by their bytes, in advance, is what makes reruns free and
   answers convergent — never "optimize" identity into paper trail.

Exit criterion for P2 and every schema-changing project after it: [schema.dbml](schema.dbml) and
[ELI5.md](ELI5.md) updated in the same change.

*Chapter and verse: TIME_CAPSULE.md §P2.*

## P3 — Menu diet (removal and absorption)

Nearly free once P2.0's wipe-and-rebuild path exists — the menu is reprinted from code at boot.

1. **The "which entry program" column: keep, and write down why.** Review flipped this default.
   Every row holds the same constant (there is only one entry program) and one line of code reads
   it — a textbook column to delete. But the per-row pinning it provides — old workspaces keep
   pointing at the program they were built for — is precisely the cutover lever if P5 ships as a
   second program ("V2"). Final call belongs to P5 planning (P5.8); don't discard the parachute
   before deciding whether to jump.
2. **The "which office" column: pick one boss.** Either the environment setting is the only
   authority (drop the column) or the menu row is (then P1.2's sweeps and the worker config must
   honor it). Verified: every boot re-stamps all rows from the environment *except* retired
   workflows, whose stale office is intentional pinning. The pinning and the unstaffed-office
   failure are the same mechanism; decide which you want.
3. **Fold the per-workflow kinds list into the workflow row,** as a JSON column (a structured
   list in one cell). Verified safe: nothing else references that table, both reads go through
   the parent, and a list preserves declaration order naturally. Overwriting the whole list per
   publish also closes the bug where declared kinds could only ever get looser, never tighter
   (originally a P1 item). Makes P4's rename of that table moot.
4. **Keep the steps list as a real table.** It anchors the case file's cross-references, serves a
   genuine query (the stats page counts human answers by joining through it), and powers the
   publish-time tripwire warning "you edited this step's code in place — consider a v2."
5. **Make retired-version retention an explicit, written policy.** Today it's an accident of
   "publish adds and updates but never deletes" — an accident P3.1 and P3.2 both quietly depend
   on. Promote it to a promise.

*Chapter and verse: TIME_CAPSULE.md §P3.*

## P4 — Vocabulary reset (menu only)

After the P2/P3 decisions. Review moved all desk-side renaming into P5 — you don't repaint a wall
you're about to demolish. P5 doesn't touch the menu, so these renames can't be doomed by it.

1. **"Workflow kinds" → "slots."** The list is really each workflow's named sockets — the
   document kinds it accepts and produces — not "kinds of workflow," the universal misreading.
   Becomes a `slots` JSON field per P3.3, or a slots-named table if kept relational.
2. **"Leaf" → "is_user_input."** The business fact is "a document you upload" versus "something
   the engine makes," and it drives the upload dialog's default list. "Leaf" is tree vocabulary;
   nobody staring at an upload dialog thinks in trees.
3. **Give the menu's code fingerprint a name that says "currently deployed."** It shares a name
   with the case file's "code that actually ran" fingerprint — same words, two facts — and P2.2
   adds a third ("the version that composed the question"), making the three-way distinction
   worth naming precisely.
4. **"Engagement" stays, for now.** The concept — the unit of trust and reuse — is generic; only
   the word smells of professional services. Renaming touches the engagement id column on every
   case-file table, a real renovation — if it ever happens, it rides the P9 port window. Parked,
   not lost.
5. **Doc-sync,** per the P2 exit criterion.

*Chapter and verse: TIME_CAPSULE.md §P4.*

## P5 — Runs as first-class (the saved-versions overhaul)

The desk layer rebuilt on the saved-versions model. The case file needs zero changes — verified.
Review re-priced this as the **largest project in the plan**: the database work is the cheap
part; the API contract and frontend rebuild are the real cost.

1. **Run receipts, sealed at completion.** Persist what today evaporates: the exact input
   snapshot, every document the run touched, and the tally (computed vs reused vs
   waited-on-a-person). Only one writer ever touches a given receipt — the finishing job itself —
   so a plain JSON document is safe. Today's live-progress stream assumes one run per workspace,
   which item 5 deletes; it gets re-addressed in item 6, not reused as-is.
2. **Split the staging area from the results.** The folder keeps only what *you* staged — your
   uploaded documents, editable rows with a proper pin/unpin/promote story — while engine results
   stop polluting the pin list and live in receipts. Fixes P1.3 at the root and ends the
   stale-and-fresh-reports-side-by-side display (our own demo script grabs "the last report in
   the list" to dodge the stale one).
3. **Free-form folder labels.** Workspaces become cheap labeled folders: an unguessable internal
   id, a path-shaped label like `jan_2026/run_pfic_scenario_1`, room for commentary. The apparent
   hierarchy is presentation only — no real nesting. Verified safe: a workspace's identity enters
   no question fingerprint, no document identity, nothing the engine reads after launch.
4. **The pin that says: this is the one we sent the client.** One blessed run per folder line —
   "run_3 went to Acme." The honest replacement for today's polluted pin list.
5. **Dissolve the double-click and stale-run protection.** It exists only because a workspace and
   its run share one identity — one job id per workspace, so a second press must reuse the first
   run or kill it. Per-run identities with frozen input snapshots make concurrent what-if runs a
   feature instead of an error.
6. **Re-address the execution API.** Run, status, progress, and the live stream are all addressed
   by workspace id today; once a workspace holds many runs, "the run for this workspace" stops
   meaning anything. A breaking, versioned API change — priced in now (review found it unpriced).
7. **Rebuild the frontend.** The workspace page's pin list changes meaning (engine rows leave
   it), and run history, receipts, and the blessed-run pin need new views. Also previously
   unpriced.
8. **Decide what happens to jobs already running when the engine changes under them.** Item 2
   changes the engine's mid-walk behavior, and the job-runner replays a run's recorded history
   against current code on recovery — replays must be always the same, on purpose, so old runs
   replayed against new code fail. Runs *do* park on human tasks for days, so there will be open
   runs at cutover. Options: drain first, use the job-runner's version-compatibility switch, or
   ship a second entry program ("V2") — and if V2, the P3.1 column is exactly the pinning lever
   that makes the cutover safe. P3.1's final decision lands here.
9. **Name the desk vocabulary once, in the new model's terms** (moved from P4): folder, staged
   input, member, receipt — instead of renaming the old model's parts and then demolishing them.
10. **Define "archived" for the folder era,** refining P1.4's stopgap guard.
11. **Rules we never break, enforced in code review:** folder names and labels never enter
    question fingerprints or document identity; what-if deltas enter only as calculator inputs or
    attached documents.

*Chapter and verse: TIME_CAPSULE.md §P5.*

## P6 — Simulation engine (the stated ultimate goal; needs P5)

1. **Scenario folders sharing one case file.** Ten what-if branches of the February estimate all
   reuse the shared opening steps (repeat questions); only the part that differs computes. An
   assumption enters a scenario as the delta-as-document pattern — e.g. a document electing a
   different tax treatment for a foreign fund (the demo's "PFIC election") — because an attached
   document is part of the question, and ambient settings are not.
2. **Compare and diff views** across sibling runs' receipts: what did scenario 3 compute that
   scenario 1 didn't, and what changed in the answer?
3. **A simulation coordinator** — fan out N scenario runs, gather, rank. A genuinely new
   *coordination shape*, the only correct reason to register a new entry program with the
   job-runner (never a new business domain).
4. **The scale tripwire, threshold stated.** Wide fan-outs all queue at SQLite's
   one-writer-at-a-time door, each willing to wait fifteen seconds before giving up. If
   simulations exceed a handful of concurrent scenario runs — or give-up retries appear — **P9
   jumps ahead of further P6 work.**

*Chapter and verse: TIME_CAPSULE.md §P6.*

## P7 — Access and exposure (parallel track; lands before real-world exposure)

The finding that frames this project: the engagement wall only gates *writes*. Reads are global.

1. **There is no login and no permission system, anywhere.** No gatekeeping layer, no notion of
   who is asking, no permission table — verified by exhaustive search. The entire lock today: by
   default the server listens only on the machine it runs on.
2. **Documents are numbered 1, 2, 3 — anyone can walk the numbers.** Fetching or editing a
   document by number checks no engagement at all, so anyone who can reach the API can read every
   client's documents with a counting loop — Acme's reports, Blue Harbour's statements, all of it.
3. **Anyone can answer any human task — and the answer is forever.** The only check on a
   submitted answer is a prefix on the task id. Blue Harbour's Q1 estimate is waiting on two of
   Priya's reviews right now; nothing stops someone who is not Priya from answering them, and
   because human answers are cached permanently, a spoofed answer becomes a permanent case-file
   fact every future run happily reuses.
4. **Reviewer identity gets decided here** (moved from P2.3, on purpose): choose how people are
   represented once the login model exists, then add it as an optional new case-file column —
   always safe under rule 3. Until then, "created by: Priya Sharma" is unverified display text.
5. **The live progress streams have no lock either.** Decide the intended posture per deployment
   mode (laptop demo versus shared server).
6. **Exit criterion:** the exposure audit re-runs after any project that adds API surface — P5
   and P6 both do.

*Chapter and verse: TIME_CAPSULE.md §P7.*

## P8 — General-purpose scoping (multi-practice readiness; waits for demand)

The engine's data model is domain-free — verified. Its *governance* model is single-team: fine
while one team runs one practice, not the day a second practice shows up.

1. **Vocabulary.** Document kind names are one flat, unpoliced pool shared by the whole
   installation: nothing stops two teams from both coining `final_report` and meaning different
   things. Multi-practice needs a kinds registry (owner, description, expected shape) or dotted
   names. Governing must happen wherever meaning is shared — the engine supplies the mechanism;
   the organization picks the boundary.
2. **Placement.** Per-practice worker fleets via the office mechanism (after P3.2 settles office
   ownership); the job-runner's namespaces — hard walls between tenants — for real isolation.
3. **Permission.** P7's dimension, extended to practice and team scoping.
4. **Naming.** The "engagement" → generic-term decision, parked in P4.4, comes due here.
5. **Generalize the auto-submitter** (moved from P1, on purpose). The command-line auto-approver
   only understands the demo's verification answer shape; the strategic fix is pluggable
   submitters per step kind — multi-domain work, not a bug fix.

*Chapter and verse: TIME_CAPSULE.md §P8.*

## P9 — Postgres port and fleet unpinning (the declared eventual target)

Gates, per review: P2 decided AND P5's schema decisions final (receipts and the staging split —
decided, even if not fully shipped), so the port's concurrency homework happens once, not twice.
P4's renames are preferred but not gating — names can be redone after the port.

1. **The schema mapping carries the earlier verdicts.** Menu children may collapse into JSON
   columns (tree-shaped, owned by one parent); the case file and the desk's pin lists stay proper
   tables (shared ownership, per-pin facts, per-pin edits, row-level cross-references).
2. **If P2.1 landed, the port's two hardest translations disappear.** No more two tables pointing
   at each other, no more hand-computed next-ids — ordinary auto-numbered columns and plain
   cross-references.
3. **SQLite lets one writer in at a time; Postgres lets many write at once, which changes what's
   safe.** Every transaction gets re-reviewed in that light — especially completion recording (a
   step may run more than once, so it must stay safe to do twice), the pin add-or-update logic,
   and P2.1's "earliest run created this document" derivation, sound when writers take turns but
   not automatically sound when many writers' commits can land out of order.
4. **Fleet unpinning.** Today every worker must open the same SQLite file and local storage
   folder, and SQLite's crash-safety journaling doesn't survive network drives — the whole system
   is effectively one machine. Postgres plus real cloud file storage (the folder is already named
   `mock_s3_gcs` — literally "pretend cloud storage") unlocks multi-machine fleets and
   per-practice pools (P8), and dissolves P6's traffic-jam ceiling.

*Chapter and verse: TIME_CAPSULE.md §P9.*

## Small quirks and chores — no project warranted

- **Engagement labels can't be renamed.** No API for it. Review demoted this from P1: a missing
  feature, not an integrity defect.
- **The `meta` table holds exactly one value** (the installation's id): a single setting in a
  table costume. Harmless.
- **The "leaf" flag is the schema's only number-pretending-to-be-yes/no** — the other two-state
  facts use words. Dissolves with P3.3/P4.2.
- **The job-runner's dashboard queries are built by pasting the office name into the query text**
  — a quote character in the name would break them. Config-controlled, so a footgun rather than
  an exposure.
- **Engine test files are saturated with tax vocabulary.** Fine as fixtures; sweep if P8 ships.
- **Every restart must re-adopt open jobs.** After a worker restarts, a sweep re-claims runs that
  were mid-flight; skip it and open runs sit unwatched. A standing requirement of every restart,
  not an optimization.

## The rules we never break

Break any of these and the system's core properties die. Each rule, plus what breaks.

1. **Identity is content, never paper trail.** A document's identity is (engagement, kind,
   fingerprint of its bytes); a question's identity is (code fingerprint, fingerprints of the
   input contents). Who-made-what lives in ordinary columns alongside. Bake history into identity
   instead, and reruns stop being free, identical answers stop converging, and every harmless
   upstream code change invalidates finished downstream work — including Priya's.
2. **The engagement is the reuse wall *and* the confidentiality wall — one wall, on purpose.**
   Loosen it — say, reuse answers across clients to save compute — and Acme's data quietly
   becomes part of Blue Harbour's work product.
3. **The case file is written once.** Unpinning from a desk is the system's only delete; a
   document's display label its only edit; optional new columns allowed, via P2.0's renovation
   tool. Edit or delete anything else and the audit trail stops being trustworthy — the only
   reason a case file exists.
4. **Folder names and workspaces never enter question fingerprints or document identity.** Let
   them in, and renaming a folder "changes" the inputs — pointless recomputation — and identical
   work in two folders stops converging on one stored answer.
5. **What-if deltas enter computations only as inputs — a calculator argument or an attached
   document — never as ambient settings.** Let one in ambiently, and two runs with identical
   fingerprints can produce different answers, which poisons the answer cache: the system will
   confidently serve wrong answers forever after.
6. **New entry programs only for new coordination shapes — never for business domains.** Offices
   choose which machines do the work; namespaces choose whose data is walled off. Break this and
   the program count grows with every new domain, and the careful pinning story that makes
   cutovers safe (P3.1, P5.8) collapses.
