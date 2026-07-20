# Scenario 5 — simulations: three residencies, one family

The what-if story on `tax_demo_workflow_v2` (24% rate + a residency questionnaire feeding the
calculator). The base Q1 run answers the questionnaire with SG. Each simulation copies the base,
swaps ONLY the questionnaire (v2 requires exactly one residency answer per run, so the inherited
one is detached first), and re-executes: the document chains (OCR + human verify) memo-hit
across the whole family — only the calculator and report recompute per scenario.

What the output should show:

- `execute base`: 5 executed (1 OCR, 1 verify, fold, calc_v2, report_v2), 1 human question.
- Each simulation: 2 executed (`calculate_tax_v2`, `build_report_v2`), 3 memo hits, 0 human
  questions — scenario deltas enter as artifacts, never ambient (invariant: the changed
  questionnaire changes the memo keys downstream of it, nothing else).
- Family table: `sim_us`/`sim_hk` with `lineage_kind simulation`, root `base`,
  `lineage_display` "Q1 estimate/…".
- Convergence, the subtle one: `calculate_tax_v2` embeds the country in its output, so the three
  `tax_calc` artifacts are distinct — but `build_report_v2` renders only totals, so all three
  report executions produce identical bytes and CONVERGE on ONE `final_report` artifact
  (engagement artifacts = 11, not 13: 4 user + ocr + verified + master + 3 tax_calc + 1 report).
  The two reports below are byte-identical on purpose. Demo-domain finding, not an engine bug:
  the mock report template ignores residency and the 24% rate is country-independent, so a
  business user's N-state simulation currently yields N identical reports — the engine
  faithfully recomputed each one and then filed one converged answer.

```steps
engagement blue "Blue Harbour LLP — demo"
run base = create tax_demo_workflow_v2 "Q1 estimate" in blue
upload base brokerage_statement bh_schwab.txt
answers base residency_answers {"country":"SG"}
execute base
report base
run sim_us = copy base simulation "what-if: US residency"
detach sim_us residency_answers
answers sim_us residency_answers {"country":"US"}
execute sim_us
report sim_us
run sim_hk = copy base simulation "what-if: HK residency"
detach sim_hk residency_answers
answers sim_hk residency_answers {"country":"HK"}
execute sim_hk
```
