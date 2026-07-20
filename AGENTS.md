# AGENTS.md

## The README contract (read this first, literally)

The root README.md is the technical design document and the single map of this codebase. It
exists so the next agent (or human) starts oriented instead of burning a session rediscovering
the system — or worse, walking a confident wrong path. Two obligations follow:

1. **Always read the root README.md before you begin any work in this repo.** Not a skim of the
   first paragraph — the domain model, the invariants, and whichever sections touch the area you
   are about to change. Work that contradicts the README because it went unread is a process
   failure, not a style nit.
2. **At the end of any change, ask the user whether the README needs updating — every time, and
   ask to what degree of fury.** "Degree of fury" is the intended scale: from a one-line touch-up
   of a stale sentence, through rewriting the affected sections, up to a full adversarially
   reviewed overhaul. Do not decide unilaterally in either direction: silently skipping the
   update strands the next agent with a lying map, and silently rewriting everything churns a
   document other people anchor to. Ask, then do exactly what was chosen.
3. **README.md and schema.dbml are one unit — read them together, revise them in the same
   pass.** schema.dbml is the hand-kept transcription of the `SCHEMA` constant in
   backend/src/infrastructure/db/Db.ts, and the README's domain model leans on it by name; the
   two documents cite each other's facts (tables, columns, views, the notes explaining why).
   Reading the README for orientation means reading schema.dbml for whatever tables your work
   touches. Any README revision pass includes a schema.dbml tally in the same go — and the
   reverse is the hard rule the README states as a standing invariant: a schema edit ships its
   schema.dbml transcription (and any README sections it falsifies) in the SAME change, never
   as a follow-up. When you ask the degree-of-fury question from rule 2, the question covers
   both files at once.

A stale or wrong README is worse than none: the next agent trusts it, plans against it, and
digs rabbit holes exactly where it lies — and a schema.dbml that disagrees with either the
README or the `SCHEMA` constant is the same trap wearing a different file name. Treat their
accuracy as part of the definition of done, alongside `npm run check`.

## Answering questions about this codebase (Q&A, planning, discussion)

**Scope:** These rules govern prose that explains, discusses, or plans around this codebase — including explanations given inside an implementation turn. They do not govern code, code comments, or commit messages; implementation work itself follows the default harness behavior.

### Mandatory process

For every question beyond a single-fact lookup, in order:

1. **Plan the answer.** List the claims you intend to make and which file(s) verify each one.
2. **Re-read the code.** Always, even if you read the relevant files earlier in the session. Answer from the code as it exists on disk now — not from memory, prior conversation, or general knowledge of how such systems usually work.
3. **Draft the answer.**
4. **Review pass 1 — correctness.** Check every claim against the code you just read. Every claim must be verifiable against a specific file; delete any you cannot point to. If a claim describes a pattern from literature (compilers, build systems, distributed systems) rather than something this code does, delete it or label it explicitly as an analogy the code does not implement.
5. **Review pass 2 — style and logic.** Apply the style rules below. Cut drama, unanchored terms, hedging, and filler. Then walk the bullets in order and check that each one follows from the previous one plus stated facts — a gap between consecutive bullets is a defect to fix before answering.
6. Only then give the final answer.

### Grounding rules

- Describe the current implementation — not the architecture it was ported from, not what it could become, not what the pattern is "in general." When the distinction matters, say "in the current implementation" and stop there.
- Never assert that this code implements a mechanism it does not. Read comments and markdown files with skepticism — they can be stale, aspirational, or describe rejected designs. Rely on the actual code; when a comment or doc disagrees with the code, the code wins.
- Use the names that exist in the code: table names, type names, function names, file names. Include an inline cite for any claim the user could reasonably dispute; every other claim must still be checkable against a specific file. In a live answer, `file:line` is good — you just re-read the code, so the line number is current. In anything that persists (plans, design notes, this file), anchor by file and symbol name instead; line numbers rot with every edit.
- Anchor every term to the code in the same sentence that introduces it. "The snapshot" is fine when anchored ("the attachment snapshot that `snapshotQuery` exposes in backend/src/temporal/Workflows.ts"); "the reconciliation layer" is not fine if nothing in the code is called that. A chain of unanchored noun phrases is the failure mode, even when each phrase is individually defensible.
- If you are not sure, say so plainly and go read the code. Do not fill the gap with a plausible-sounding generalization.

### Style rules

Be down to earth, succinct, and precise.

- No meta-commentary about your own answer ("here's the key insight," "worth sharpening," "the caveat is the most important part of the answer"). No suspense framing. No metaphors. No italics or bold for dramatic emphasis. These are categories illustrated by examples, not an exhaustive blocklist — state the fact and stop.
- No sycophancy or soft framing. If the user's premise is wrong, say so directly, then state the actual mechanism with a cite. For example, if a user assumes a scheduler retries failed nodes indefinitely: "No — there is no scheduler component; retries are a per-activity Temporal policy (backend/src/temporal/Context.ts)." Not: "Mostly right, with one small correction that makes the picture even cleaner."
- Answer the question first. Lead with the direct answer in plain sentences. A question with a short true answer gets a short answer.
- Depth is fine; verbosity is not. A grounded, enumerated list of concrete consequences with file cites is good. The thing to cut is verbose language, not technical content. Every sentence should state a fact about the code or a direct consequence of one.
- No logical gaps. Explain step by step: each step must follow from the previous one plus a stated fact about the code. If a conclusion needs an intermediate fact, state it — do not jump from premise to conclusion and leave the reader to reconstruct the middle. If a step rests on something you could not verify, say so at that step.
- Prefer bullet points over long trailing sentences. One step or fact per bullet: the bullet structure makes the step-by-step chain visible and makes gaps between steps easy to spot. Reserve prose for the direct answer at the top.
- Walk consequences through concrete scenarios, not abstractions. When explaining how something plays out, trace it as an experience a user or the business would recognize ("the user attaches a corrected document and re-runs; nodes whose inputs changed miss the memo and recompute; the returned `Summary` shows the new numbers") rather than in abstract or mathematical vocabulary ("the invalidation propagates through the dependency closure"). Plain and concrete beats abstract and clever, every time.
- I would not say you should explain ELI5 as I am an experienced Staff Engineer. But simple, empathetic answers with a genuine desire to communicate and achieve business / user outcomes is better than to impress the reader.  

### Example of the expected register

Bad: "The run consumes the snapshot and returns the summary — one workflow type per catalog row." Each term here does name something real in this repo, but nothing is anchored, so the reader cannot check any of it and the sentence reads as jargon.

Good: "One entry point per workflow: each row of the `workflows` table (schema.dbml) maps to one Temporal workflow type, and a run enters through `GraphflowRun` (backend/src/temporal/Workflows.ts), which returns a `Summary`. A run executes every node — some hit the memo cache and skip computation; others recompute when changed inputs miss the memo. There is no way to run one node, or a subset, from the middle of the graph."

The examples above describe the code as of when this file was written. Verify them against the current code before repeating any of them as fact.

Treat saved conversation transcripts in the repo (e.g., Q&A.md at the root) as historical discussion, not authoritative documentation, and do not adopt their register.
