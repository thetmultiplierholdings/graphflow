// The workflow catalog — a THIN mirror of GET /catalog. The real catalog
// lives in the backend (workflows/*.ts published to the ledger's mirror
// tables); this module only defines the shapes and non-reactive helpers.
// Components that must re-render when the catalog loads should subscribe to
// useCatalogStore directly.

import { useCatalogStore } from "@/lib/stores/catalog-store"

export interface KindDef {
  kind: string
  display: string
  leaf: boolean // leaf = consumed by the workflow, produced by none of its nodes
}

export interface NodeInfo {
  nodeId: string
  displayName: string
  executor: "engine" | "human"
  outputKind: string
  codeHash: string
}

export interface WorkflowInfo {
  workflowId: string
  displayName: string
  taskQueue: string
  supersededBy: string | null // superseded files stop being offered for NEW workspaces
  kinds: KindDef[]
  nodes: NodeInfo[]
}

// Safe fallbacks throughout: before the catalog loads, an unknown workflow is
// undefined-tolerant and a kind displays as its raw name.

export function getWorkflow(workflowId: string): WorkflowInfo | undefined {
  return useCatalogStore.getState().workflows[workflowId]
}

export function kindDisplay(workflowId: string, kind: string): string {
  return getWorkflow(workflowId)?.kinds.find((k) => k.kind === kind)?.display ?? kind
}

export function leafKinds(workflowId: string): KindDef[] {
  return getWorkflow(workflowId)?.kinds.filter((k) => k.leaf) ?? []
}

export function nodeDisplayName(workflowId: string, nodeId: string): string {
  return getWorkflow(workflowId)?.nodes.find((n) => n.nodeId === nodeId)?.displayName ?? nodeId
}
