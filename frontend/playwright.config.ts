// Playwright e2e against the REAL stack: Fastify (TypeScript) + SQLite +
// Temporal Cloud behind a test-dedicated API on :8100, and a test-dedicated
// Next dev server on :3100. The live dev stack (:3000 / :8000 /
// graphflow.sqlite3) is never touched — the e2e run gets its own scratch db
// (graphflow_e2e.sqlite3) and payload store (mock_s3_gcs_e2e); leftovers are
// cleared below before the servers boot, and the spec's afterAll deletes
// them again at the end.

import path from "path"
import { defineConfig, devices } from "@playwright/test"
import {
  deleteScratchState,
  E2E_TASK_QUEUE,
  terminateScratchTemporalWorkflows,
} from "./e2e/scratch-cleanup"

// The TypeScript backend lives in ../backend_typescript (sibling of this
// frontend). tsx, the Fastify app, and .env all resolve from there.
const BACKEND_ROOT = path.resolve(__dirname, "..", "backend_typescript")

// Pre-run cleanup MUST happen here, not in globalSetup: Playwright starts
// the webServer plugins BEFORE globalSetup, and the API creates the scratch
// db at boot — deleting it afterwards would pull the schema out from under
// live connections. The config is also re-evaluated inside worker processes
// (TEST_WORKER_INDEX set), where cleanup must NOT run again mid-suite.
if (!process.env.TEST_WORKER_INDEX) {
  terminateScratchTemporalWorkflows()
  deleteScratchState()
}

export const E2E_DB = "graphflow_e2e.sqlite3"
export const E2E_STORAGE = "mock_s3_gcs_e2e"
export const API_PORT = 8100
export const WEB_PORT = 3100
// E2E_TASK_QUEUE (from scratch-cleanup): the e2e stack gets a DEDICATED
// Temporal task queue. The namespace is shared and the live dev stack's
// embedded worker polls the default queue — on a shared queue it would race
// the e2e worker for activities and run them against the WRONG SQLite db
// (engagement ids collide across dbs). load_dotenv never overrides existing
// env vars, so the value set below wins over .env.

export default defineConfig({
  testDir: "./e2e",
  // One story, one browser, one worker — the steps traverse real Temporal
  // Cloud and share one scratch database, so parallelism is meaningless.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  // Real Temporal round-trips: nodes complete in seconds, whole runs in
  // minutes. Generous, auto-retrying expects instead of manual sleeps.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Test-dedicated API over a scratch db + storage. The embedded
      // Temporal worker connects with the .env credentials loaded by the
      // backend's Env loader; GRAPHFLOW_CORS_ORIGINS admits the :3100 frontend.
      command: "npx tsx src/index.ts",
      cwd: BACKEND_ROOT,
      url: `http://localhost:${API_PORT}/catalog`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        PORT: String(API_PORT),
        GRAPHFLOW_DB: E2E_DB,
        GRAPHFLOW_STORAGE: E2E_STORAGE,
        GRAPHFLOW_EMBED_WORKER: "1",
        GRAPHFLOW_CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        TEMPORAL_TASK_QUEUE: E2E_TASK_QUEUE,
      },
    },
    {
      command: `npm run dev -- --port ${WEB_PORT}`,
      cwd: __dirname,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_GRAPHFLOW_API: `http://localhost:${API_PORT}`,
        // Own dist dir: Next allows only one dev server per dist dir, and
        // the live dev stack on :3000 already holds .next.
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
})
