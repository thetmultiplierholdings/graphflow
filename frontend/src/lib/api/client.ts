// Typed fetch wrapper over the Graphflow API service. This is the ONE place
// where backend conventions (integer ids, snake_case) are converted into the
// app's conventions (string ids, camelCase schema types) — and back on the
// way out. Nothing past this module should ever see a snake_case key.

import { type Artifact, type ArtifactRef } from "@/lib/schemas/artifact"
import {
  EMPTY_STATS,
  type Engagement,
  type EngagementStats,
} from "@/lib/schemas/engagement"
import { type NodeRun } from "@/lib/schemas/node-run"
import { type Workspace } from "@/lib/schemas/workspace"
import { type HumanTask } from "@/lib/schemas/human-task"
import type { WorkflowInfo } from "@/lib/graphflow/catalog"

export const API_BASE = process.env.NEXT_PUBLIC_GRAPHFLOW_API ?? "http://localhost:8000"

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

// Errors arrive as { detail: string }.
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === "string") return body.detail
    if (body.detail !== undefined) return JSON.stringify(body.detail)
  } catch {
    // not JSON — fall through
  }
  return `Request failed (${res.status} ${res.statusText})`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new ApiError("Cannot reach the Graphflow API — is the backend running?", 0)
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

// ---------- wire types (backend shapes, snake_case, integer ids) ----------

interface RawArtifact {
  artifact_id: number
  engagement_id: number
  hash: string
  kind: string
  label: string
  media_type: string
  byte_size: number
  produced_by_node_run: number | null
  created_by: string
  created_at: string
  payload_available: boolean
}

interface RawStats {
  workspaces: number
  artifacts: number
  node_runs: number
  human_answers: number
}

interface RawEngagement {
  engagement_id: number
  label: string
  created_at: string
  stats?: RawStats
}

interface RawWorkspace {
  workflow_run_id: number
  engagement_id: number
  workflow_id: string
  label: string
  copied_from_workflow_run: number | null
  archived_at: string | null
  created_by: string
  created_at: string
  user_docs?: number
  engine_results?: number
}

interface RawNodeRun {
  node_run_id: number
  workflow_id: string
  node_id: string
  code_hash: string
  memo_key: string
  temporal_id: string
  input_artifact_ids: number[]
  output: RawArtifact
}

interface RawMember extends RawArtifact {
  source: "user" | "engine"
  added_by: string
  added_at: string
}

interface RawHumanTask {
  task_id: string
  engagement_id: number
  workflow_id: string
  node_id: string
  output_kind: string
  display_name: string
  instructions: string
  payload: Record<string, unknown>
  result_required_keys: string[]
  requested_by_workflow_run: number
  input_artifact_ids: number[]
  start_time: string
}

interface RawCatalogWorkflow {
  workflow_id: string
  display_name: string
  task_queue: string
  superseded_by: string | null
  kinds: { kind: string; display_name: string; leaf: boolean }[]
  nodes: {
    node_id: string
    display_name: string
    executor: "engine" | "human"
    output_kind: string
    code_hash: string
  }[]
}

// ---------- mappers (wire -> app schema) ----------

function mapArtifact(raw: RawArtifact): Artifact {
  return {
    id: String(raw.artifact_id),
    engagementId: String(raw.engagement_id),
    hash: raw.hash,
    kind: raw.kind,
    label: raw.label,
    mediaType: raw.media_type,
    byteSize: raw.byte_size,
    payloadAvailable: raw.payload_available,
    producedByNodeRunId:
      raw.produced_by_node_run === null ? null : String(raw.produced_by_node_run),
    createdBy: raw.created_by,
    createdAt: raw.created_at,
  }
}

function mapStats(raw: RawStats | undefined): EngagementStats {
  if (!raw) return { ...EMPTY_STATS }
  return {
    workspaces: raw.workspaces,
    artifacts: raw.artifacts,
    nodeRuns: raw.node_runs,
    humanAnswers: raw.human_answers,
  }
}

function mapEngagement(raw: RawEngagement): Engagement & { stats: EngagementStats } {
  return {
    id: String(raw.engagement_id),
    label: raw.label,
    createdAt: raw.created_at,
    stats: mapStats(raw.stats),
  }
}

export interface WorkspaceWithCounts extends Workspace {
  userDocs: number
  engineResults: number
}

function mapWorkspace(raw: RawWorkspace): WorkspaceWithCounts {
  return {
    id: String(raw.workflow_run_id),
    engagementId: String(raw.engagement_id),
    workflowId: raw.workflow_id,
    label: raw.label,
    copiedFromId:
      raw.copied_from_workflow_run === null ? null : String(raw.copied_from_workflow_run),
    archivedAt: raw.archived_at,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    userDocs: raw.user_docs ?? 0,
    engineResults: raw.engine_results ?? 0,
  }
}

export interface NodeRunWithOutput {
  nodeRun: NodeRun
  output: Artifact
}

// createdBy / createdAt come from the node run's OUTPUT artifact meta —
// the answered-by/when of a fact IS the answer artifact's provenance.
function mapNodeRun(raw: RawNodeRun): NodeRunWithOutput {
  const output = mapArtifact(raw.output)
  return {
    nodeRun: {
      id: String(raw.node_run_id),
      engagementId: output.engagementId,
      workflowId: raw.workflow_id,
      nodeId: raw.node_id,
      codeHash: raw.code_hash,
      memoKey: raw.memo_key,
      outputArtifactId: output.id,
      inputArtifactIds: raw.input_artifact_ids.map(String),
      temporalId: raw.temporal_id,
      createdBy: output.createdBy,
      createdAt: output.createdAt,
    },
    output,
  }
}

// Task payload artifact values travel as { __artifact__: ref }; the ref
// arrives snake_case and must cross the boundary like everything else.
function mapPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === "object" && "__artifact__" in value) {
      const raw = (value as { __artifact__: Record<string, unknown> }).__artifact__
      const ref: ArtifactRef = {
        artifactId: String(raw.artifact_id ?? raw.artifactId ?? ""),
        hash: String(raw.hash ?? ""),
        kind: String(raw.kind ?? ""),
        label: String(raw.label ?? ""),
        mediaType: String(raw.media_type ?? raw.mediaType ?? "text/plain"),
      }
      out[key] = { __artifact__: ref }
    } else {
      out[key] = value
    }
  }
  return out
}

function mapHumanTask(raw: RawHumanTask): HumanTask {
  return {
    id: raw.task_id,
    engagementId: String(raw.engagement_id),
    workflowId: raw.workflow_id,
    nodeId: raw.node_id,
    outputKind: raw.output_kind,
    displayName: raw.display_name,
    instructions: raw.instructions,
    payload: mapPayload(raw.payload ?? {}),
    resultRequiredKeys: raw.result_required_keys ?? [],
    requestedByWorkspaceIds: [String(raw.requested_by_workflow_run)],
    inputArtifactIds: (raw.input_artifact_ids ?? []).map(String),
    createdAt: raw.start_time,
  }
}

function mapCatalogWorkflow(raw: RawCatalogWorkflow): WorkflowInfo {
  return {
    workflowId: raw.workflow_id,
    displayName: raw.display_name,
    taskQueue: raw.task_queue,
    supersededBy: raw.superseded_by,
    kinds: raw.kinds.map((k) => ({ kind: k.kind, display: k.display_name, leaf: Boolean(k.leaf) })),
    nodes: raw.nodes.map((n) => ({
      nodeId: n.node_id,
      displayName: n.display_name,
      executor: n.executor,
      outputKind: n.output_kind,
      codeHash: n.code_hash,
    })),
  }
}

// ---------- catalog ----------

export async function fetchCatalog(): Promise<WorkflowInfo[]> {
  const body = await request<{ workflows: RawCatalogWorkflow[] }>("/catalog")
  return body.workflows.map(mapCatalogWorkflow)
}

// ---------- engagements ----------

export async function listEngagements(): Promise<(Engagement & { stats: EngagementStats })[]> {
  const body = await request<RawEngagement[]>("/engagements")
  return body.map(mapEngagement)
}

export async function createEngagement(label: string): Promise<Engagement & { stats: EngagementStats }> {
  return mapEngagement(await request<RawEngagement>("/engagements", jsonInit("POST", { label })))
}

export async function getEngagement(id: string): Promise<Engagement & { stats: EngagementStats }> {
  return mapEngagement(await request<RawEngagement>(`/engagements/${Number(id)}`))
}

// ---------- artifacts ----------

export async function browseArtifacts(
  engagementId: string,
  filters: { kind?: string; q?: string } = {}
): Promise<Artifact[]> {
  const params = new URLSearchParams()
  if (filters.kind) params.set("kind", filters.kind)
  if (filters.q) params.set("q", filters.q)
  const qs = params.size > 0 ? `?${params}` : ""
  const body = await request<RawArtifact[]>(`/engagements/${Number(engagementId)}/artifacts${qs}`)
  return body.map(mapArtifact)
}

export async function uploadArtifact(input: {
  engagementId: string
  kind: string
  payload: string
  label?: string
  workspaceId?: string
}): Promise<{ artifact: Artifact; revived: boolean }> {
  const form = new FormData()
  form.append(
    "file",
    new Blob([input.payload], { type: "text/plain" }),
    `${input.label ?? input.kind}.txt`
  )
  form.append("kind", input.kind)
  if (input.label) form.append("label", input.label)
  if (input.workspaceId) form.append("workflow_run_id", String(Number(input.workspaceId)))
  const body = await request<{ artifact: RawArtifact; revived: boolean }>(
    `/engagements/${Number(input.engagementId)}/artifacts`,
    { method: "POST", body: form }
  )
  return { artifact: mapArtifact(body.artifact), revived: body.revived }
}

export interface ArtifactLineage {
  artifact: Artifact
  producedBy: NodeRunWithOutput | null
  consumedBy: NodeRunWithOutput[]
}

export async function getArtifactLineage(id: string): Promise<ArtifactLineage> {
  const body = await request<{
    artifact: RawArtifact
    produced_by: RawNodeRun | null
    consumed_by: RawNodeRun[]
  }>(`/artifacts/${Number(id)}`)
  return {
    artifact: mapArtifact(body.artifact),
    producedBy: body.produced_by ? mapNodeRun(body.produced_by) : null,
    consumedBy: body.consumed_by.map(mapNodeRun),
  }
}

export function artifactContentUrl(id: string): string {
  return `${API_BASE}/artifacts/${Number(id)}/content`
}

export async function fetchArtifactContent(id: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(artifactContentUrl(id))
  } catch {
    throw new ApiError("Cannot reach the Graphflow API — is the backend running?", 0)
  }
  if (res.status === 410) {
    throw new ApiError(
      "Payload destroyed per policy — the ledger keeps the hash, kind and lineage.",
      410
    )
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status)
  return res.text()
}

export async function renameArtifact(id: string, label: string): Promise<void> {
  await request(`/artifacts/${Number(id)}`, jsonInit("PATCH", { label }))
}

// ---------- workspaces (workflow runs) ----------

export async function listWorkspaces(engagementId: string): Promise<WorkspaceWithCounts[]> {
  const body = await request<RawWorkspace[]>(`/engagements/${Number(engagementId)}/workflow-runs`)
  return body.map(mapWorkspace)
}

export async function createWorkspace(input: {
  engagementId: string
  workflowId: string
  label: string
  copyFrom?: string | null
}): Promise<WorkspaceWithCounts> {
  const payload: Record<string, unknown> = {
    workflow_id: input.workflowId,
    label: input.label,
  }
  if (input.copyFrom) payload.copy_from = Number(input.copyFrom)
  return mapWorkspace(
    await request<RawWorkspace>(
      `/engagements/${Number(input.engagementId)}/workflow-runs`,
      jsonInit("POST", payload)
    )
  )
}

export interface WorkspaceMemberRow extends Artifact {
  source: "user" | "engine"
  addedBy: string
  addedAt: string
}

export async function getWorkspace(
  id: string
): Promise<{ workspace: WorkspaceWithCounts; members: WorkspaceMemberRow[] }> {
  const body = await request<RawWorkspace & { members: RawMember[] }>(
    `/workflow-runs/${Number(id)}`
  )
  return {
    workspace: mapWorkspace(body),
    members: body.members.map((m) => ({
      ...mapArtifact(m),
      source: m.source,
      addedBy: m.added_by,
      addedAt: m.added_at,
    })),
  }
}

export async function patchWorkspace(
  id: string,
  changes: { label?: string; workflowId?: string }
): Promise<void> {
  const payload: Record<string, unknown> = {}
  if (changes.label !== undefined) payload.label = changes.label
  if (changes.workflowId !== undefined) payload.workflow_id = changes.workflowId
  await request(`/workflow-runs/${Number(id)}`, jsonInit("PATCH", payload))
}

export async function setWorkspaceArchived(id: string, archived: boolean): Promise<void> {
  await request(`/workflow-runs/${Number(id)}/archive`, jsonInit("POST", { archived }))
}

export async function attachArtifact(workspaceId: string, artifactId: string): Promise<void> {
  await request(
    `/workflow-runs/${Number(workspaceId)}/attachments`,
    jsonInit("POST", { artifact_id: Number(artifactId) })
  )
}

export async function detachArtifact(workspaceId: string, artifactId: string): Promise<void> {
  await request(`/workflow-runs/${Number(workspaceId)}/attachments/${Number(artifactId)}`, {
    method: "DELETE",
  })
}

// ---------- execution ----------

export type ExecuteResult =
  | { started: true; temporalWorkflowId: string }
  | { conflict: true; message: string }

// 202 = started (or attached to the open run — double-click safe).
// 409 = open run with a CHANGED snapshot; retry with supersede=true.
export async function executeWorkspace(id: string, supersede = false): Promise<ExecuteResult> {
  const qs = supersede ? "?supersede=true" : ""
  let res: Response
  try {
    res = await fetch(`${API_BASE}/workflow-runs/${Number(id)}/execute${qs}`, { method: "POST" })
  } catch {
    throw new ApiError("Cannot reach the Graphflow API — is the backend running?", 0)
  }
  if (res.status === 409) return { conflict: true, message: await errorMessage(res) }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status)
  const body = (await res.json()) as { temporal_workflow_id: string }
  return { started: true, temporalWorkflowId: body.temporal_workflow_id }
}

export interface WorkspaceStatus {
  status: "idle" | "running" | "completed" | "failed"
  error: string | null
}

export async function getWorkspaceStatus(id: string): Promise<WorkspaceStatus> {
  return request<WorkspaceStatus>(`/workflow-runs/${Number(id)}/status`)
}

export function progressUrl(id: string): string {
  return `${API_BASE}/workflow-runs/${Number(id)}/progress`
}

// ---------- node runs (the ledger) ----------

export async function listNodeRuns(engagementId: string): Promise<NodeRunWithOutput[]> {
  const body = await request<RawNodeRun[]>(`/engagements/${Number(engagementId)}/node-runs`)
  return body.map(mapNodeRun)
}

// ---------- human tasks ----------

export async function listHumanTasks(engagementId?: string): Promise<HumanTask[]> {
  const qs = engagementId ? `?engagement_id=${Number(engagementId)}` : ""
  const body = await request<RawHumanTask[]>(`/human-tasks${qs}`)
  return body.map(mapHumanTask)
}

// 422 (validator rejected — task keeps waiting) and 404 (already completed)
// surface as ApiError; callers map them to friendly results.
export async function submitHumanTask(
  taskId: string,
  reviewer: string,
  result: Record<string, unknown>
): Promise<Artifact> {
  const body = await request<{ artifact: RawArtifact }>(
    `/human-tasks/${encodeURIComponent(taskId)}/submit`,
    jsonInit("POST", { reviewer, result })
  )
  return mapArtifact(body.artifact)
}
