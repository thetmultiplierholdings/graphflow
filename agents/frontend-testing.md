---
snippet: How to unit-test React frontends (corporate-frontend) with Vitest, Testing Library and MSW — render helpers, MSW-over-hook-mocking, and the shared test environment.
---

# Frontend Testing

How to write tests for the React apps — primarily `apps/corporate-frontend`. This complements the general rules in [Testing Best Practices](09-testing.md) (TDD, colocation, no `any`, don't test what the type system guarantees); everything there still applies. This guide covers the React-specific stack: **Vitest + Testing Library + MSW**.

For keeping mock data in sync with the API contract, use the `updating-msw-handlers` skill.

## Stack

- **Runner:** Vitest (happy-dom environment), config in `apps/corporate-frontend/vitest.config.mjs`.
- **Rendering:** `@testing-library/react` + `@testing-library/user-event`.
- **Network:** [MSW](https://mswjs.io/) — handlers in `src/test/mocks/handlers.ts`, server in `src/test/mocks/server.ts`.
- **Environment:** `apps/corporate-frontend/test.setup.ts` wires MSW lifecycle, React Query `act()` handling, jsdom polyfills, and global Okta/sonner mocks. Read it before debugging a confusing test-environment failure — most of the gotchas are already commented there.

Run tests with `yarn app:corporate:frontend test`, or a single file with `yarn nxtest <repo-relative-path>`.

## Prefer MSW handlers over mocking hooks

When a component or page fetches data, assert on the contents of the network requests, and mock network responses MSW, rather than mocking the query hooks (`useX`) or the API module directly.

Mocking a hook bypasses the real data flow — fetching, response parsing, `select`/transform logic, and loading/error states, allows the hook to return responses a real API would never return, and glosses over critical integration logic in hooks.

The pattern (illustrative — real names below): override the handler for the test, render, let the real hook run.

```tsx
import { server } from '@/test/mocks/server';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@/test/test-utils';

server.use(
  http.get('*/organizations/:organizationId/client-accounts', () => new HttpResponse(null, { status: 500 }))
);
renderWithProviders(<ClientsTable />);
// then assert the component's error/empty state
```

See `src/components/organization/clients-table/ClientsTable.test.tsx` for a worked example that overrides the `client-accounts` handler per test.

Add the default (happy-path) response to `src/test/mocks/handlers.ts` so every test sees a realistic payload, and override per-test with `server.use(...)` for error and edge cases. The `updating-msw-handlers` skill covers matching handler shapes to the generated Zod/OpenAPI types.

## Rendering components

Use `renderWithProviders` from `src/test/test-utils.tsx` for anything that touches React Query, routing, org context, or feature flags. It wraps the tree in a fresh `QueryClient` (retries off, `gcTime: 0`), `FeatureFlagProvider`, and a synchronous `TestOrganizationProvider`.

```tsx
import { renderWithProviders, noOrganizationTestValue } from '@/test/test-utils';

// Default: canned org context (org-1, OWNER) injected synchronously
renderWithProviders(<MyComponent />);

// Component uses routing (useNavigate, Link, loaders)
renderWithProviders(<MyComponent />, { withRouter: true });

// Simulate a signed-in user with no organisation
renderWithProviders(<MyComponent />, { organizationOverride: noOrganizationTestValue });

// Exercise the real OrganizationProvider bootstrap (via the /user MSW handler)
renderWithProviders(<MyComponent />, { organizationOverride: false });
```

- The default `organizationOverride: true` short-circuits the org bootstrap so most tests don't wait on `useUser`. Only pass `false` when the test specifically verifies bootstrap behaviour.
- Feature flags: use `setFeatureFlags({ myFlag: true })` from `test-utils` (installs an MSW handler); unspecified flags default to `false`.

## What the shared environment already handles

`test.setup.ts` runs for every test file — don't re-implement these per file:

- **MSW lifecycle** — `server.listen({ onUnhandledRequest: 'error' })`, `resetHandlers()` after each test, `close()` at the end. Any request without a matching handler **fails the test** — add a handler, don't ignore it.
- **Org mock state and web storage** are reset between tests (`resetOrganizationMockState()`, `localStorage`/`sessionStorage` cleared) so selected-org state doesn't leak across tests in a file.
- **Global mocks** — `sonner` (assert via `vi.mocked(toast.error).toHaveBeenCalledWith(...)`, clear with `mockClear()` in `beforeEach` if you assert on call history), Okta auth (`@okta/okta-auth-js`, `@okta/okta-react`, `@/lib/auth` — a signed-in user), and `@/lib/api` (routed through a fetch adapter so MSW can intercept axios calls).
- **jsdom polyfills** — `ResizeObserver`, `matchMedia` (returns `prefers-reduced-motion: reduce` to disable Radix animations), pointer capture, `scrollIntoView`, `elementFromPoint`.
- **`act()` noise** — React Query re-renders are wrapped in `act()`; a small allowlist of known library-internal act warnings is suppressed. If you see a *new* act warning, it's likely a real issue in your component, not noise to silence.
