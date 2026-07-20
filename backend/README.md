# graphflow backend

An engagement-scoped, memoized workflow engine—SQLite ledger + real Temporal execution +
workflows baked in code. The Fastify API is the HTTP layer and the only thing a frontend talks
to (its routes reach Temporal through the `TemporalGateway` seam in `src/api/Deps.ts`; the CLI
and scripts open their own Temporal clients); the Next.js frontend in `../frontend` consumes it
over snake_case JSON. The technical design document is the root `../README.md`.

## Run

Credentials live in `.env` (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`,
`TEMPORAL_TASK_QUEUE`).

```
npm install
npm run check                 # typecheck + tests + lint + workflow-folder discipline
npm run seed -- --fresh       # seed the demo dataset (terminates old runs, resets db + payload store)
                              # REQUIRED once when pulling a schema change: no migrations exist,
                              # and boot fails loud (publishCatalog) against a stale db
npm run dev                   # API on :8000 (+ embedded Temporal worker)
```

Environment (all optional): `GRAPHFLOW_DB` (default `graphflow.sqlite3`), `GRAPHFLOW_STORAGE`
(default `mock_s3_gcs`), `GRAPHFLOW_EMBED_WORKER` (default `1`), `GRAPHFLOW_CORS_ORIGINS`
(default `http://localhost:3000`), `GRAPHFLOW_HOST` (default `127.0.0.1`—loopback; set
`0.0.0.0` only for deliberate network exposure), `PORT` (default `8000`). Shell environment
wins over `.env`.

CLI:

```
npm run cli -- init | worker | demo | seed [--fresh] | tasks | submit <task-workflow-id> | show <workflow_run_id> | download <artifact_id> <out>
```

## Design notes

**Defining nodes and workflows.** Nodes and workflows are declared with config-object
factories—`defineNode({...})`, `defineHumanNode({...})`, `defineWorkflow({...})` in
`src/domain/registry/Registry.ts`—the same shape as Trigger.dev `task()`, Inngest
`createFunction()`, tRPC procedures, and XState `setup()`. Registration is explicit: every
workflow version is listed in the `src/workflows/index.ts` manifest (`ALL_WORKFLOWS`), which
`buildRegistry()` consumes. Static imports are what let Temporal's workflow bundler see every
version.

**Temporal.** Workflows are plain exported async functions (`GraphflowRun`,
`GraphflowHumanTask`—the function name is the workflow type); queries and the update-based
submit use `defineQuery`/`defineUpdate` + `setHandler` (the submit validator rejects malformed
reviewer answers — including a reviewer that is not a `'<type>[:<name>]'` principal —
synchronously, before they can ever be filed); activities are a
`createActivities(deps)` factory whose object keys are the activity names. Workflow-sandbox code
(`src/temporal/Context.ts`, `Workflows.ts`, everything under `src/domain` and `src/workflows`)
never imports `node:*`—hashing inside the sandbox uses `@noble/hashes`.

**Name identity (the naming contract).** The node's declared id IS its version identity:
`memo_key = sha256(node_id ':' input_hash)` (`memoKey` in `src/domain/canonical/Canonical.ts`).
Nodes meant to span versions live ONCE in `src/workflows/nodes_shared/` and are listed by every
workflow that uses them — same name, same code, same memo hits, including answers given by
humans. A behavior change—body, helper, validator, output nodeparamslot, executor—forces a RENAME
(`calculate_tax` → `calculate_tax_v2`) and belongs in the owning workflow's `nodes_special/`;
an edit to a shared node under an unchanged name changes every workflow that lists it, which is
why shared code must never carry versioned behavior. One node per file, file name == node_id
(enforced by `npm run check:workflows`). There is no mechanical tripwire for a forgotten rename;
`validateCatalog` (in `src/domain/registry/Registry.ts`, run by every publish) catches the
declared-shape divergences it can (same name, different executor/output/inputNodeparamslots/display
across workflows) and the rest is the contract.

**Nodeparamslots are first-class.** A global `nodeparamslots` table classifies every nodeparamslot by its birth channel
(`upload` / `questionnaire` / `email` / `computed`); `artifacts.nodeparamslot` and `nodes.output_nodeparamslot` FK
it, and `supplyArtifact` rejects unknown nodeparamslots. Every node declares a total `inputNodeparamslots` map
(param → consumed nodeparamslot, or null for scalar), published to `node_input_nodeparamslots` and enforced at run
time before hashing. Artifact provenance is DERIVED, never stored: the `artifact_facts` view
computes `produced_by_node_run` (earliest producing run) and `origin`
(`produced | upload | questionnaire | email | override`). Questionnaire answers are canonicalized
server-side (upload route flag `canonical_json=true`), so a re-answered identical form converges
on the same artifact and revives downstream memo hits.

**Worker restarts.** On startup the worker runs `adoptOpenWorkflows()`—a no-op signal sweep
over this instance's open workflows—so their Temporal stickiness transfers to the live worker
instead of stalling queries against the dead one's sticky queue. Inbox `task_info` queries also
carry a 5s deadline: an unhealthy task drops out of one sweep rather than wedging the endpoint.

## Layout

```
src/
  domain/          pure, bundle-safe (canonical JSON + hashing, registry factories, ArtifactHandle, decimal strings)
  workflows/       THE PRODUCT—one folder per workflow version (folder name == workflow_id); each
                   holds workflow.ts (the DAG) + enums.ts (its Nodeparamslot/NodeId vocabulary + NODEPARAMSLOTS
                   declarations) + nodes_special/ (this version's behavior, one node per file,
                   file name == node_id). nodes_shared/ is the version-spanning library: shared
                   nodes (same layout) + the shared vocabulary
  temporal/        Context (the memoize-or-execute walk) + Workflows (bundle entry) + Activities + Runtime
  infrastructure/  env, SQLite ledger + completion transaction, payload store
  api/             Fastify service (routes, wire serializers, SSE progress stream)
  cli/             init / worker / demo / seed / tasks / submit / show / download
  shared/errors/   local mirror of @multiplier/lib-shared-errors
scripts/           check-workflows.ts (folder discipline) + cleanup-temporal.ts (frontend e2e suite)
sample_docs/       mock "PDF" documents (.txt) the CLI seed/demo attaches
```

## Deviations from the monorepo standards (and why)

1. **better-sqlite3 + hand-written SQL, not Drizzle/Postgres.** The ledger semantics
   (`BEGIN IMMEDIATE`, the idempotent completion transaction, the derived
   `artifact_facts`/`workflow_run_facts` views)
   *are* the product; SQLite is the deliberate v0 stand-in for Postgres.
   Migrating to Drizzle/Postgres is a post-move project. `src/infrastructure/db/Db.ts` stays
   concrete functions (no repository interface over 26 SQL functions); the narrow
   `TemporalGateway` interface in `src/api/` covers the seam where tests actually mock.
2. **`src/shared/errors`** mirrors the `@multiplier/lib-shared-errors` API—swap the import
   specifier on move. State-conflict 409s are discriminated by `RuntimeError` with
   `context.code` in `{RUN_FROZEN, RUN_NOT_COPYABLE}` (the `CONFLICT_CODES` set in
   `src/api/App.ts`); every other `RuntimeError` maps to 422. No custom error subclasses.
3. **`DecimalString` (BigInt-backed decimal-string arithmetic)** instead of
   `@multiplier/lib-shared-monetary`—payload money is decimal strings end to end (canonical
   JSON bans floats) and needs exact ROUND_HALF_UP quantization. The eventual `MonetaryAmount`
   swap is a call-site rewrite, not an import swap; accepted.
4. **Biome override:** snake_case names allowed under `src/workflows/` only—the folder IS
   the workflow version (`workflow_id == folder name`), a load-bearing product rule enforced by
   `npm run check:workflows`.
5. **Wire JSON is snake_case** (the frontend contract); internal identifiers are camelCase; the
   mapping lives in `src/api/Serializers.ts` and the transport types. One deliberate wire-key ≠
   column-name exception: workflow-run members serve the membership's `created_by`/`created_at`
   as `added_by`/`added_at` (aliased in `MEMBERS_SQL`) because the joined row also carries the
   artifact's own `created_*`.
6. **No `application/` layer**—the API routes are the application services; adding a
   pass-through layer would violate the altitude rule.
7. **Integral numbers absorb their decimal point at `JSON.parse`** (`12.0` parses to `12`), so
   the float ban in reviewer submissions can only reject non-integral and unsafe numbers.
   Information-theoretically unfixable after parsing; deliberate.
8. **Sync better-sqlite3 inside async activities** can block the worker event loop up to
   `busy_timeout` (15s) under cross-process write contention (split-worker or seed-beside-API
   modes). Demo-scale transactions are milliseconds; accepted stall mode.
9. **Catch-variable narrowing**: `useUnknownInCatchVariables: false` (monorepo base); caught
   errors are narrowed only via `errorMessage()` / `isSqliteConstraintError()` from
   `src/shared/errors`. No `unknown`/`any` in exported signatures.
10. **Request-size caps**: JSON bodies and uploads are capped at 50 MB. `-0.001` quantizes to
    `0.00` (BigInt has no signed zero).
11. **Loopback bind by default** (`GRAPHFLOW_HOST=127.0.0.1`); set `0.0.0.0` explicitly for
    network exposure.

## Monorepo-move checklist

Delete `tsconfig.base.json` and repoint `extends` to the root one; delete `package-lock.json`
(root `yarn.lock` takes over); delete local `biome.jsonc`/`knip.json` (fold the workflows
filename override and knip entries into the root configs); swap `src/shared/errors` →
`@multiplier/lib-shared-errors` and `DecimalString` → `@multiplier/lib-shared-monetary`; add the
package to root `tsconfig.json` references; add Nx tags (`type:backend`); run `yarn constraints`,
`yarn nx sync`, `yarn check`.
