import { pathToFileURL } from 'node:url';
import { bootstrap } from './api/Bootstrap.js';

// Package barrel: public API surface for the monorepo move.
export { buildApp } from './api/App.js';
export { bootstrap } from './api/Bootstrap.js';
export type { ApiDeps, TemporalGateway } from './api/Deps.js';
export type { ArtifactRef } from './domain/artifact/ArtifactRef.js';
export type { JsonValue } from './domain/json/JsonValue.js';
export type { Registry, WorkflowDef } from './domain/registry/Registry.js';
export type { Env } from './infrastructure/env/Env.js';

// Entry point (`npm run dev` / `npm start`): boot the API (+ optional embedded worker) only when
// executed directly, never when imported as a library.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await bootstrap();
}
