# Scenario 2 — running January again: the no-change revision

The reason there is no "re-run" button on a completed run: running January again IS a new run.
A `revision` copies January's user attachments into a new family member; executing it with
nothing changed is a pure memo replay — zero node bodies execute, zero humans are disturbed,
and the business gets a second, separately-dated run record with identical answers.

What the output should show:

- `execute jan`: 7 executed (the first, real run).
- `execute rev`: 0 executed, 7 memo hits, 0 human questions — the memo held across the family.
- Both rows frozen; `rev` has `lineage_kind revision`, root `jan`, `lineage_byid` = `jan/rev`
  ids, `lineage_display` = "January estimate/January estimate — second pass".
- `rev` still shows 7 engine results: the memo-hit attach-back pins every reused answer to the
  new run's own pinboard.
- Stats: node runs stay at 7 (memo hits insert nothing into the ledger); runs = 2.

```steps
engagement acme "Acme Ltd — demo"
run jan = create tax_demo_workflow "January estimate" in acme
upload jan brokerage_statement morgan_stanley.txt
upload jan payment_slip payslip_jan.txt
execute jan
run rev = copy jan revision "January estimate — second pass"
execute rev
```
