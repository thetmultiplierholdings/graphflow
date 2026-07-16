'use strict';

// Yarn constraints — enforces consistent dependency versions across the monorepo.
// Mirrors the rules previously expressed in constraints.pro. See yarnpkg.com/features/constraints.

// Hard-pinned ranges. If the dep appears anywhere (any workspace, dependencies or devDependencies),
// it must match this range.
const PINS = {
  zod: '^4.1.9',
  '@types/node': '^22.17.1',
  fastify: '^5.8.5',
  'xero-node': '13.0.0',
  pino: '^10.1.0',
  openai: '^6.7.0',
  stripe: '^20.0.0',
  '@sentry/node': '^10.27.0',
  '@sentry/react': '^10.27.0',
  '@swc/core': '1.15.8',
};

// Synced against root's declared range. Non-root workspaces that declare these
// must use whatever range the root workspace declares.
const SYNC_WITH_ROOT = [
  'typescript',
  'vitest',
  'vite',
  '@vitest/coverage-v8',
  'postgres',
  'drizzle-orm',
  'nx',
  '@biomejs/biome',
];

// Names that must live in devDependencies, not dependencies.
// excludeRoot mirrors the WorkspaceCwd \= '.' guards in constraints.pro:
//   typescript was guarded (root may keep it in dependencies); vitest and @types/node were not.
const DEV_ONLY = [
  { ident: 'typescript', excludeRoot: true },
  { ident: 'vitest', excludeRoot: false },
  { ident: '@types/node', excludeRoot: false },
];

function enforcePins(Yarn) {
  for (const [ident, range] of Object.entries(PINS)) {
    for (const dep of Yarn.dependencies({ ident })) {
      if (dep.type === 'peerDependencies') {
        continue;
      }
      dep.update(range);
    }
  }
}

function syncIdentWithRoot(Yarn, root, ident) {
  const rootDep = Yarn.dependency({ workspace: root, ident });
  if (!rootDep) {
    return;
  }
  for (const dep of Yarn.dependencies({ ident })) {
    // peerDependencies declare compatibility ranges, not version pins — leave them alone.
    if (dep.workspace.cwd === root.cwd || dep.type === 'peerDependencies') {
      continue;
    }
    dep.update(rootDep.range);
  }
}

function syncWithRoot(Yarn, root) {
  for (const ident of SYNC_WITH_ROOT) {
    syncIdentWithRoot(Yarn, root, ident);
  }
  const rootNxDeps = Yarn.dependencies({ workspace: root }).filter((d) => d.ident.startsWith('@nx/'));
  for (const rootDep of rootNxDeps) {
    syncIdentWithRoot(Yarn, root, rootDep.ident);
  }
}

function moveToDevDependencies(Yarn, root) {
  for (const { ident, excludeRoot } of DEV_ONLY) {
    for (const prodDep of Yarn.dependencies({ ident, type: 'dependencies' })) {
      // "must also exist in devDependencies at the same range" — applies to all workspaces.
      prodDep.workspace.set(['devDependencies', ident], prodDep.range);
      // "must not exist in dependencies" — respect the excludeRoot guard.
      if (excludeRoot && prodDep.workspace.cwd === root.cwd) {
        continue;
      }
      prodDep.workspace.unset(['dependencies', ident]);
    }
  }
}

// Workspace libs and apps must declare a `version` field. Background:
// TypeScript's module resolution only sets `resolvedModule.packageId.name`
// when the resolved package.json has a non-null `version`. Tools that use
// packageId for package-boundary detection — notably api-extractor's
// `bundledPackages` matching, which the published client libs use to inline
// workspace types into the bundled `.d.ts` — silently skip workspace deps
// without a version. The value is metadata only: private libs are never
// published, and yarn workspace resolution uses `workspace:*` regardless.
function enforceWorkspaceVersions(Yarn, root) {
  for (const workspace of Yarn.workspaces()) {
    if (workspace.cwd === root.cwd) {
      continue;
    }
    if (workspace.manifest.version == null) {
      workspace.set('version', '0.0.0');
    }
  }
}

module.exports = {
  async constraints({ Yarn }) {
    const root = Yarn.workspace({ cwd: '.' });
    if (!root) {
      throw new Error('Root workspace not found');
    }
    enforcePins(Yarn);
    syncWithRoot(Yarn, root);
    moveToDevDependencies(Yarn, root);
    enforceWorkspaceVersions(Yarn, root);
  },
};
