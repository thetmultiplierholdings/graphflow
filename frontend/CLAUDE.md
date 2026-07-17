# Graphflow Design System

This is the UI for **Graphflow** — a memoised computation engine for
professional-service firms. Firms open
engagements; inside an engagement they create workspaces, attach documents,
press Run, watch it execute, and download the results.

The frontend is a PURE RENDERING LAYER over the Fastify service in
`../backend_typescript/src/api`. The responsibility split: ALL invariants live
in the TypeScript engine and its SQLite ledger; the API is a thin translation
layer; the UI only renders and calls.

## Graphflow Domain (do not casually re-model)

Entities live in `@/lib/schemas/` and mirror the backend ledger schema:

- **Engagement** — the isolation boundary. Memo entries and artifacts are
  never shared across engagements.
- **Artifact** — immutable, content-addressed (SHA-256 of payload bytes);
  `UNIQUE (engagementId, kind, hash)`. Only `label` is mutable.
- **NodeRun** — a memo entry: `UNIQUE (engagementId, memoKey)` where
  `memoKey = H(codeHash ‖ inputHash)`. Insert-only.
- **Workspace** (workflow_run) — editable intent; never deleted, only archived.
- **WorkspaceArtifact** — membership with `source: user | engine`. User
  attach promotes engine rows; engine attach never demotes. Detaching is the
  ONLY delete in the system.
- **HumanTask** — mirror of a waiting Temporal task workflow; the inbox.

## Stack

- **Framework**: Next.js 16 (App Router)
- **UI Components**: shadcn/ui (radix-vega style) from `@/components/ui/`
- **Styling**: Tailwind CSS v4 with OKLCH design tokens in `globals.css`
- **Icons**: Lucide React (`lucide-react`)
- **State**: Zustand (in-memory server mirrors, no persistence)
- **Validation**: Zod schemas for all data entities
- **Utilities**: `cn()` from `@/lib/utils`

## Data Architecture

### The API boundary

`@/lib/api/client.ts` is the ONE boundary between backend and app
conventions: snake_case keys and integer ids on the wire become camelCase
keys and string ids in the app (and back on the way out). Nothing past that
module ever sees a snake_case key.

`@/lib/api/operations.ts` is the engine-facing surface pages call: it starts
runs (POST `/execute`, then mirrors the SSE `/progress` stream into the run
store), resumes in-flight runs on mount (`resumeRunIfActive`), and submits
human-task answers.

### Stores are non-persisted server mirrors

All stores under `@/lib/stores/` are in-memory mirrors of what the API says —
nothing is persisted client-side, ever.

- **ledger-store** — the database mirror. Async refreshers pull server state;
  mutations are an API call followed by a refresh of the affected scope, so
  the mirror converges on server truth.
- **catalog-store** — mirror of GET `/catalog`, hydrated on mount.
- **human-task-store** — polled Temporal visibility: the sidebar badge polls
  ~5s, the inbox ~3s. Only open tasks are ever listed; an answered task
  simply disappears (its answer is a ledger fact).
- **run-store** — mirror of the SSE progress stream for the watch-it-run
  panel. Deliberately NOT persisted: nothing pending is ever stored
  client-side; everything with a pulse lives in Temporal.

Payload bytes never live in stores. Fetch content on demand via
`/artifacts/{id}/content` (the `payloadAvailable` flag says whether bytes
exist; a 410 means the payload was destroyed per policy — the ledger keeps
the hash, kind and lineage).

### Why This Matters

An artifact renamed in the workspace must show the new label in the artifact
pool, the ledger, and the lineage view — it is the same row everywhere.
Never create standalone mock data arrays in page components.

### Entity Relationships

```
Engagement ──< Workspace ──< WorkspaceArtifact >── Artifact
     │                                                │
     ├──< Artifact ── producedByNodeRunId ──> NodeRun │
     ├──< NodeRun ── inputArtifactIds ──────> Artifact┘
     └──< HumanTask (open questions; the inbox)

Catalog (data from GET /catalog, mirrored in catalog-store): workflows,
nodes (with codeHash), kinds (leaf = attachable document).
```

### Seed / reset is backend-only

Demo data is seeded by the backend: `npm run seed -- --fresh` in the
`../backend_typescript` directory. There is no client-side seed and no
localStorage — reloading the app re-fetches everything from the API.

### Rules

- The frontend must NEVER compute content hashes, memo keys, or canonical
  JSON — those belong to the backend engine
- NEVER execute node bodies client-side
- NEVER write or fabricate ledger rows; never invent data the API owns
- Client-side form validation is UX only — the backend enforces the same
  contract (the human node's `result_validator`)
- NEVER create inline mock data in page components
- NEVER duplicate entity fields across stores — store ids and look them up
- When prototyping a new page, use existing store data — don't invent new
  disconnected records

## UI Foundation

- Always use shadcn/ui components from `@/components/ui/`
- If a required shadcn component is missing, install it with
  `npx shadcn@latest add <component> --yes`
- Use design tokens from `globals.css` (e.g., `bg-primary`, `text-muted-foreground`)
- Icons: Lucide React from `lucide-react`
- No negative margins — restructure layout instead
- All components must support dark mode through semantic tokens

## Colour Scales

The `--color-primary-{50-950}`, `--color-neutral-{50-950}`, and
`--color-secondary-{50-950}` scales in `globals.css` exist for reference
and demonstration only. Do NOT use them directly in components — always
use the semantic tokens (`bg-primary`, `text-success-strong`,
`bg-destructive-muted`, etc.) instead.

## Typography

| Class          | Font       | Usage                                     |
|----------------|------------|-------------------------------------------|
| `font-body`    | Inter      | Body text, UI elements (applied globally) |
| `font-heading` | Financier  | Page titles, major headings               |
| `font-code`    | Fira Code  | Code snippets, monospace text             |

- Default text size: `text-sm` for body text and UI elements
- `text-lg` and above: headings only
- Max 2 font styles per component (font size + weight combination)
- Use colour (`text-muted-foreground`) to differentiate secondary text
  instead of varying font size

## Text Colours

| Class                   | Usage                         |
|-------------------------|-------------------------------|
| `text-foreground`       | Default (inherited from body) |
| `text-muted-foreground` | Secondary/de-emphasised text  |

Never use hardcoded Tailwind colours like `text-gray-600`.

## Semantic Colours

| Colour        | Meaning                    | Example                         |
|---------------|----------------------------|---------------------------------|
| `success`     | Positive, complete, active | Active status, approved         |
| `destructive` | Danger, error              | Archived, error state           |
| `warning`     | Caution, pending           | Pending review, revision needed |
| `info`        | Informational              | Awaiting data                   |
| `neutral`     | Default, inactive          | Draft, inactive                 |
| `primary`     | Brand, owner               | Primary actions                 |

## Text Formatting

- **British English** for all UI copy (Organisation, Colour, Cancelled, Centre)
- **American English** for code (variable names, comments)
- **Title Case** for labels and badges

## Button Icons

Put margin on the label span, not the icon:

```tsx
// Correct
<Button>
  <Plus className="h-4 w-4" />
  <span className="mr-1">Add Client</span>
</Button>
```

## Component Conventions

### Project Structure

```
/src
├── /app                    # Next.js App Router
│   ├── /components         # App-specific custom components
│   ├── /[feature]          # Feature routes (clients, jobs, rfis, etc.)
│   ├── globals.css         # Design tokens
│   └── layout.tsx
├── /components
│   └── /ui                 # shadcn/ui base components
├── /lib
│   ├── /api                # client.ts (the wire boundary) + operations.ts
│   ├── /schemas            # Zod schemas (one per entity)
│   ├── /stores             # Zustand stores (server mirrors)
│   └── utils.ts            # cn() utility
```

### Tables

TableHead includes kicker styling automatically (uppercase, tracking-wider).
Do not add extra styling to table headers.

### Dialogs

Use shadcn `Dialog` for modals. For multi-step flows, manage steps with
state (`useState<"select" | "setup" | "verify">`).

### Delete Flows

- Use `AlertDialog` for irreversible or high-impact deletions
- Skip confirmation for removing unsaved/draft items or re-addable tags

### Form Fields

- Wrap label + input in `<div className="space-y-2">`
- Do not add `text-xs` to Label — use default size

### Overflowing Filter Bars

Use horizontal scroll with hidden scrollbar:
`overflow-x-auto scrollbar-none min-w-0 overscroll-x-contain`

## Workflow

- Do NOT perform git operations (commits, pushes) — user handles git
- When creating a new page/feature, always wire it to existing store data
- When adding a new entity type, create the Zod schema first, then the
  `client.ts` mapper, then the store refresher, then the UI (no seed step)
