# Repository Guidelines

This monorepo contains the Multiplier platform codebase. This file is your map: hand-written core rules below, then a generated index of everything else. The map between the markers is auto-generated—do not edit it by hand.

Nested `AGENTS.md` files in subdirectories override these rules. Agents read the nearest `AGENTS.md` in the directory tree.

## Core rules

### Platform principles

Properties this codebase tries to keep true. The operational rules below carry a *(→ Principle N)* marker where they implement one of these.

1. <a id="principle-1"></a>**The domain is pure.** No framework, no `node:*`, no I/O in `domain/`. Purity is what lets the rest work. → [DDD](docs/agents/11-domain-driven-design.md)
2. <a id="principle-2"></a>**One library, one bounded context.** Cross-context access through interfaces, not shared tables or internal subpaths. → [Strategic Design](apps/platform-documentation/guides/software-development/architectural-patterns/domain-driven-design/strategic-design.md)
3. <a id="principle-3"></a>**Validate at the boundary, trust inside.** Zod at the edge; domain factories receive typed data, not `unknown`. → [Patterns](docs/agents/03-development-patterns.md)
4. <a id="principle-4"></a>**Migrations are generated, never edited.** `yarn nx db:generate <project>` — treat output under `migrations/` as build artifacts.

### Workflow
- Use `yarn`; never `npx` (Yarn 4 with the pnpm node-linker).
- In a git worktree, every absolute path you write must live under the worktree root, never the main checkout.
- Run `yarn check` before committing. After a rebase or merge, run `yarn install` first if unrelated builds break.
- Never pass `--no-verify` or otherwise skip pre-commit hooks. If a hook fails, fix the underlying issue.
- Don't use `git -C`; `cd` into the repo root instead.

### TypeScript
- Never `any`, `unknown`, `@ts-ignore`, or non-null `!` assertions.
- Use `import type` / `export type` for type-only imports.
- `===` and `!==`. `const` for single-assignment, `let` otherwise. Never `var`.
- Source file names are `PascalCase.ts` (except `index.ts` and config files).
- `node:` protocol for Node.js builtins (`import { readFile } from 'node:fs/promises'`).

### Errors
- Use centralised errors from `@multiplier/lib-shared-errors` (`ValidationError`, `NotFoundError`, `RuntimeError`).
- Wrap external errors via `convertToStandardErrorAndThrow`. Never define custom error classes.

### Imports and modules
- Always import from the package root: `import { X } from '@multiplier/lib-foo'`. Never use subpath imports (allowed exceptions: `/testutil`, `/node`, `/schemas`). *([→ Principle 2](#principle-2))*
- Module boundaries are enforced—libraries must not import application code. *([→ Principle 2](#principle-2))*

### Domain conventions
- Before making any database schema change, invoke the `creating-drizzle-migrations` skill and/or search for drizzle migration documentation in the codebase—never hand-write migration SQL, journal, or snapshot files. *([→ Principle 4](#principle-4))*
- Use `MonetaryAmount` from `@multiplier/lib-shared-monetary` for currency.
- Zod v4: prefer `z.email()`, `z.uuid()`, `z.iso.datetime()`. Don't chain validators on `z.string()`. *([→ Principle 3](#principle-3))*
- React mutations: `mutation.mutate(data, { onSuccess, onError })`. Never `mutateAsync`—bypasses global error handling.
- Temporal: activities live in separate files from workflows. No `Date.now()`, `Math.random()`, HTTP, or DB calls inside workflows.

### Tests
- Every change ships with tests. Red/green TDD. Colocate `Foo.test.ts` next to `Foo.ts`. No `any` in tests. Real DB for integration tests, not mocks.

### Style
- British English in `corp-*` user-facing copy ("organisation", "colour"). American English in code, comments, identifiers.
- Em-dashes have no surrounding spaces (`word—word`, not `word — word`).

## How to find more

- **Look up a specific topic across all docs**—`./scripts/search-docs.sh "<phrase>"` (BM25 over `docs/` and `apps/platform-documentation/`; ~30ms; add `--json` for structured output).
- **Scope-specific rules**—read the nearest `AGENTS.md` in the directory tree.
- **Deep guides on a known topic**—see the map below.
- **Triggerable workflows**—skills in `.claude/skills/`. Invoke a skill by name when its trigger description matches your task.

<!-- AUTO-GENERATED:START -->

### Deep guides — `docs/agents/`

| Topic | Summary |
| --- | --- |
| [Overview](docs/agents/00-overview.md) | Index of agent docs and how the build process works. |
| [Architecture](docs/agents/01-architecture.md) | Yarn 4, Nx, TypeScript, Vitest, tsx, Fastify, Biome — core toolchain. |
| [Development Commands](docs/agents/02-development-commands.md) | Dev script, yarn shortcuts, worktree rules, generate:specs, clean. |
| [Development Patterns](docs/agents/03-development-patterns.md) | Boundary validation, typed Fastify/Zod handlers, MonetaryAmount, Zod v4 specialised patterns. |
| [Error Handling](docs/agents/04-error-handling.md) | Centralised error types and convertToStandardErrorAndThrow wrapping pattern. |
| [TypeScript Best Practices](docs/agents/05-typescript-rules.md) | No any/unknown/@ts-ignore, import type, ===, PascalCase.ts files. |
| [Code Complexity and Quality](docs/agents/06-code-quality.md) | Cognitive-complexity ceiling, parallel awaits, Map for lookups. |
| [Correctness and Safety](docs/agents/07-correctness-safety.md) | Runtime safety, async/await rules, security guidelines, common pitfalls. |
| [Style and Consistency](docs/agents/08-style-consistency.md) | British English in corp-* user copy, American in code; em-dash style. |
| [Testing Best Practices](docs/agents/09-testing.md) | TDD, colocated tests, no any in tests, real DB for integration. |
| [Monorepo and Multiplier packages](docs/agents/10-monorepo-and-packages.md) | apps/, libs/{platform,shared,corporate,tax,kip}, module boundaries. |
| [Domain-Driven Design](docs/agents/11-domain-driven-design.md) | domain/ pure, infrastructure/ framework-aware, application/ orchestration; BaseRepository. |
| [Temporal Workflows](docs/agents/12-temporal-workflows.md) | Activities separate from workflows, no Date.now() in workflows, noRetries(). |
| [Evaluation Framework](docs/agents/13-evaluation-framework.md) | AI evaluation framework in libs/platform/ai for LLM-powered features. |
| [Agent Framework](docs/agents/14-agent-framework.md) | Tool-using AI agent framework in libs/platform/ai. |
| [Multiplier Code Agent (MCA) System](docs/agents/15-multiplier-code-agent.md) | MCA orchestrator, webhook ingress, worker lifecycle, session management. |
| [Cloud Build cluster sub-builds](docs/agents/cloudbuild-sub-builds.md) | Shard application-builds into team-owned sub-builds (platform, corp, tax…). |
| [Deploy pipeline and affected detection](docs/agents/deploy-pipeline.md) | Selective builds and deploys via Nx affected on push to main; deployArtifacts convention. |
| [Bash slop catalog](docs/agents/deslop-bash.md) | Deslop review grounding — quoting, strict mode, ls parsing, subshell traps. |
| [TypeScript slop catalog](docs/agents/deslop-typescript.md) | Deslop review grounding — type-system escapes, promise misuse. |
| [Frontend Testing](docs/agents/frontend-testing.md) | Unit-test React frontends with Vitest, Testing Library, and MSW. |
| [Knowledge Intelligence Platform (KIP)](docs/agents/kip/index.md) | KIP landing page — ingest → extract → Fact loop → ISS pipeline. |
| [Routine report format contract](docs/agents/routine-report-format.md) | Fleet-wide rendering contract for cloud-routine reports — skeleton, line grammar, caps. |
| [Temporal Cloud server-side metrics](docs/agents/temporal-cloud-metrics.md) | temporal_cloud_v1_* metrics, stranded-workflow alert, SDK metric gaps. |
| [Pool-scoped Temporal schedules](docs/agents/temporal-schedule-pools.md) | Schedule IDs scoped to worker pool, per-pool orphan cleanup on pool moves. |

### Domain guides — nested `AGENTS.md`

| Path | Scope |
| --- | --- |
| [Platform Dashboard - Component Design Principles](apps/platform-dashboard/AGENTS.md) | Components own their behavior, UI elements, and event handlers. |
| [Platform Documentation](apps/platform-documentation/AGENTS.md) | Inherits root `AGENTS.md`. Public-facing VitePress documentation site. |
| [Corporate Libraries](libs/corporate/AGENTS.md) | Inherits root `AGENTS.md`. Code shared across corporate apps. |
| [Platform Libraries](libs/platform/AGENTS.md) | Inherits root `AGENTS.md`. Implements Multiplier's platform domain. |
| [bigquery-reporting](libs/platform/bigquery-reporting/AGENTS.md) | Emulator-backed tests opt-in via `HAS_BIGQUERY_EMULATOR=1`. |
| [sql-pipeline Architecture](libs/platform/bigquery-reporting/src/sql-pipeline/AGENTS.md) | Boundary between TypeScript and BigQuery — generates SQL, binds query params. |
| [business-analysis Architecture](libs/platform/business-analysis/AGENTS.md) | Strict three-layer pattern for data representation. |
| [Platform Design System](libs/platform/design-system/AGENTS.md) | shadcn/ui primitives with shared design tokens and composed core-ui/ components. |
| [Shared Libraries](libs/shared/AGENTS.md) | Inherits root `AGENTS.md`. Cross-domain utilities used by every workspace. |
| [authz](libs/shared/authz/AGENTS.md) | Route-level authz plugin with serialisable rule DSL and six-variant RuleResult. |
| [Communication library](libs/shared/communication/AGENTS.md) | Shared bounded context for email/Slack threads, messages, attachments, mailbox. |
| [Warden](warden/AGENTS.md) | Legacy Tax application — self-contained, lifted from the legacy warden repo. |

### Skills — `.claude/skills/`

| Skill | Trigger |
| --- | --- |
| adopt-result | Work with the Result pattern for explicit, type-safe error handling. |
| corp-ai-prompts | Add new AI prompts to the generic prompting system in @multiplier/lib-corp-ai-prompts. |
| creating-drizzle-migrations | Create Drizzle ORM database migrations correctly. |
| cross-client-email-rendering | Build or modify email templates to render correctly across Outlook and other clients. |
| gcp-monitoring-dashboard | Create and edit GCP Monitoring dashboards in Terraform. |
| generate-design-doc | Co-author a technical design document or RFD and publish it to Notion. |
| generate-openapi-and-frontend-clients | Generate OpenAPI specs and frontend clients. |
| generating-ui | Generate UI in any Multiplier frontend project. |
| incident-triage | Triage Cloud Run incidents and Cloud Build failures with source-change attribution. |
| linear-api | Manage Linear issues and workflows via GraphQL API bash scripts. |
| postgres-repository | Implement PostgreSQL repositories using Drizzle ORM with DDD patterns. |
| pr-stack | Split an oversized branch into a stack of dependent PRs and manage to merge. |
| prepare-pr-description | Draft a pull request description for the current branch. |
| property-based-testing | Write property-based tests using fast-check in TypeScript. |
| resolving-migration-conflicts | Resolve database migration merge conflicts. |
| resolving-typecheck-issues | Resolve TypeScript errors without type escape hatches. |
| searching-platform-docs | Search the Multiplier docs FTS5 index for patterns and conventions. |
| temporal-workflows | Best practices for Temporal workflows and activities in TypeScript. |
| updating-msw-handlers | Update MSW handlers to match the current OpenAPI spec for corporate-frontend tests. |
| using-nx | Use Nx to build, test, lint, and typecheck in the monorepo. |
| writing-platform-documentation | Write technical docs for the platform-documentation VitePress site. |

<!-- AUTO-GENERATED:END -->

## Regenerating

`yarn generate:agents` rebuilds the map between the markers from tracked markdown. CI runs this automatically on push to `main` (see [`.github/workflows/build-search-index.yml`](.github/workflows/build-search-index.yml)) and commits any change.

To curate the one-line summary for a deep guide or a nested `AGENTS.md`, add `snippet:` to its frontmatter (and optionally `title:` to override the H1). The map prefers `snippet` over the auto-extracted first paragraph.
