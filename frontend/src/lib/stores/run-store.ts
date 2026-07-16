import { create } from "zustand"

// In-flight run state — deliberately NOT persisted. In graphflow, nothing
// pending is ever stored in the database; everything with a pulse lives in
// Temporal. This store mirrors the run's progress query (streamed over SSE
// by the API) for the watch-it-run panel. Reloading mid-run loses nothing:
// the workspace page re-attaches to the stream on mount if a run is open.

export type RunEventType =
  | "run-started"
  | "memo-hit"
  | "node-completed"
  | "human-task-opened"
  | "run-completed"
  | "run-failed"

export interface RunEvent {
  id: number
  at: string
  type: RunEventType
  nodeId?: string
  message: string
}

export interface NodeTally {
  executed: number
  memoHits: number
  waitingHuman: number
}

export interface RunSummary {
  executed: string[]
  memoHits: string[]
  humanWaits: string[]
}

export interface RunState {
  workspaceId: string
  status: "running" | "completed" | "failed"
  startedAt: string
  finishedAt: string | null
  error: string | null
  events: RunEvent[]
  tallies: Record<string, NodeTally>
  summary: RunSummary
  // The last cumulative progress snapshot seen from the SSE stream. A
  // re-attached stream (after a transport drop) seeds its diff from this,
  // so the event feed is not replayed as duplicates.
  lastSnapshot: RunSummary
}

const emptyTally = (): NodeTally => ({ executed: 0, memoHits: 0, waitingHuman: 0 })

interface RunStore {
  runs: Record<string, RunState>
  startRun: (workspaceId: string, nodeIds: string[]) => void
  addEvent: (workspaceId: string, event: Omit<RunEvent, "id" | "at">) => void
  // Set tallies + summary wholesale from a cumulative progress snapshot
  // (the SSE stream is stateful; the store is not). No-op if no run exists.
  syncProgress: (
    workspaceId: string,
    tallies: Record<string, NodeTally>,
    summary: RunSummary
  ) => void
  setLastSnapshot: (workspaceId: string, snapshot: RunSummary) => void
  finishRun: (workspaceId: string) => void
  failRun: (workspaceId: string, error: string) => void
}

export const useRunStore = create<RunStore>()((set) => ({
  runs: {},

  startRun: (workspaceId, nodeIds) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [workspaceId]: {
          workspaceId,
          status: "running",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
          events: [],
          tallies: Object.fromEntries(nodeIds.map((id) => [id, emptyTally()])),
          summary: { executed: [], memoHits: [], humanWaits: [] },
          lastSnapshot: { executed: [], memoHits: [], humanWaits: [] },
        },
      },
    })),

  addEvent: (workspaceId, event) =>
    set((state) => {
      const run = state.runs[workspaceId]
      if (!run) return state
      const next: RunEvent = { ...event, id: run.events.length + 1, at: new Date().toISOString() }
      return { runs: { ...state.runs, [workspaceId]: { ...run, events: [...run.events, next] } } }
    }),

  syncProgress: (workspaceId, tallies, summary) =>
    set((state) => {
      const run = state.runs[workspaceId]
      if (!run) return state
      return {
        runs: {
          ...state.runs,
          [workspaceId]: { ...run, tallies: { ...run.tallies, ...tallies }, summary },
        },
      }
    }),

  setLastSnapshot: (workspaceId, snapshot) =>
    set((state) => {
      const run = state.runs[workspaceId]
      if (!run) return state
      return { runs: { ...state.runs, [workspaceId]: { ...run, lastSnapshot: snapshot } } }
    }),

  finishRun: (workspaceId) =>
    set((state) => {
      const run = state.runs[workspaceId]
      if (!run) return state
      return {
        runs: {
          ...state.runs,
          [workspaceId]: { ...run, status: "completed", finishedAt: new Date().toISOString() },
        },
      }
    }),

  failRun: (workspaceId, error) =>
    set((state) => {
      const run = state.runs[workspaceId]
      if (!run) return state
      return {
        runs: {
          ...state.runs,
          [workspaceId]: { ...run, status: "failed", error, finishedAt: new Date().toISOString() },
        },
      }
    }),
}))
