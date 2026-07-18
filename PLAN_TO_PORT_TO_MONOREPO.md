# Port graphflow into the multiplier monorepo — Plan

## Context

Graphflow is an engagement-scoped, **memoized workflow engine** prototyped at `/Users/thetlinthu/graphflow`: an insert-only ledger (SQLite), content-addressed artifacts, per-node code hashes, real Temporal execution with human-in-the-loop tasks, a Fastify API, and a Next.js UI. The prototype's job was to prove the memoization contract (`memo_key = sha256(code_hash ‖ input_hash)` over canonical JSON); its data is disposable mock content ("shows something in the UI"). This plan ports it into the Multiplier monorepo (`/Users/thetlinthu/multiplier`) for real production with human review.

**Decisions locked with the product owner (2026-07-17):**
1. **Monorepo conventions are BLESSED** — wherever the prototype deviates (errors, money, wire casing, file naming, state management), the monorepo idiom wins. This is a semantic port, not a lift-and-shift.
2. **Graphflow is platform-central** — "not just for tax, it's for everyone." Engine + persistence + API live at platform level; tax is the first consumer.
3. Tables get a **`grfl_` prefix** (words like `workflow_run`/`engagement` are too generic).
4. Engagements are **org-scoped with a soft ClientJob link** (`organization_id` required + enforced in every query; `client_job_id` nullable soft UUID reference, no FK — the established cross-service pattern).
5. **MonetaryAmount** replaces DecimalString (call-site rewrite in node bodies; hash changes are fine, no data migrates).
6. Frontend uses **TanStack Query** + tax-frontend conventions; zustand only for genuine client state (live run panel).
7. "Warden" is dead legacy; the New Tax App (`apps/tax-*`) is where tax lives.
8. **agent-workflows is unrelated** — we copy only its PR-stacking playbook and directory conventions. No shared code/tables/buckets/queues. `graphflow` (and `grfl_`) is deliberately a collision-free namespace (the bare word "workflow" is heavily overloaded in the repo: `platform-workflows` app, `tax-workflows` pool, `lib-shared-workflows`, `WorkflowFilesController`).

## Target architecture

```
tax-frontend (Vite/React SPA)            ── new /graphflow section, flag-gated
      │  axios + TanStack Query (tax convention)
tax-api (stateless BFF, Okta)            ── new Grfl* controllers: authn + org-scope, proxy only
      │  oRPC service-to-service (existing PlatformServiceAuthProvider)
platform-service                          ── graphflow bounded-context HOST:
      ├── grfl_* tables in platform-service-db (existing migration chain + predeploy migrate job — verified: skaffold run-migration hook + Cloud Run migrate job)
      ├── oRPC handlers; contract in a NEW libs/platform/graphflow-contracts lib (org-management-contracts pattern — api-contracts is deliberately rescoped to AI/System clusters, PLA-1723)
      └── Temporal dispatch via existing WorkflowService.startWorkflow + CloudTemporalClient (verified: resolves platformWorkflowId → task queue via taskQueueForWorkflowType); graphflow registers platformWorkflowIds `graphflow.run` / `graphflow.human-task`
platform-workflows (GKE worker app)       ── GraphflowRun + GraphflowHumanTask on the existing
      │                                      `tax` worker pool (WORKFLOW_POOL_MANIFEST entry);
      │                                      activities call platform-service oRPC for ledger ops
      └── GCS: multiplier-graphflow-{env}-artifacts (payload bytes; DB stores refs only)

libs/platform/graphflow        @multiplier/lib-platform-graphflow   — THE ENGINE (generic)
libs/tax/graphflow-workflows   @multiplier/lib-tax-graphflow-workflows — tax nodes + workflows
```

Why this shape (each point has monorepo precedent):
- **platform-service hosts persistence + API**: copies the agent-workflows hosting pivot (fold tables into an existing service's DB/migration chain rather than new cloud infra — their COR-4609), but at platform level per decision #2. tax-api already proxies platform-service for org-management data with forwarded caller identity, so the BFF pattern is literally the existing tax architecture (`apps/tax-api/docs/architecture.md`).
- **Workers**: never a new worker app. `apps/platform-workflows` is the single worker binary; it already imports tax libs (`lib-tax-warden`), and the `tax` pool already exists (`tax-workflows-{env}-gke` queues). Registering GraphflowRun/GraphflowHumanTask there + one `WORKFLOW_POOL_MANIFEST` entry is the entire "worker infra". Pool moves later are a documented runbook (`docs/agents/temporal-schedule-pools.md`). Activities do **not** touch platform-service-db directly (one owner per dataset): ledger ops go through internal oRPC routes on platform-service — same pattern as `emailIngestSyncWorkflow` → tax-dataservice oRPC. Payload bytes go activity ↔ GCS directly.
- **Single-writer ledger semantics survive**: the idempotent `recordCompletion` transaction becomes a platform-service oRPC op executing the engine lib's repository transaction (BaseRepository.executeTransaction with deadlock retry).
- **Module boundaries**: platform must not import tax; tax→platform is the allowed direction. Engine (platform) exposes registration seams (`defineNode`/`defineWorkflow`/`buildRegistry`); `lib-tax-graphflow-workflows` depends on the engine. Note: eslint.config.mjs has no scope:tax depConstraint today (docs claim one) — do not rely on lint to police it; the review checks will.
- **Run progress: polling, not SSE, in v1.** The prototype's SSE stream just mirrors a cumulative Temporal-query snapshot, and the frontend already does multiset diffing + reconnect-resume. A plain `getRunProgress` snapshot endpoint polled at 2–3s (TanStack Query refetchInterval) is semantically identical, avoids reply.hijack()/LB-timeout complexity (backend timeout_sec=30 on the LBs), and kills the hardest frontend port target. SSE can be a follow-up.

## 1. Folders and files to create

### `libs/platform/graphflow` — the engine (new lib, @multiplier/lib-platform-graphflow)
Follow the standard lib shape (package.json#nx, tags `["type:lib","scope:platform","type:backend"]`… with browser-safe main barrel + subpath exports; exemplar: `libs/platform/agent-workflows/package.json`):
- `src/domain/canonical/` — canonical JSON + hashing (port of `backend/src/domain/canonical/Canonical.ts`; @noble/hashes, bundle-safe)
- `src/domain/registry/` — defineNode/defineHumanNode/defineWorkflow, buildRegistry, leafKinds (port of `Registry.ts`)
- `src/domain/artifact/` — ArtifactHandle/ArtifactRef + PayloadLoader
- `src/domain/` — entities (GrflEngagement, GrflArtifact, GrflNodeRun, GrflWorkspace…), repository interfaces
- `src/infrastructure/database/schema/` — Drizzle `grfl_*` tables (exported via `/schemas`)
- `src/infrastructure/repositories/` — Postgres repos extending BaseRepository (`@multiplier/lib-shared-postgres`), every method org-scoped
- `src/infrastructure/storage/` — `PayloadStore` port + `GcsPayloadStore` (via `/node`) + in-memory testutil impl
- `src/application/` — GraphflowService (engagements/workspaces/artifacts/catalog orchestration), completion service
- `src/temporal/` — the Ctx memoize-or-execute walk + workflow functions, exported via a bundle-safe `/workflows` subpath (pattern: `libs/platform/ai` exports `/schemas /node /testutil /workflows`)
- `src/index.ts` (browser-safe), `src/index.node.ts`, `src/schemas.ts`, testutil barrel; `vitest.config.mjs` (mandatory), `vitest.global-setup.mts` (per-run template DB via drizzle-kit schema diff — the agent-workflows pattern for libs whose migrations live in a hosting app), tsconfigs, colocated tests

### `libs/tax/graphflow-workflows` — tax nodes (new lib, @multiplier/lib-tax-graphflow-workflows)
- `src/workflows/` — tax demo workflow v1/v2 ported (PascalCase files; `workflow_id` becomes an explicit `defineWorkflow({id})` field — the filename-stem rule dies with the Biome override)
- `src/nodes/` — node bodies rewritten on MonetaryAmount
- `src/generated/CodeHashes.ts` — checked in; `generate-code-hashes` Nx target (ts-morph port of `backend/scripts/generate-code-hashes.ts`); freshness enforced by a colocated test that recomputes and compares (no CI wiring needed)
- `src/index.ts` — `ALL_WORKFLOWS` manifest

### `libs/platform/graphflow-contracts` — oRPC contract (new lib)
- GraphflowContract: Zod contract for engagements/artifacts/workspaces/runs/human-tasks + internal worker-facing ops (org-management-contracts is the structural template)

### `apps/platform-service` — hosting
- schema index re-exports the engine lib's `grfl_*` tables from `@multiplier/lib-platform-graphflow/schemas` (verified mechanics: corporate-dataservice does exactly this for agent-workflows — "sole owner of these tables' migration chain")
- `src/infrastructure/database/migrations/NNNN_*.sql` + journal/snapshots — generated only (`creating-drizzle-migrations` skill)
- oRPC handlers wired into the existing server plumbing (`lib-platform-service-server`), implementing GraphflowContract
- Temporal dispatch via existing WorkflowService/CloudTemporalClient; internal worker-facing routes (service-auth only, SystemContract network-gated pattern)

### `apps/platform-workflows` — workers
- `src/usr/temporal/workflows/graphflow/GraphflowRunWorkflow.ts` + `GraphflowHumanTaskWorkflow.ts` (thin re-exports over the engine lib's `/workflows` code; exported from `workflows/index.ts`)
- `src/usr/temporal/activities/graphflow/` — createGraphflowActivities(deps): memo lookup / record completion via platform-service oRPC client; payload IO via GcsPayloadStore
- registration in `src/usr/index.ts` processRegistrations() with Zod input/output schemas; `WORKFLOW_POOL_MANIFEST` entry → pool `tax` (completeness test enforces)

### `apps/tax-api` — BFF
- `src/infrastructure/web/controllers/Grfl*Controller.ts` (Engagements, Workspaces, Artifacts, Runs, HumanTasks) registered in `RouteRegistration.ts`; Okta + `commonPreHandlers` + org-membership enforcement; inline Zod-schema handlers (hard rule); proxies platform-service with forwarded caller identity

### `apps/tax-frontend` — UI
- Sidebar: new nav item labeled **"Workflows"**, positioned **above "Clients"** in `src/components/app-sidebar/constants.ts` (user-facing label is "Workflows"; code, routes' components, and namespaces stay `graphflow` — the collision concern is a code/infra concern, not a UI-label one)
- `src/pages/graphflow/` — Engagements, EngagementDetail, Workspace, Inbox, Catalog (lazy routes under `/workflows/...` in `AppRouter.tsx`, gated by the `tax_graphflow` feature flag)
- `src/lib/graphflow-client.ts` — axios client per tax convention; `src/hooks/queries|mutations/graphflow/` — TanStack Query hooks (ledger/catalog/human-task mirrors become queries with refetchInterval; run-panel live state stays a small zustand store)
- Components ported: StatusBadge system, attach dialog, artifact preview sheet, run panel, HITL review dialog, static SVG DAG. Stock shadcn primitives are NOT ported — reuse tax-frontend's local UI kit.

### `infra/`
- `infra/terraform/modules/platform-service/graphflow-artifacts.tf` — bucket + IAM (see §3)

## 2. Infrastructure differences: prototype vs monorepo

| Concern | prototype | monorepo target |
| --- | --- | --- |
| DB | better-sqlite3, 26 hand-written SQL fns, `BEGIN IMMEDIATE` | Drizzle/Postgres in platform-service-db, BaseRepository + executeTransaction (deadlock retry), generated migrations only |
| Ids | integer MAX+1 pre-allocation (SQLite-ism) | **UUID `defaultRandom()` PKs** — the verified repo norm (zero identity/serial usage repo-wide). Also kills the int-id↔string-id wire mapping |
| Circular FK | deferred circular pair artifacts↔node_runs | **VERIFIED: drizzle-kit ^0.31 cannot generate DEFERRABLE (no API, zero repo usage)** → `grfl_node_runs.output_artifact_id` is nullable, set inside the completion transaction; keep `grfl_artifacts.produced_by_node_run_id` as the FK direction |
| Payload store | local `mock_s3_gcs/` dir, tmp+rename | GCS, `ifGenerationMatch:0` write-once (copy `RdClaimsGcsObjectStore.createImmutable` semantics) |
| Temporal worker | embedded in API process | existing `tax` pool of apps/platform-workflows; bundle-safe engine code; 2MB Temporal payload cap already respected (refs-only transport) |
| API | Fastify snake_case wire + `{detail}` envelope + SSE | oRPC contracts (camelCase end-to-end — the frontend's client.ts mapping layer dies), lib-shared-errors envelope, polling instead of SSE |
| Errors | local `src/shared/errors` mirror | `@multiplier/lib-shared-errors` (import swap — API-compatible by design); `convertToTemporalError` in activities |
| Money | DecimalString (currencyless BigInt decimal strings) | MonetaryAmount in node bodies — **verified riders**: (1) MonetaryAmount cannot hold non-zero currencyless values, so each workflow declares an explicit currency constant (USD for the tax demo) included in `hashWith`; (2) hashed/canonical payload amounts stay bare quantized decimal strings (`"1234.50"` via `round(2, ROUND_HALF_UP).getValue().toFixed(2)`), never `{value,currency}` objects or class instances (canonical JSON rejects non-plain prototypes); (3) pin/forbid global `Decimal.set` in engine processes; decimal.js 20-sig-digit precision vs BigInt exactness is an accepted, documented delta |
| Filenames | snake_case workflow files == workflow_id | PascalCase everywhere; workflow_id an explicit config field |
| Auth | CURRENT_USER='Thet' stub | Okta JWT via tax-api commonPreHandlers; org-scoping in every repo query (the #6634 lesson: validated-but-unused organizationId is an auto-block) |
| Tests | vitest, real Temporal Cloud integration suite | vitest 4 + TestDatabase template DBs; WorkflowTestContext + TestActivityOptions.noRetries() for Temporal; guard-isolation negative tests |
| Frontend | Next.js 16 CSR SPA, zustand mirrors, EventSource | Vite/React/react-router in tax-frontend, TanStack Query, polling |

## 3. Special infra to set up

**GCS (the only new cloud infra):** `multiplier-graphflow-{env}-artifacts` (mirrors `multiplier-rd-claims-{env}-artifacts`). A small dedicated terraform module (rd-claims-artifacts pattern) instantiated in `environments/{staging,production}/main.tf`: `google_storage_bucket` (uniform access, public-access prevention enforced, no lifecycle delete — ledger payloads are permanent unless policy-destroyed), `objectAdmin` IAM to **both** the platform-service SA and the tax-pool worker SA (verified grantable via existing `module.workload_identity_temporal_pools["tax"].service_account_email` locals — no new identity plumbing), env-var wiring, plus a TS contract test pinning terraform env names to app config (KIP-204 pattern, commit 98003d076).

**Worker→service auth (verified nuance):** graphflow activities call platform-service; follow the sanctioned worker→platform-service pattern — terraform `run.invoker` grant for the tax-pool worker SA via `client_service_account_members` + the app-level SA allowlist. (The verifier found the analogous worker→tax-dataservice grant is MISSING in terraform on main — an existing gap, flagged separately; do not copy that precedent.)

**Not needed:** no new logical database, no new Temporal task queue/pool/namespace, no new deployable service, no new Cloud Deploy pipeline. Feature flag `tax_graphflow` (default off): a **manual 3-file change, no codegen** — tax `Flags.ts`, tax-api `FeatureFlagController.ts` (schema + Promise.all + response), tax-frontend `use-feature-flags.ts` — then an `OrgManagementRoute`-style gate wrapper for the new route subtree.

## 4. Artifact storage design (GCS) — verified against the engine

Verified facts (first-hand + dedicated investigation):
- Current keys are `{engagementId}/{sha256-of-bytes}` — already content-addressed, write-once; NOT `$0`-style blobs. The DB stores only `payload_ref` + metadata.
- **Slot names exist** (`defineNode({params})`) and key the canonical arg map inside the memo hash, but are **persisted nowhere**. Outputs have no slot — only `outputKind`.
- The object key participates in **no hash** (`memoKey = sha256(codeHash ‖ inputHash)`, inputHash over `{$artifact: <content-hash>}` forms) — re-keying storage cannot break memoization.
- Artifacts cross Temporal boundaries as refs only; bytes load lazily inside activities (`ArtifactHandle.bytes()` throws in workflow code). This already satisfies the repo's FileReference/2MB-cap discipline.

**Production scheme:**
- Key: `graphflow/v1/engagements/{engagementId}/artifacts/{kind}/{sha256}` — browsable, versioned prefix (RD-claims precedent), and deliberately ADDS `{kind}` so object identity matches `UNIQUE(engagement_id, kind, hash)` 1:1, fixing a real retention hazard (same-bytes-different-kind rows currently share one object; destroying one silently destroys both).
- **Slot-named keys are rejected** (this settles the "hazy" design question): slots are consumer-side, plural per artifact, and unknown at write time (payload is written by the producer before any consumer exists). Slot names instead get a new nullable `slot` column on `grfl_node_run_inputs` (the encodeArgs walk already knows the param each artifact came from and currently discards it) + optionally GCS custom metadata (label/kind/producer) for operator browsing.
- Writes: `ifGenerationMatch:0`, exists-with-identical-bytes = idempotent success; keep write-payload-before-DB-tx ordering. No file extensions in keys (media_type is caller-declared); set GCS `contentType` from the artifact row instead.
- Downloads: API-proxy first (preserves 410 "payload destroyed per policy" + auth semantics; payloads are mostly small JSON); V4 signed URLs as a follow-up for large binaries.
- Retention: destruction becomes an explicit first-class op (delete object + null `payload_ref`); decide during the port whether re-supplying identical bytes revives a destroyed payload (today it silently doesn't — known gap).

## 5. PR stack

Hard constraints from `REVIEW.md` (auto-enforced by the review bot): **≤1000 hand-written lines AND exactly one shippable concern per PR** (generated Drizzle SQL/journal/snapshots, openapi, lockfiles excluded); additive-only migrations; no ride-alongs; negative tests on every new ingress; no mocked system-under-test; ≥70%-clone files blocked. Playbook: agent-workflows landed 17 PRs of 165–930 additions with stack position in title brackets (`feat(graphflow): … [GRFL A/B1]`), full PR template, flag-gated. **Write the design doc first** (generate-design-doc skill → Notion) containing this stack plan; every PR's Motivation links it.

Prototype sizing: backend ~7.2k hand-written lines (temporal 940 + cli 751 currently have NO tests — new tests required), frontend ~6.4k portable (4.7k stock shadcn dropped).

### Epoch 0 — foundations (can start immediately, parallel-friendly)
| PR | Contents | Tests |
|---|---|---|
| 0.1 | `tax_graphflow` feature flag, default off — manual 3-file change (tax Flags.ts, tax-api FeatureFlagController, tax-frontend use-feature-flags), no codegen | controller schema test |
| 0.2 | Terraform: bucket module + objectAdmin IAM (both SAs) + run.invoker grant for tax-pool worker SA on platform-service + env wiring | contract test pinning env names |
| 0.3 | Engine lib scaffold + pure domain: canonical JSON/hashing, registry factories, ArtifactHandle (~900 lines w/ tests) | ported Canonical/Registry unit suites |

### Epoch 1 — backend (strictly ordered)
| PR | Contents | Tests |
|---|---|---|
| B1 | Drizzle `grfl_*` schema in engine lib `/schemas` + generated migration in platform-service chain (incl. `organization_id` everywhere, `client_job_id` soft ref, `node_run_inputs.slot`) | MigrationJournalIntegrity; schema Zod tests |
| B2 | Lib test harness (template-DB globalSetup) + repository 1: engagements + artifacts (supply/revive, label rename, org-scoped) | real-DB integration (TestDatabase) |
| B3 | Repository 2: node_runs + **the idempotent completion transaction** + memo lookup | heavy integration: idempotency, concurrent completion, guard-isolation negatives |
| B4 | Repository 3: workspaces/memberships/catalog publish; org-scoping sweep test (every repo method) | integration + the #6634-style tenant-isolation negatives |
| B5 | PayloadStore port + GcsPayloadStore + in-memory testutil | fake-backed unit + emulator/opt-in integration per repo conventions |
| B6 | `libs/platform/graphflow-contracts` lib + platform-service handlers: engagements/artifacts/workspaces CRUD | handler tests w/ real DB; ingress negatives (size/content-type/malformed) |
| B7 | oRPC: execute/status/progress-snapshot/human-tasks + Temporal dispatch (TemporalGateway seam port) + internal worker-facing routes | gateway-stubbed tests + dispatch integration |
| B8 | Worker activities in platform-workflows (oRPC ledger ops + GCS payload IO) | activity unit tests w/ DI, convertToTemporalError |
| B9 | GraphflowRun + GraphflowHumanTask + Ctx walk (engine `/workflows`) + registration + pool manifest (`tax`) | WorkflowTestContext + TestActivityOptions.noRetries(); memoize-or-execute walk scenarios; validated-update rejection |
| B10 | `libs/tax/graphflow-workflows`: tax demo workflow v1/v2 + nodes on MonetaryAmount + gen-code-hashes target + generated hashes | golden report tests (regenerated for MonetaryAmount), hash-freshness test, cross-version memo-stability test |
| B11 | tax-api BFF controllers part 1: engagements/workspaces/artifacts (Okta, org membership) | inject tests + authz negatives |
| B12 | tax-api part 2: run/execute/supersede, progress, human-task submit (422 semantics) | inject tests; 409/410/422 paths |

### Epoch 2 — frontend (after B11/B12)
| PR | Contents |
|---|---|
| F1 | graphflow axios client + Zod schemas + TanStack Query hooks (queries/mutations) |
| F2 | Routes + nav (flag-gated) + Engagements list/detail pages |
| F3 | Workspace page: documents/results cards, attach dialog, artifact preview sheet |
| F4 | Run flow: execute/supersede dialog, progress polling + snapshot diffing, run panel, resume-on-mount |
| F5 | Inbox + HITL review dialog (editable grid, validation, auto-approve) |
| F6 | Catalog page + static SVG DAG + version comparison |
| F7 | Playwright e2e: port the 8-step story (engagement → attach → run → 2× review → report → **memoised re-run "0 executed"** → catalog versions) onto the monorepo stack |

Each frontend PR ships with Vitest+Testing Library+MSW unit tests per `docs/agents/frontend-testing.md`. Every PR: full template body, test evidence, `Live functionality is behind a feature flag` checked, correct team tag.

## 6. Verification (end-to-end)

- Per PR: `yarn check` (validate battery + affected lint/typecheck/test/build); migration PRs also run the MigrationJournalIntegrity test; `yarn generate:specs` when contracts/flags change (Generated Files CI check).
- Engine correctness gates: (a) memo-stability test — copy-paste-unchanged node into a v2 file keeps its code hash (ports the prototype's core guarantee incl. human answers); (b) completion-transaction idempotency under concurrent identical executions; (c) canonical-JSON golden vectors.
- Local stack: `./scripts/dev.sh` with platform-service + tax-api + tax-frontend + a local worker (`TEMPORAL_WORKER_BUILD_ID=dev-local`), run the tax demo workflow end-to-end through the UI: attach docs → run → answer both HITL tasks → final report → re-run shows all memo hits.
- Staging behind the flag before any exposure: deploy, run the same story against staging Temporal Cloud namespace + staging bucket; confirm pool routing (`tax-workflows-staging-gke`) and payload objects landing under `graphflow/v1/...`.
- F7 e2e in CI needs a Temporal strategy (dedicated queue like the prototype's, or time-skipping local env) — resolve during B9 when the worker test harness exists.

## 7. Risks / open follow-ups

- **Progress UX**: v1 polling; SSE follow-up would need tax-api hijack pattern + LB timeout review (30s backend timeout today).
- **Pool evolution**: GraphflowRun is one workflow type → one pool (`tax`). If corp adopts graphflow, either move pools (runbook) or introduce per-domain runner registrations. Non-blocking now.
- **Revive-after-destruction semantics**: product decision, default = destroyed stays destroyed (matches today).
- **Money hashing**: currency constants + quantized-decimal-string boundary regenerate the golden vectors once in B10, then frozen. Full `{value,currency}` objects in hashed payloads is only ever a future migration that knowingly invalidates every memo hash.
- No SQLite data migrates (all mock). CLI (`init/worker/demo/seed/...`) is not ported; a dev seed script lands with B10 if needed for local demos.
