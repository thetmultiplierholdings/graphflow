# AGENTS.md

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
