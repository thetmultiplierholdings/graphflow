# Plan: single-truth node params (inputKinds only) + shared-node folders

Backend only, as before. Supersedes second_plan.md's decision 3 where they conflict (per-workflow
TS enums become composable `as const` objects — rationale below). Verification: the vitest suites
plus a stale-reference review pass at the end.

## Problem #2 — `params` is deleted; `inputKinds` is THE parameter declaration

- `NodeConfig`/`HumanNodeConfig` (Registry.ts) lose `params`; `defineNode`/`defineHumanNode`
  derive `paramNames = Object.keys(inputKinds)` (frozen). An `inputKinds` entry IS a param
  declaration; key insertion order IS the declared param order (cosmetic only — it feeds
  `node_input_kinds` rowid order; memo keys canonicalize with sorted keys and never see order).
- `checkInputKinds` dies — it only reconciled the two lists, and there is one list now. Totality
  stays compile-time (`Record<keyof P & string, string | null>`); a forgotten param cannot
  masquerade as anything because it simply does not exist, and passing it to `ctx.node` hits the
  existing loud "unknown parameter" error (Context.ts).
- Consumers unchanged: `Ctx.node`, `enforceInputKinds`, `publishCatalog` all keep reading
  `nd.paramNames`/`nd.inputKinds`. Zero memo/ledger/wire impact.
- Owner's call, recorded: integer-like param names ('0') are not worth guarding against.
- Tests: fixtures drop `params`; the two definition-time mismatch tests die with the check they
  tested (the compiler owns that job now); a new test pins paramNames = inputKinds key order.

## Problem #3 — shared nodes: `workflows/nodes_shared/` + per-workflow `nodes_special/`

### Feasibility against the DB design: aligned by construction

- The memo key is already global by node name — `memo_key = sha256(node_id ':' input_hash)`
  (Canonical.ts), no workflow_id inside. first_plan item 3.2 chose this precisely so that a node
  reused unchanged across workflow versions keeps its memo hits. Sharing the *code* makes the
  source layout match the identity model the ledger already lives by; the copy-paste layout was a
  leftover of the dead code-hash regime (its own comment said the copies existed "because the
  code-hash codegen resolves hashWith function deps within the owning file").
- Catalog tables need no change: `nodes` and `node_input_kinds` are keyed (workflow_id, node_id)
  — publish iterates each workflow's `nodes` list, so one shared `NodeDef` listed by two
  workflows publishes two identical rows, exactly as the copies did. `workflow_kinds` membership
  and the global `kinds` row also come out identical.
- `validateCatalog`'s same-name-same-shape tripwire is satisfied *structurally* for shared nodes
  (one object, one signature) instead of by luck of byte-identical copies. The check stays — it
  still guards independently-declared duplicates (e.g. `tax_calc` declared by both workflows).
- The contract shift to record: an edit to a shared node under an unchanged name now changes
  every workflow that lists it. That is not new risk — the memo key never cared which file the
  code lived in, so a divergent same-named copy was the *worse* failure (v1 answers served for v2
  behavior). One definition per name makes the naming contract ("behavior change ⇒ rename")
  enforceable at one place, and a rename automatically re-executes in every importing workflow.

### Layout

```
src/workflows/
  index.ts                     manifest (unchanged role)
  nodes_shared/                shared across workflow versions — NOT a workflow folder
    enums.ts                   SharedKind / SharedNodeId / SHARED_KINDS declarations
    helpers.ts                 Txn + parseTransactionLines (shared by the OCR nodes)
    ocr_brokerage_statement.ts one node per file, file name == node_id
    ocr_payment_slip.ts
    verify_txns.ts             + validateVerifiedTxns (the answer contract lives with its node)
    append_to_master.ts
  tax_demo_workflow/
    enums.ts                   Kind = {...SharedKind, TaxCalc, FinalReport}; NodeId; KINDS
    nodes_special/             one node per file: calculate_tax.ts, build_report.ts (25%)
    workflow.ts                defineWorkflow + the run() orchestration only
  tax_demo_workflow_v2/
    enums.ts                   adds ResidencyAnswers, CalculateTaxV2, BuildReportV2
    nodes_special/             calculate_tax_v2.ts (24% + residency), build_report_v2.ts
    workflow.ts
```

Owner addendum during execution: one node per file with file name == node_id, enforced
mechanically by `check:workflows` (every node in the manifest must own
`nodes_shared/<node_id>.ts` or `<workflow_id>/nodes_special/<node_id>.ts`).

- **Enums become `as const` objects** (usage syntax identical: `Kind.BrokerageStatement`).
  Forced by composition: TS enums cannot be spread/extended, and the per-workflow vocabulary is
  now shared ∪ special. Side benefit: const-object values are structural string literals, so the
  nominal-enum friction between v1 and v2 types disappears.
- Per-workflow `KINDS = [...SHARED_KINDS, ...specials]` — declaration order shifts (v2's
  residency_answers moves after the shared five); cosmetic, catalog test updated.
- `scripts/check-workflows.ts`: a workflow folder is a directory containing `workflow.ts`;
  directories without one (nodes_shared) are shared-code libraries, ignored. Both directions of
  the manifest check stay: every manifest id has its folder+workflow.ts; every folder with a
  workflow.ts is in the manifest.
- Comment/doc updates: the per-file copy-paste rationale is replaced by the sharing contract;
  backend README name-identity + layout sections and root README layout follow.

### What is deliberately NOT shared

`tax_calc`/`final_report` kind declarations (each workflow declares them; validateCatalog enforces
agreement), TAX_RATE, and the calc/report nodes — versioned behavior stays in the version's
folder. Sharing is only for code whose name-identity is meant to span versions.

## Execution order

1. Registry.ts (params removal) → 2. nodes_shared/{enums,nodes}.ts → 3. v1 folder split →
4. v2 folder split → 5. check-workflows.ts → 6. tests (Registry, Context, Db publish fixtures,
TaxDemoNodes imports/aliases, ApiCrud kind order) → 7. READMEs → 8. `npm run check` →
9. stale-reference review (params remnants, problem-1 remnants: inline kinds arrays, enum
references, docs) → fix → final check.
