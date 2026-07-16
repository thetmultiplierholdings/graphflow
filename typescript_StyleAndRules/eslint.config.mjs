import nxPlugin from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    '.claude/',
    '.git/',
    '.nx/',
    '.yarn/',
    '**/dist/',
    '**/dist-publish/',
    '**/out-tsc/',
    '**/coverage/',
    '**/node_modules/',
    '**/*.timestamp-*.mjs',
    '**/generated/',
    '**/data/development/ledger/',
    '**/.vitepress/cache/',
    'apps/corporate-frontend/public/mockServiceWorker.js',
    '**/workflow-bundle.js',
    // Warden import (warden/**) is lift-and-shift; see warden/IMPORT_NOTES.md
    'warden/',
  ]),
  {
    plugins: {
      '@nx': nxPlugin,
    },
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
      parser: tsParser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '@multiplier/[^/]+/(?!testutil|node|schemas|contracts|workflows|seed$|browser$|server$).*',
              message:
                'No deep linking inside of imported projects except for testutil, node, schemas, contracts, workflows, seed, server, or browser exports',
            },
          ],
        },
      ],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:lib'], // App code should only depend on library code
            },
            {
              sourceTag: 'scope:platform',
              notDependOnLibsWithTags: ['scope:corporate'], // Platform code should not depend on corporate code
            },
            {
              sourceTag: 'scope:shared',
              notDependOnLibsWithTags: ['scope:platform'], // Shared code should not depend on platform code
            },
            {
              sourceTag: 'scope:corporate',
              // Corp code must use platform HTTP endpoints instead of importing platform-internal libs directly.
              // NOTE (2026-05-13): no platform libs currently carry the scope:platform-internal tag, so this rule
              // is dormant. The "no shared cross-HTTP libs" intent is currently enforced informally via code review
              // for all platform-domain libs (billing, batch, ai, etc.). Restore by tagging libs consistently in a
              // follow-up PR, or remove this rule if the informal discipline is sufficient.
              // See `libs/platform/ai/package.json` tagsNote.
              notDependOnLibsWithTags: ['scope:platform-internal'],
            },
            {
              sourceTag: '*',
              notDependOnLibsWithTags: ['type:script'], // Nothing should depend on scripts
            },
            {
              sourceTag: 'type:frontend',
              notDependOnLibsWithTags: ['type:backend'], // Frontend code should not depend on infrastructure code
            },
          ],
        },
      ],
    },
  },
  // platform-cli html-viewer: Allow importing dashboard components for standalone HTML generation
  // Justification: CLI generates standalone HTML files that bundle dashboard React components
  // for offline viewing. This is a build-time dependency, not a runtime deployment coupling.
  // The dashboard's package.json exports field defines a stable public API.
  {
    files: ['apps/platform-cli/src/html-viewer/**/*.{ts,tsx}'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
  // cli-seeder: Allow importing from platform-service and org-management apps
  // Justification: The seed CLI orchestrates platform-service and org-management
  // databases for local development. It needs direct access to their seed context factories.
  {
    files: ['apps/cli-seeder/src/Cli.ts'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
]);
