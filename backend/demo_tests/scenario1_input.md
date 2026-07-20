# Scenario 1 — January from scratch

The baseline story: an engagement with one workflow run, executed to completion. A run is a
`root` (its own one-member family), every question is answered fresh — zero memo hits
(`verify_txns` appears twice in the executed list: one distinct question per document) — the
auto-approver answers the two `verify_txns` questions, and the run FREEZES at dispatch — after
this scenario, January's attachments can never change again; more work means a copy.

What the output should show:

- `execute jan`: 7 executed node bodies (2 OCR, 2 verify, fold, calc, report), 0 memo hits,
  2 human questions.
- The run row: `lineage_kind root`, state `frozen`, its own root, bare-id `lineage_byid`.
- Engagement stats: 1 workflow run; artifacts = 2 uploads + 7 computed = 9; 7 node runs of which
  2 are human answers.
- The final report, byte-exact (25% v1 rate).

```steps
engagement acme "Acme Ltd — demo"
run jan = create tax_demo_workflow "January estimate" in acme
upload jan brokerage_statement morgan_stanley.txt
upload jan payment_slip payslip_jan.txt
execute jan
report jan
```
