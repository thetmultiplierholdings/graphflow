// The engine-facing operations pages call — the replacement for the old
// client-side engine simulation. Execution now happens in the real backend
// (FastAPI -> Temporal); this module starts runs, mirrors their progress
// stream into the run store, and submits reviewer answers.

import * as api from "@/lib/api/client"
import { getWorkflow, nodeDisplayName } from "@/lib/graphflow/catalog"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { useHumanTaskStore } from "@/lib/stores/human-task-store"
import { useRunStore, type NodeTally, type RunSummary } from "@/lib/stores/run-store"
import { type ArtifactRef } from "@/lib/schemas/artifact"
import { type HumanTask } from "@/lib/schemas/human-task"

interface ProgressSnapshot {
  executed: string[]
  memoHits: string[]
  humanWaits: string[]
}

interface StreamEntry {
  source: EventSource
  prev: ProgressSnapshot
  lastRefresh: number
}

// One open EventSource per workspace, ever (idempotent attach).
const streams = new Map<string, StreamEntry>()

const emptySnapshot = (): ProgressSnapshot => ({ executed: [], memoHits: [], humanWaits: [] })

function nodeIdsFor(workspaceId: string): string[] {
  const ws = useLedgerStore.getState().workspaces[workspaceId]
  const wf = ws ? getWorkflow(ws.workflowId) : undefined
  return wf ? wf.nodes.map((n) => n.nodeId) : []
}

function displayNameFor(workspaceId: string, nodeId: string): string {
  const ws = useLedgerStore.getState().workspaces[workspaceId]
  return ws ? nodeDisplayName(ws.workflowId, nodeId) : nodeId
}

// Multiset delta over cumulative arrays: which entries are new in `next`?
function newEntries(prev: string[], next: string[]): string[] {
  const seen = new Map<string, number>()
  for (const id of prev) seen.set(id, (seen.get(id) ?? 0) + 1)
  const fresh: string[] = []
  for (const id of next) {
    const n = seen.get(id) ?? 0
    if (n > 0) seen.set(id, n - 1)
    else fresh.push(id)
  }
  return fresh
}

const countOf = (arr: string[], id: string) => arr.filter((x) => x === id).length

// ---------- executing a workspace ----------

export type ExecuteOutcome =
  | { ok: true }
  | { conflict: true; message: string }
  | { ok: false; error: string }

export async function executeWorkspace(
  workspaceId: string,
  opts: { supersede?: boolean } = {}
): Promise<ExecuteOutcome> {
  try {
    const result = await api.executeWorkspace(workspaceId, opts.supersede ?? false)
    if ("conflict" in result) return { conflict: true, message: result.message }
    beginRun(workspaceId, opts.supersede ?? false)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function beginRun(workspaceId: string, superseded: boolean) {
  // Double-clicking Run attaches to the open execution (USE_EXISTING) — do
  // not wipe the feed if we are already streaming it. A supersede restart is
  // a NEW execution: drop the old stream and start over.
  if (superseded) closeStream(workspaceId)
  if (streams.has(workspaceId) && useRunStore.getState().runs[workspaceId]?.status === "running") {
    return
  }
  const ws = useLedgerStore.getState().workspaces[workspaceId]
  const wf = ws ? getWorkflow(ws.workflowId) : undefined
  const runs = useRunStore.getState()
  runs.startRun(workspaceId, nodeIdsFor(workspaceId))
  runs.addEvent(workspaceId, {
    type: "run-started",
    message: `Run started on ${wf?.displayName ?? ws?.workflowId ?? "the workflow"}.`,
  })
  useLedgerStore.getState().setWorkspaceStatus(workspaceId, { status: "running", error: null })
  attachProgressStream(workspaceId)
}

// ---------- the progress stream ----------

function closeStream(workspaceId: string) {
  const entry = streams.get(workspaceId)
  if (entry) {
    entry.source.close()
    streams.delete(workspaceId)
  }
}

function onTerminal(workspaceId: string) {
  closeStream(workspaceId)
  void useLedgerStore.getState().refreshWorkspace(workspaceId).catch(() => {})
  void useHumanTaskStore.getState().refreshTasks().catch(() => {})
}

// Idempotent: at most one EventSource per workspace. Each progress event is
// a cumulative snapshot from the run's Temporal query; the event feed is
// synthesised from snapshot deltas.
export function attachProgressStream(workspaceId: string): void {
  if (typeof window === "undefined") return
  if (streams.has(workspaceId)) return

  const source = new EventSource(api.progressUrl(workspaceId))
  // Seed the diff from the run store's persisted snapshot: a re-attached
  // stream (after a transport drop) must diff against what the feed already
  // shows, not replay the whole cumulative history as duplicates.
  const persisted = useRunStore.getState().runs[workspaceId]?.lastSnapshot
  const entry: StreamEntry = {
    source,
    prev: persisted
      ? {
          executed: [...persisted.executed],
          memoHits: [...persisted.memoHits],
          humanWaits: [...persisted.humanWaits],
        }
      : emptySnapshot(),
    lastRefresh: Date.now(),
  }
  streams.set(workspaceId, entry)

  source.addEventListener("progress", (ev) => {
    let data: {
      status?: string
      executed?: string[]
      memo_hits?: string[]
      human_waits?: string[]
      error?: string | null
    }
    try {
      data = JSON.parse((ev as MessageEvent).data)
    } catch {
      return
    }
    const executed = data.executed ?? []
    const memoHits = data.memo_hits ?? []
    const humanWaits = data.human_waits ?? []
    const runs = useRunStore.getState()

    // Event feed: one entry per newly-seen outcome.
    for (const nodeId of newEntries(entry.prev.memoHits, memoHits)) {
      runs.addEvent(workspaceId, {
        type: "memo-hit",
        nodeId,
        message: `${displayNameFor(workspaceId, nodeId)} — memo hit`,
      })
    }
    for (const nodeId of newEntries(entry.prev.executed, executed)) {
      runs.addEvent(workspaceId, {
        type: "node-completed",
        nodeId,
        message: `${displayNameFor(workspaceId, nodeId)} — executed`,
      })
    }
    for (const nodeId of newEntries(entry.prev.humanWaits, humanWaits)) {
      runs.addEvent(workspaceId, {
        type: "human-task-opened",
        nodeId,
        message: `${displayNameFor(workspaceId, nodeId)} — waiting on a reviewer`,
      })
    }
    entry.prev = { executed: [...executed], memoHits: [...memoHits], humanWaits: [...humanWaits] }
    runs.setLastSnapshot(workspaceId, {
      executed: [...executed],
      memoHits: [...memoHits],
      humanWaits: [...humanWaits],
    })

    // Tallies: occurrence counts over the cumulative arrays. A human wait
    // that has since executed is answered — never negative.
    const nodeIds = new Set([...nodeIdsFor(workspaceId), ...executed, ...memoHits, ...humanWaits])
    const tallies: Record<string, NodeTally> = {}
    for (const nodeId of nodeIds) {
      const executedCount = countOf(executed, nodeId)
      tallies[nodeId] = {
        executed: executedCount,
        memoHits: countOf(memoHits, nodeId),
        waitingHuman: Math.max(0, countOf(humanWaits, nodeId) - executedCount),
      }
    }
    const summary: RunSummary = {
      executed: [...executed],
      memoHits: [...memoHits],
      humanWaits: [...humanWaits],
    }
    runs.syncProgress(workspaceId, tallies, summary)

    // Results pop in live: refresh workspace members at most every ~2s.
    const now = Date.now()
    if (now - entry.lastRefresh >= 2000) {
      entry.lastRefresh = now
      void useLedgerStore.getState().refreshWorkspace(workspaceId).catch(() => {})
    }
  })

  source.addEventListener("finished", () => {
    const runs = useRunStore.getState()
    const summary = runs.runs[workspaceId]?.summary
    runs.addEvent(workspaceId, {
      type: "run-completed",
      message: summary
        ? `Run finished: ${summary.executed.length} executed, ${summary.memoHits.length} memo hits, ${summary.humanWaits.length} human question${summary.humanWaits.length === 1 ? "" : "s"} asked.`
        : "Run finished.",
    })
    runs.finishRun(workspaceId)
    useLedgerStore.getState().setWorkspaceStatus(workspaceId, { status: "completed", error: null })
    onTerminal(workspaceId)
  })

  source.addEventListener("failed", (ev) => {
    let error = "Run failed."
    try {
      const d = JSON.parse((ev as MessageEvent).data) as { error?: unknown }
      if (d && typeof d.error === "string" && d.error) error = d.error
    } catch {
      // no structured error payload
    }
    const runs = useRunStore.getState()
    runs.addEvent(workspaceId, { type: "run-failed", message: `Run failed: ${error}` })
    runs.failRun(workspaceId, error)
    useLedgerStore.getState().setWorkspaceStatus(workspaceId, { status: "failed", error })
    onTerminal(workspaceId)
  })

  source.onerror = () => {
    // A terminal event already tore the entry down; anything else is a
    // transport drop — close and let the status poll / resume re-attach.
    if (streams.get(workspaceId)?.source === source) closeStream(workspaceId)
  }
}

// Runs survive reloads now: on workspace mount, check the derived status and
// re-attach the progress stream if an execution is open.
export async function resumeRunIfActive(workspaceId: string): Promise<void> {
  let status: api.WorkspaceStatus
  try {
    status = await api.getWorkspaceStatus(workspaceId)
  } catch {
    return // API unreachable — the page's poll will retry
  }
  useLedgerStore.getState().setWorkspaceStatus(workspaceId, status)
  if (status.status !== "running") return
  const runs = useRunStore.getState()
  if (runs.runs[workspaceId]?.status !== "running") {
    runs.startRun(workspaceId, nodeIdsFor(workspaceId))
    runs.addEvent(workspaceId, {
      type: "run-started",
      message: "Re-attached to a run already in flight.",
    })
  }
  attachProgressStream(workspaceId)
}

// ---------- reviewer submission (the Temporal workflow update) ----------

export type SubmitResult = { ok: true; artifactId: string } | { ok: false; error: string }

export async function submitHumanTask(
  taskId: string,
  result: Record<string, unknown>,
  reviewer: string
): Promise<SubmitResult> {
  try {
    const artifact = await api.submitHumanTask(taskId, reviewer, result)
    void useHumanTaskStore.getState().refreshTasks().catch(() => {})
    return { ok: true, artifactId: artifact.id }
  } catch (err) {
    // 422 = validator rejected (task keeps waiting); 404 = already answered.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// The mock HITL from the CLI demo: fetch the OCR extraction referenced by
// the task payload and approve it unchanged.
export async function buildAutoApprovalAsync(
  task: HumanTask
): Promise<Record<string, unknown> | null> {
  const ocr = task.payload.ocr as { __artifact__?: ArtifactRef } | undefined
  const ref = ocr?.__artifact__
  if (!ref?.artifactId) return null
  try {
    const text = await api.fetchArtifactContent(ref.artifactId)
    const extraction = JSON.parse(text) as { transactions?: unknown }
    if (!Array.isArray(extraction.transactions)) return null
    return { approved: true, transactions: extraction.transactions }
  } catch {
    return null
  }
}
