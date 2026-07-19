# Implementation plan: first_plan.md items 1–3 + inputKinds + per-workflow enum folders (backend only)

Scope: backend only. Frontend and e2e are deliberately untouched this round; the wire contract
changes below (removed `task_queue`/`code_hash`, added `source`/`origin`/`input_kinds`) will be
carried into `frontend/src/lib/api/client.ts` and friends in a later round. Verification relies on
the backend suites (`Db.test.ts`, `Registry.test.ts`, `Canonical.test.ts`, `TaxDemoNodes.test.ts`,
`ApiCrud.test.ts`) plus `ApiIntegration.test.ts` when `TEMPORAL_API_KEY` is present. The target
schema lives in `schema.dbml` at the repo root, updated in this same change (standing exit
criterion for schema-changing work; the interim `schema_v2.dbml` target doc was folded into it
and deleted).

## Decisions taken (where first_plan.md left options open)

1. **v2 rename, not rate-promotion.** `tax_demo_workflow_v2`'s behavior-changed nodes are renamed
   `calculate_tax` → `calculate_tax_v2` and `build_report` → `build_report_v2`. Promoting
   `TAX_RATE` to a node argument would ripple through five golden tests and
   `expectedTotals` in ApiIntegration.test.ts; the rename is the surgical option and exercises the
   naming contract the plan establishes.
2. **The questionnaire kind lands on the renamed node.** `residency_answers`
   (source `questionnaire`, declared only by v2) becomes a new required param of
   `calculate_tax_v2` — one rename absorbs both the 24% behavior change and the new input. The
   node echoes `residency` (the answered country) into its output payload so the channel is
   observable; `build_report_v2` ignores the extra field, so the Blue Harbour golden report is
   unchanged.
3. **Per-workflow enum files use TS string enums** (`biome.jsonc` has `noEnum: off`; enum members
   erase to the exact same string bytes, so memoized payload literals like `doc_kind:
   'brokerage_statement'` are byte-identical when written as `Kind.BrokerageStatement`). Two enums
   per workflow: `Kind` and `Node` (node ids). `defineNode`'s signature stays `string`-typed —
   raw strings are kept out by convention plus two mechanical backstops: definition-time
   `inputKinds` totality validation and publish-time `validateCatalog`.
4. **`validateCatalog` lives in Registry.ts and runs inside `publishCatalog`** as its first
   statement, so every publish caller (Bootstrap.ts, cli/Shared.ts, both API test suites) gets it
   without individual wiring.
5. **`RegisteredNode` is deleted, not slimmed.** With `codeHash` gone it would be a one-field
   wrapper; `Registry.nodeForWorkflow`/`tryNodeForWorkflow` return `NodeDef` directly.
6. **`kinds` rows are upsert-only** (like `workflows`/`nodes` — retired kinds persist as FK
   parents); `workflow_kinds` and `node_input_kinds` are delete-then-insert inside the publish
   transaction (nothing FKs either mirror).
7. **`nodes.source` display conflicts are publish errors, not first-wins.** Two workflows
   declaring the same kind with a different `source` or a different display name fail
   `validateCatalog` — the global `kinds` table cannot hold both.
8. **Same node_id across workflows must declare identical shape.** `validateCatalog` asserts
   equal (executor, outputKind, paramNames, inputKinds, displayName) for same-named nodes across
   workflows. This is the cheap mechanical remnant of the dead code-hash tripwire: it would have
   caught today's v1/v2 `calculate_tax` divergence (the displayNames differ 25%/24%). Run-body
   divergence under an unchanged name remains trusted to the naming contract, as first_plan
   records.
9. **`input_kinds` is added to the catalog wire payload now** (`CatalogNodeOut.input_kinds:
   Record<string, string | null>`), additively — it is the entire point of publishing
   `node_input_kinds`, and the frontend graph work later needs it.
10. **DB reset, no migration.** `initDb` uses `CREATE ... IF NOT EXISTS` only; per first_plan
    ("a SCHEMA edit plus reset") dev databases are recreated via `npm run seed -- --fresh`. Open
    Temporal histories survive a DB reset — stale human-task workflows on the env queue are
    cleaned by `scripts/cleanup-temporal.ts` / `terminateStaleRuns` in Seed.ts, unchanged.

## Item 1 — drop `workflows.temporal_workflow_type` + `workflows.task_queue`

- `Db.ts` `SCHEMA`: `workflows` becomes `(workflow_id TEXT PRIMARY KEY, display_name TEXT NOT
  NULL)`.
- `publishCatalog`: `taskQueue` parameter and the `RUN_WORKFLOW_TYPE` import die; the workflows
  upsert writes id + display only. Callers updated: Bootstrap.ts, cli/Shared.ts `publish`,
  ApiCrud.test.ts (missing from first_plan's caller list), ApiIntegration.test.ts.
- `catalogSnapshot` + `CatalogWorkflow`: both columns gone from row type and result.
- `Runtime.ts`: `WorkspaceStart` loses `temporalWorkflowType`/`taskQueue`; `loadWorkspaceStart`
  keeps the catalog-existence guard (now `SELECT workflow_id FROM workflows WHERE workflow_id=?`)
  but stops reading dispatch columns; `startWorkspace` gains a `taskQueue` parameter and
  dispatches `client.workflow.start(RUN_WORKFLOW_TYPE, { taskQueue, ... })` (Runtime.ts becomes
  the constant's consumer). Callers updated: `createTemporalGateway` in Deps.ts (env in scope),
  cli/Shared.ts `executeWorkspace` (gains a queue param), Seed.ts direct call — the latter two are
  missing from first_plan's impact list.
- `Schemas.ts` `CatalogWorkflowOut` and routes/Catalog.ts serialization: `task_queue` deleted.
- Unchanged: `ensure_human_task` (already env queue), the three visibility sweeps + the fourth in
  Seed.ts `terminateStaleRuns`, `adoptOpenWorkflows`.

## Item 2 — kinds as first-class objects, inputKinds, derived origin

Schema (matches schema.dbml):
- New `kinds (kind TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN
  ('upload','questionnaire','email','computed')), display_name TEXT)`.
- `workflow_kinds` slims to `(workflow_id, kind REFERENCES kinds, PK (workflow_id, kind))` — the
  `leaf` and `display_name` columns move out.
- New `node_input_kinds (workflow_id, node_id, param, kind REFERENCES kinds NULLable — NULL =
  scalar arg, PK (workflow_id, node_id, param), FK (workflow_id, node_id) REFERENCES nodes)`.
- `artifacts.kind` and `nodes.output_kind` FK `kinds(kind)`.
- `artifacts.produced_by_node_run` deleted; both `DEFERRABLE INITIALLY DEFERRED` clauses die;
  `node_runs.output_artifact_id` becomes a plain immediate FK.
- New `artifact_facts` view (in `SCHEMA`, `CREATE VIEW IF NOT EXISTS`): `artifacts` JOIN `kinds`
  plus derived `produced_by_node_run := (SELECT MIN(node_run_id) FROM node_runs WHERE
  output_artifact_id = artifact_id)` and `origin := 'produced'` when a producing run exists, else
  `'override'` for computed kinds, else the kind's source. Writers (`MEMO_LOOKUP_SQL`,
  `recordCompletion`, `supplyArtifact`) stay on base tables.

Registry.ts:
- `Kind` gains required `source: KindSource` (`'upload' | 'questionnaire' | 'email' |
  'computed'`) and optional `intake?: true` (cross-workflow intake declaration for computed kinds
  with no local producer — no current workflow needs it, the mechanism just exists).
- `NodeDef`/`NodeConfig`/`HumanNodeConfig` gain required `inputKinds: Readonly<Record<keyof P &
  string, string | null>>` — the mapped-type key makes totality a compile-time error;
  `defineNode`/`defineHumanNode` additionally validate at definition time that `inputKinds` keys
  and `params` are the same set (a forgotten annotation cannot masquerade as a deliberate scalar).
- `leafKinds` → `kindClasses(wd): Record<string, 'leaf' | 'computed'>` (derived: computed iff some
  node in the workflow produces it).
- New `validateCatalog(all: readonly WorkflowDef[])`: per workflow — duplicate kind declarations,
  every `outputKind` and every non-null `inputKinds` value ∈ declared kinds, authored source vs
  derived class reconciliation (computed ⇒ has producer or `intake`; leaf-channel ⇒ no producer);
  cross-workflow — same kind ⇒ same source + display, same node_id ⇒ same declared shape
  (decision 8).

Db.ts:
- `publishCatalog`: `validateCatalog` first; upsert `kinds` before `nodes` (FK order);
  `workflow_kinds` and `node_input_kinds` delete-then-insert; nodes upsert loses `code_hash` and
  the tripwire.
- `catalogSnapshot`: kinds come from `workflow_kinds JOIN kinds` with `leaf` derived in SQL
  (`NOT EXISTS` producer among the workflow's nodes) and `source` included; nodes gain an
  `input_kinds` map read from `node_input_kinds`.
- `supplyArtifact`: rejects kinds absent from `kinds` with `ValidationError` **before**
  `writePayload` (no orphaned blobs); supplying a computed kind stays legal.
- `recordCompletion`: MAX+1 preallocation dies — artifact inserted first, `node_runs` insert uses
  SQLite's assigned rowid (`lastInsertRowid` when fresh, re-select on convergence); asserts the
  output kind exists and is `computed` (typed `RuntimeError` before the insert, so FK noise never
  reaches the constraint-race catch block).
- `artifactLineage`: producer query gains `ORDER BY node_run_id LIMIT 1`.
- `workspaceArtifacts`, `getArtifact`, `browseArtifacts`: read `artifact_facts` (they serve
  `produced_by_node_run`/`produced`/`origin`); `ArtifactRow` loses `produced_by_node_run`; new
  `ArtifactFactsRow extends ArtifactRow` with `produced_by_node_run: number | null` and `origin`.

Context.ts (`Ctx.node`): after null-fill, before `encodeArgs` — for each param, if
`inputKinds[param]` is a kind, every `ArtifactHandle` in the value (single or array) must carry
that `ref.kind`; if `null`, the value must contain no handles. Violations throw nonRetryable
`ApplicationFailure` like the existing unknown-param guard.

API layer:
- `Serializers.ts`: `ArtifactMetaOut` gains `origin: string`; `artifactMeta` takes
  `ArtifactFactsRow`; `MEMBERS_SQL` joins `artifact_facts`.
- routes/Artifacts.ts upload route: new optional multipart field `canonical_json` — when `'true'`,
  the payload is parsed as JSON and re-serialized through `canonicalBytes` before `supplyArtifact`
  (media type `application/json`), so a re-answered identical questionnaire converges on the same
  artifact; parse/float failures surface as 422 via the existing `ValidationError` envelope.
- `Schemas.ts`: `CatalogKindOut` gains `source`, keeps derived `leaf`; `CatalogNodeOut` gains
  `input_kinds`.
- cli/Cli.ts `cmdShow`: prints the derived `origin` (richer than the old produced/supplied).

Workflow wiring (the demonstrable questionnaire): v2 declares `{ kind: 'residency_answers',
source: 'questionnaire', display: 'Residency questionnaire' }`; `calculate_tax_v2` takes it as a
required param; Seed.ts supplies canonical-JSON residency answers for the Blue Harbour engagement
and attaches them. `email` ships as an allowed `source` value with no channel behind it.

## Item 3 — remove code_hash; memo_key = sha256(node_id ‖ ':' ‖ input_hash)

- `Canonical.ts` `memoKey(nodeId, inputHash)` = `sha256Hex(`${nodeId}:${inputHash}`)`; comment
  updated. `Ctx.node` mints `memoKey(nd.nodeId, hashValue(hashForm))`.
- Deleted outright: `src/generated/CodeHashes.ts`; `scripts/generate-code-hashes.ts` (replaced —
  see item 4); `gen:hashes` script + the `git diff --exit-code -- src/generated` check step;
  `HashDep`, `hashWith`, `codeSalt` (config options **and** the frozen `NodeDef` fields),
  `RegisteredNode`, `buildRegistry`'s `codeHashes` param and missing-hash throw;
  `node_runs.code_hash` + `nodes.code_hash` columns; `CompletionInput.codeHash`;
  `TaskInput.code_hash` (Workflows.ts) **and its hand-copied duplicate in the `TaskInfo`
  interface in api/Deps.ts** (missed by first_plan); the `codeHash` arguments in
  `run_engine_node`, `buildTaskInput`, `record_human_completion`; `code_hash` in `NodeRunOut`
  (Serializers.ts), `CatalogNodeEntry`, `CatalogNodeOut`, routes/Catalog.ts; the publish tripwire.
  `ts-morph` leaves devDependencies.
- v2 renames per decision 1/2. Consequence check: the CLI auto-approver's hard-wired coupling to
  `verify_txns`'s `ocr` param (`ApprovalPayloadSchema` in cli/Inbox.ts) is safe — verify_txns is
  not renamed.
- Test fallout beyond first_plan's list: `Canonical.test.ts` (memo-key test re-targeted at
  node-id sensitivity + a fixed vector), `TaxDemoNodes.test.ts` (manifest test: v2 node-id list
  and kind-vocabulary superset), ApiCrud's `catalog versioning invariant` (re-expressed as "v2
  renamed exactly calculate_tax and build_report" without hashes).

## Item 4 — per-workflow folders with enum files

Layout: `src/workflows/<workflow_id>/workflow.ts` + `src/workflows/<workflow_id>/enums.ts`;
`src/workflows/index.ts` stays the static manifest (Temporal bundler needs static imports);
`TaxDemoNodes.test.ts` stays at `src/workflows/` (it spans both versions).

- `enums.ts` per workflow: `export enum Kind {...}` (workflow's kind vocabulary) and
  `export enum Node {...}` (its node ids). v2's file adds `ResidencyAnswers`,
  `CalculateTaxV2`, `BuildReportV2`. `workflow.ts` uses enum members for every `name:`,
  `outputKind:`, `inputKinds` value, `ctx.attached(...)` call and kinds declaration — no raw kind
  or node-id strings in workflow code. Seed.ts and tests import the enums instead of literals.
- `scripts/generate-code-hashes.ts` → `scripts/check-workflows.ts` (the surviving
  name-discipline half, re-keyed on folders): every `ALL_WORKFLOWS` id has
  `src/workflows/<id>/workflow.ts`; every directory under `src/workflows/` is listed in the
  manifest. No ts-morph. package.json: `gen:hashes` → `check:workflows`; `check` becomes
  `typecheck && test && lint && check:workflows`.
- `backend/biome.jsonc`: the `src/workflows/*.ts` snake_case filename override is re-scoped to
  `src/workflows/**` (the glob is single-level today and would stop matching nested files).
- README layout sections (root + backend) re-describe the folder-per-version contract and lose
  the gen:hashes references.

## Test plan (backend-only, API-test heavy)

Updated: Db.test.ts (seed `kinds`, explicit-column catalog inserts, circular-pair test becomes
reverse-edge lineage, `complete` helper loses codeHash), Registry.test.ts (inputKinds +
kindClasses + validateCatalog suites replace hashWith/codeSalt/buildRegistry-hash tests),
Canonical.test.ts (memoKey), TaxDemoNodes.test.ts (manifest, v2 goldens with residency, enum
imports), ApiCrud.test.ts (catalog shape, versioning-by-rename), ApiIntegration.test.ts (caller
signatures only — its memo-replay counts are the regression suite for the new memo key).

New coverage:
- Db: supply-guard rejection (unknown kind) + computed-kind supply stays legal; `artifact_facts`
  origin for upload/questionnaire/override/produced; MIN(node_run_id) determinism when two runs
  converge on one artifact; recordCompletion's kind-class assertion (leaf output kind → typed
  error).
- Registry: inputKinds totality (extra key / missing key throws), kindClasses, every
  validateCatalog rule (one negative test per rule).
- ApiCrud: upload of unknown kind → 422; upload of computed kind `ocr_txns` → 200 with
  `origin: 'override'`; leaf upload → `origin: 'upload'`; `canonical_json` round-trip — two
  differently-formatted but canonically-equal JSON bodies converge (`revived: true`, same
  artifact_id); catalog payload asserts `source`, derived `leaf`, `input_kinds`, absence of
  `task_queue`/`code_hash`; `origin: 'produced'` via a directly-seeded completion.

## Execution order

1. Registry.ts + Canonical.ts (new contracts) → 2. workflow folders/enums/renames →
3. Db.ts (schema + functions) → 4. temporal/ → 5. api/ → 6. cli/ → 7. scripts + package.json +
biome.jsonc → 8. test updates + new tests → 9. `npm run typecheck && npm test && npm run lint` +
iterate → 10. adversarial review pass (stale references, contract drift, test gaps) + fixes →
11. schema.dbml + READMEs.

## Consciously accepted (recorded, not overlooked)

- No mechanical tripwire for a behavior change under an unchanged node name (first_plan item 3.4)
  beyond decision 8's declared-shape check.
- Renamed nodes leave stale rows in `nodes` forever (upsert-never-delete); harmless post-reset,
  visible in the catalog only if the frontend renders retired ids — revisit when publish learns
  retirement. Corollary: `catalogSnapshot`'s derived `leaf` counts retired rows as producers, so
  a kind that loses its last current producer keeps `leaf = false` until a reset.
- `TEMPORAL_TASK_QUEUE`'s default `'thet-temporal-dev-ignore'` becomes the sole dispatch truth
  when the env var is unset — unchanged behavior, larger blast radius; flagged for a later env
  hardening pass.
- `origin` of a hand-supplied computed artifact flips to `'produced'` if a later run converges on
  the same bytes — derived truth by design.
