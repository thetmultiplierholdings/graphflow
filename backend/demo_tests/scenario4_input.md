# Scenario 4 — the guardrails

The freeze/lineage refusals reachable from this Db-level harness, exercised end to end. A frozen
run's attachment set is immutable (the record of what ran never lies); a completed run never
re-executes (copy or revise instead); a never-executed draft is uncopyable ("only finished runs
can be copied"); a revision may not switch workflows (a different DAG is a root-class `copy`);
and `root` cannot carry a parent. The two Temporal-gated refusals this harness cannot reach —
copying a parent whose execution is still RUNNING or frozen-but-idle — are pinned over the API
in ApiIntegration.test.ts (real describe) and ApiCrud.test.ts, as is the API route's
frozen-check-before-filing ordering on upload-with-attach.

What the output should show — every rejected command with its exact message:

- upload to frozen `jan` → RUN_FROZEN from `attach`'s guard. Layering detail worth reading off
  the stats: this harness supplies THEN attaches (the Db layer), so the refused upload still
  files the bytes into the engagement pool — artifacts = 8 (3 uploads incl. the refused one + 5
  computed) — while jan's MEMBERSHIP stays 1 user doc. The API's one-request upload-with-attach
  checks frozen BEFORE filing and files nothing; that route ordering is route-owned and pinned
  in the API suites.
- detach from frozen `jan` → RUN_FROZEN (the guard is state-based — the slot doesn't matter).
- re-execute completed `jan` → RUN_FROZEN ("create a copy or revision to run it again").
- revise the never-executed `draft` → RUN_NOT_COPYABLE.
- cross-workflow revision of `jan` → "asking for a different workflow is a copy".
- `root` with a parent → "lineage_kind 'root' cannot carry copy_from".
- Meanwhile the draft stays a `draft` and editable, and jan stays `frozen` with 1 user doc.

```steps
engagement acme "Acme Ltd — demo"
run jan = create tax_demo_workflow "January estimate" in acme
upload jan brokerage_statement morgan_stanley.txt
execute jan
run draft = create tax_demo_workflow "March — still gathering documents" in acme
upload draft payment_slip payslip_mar.txt
fail upload jan brokerage_statement extra_ubs.txt
fail detach jan brokerage_statement
fail execute jan
fail run nope1 = copy draft revision "revision of a draft"
fail run nope2 = copy jan revision "cross-workflow revision" workflow=tax_demo_workflow_v2
fail run nope3 = copy jan root "root with a parent"
```
