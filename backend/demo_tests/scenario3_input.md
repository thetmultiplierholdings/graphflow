# Scenario 3 — February: a period copy pays only for what changed

February is NOT a revision of January — it is a new period seeded from it: a `copy` starts a NEW
family (root = itself) while `copied_from` still records where its documents came from. With one
extra statement attached, only the marginal chain recomputes, plus the three downstream nodes
whose inputs changed — the fold, the calculator, and the report; January's four answered
questions (2 OCR + 2 verify) memo-hit.

What the output should show:

- `execute jan`: 7 executed.
- `execute feb`: 5 executed (OCR + verify for the new statement, then fold/calc/report — their
  inputs changed), 4 memo hits, 1 human question (only the new statement needs review).
- `feb` row: `lineage_kind copy`, root = feb itself (new family), `copied_from` = jan,
  bare-id `lineage_byid`.
- Stats: 12 node runs total (7 + 5), 3 of them human answers.
- February's report includes the extra statement's transactions (compare with scenario 1's).

```steps
engagement acme "Acme Ltd — demo"
run jan = create tax_demo_workflow "January estimate" in acme
upload jan brokerage_statement morgan_stanley.txt
upload jan payment_slip payslip_jan.txt
execute jan
run feb = copy jan copy "February estimate"
upload feb brokerage_statement extra_ubs.txt
execute feb
report feb
```
