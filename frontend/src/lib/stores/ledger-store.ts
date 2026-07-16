import { create } from "zustand"
import * as api from "@/lib/api/client"
import { type Artifact } from "@/lib/schemas/artifact"
import {
  EMPTY_STATS,
  type Engagement,
  type EngagementStats,
} from "@/lib/schemas/engagement"
import { type NodeRun } from "@/lib/schemas/node-run"
import {
  membershipKey,
  type Workspace,
  type WorkspaceArtifact,
} from "@/lib/schemas/workspace"

// The database mirror — a client-side cache of what the API says the ledger
// and workspaces look like. NOTHING is computed here any more: every mutation
// calls the API, then refreshes the affected scope so the mirror converges on
// server truth. No persistence — the server is the source of truth.

export interface WorkspaceRunStatusEntry {
  status: "idle" | "running" | "completed" | "failed"
  error: string | null
}

interface MirrorState {
  engagements: Record<string, Engagement>
  engagementStats: Record<string, EngagementStats>
  artifacts: Record<string, Artifact>
  nodeRuns: Record<string, NodeRun>
  workspaces: Record<string, Workspace>
  // keyed by `${workspaceId}:${artifactId}`
  workspaceArtifacts: Record<string, WorkspaceArtifact>
  // user/engine member counts per workspace (from the workspaces listing)
  workspaceCounts: Record<string, { user: number; engine: number }>
  // derived run status per workspace, from GET /status and the progress stream
  workspaceStatuses: Record<string, WorkspaceRunStatusEntry>
}

interface LedgerStore extends MirrorState {
  // ---- refreshers (server -> mirror) ----
  refreshEngagements: () => Promise<void>
  refreshEngagement: (id: string) => Promise<void>
  refreshEngagementPool: (engagementId: string) => Promise<void>
  refreshWorkspace: (id: string) => Promise<void>
  setWorkspaceStatus: (id: string, status: WorkspaceRunStatusEntry) => void

  // ---- mutations (API call, then refresh the affected scope) ----
  createEngagement: (input: { label: string }) => Promise<string>
  createWorkspace: (input: {
    engagementId: string
    workflowId: string
    label: string
    copiedFrom?: string | null
  }) => Promise<string>
  uploadArtifact: (input: {
    engagementId: string
    kind: string
    payload: string
    label?: string
    workspaceId?: string
  }) => Promise<{ artifactId: string; revived: boolean }>
  attachUser: (workspaceId: string, artifactId: string) => Promise<void>
  detachArtifact: (workspaceId: string, artifactId: string) => Promise<void>
  renameArtifact: (artifactId: string, label: string) => Promise<void>
  renameWorkspace: (workspaceId: string, label: string) => Promise<void>
  setWorkspaceArchived: (workspaceId: string, archived: boolean) => Promise<void>
  repointWorkflow: (workspaceId: string, workflowId: string) => Promise<void>

  // Lineage on demand: merges the artifact, its producer and consumers (and
  // their output artifacts) into the mirror so the preview sheet can keep
  // rendering purely from store data.
  fetchArtifactLineage: (artifactId: string) => Promise<api.ArtifactLineage>
}

function mergeWorkspaceListing(
  state: MirrorState,
  workspaces: api.WorkspaceWithCounts[]
): Partial<MirrorState> {
  const nextWorkspaces = { ...state.workspaces }
  const nextCounts = { ...state.workspaceCounts }
  for (const w of workspaces) {
    const { userDocs, engineResults, ...workspace } = w
    nextWorkspaces[workspace.id] = workspace
    nextCounts[workspace.id] = { user: userDocs, engine: engineResults }
  }
  return { workspaces: nextWorkspaces, workspaceCounts: nextCounts }
}

function mergeNodeRuns(
  state: MirrorState,
  runs: api.NodeRunWithOutput[]
): Partial<MirrorState> {
  const nextRuns = { ...state.nodeRuns }
  const nextArtifacts = { ...state.artifacts }
  for (const { nodeRun, output } of runs) {
    nextRuns[nodeRun.id] = nodeRun
    nextArtifacts[output.id] = output
  }
  return { nodeRuns: nextRuns, artifacts: nextArtifacts }
}

export const useLedgerStore = create<LedgerStore>()((set, get) => ({
  engagements: {},
  engagementStats: {},
  artifacts: {},
  nodeRuns: {},
  workspaces: {},
  workspaceArtifacts: {},
  workspaceCounts: {},
  workspaceStatuses: {},

  // ---------- refreshers ----------

  refreshEngagements: async () => {
    const list = await api.listEngagements()
    set((state) => {
      const engagements: Record<string, Engagement> = {}
      const engagementStats = { ...state.engagementStats }
      for (const { stats, ...engagement } of list) {
        engagements[engagement.id] = engagement
        engagementStats[engagement.id] = stats
      }
      return { engagements, engagementStats }
    })
  },

  refreshEngagement: async (id) => {
    const [{ stats, ...engagement }, workspaces, pool, nodeRuns] = await Promise.all([
      api.getEngagement(id),
      api.listWorkspaces(id),
      api.browseArtifacts(id),
      api.listNodeRuns(id),
    ])
    // Status per workspace comes from a separate endpoint (derived from
    // Temporal describe, never stored) — tolerate individual failures.
    const statuses = await Promise.all(
      workspaces.map((w) => api.getWorkspaceStatus(w.id).catch(() => null))
    )
    set((state) => {
      const artifacts = { ...state.artifacts }
      for (const a of pool) artifacts[a.id] = a
      const merged = mergeNodeRuns({ ...state, artifacts }, nodeRuns)
      const workspaceStatuses = { ...state.workspaceStatuses }
      workspaces.forEach((w, i) => {
        const s = statuses[i]
        if (s) workspaceStatuses[w.id] = s
      })
      return {
        engagements: { ...state.engagements, [engagement.id]: engagement },
        engagementStats: { ...state.engagementStats, [engagement.id]: stats },
        ...mergeWorkspaceListing(state, workspaces),
        ...merged,
        workspaceStatuses,
      }
    })
  },

  // The engagement's full artifact pool (unfiltered — callers apply their
  // own kind filters client-side), merged into the artifacts mirror.
  refreshEngagementPool: async (engagementId) => {
    const pool = await api.browseArtifacts(engagementId)
    set((state) => {
      const artifacts = { ...state.artifacts }
      for (const a of pool) artifacts[a.id] = a
      return { artifacts }
    })
  },

  refreshWorkspace: async (id) => {
    const [{ workspace, members }, status] = await Promise.all([
      api.getWorkspace(id),
      api.getWorkspaceStatus(id).catch(() => null),
    ])
    set((state) => {
      const { userDocs, engineResults, ...ws } = workspace
      const artifacts = { ...state.artifacts }
      // Replace this workspace's membership rows wholesale (detaches must
      // disappear), leaving other workspaces' rows untouched.
      const workspaceArtifacts: Record<string, WorkspaceArtifact> = {}
      for (const [key, row] of Object.entries(state.workspaceArtifacts)) {
        if (row.workspaceId !== id) workspaceArtifacts[key] = row
      }
      let user = 0
      let engine = 0
      for (const m of members) {
        const { source, addedBy, addedAt, ...artifact } = m
        artifacts[artifact.id] = artifact
        workspaceArtifacts[membershipKey(id, artifact.id)] = {
          workspaceId: id,
          artifactId: artifact.id,
          source,
          addedBy,
          addedAt,
        }
        if (source === "user") user += 1
        else engine += 1
      }
      return {
        workspaces: { ...state.workspaces, [id]: ws },
        artifacts,
        workspaceArtifacts,
        workspaceCounts: {
          ...state.workspaceCounts,
          [id]: { user: user || userDocs, engine: engine || engineResults },
        },
        workspaceStatuses: status
          ? { ...state.workspaceStatuses, [id]: status }
          : state.workspaceStatuses,
      }
    })
  },

  setWorkspaceStatus: (id, status) =>
    set((state) => ({
      workspaceStatuses: { ...state.workspaceStatuses, [id]: status },
    })),

  // ---------- mutations ----------

  createEngagement: async ({ label }) => {
    const created = await api.createEngagement(label)
    await get().refreshEngagements()
    return created.id
  },

  createWorkspace: async ({ engagementId, workflowId, label, copiedFrom }) => {
    const created = await api.createWorkspace({
      engagementId,
      workflowId,
      label,
      copyFrom: copiedFrom ?? null,
    })
    await get().refreshEngagement(engagementId)
    return created.id
  },

  uploadArtifact: async ({ engagementId, kind, payload, label, workspaceId }) => {
    const { artifact, revived } = await api.uploadArtifact({
      engagementId,
      kind,
      payload,
      label,
      workspaceId,
    })
    set((state) => ({ artifacts: { ...state.artifacts, [artifact.id]: artifact } }))
    if (workspaceId) await get().refreshWorkspace(workspaceId)
    return { artifactId: artifact.id, revived }
  },

  attachUser: async (workspaceId, artifactId) => {
    await api.attachArtifact(workspaceId, artifactId)
    await get().refreshWorkspace(workspaceId)
  },

  detachArtifact: async (workspaceId, artifactId) => {
    await api.detachArtifact(workspaceId, artifactId)
    await get().refreshWorkspace(workspaceId)
  },

  renameArtifact: async (artifactId, label) => {
    await api.renameArtifact(artifactId, label)
    set((state) => {
      const artifact = state.artifacts[artifactId]
      if (!artifact) return state
      return { artifacts: { ...state.artifacts, [artifactId]: { ...artifact, label } } }
    })
  },

  renameWorkspace: async (workspaceId, label) => {
    await api.patchWorkspace(workspaceId, { label })
    await get().refreshWorkspace(workspaceId)
  },

  setWorkspaceArchived: async (workspaceId, archived) => {
    await api.setWorkspaceArchived(workspaceId, archived)
    await get().refreshWorkspace(workspaceId)
  },

  repointWorkflow: async (workspaceId, workflowId) => {
    await api.patchWorkspace(workspaceId, { workflowId })
    await get().refreshWorkspace(workspaceId)
  },

  fetchArtifactLineage: async (artifactId) => {
    const lineage = await api.getArtifactLineage(artifactId)
    set((state) => {
      const artifacts = { ...state.artifacts, [lineage.artifact.id]: lineage.artifact }
      const related = [
        ...(lineage.producedBy ? [lineage.producedBy] : []),
        ...lineage.consumedBy,
      ]
      const merged = mergeNodeRuns({ ...state, artifacts }, related)
      return { artifacts: merged.artifacts, nodeRuns: merged.nodeRuns }
    })
    return lineage
  },
}))

// ---------- read-model selectors (pure, over the mirror) ----------

export interface WorkspaceMember extends Artifact {
  source: "user" | "engine"
  addedBy: string
  addedAt: string
  produced: boolean
}

function workspaceMembers(state: MirrorState, workspaceId: string): WorkspaceMember[] {
  return Object.values(state.workspaceArtifacts)
    .filter((wa) => wa.workspaceId === workspaceId)
    .map((wa) => {
      const a = state.artifacts[wa.artifactId]
      return a
        ? {
            ...a,
            source: wa.source,
            addedBy: wa.addedBy,
            addedAt: wa.addedAt,
            produced: a.producedByNodeRunId !== null,
          }
        : null
    })
    .filter((m): m is WorkspaceMember => m !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

function engagementStats(state: MirrorState, engagementId: string): EngagementStats {
  return state.engagementStats[engagementId] ?? { ...EMPTY_STATS }
}

export const ledgerSelectors = {
  workspaceMembers,
  engagementStats,
}
