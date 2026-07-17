// Scratch-state cleanup for the e2e stack (graphflow_e2e.sqlite3 +
// mock_s3_gcs_e2e + this instance's open Temporal workflows).
//
// Called from TWO places:
//  - playwright.config.ts top level (main runner process only) — Playwright
//    starts webServer plugins BEFORE globalSetup, so pre-run cleanup must
//    happen at config-load time, before the API boots and creates the db.
//  - the spec's afterAll — teardown after the story.

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

// The TypeScript backend lives in <repo>/backend_typescript — the API's cwd,
// so it creates the scratch db + payload store there, and .env resolves there.
const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "backend_typescript")
// The cleanup script ships with the backend (it imports the backend's modules).
const CLEANUP_SCRIPT = path.join(BACKEND_ROOT, "scripts", "cleanup-temporal.ts")
const E2E_DB = "graphflow_e2e.sqlite3"
const E2E_STORAGE = "mock_s3_gcs_e2e"
// The e2e stack's DEDICATED Temporal task queue (imported by
// playwright.config.ts for the API webServer env).
export const E2E_TASK_QUEUE = "thet-temporal-e2e-ignore"

// Terminate every open Temporal workflow carrying the scratch db's instance
// prefix (the namespace is shared — ids are 'wfrun-{instance}-' /
// 'node-{instance}-'). Needs the db, so it must run BEFORE deletion.
export function terminateScratchTemporalWorkflows(): void {
  const dbPath = path.join(BACKEND_ROOT, E2E_DB)
  if (!fs.existsSync(dbPath)) return
  try {
    const out = execFileSync(
      "npx",
      ["tsx", CLEANUP_SCRIPT, E2E_DB],
      {
        cwd: BACKEND_ROOT,
        timeout: 120_000,
        encoding: "utf8",
        // The e2e workflows live on the DEDICATED e2e task queue.
        env: { ...process.env, TEMPORAL_TASK_QUEUE: E2E_TASK_QUEUE },
      }
    )
    if (out.trim()) console.log(out.trim())
  } catch (err) {
    console.warn(`[e2e] Temporal cleanup failed (continuing): ${err}`)
  }
}

export function deleteScratchState(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path.join(BACKEND_ROOT, `${E2E_DB}${suffix}`)
    try {
      fs.rmSync(p, { force: true })
    } catch (err) {
      console.warn(`[e2e] could not delete ${p}: ${err}`)
    }
  }
  try {
    fs.rmSync(path.join(BACKEND_ROOT, E2E_STORAGE), { recursive: true, force: true })
  } catch (err) {
    console.warn(`[e2e] could not delete ${E2E_STORAGE}: ${err}`)
  }
}

export function scratchDbExists(): boolean {
  return fs.existsSync(path.join(BACKEND_ROOT, E2E_DB))
}
