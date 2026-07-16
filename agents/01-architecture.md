---
snippet: Yarn 4, Nx, TypeScript, Vitest, tsx, Fastify, Biome — the core toolchain.
---

# Architecture

## Key Technologies

- **Yarn 4**: Configured with `nodeLinker: pnpm`. Package management with workspaces
- **Nx**: Monorepo tooling with caching and dependency graph
- **TypeScript**: Strict typing with project references
- **Vitest**: Testing framework
- **tsx**: TypeScript execution for development servers
- **Fastify**: Service framework
- **knip**: Unused dependency, export, and file detection
- **Biome**: Linting and formatting (fast enough to run on entire monorepo)
