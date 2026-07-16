"use client"

import { useEffect, useState } from "react"
import { CpuIcon, LoaderIcon, UserIcon } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { StatusBadge } from "@/app/components/status-badge"
import { KindBadge } from "@/app/components/kind-badge"
import { WORKFLOW_GRAPHS } from "@/app/components/workflow-graphs"
import { useCatalogStore } from "@/lib/stores/catalog-store"
import { type WorkflowInfo } from "@/lib/graphflow/catalog"
import { shortHash } from "@/lib/graphflow/format"

// Read-only view of the published workflow files (GET /catalog). Workflows
// are versioned by file copy — a node pasted unchanged keeps its code hash,
// so its memoised answers keep matching across versions.

function ExecutorBadge({ executor }: { executor: "engine" | "human" }) {
  if (executor === "human") {
    return (
      <StatusBadge color="warning" variant="muted">
        <UserIcon />
        Human Review
      </StatusBadge>
    )
  }
  return (
    <StatusBadge color="neutral" variant="muted">
      <CpuIcon />
      Engine
    </StatusBadge>
  )
}

// Static hand-drawn diagram per workflow file (demo-grade by design — a
// live graph library can replace this later). The DAG itself always comes
// from the code; this is purely illustrative.
function WorkflowGraphCard({ workflowId }: { workflowId: string }) {
  const graph = WORKFLOW_GRAPHS[workflowId]
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <CardTitle className="font-heading text-lg font-semibold">Graph</CardTitle>
          <span className="text-xs text-muted-foreground">
            illustrative diagram of the deployed file — the code is the DAG
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {graph ? (
          graph()
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No diagram available for this workflow yet.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function WorkflowCard({
  workflow,
  isCurrent,
  predecessor,
}: {
  workflow: WorkflowInfo
  isCurrent: boolean
  // The file this one supersedes (if any) — unchanged nodes against it keep
  // their code hash and therefore keep hitting the same memo entries.
  predecessor: WorkflowInfo | null
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <CardTitle className="font-heading text-lg font-semibold">
            {workflow.displayName}
          </CardTitle>
          <span className="font-code text-xs text-muted-foreground">
            {workflow.workflowId}.py
          </span>
          <span className="font-code text-xs text-muted-foreground">
            queue: {workflow.taskQueue}
          </span>
          {isCurrent && (
            <StatusBadge color="success" variant="muted">
              Current version
            </StatusBadge>
          )}
          {workflow.supersededBy && (
            <>
              <StatusBadge color="warning" variant="muted">
                Superseded by {workflow.supersededBy}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                no longer offered for new workspaces
              </span>
            </>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Nodes */}
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Nodes
          </h3>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead>Node ID</TableHead>
                  <TableHead>Executor</TableHead>
                  <TableHead>Output Kind</TableHead>
                  <TableHead>Code Hash</TableHead>
                  {predecessor && <TableHead>Vs Previous Version</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflow.nodes.map((node) => {
                  const priorHash =
                    predecessor?.nodes.find((n) => n.nodeId === node.nodeId)?.codeHash ?? null
                  return (
                    <TableRow key={node.nodeId}>
                      <TableCell className="font-medium">{node.displayName}</TableCell>
                      <TableCell>
                        <span className="font-code text-xs">{node.nodeId}</span>
                      </TableCell>
                      <TableCell>
                        <ExecutorBadge executor={node.executor} />
                      </TableCell>
                      <TableCell>
                        <KindBadge kind={node.outputKind} workflowId={workflow.workflowId} />
                      </TableCell>
                      <TableCell>
                        <span className="font-code text-xs text-muted-foreground">
                          {shortHash(node.codeHash, 12)}
                        </span>
                      </TableCell>
                      {predecessor && (
                        <TableCell>
                          {priorHash === null ? (
                            <StatusBadge color="info" variant="muted">
                              new in this version
                            </StatusBadge>
                          ) : priorHash === node.codeHash ? (
                            <StatusBadge color="success" variant="muted">
                              unchanged — shares memo
                            </StatusBadge>
                          ) : (
                            <StatusBadge color="destructive" variant="muted">
                              changed
                            </StatusBadge>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          {predecessor && (
            <p className="text-xs text-muted-foreground mt-2 max-w-3xl">
              Nodes with unchanged code keep their code hash, so every engagement&apos;s
              existing answers — including human reviews — keep matching when a workspace is
              repointed at this version. Only changed questions re-execute.
            </p>
          )}
        </div>

        {/* Attachable kinds */}
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Attachable Kinds
          </h3>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Attach Behaviour</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflow.kinds.map((kindDef) => (
                  <TableRow key={kindDef.kind}>
                    <TableCell>
                      <KindBadge kind={kindDef.kind} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{kindDef.display}</TableCell>
                    <TableCell>
                      {kindDef.leaf ? (
                        <StatusBadge color="info" variant="muted">
                          Document (default attach)
                        </StatusBadge>
                      ) : (
                        <StatusBadge color="neutral" variant="muted">
                          Intermediate (override attach)
                        </StatusBadge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function CatalogPage() {
  const catalogWorkflows = useCatalogStore((s) => s.workflows)
  const refreshCatalog = useCatalogStore((s) => s.refresh)
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void refreshCatalog()
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [refreshCatalog])

  const workflows = Object.values(catalogWorkflows)
  const supersededIds = new Set(
    workflows.map((wf) => wf.supersededBy).filter((id): id is string => id !== null)
  )

  // Default the dropdown to the current (non-superseded) version.
  const currentId =
    workflows.find((wf) => supersededIds.has(wf.workflowId))?.workflowId ??
    workflows[0]?.workflowId ??
    null
  const selected =
    (selectedId ? catalogWorkflows[selectedId] : null) ??
    (currentId ? catalogWorkflows[currentId] : null) ??
    null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-2xl font-semibold">Workflow Catalogue</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Workflows are code files written by engineers and deployed like software — a new
              version is a new file. Users can never author or edit a graph.
            </p>
          </div>
          {workflows.length > 0 && selected && (
            <div className="w-72">
              <Select value={selected.workflowId} onValueChange={setSelectedId}>
                <SelectTrigger className="w-full" aria-label="Select a workflow">
                  <SelectValue placeholder="Select a workflow" />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((wf) => (
                    <SelectItem key={wf.workflowId} value={wf.workflowId}>
                      {wf.displayName}
                      {supersededIds.has(wf.workflowId) && " (current)"}
                      {wf.supersededBy && " (superseded)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* Selected workflow: graph + tables */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading the catalogue…
          </div>
        ) : !selected ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No workflows published. Is the Graphflow API running?
          </p>
        ) : (
          <div className="flex flex-col gap-6 max-w-6xl">
            <WorkflowGraphCard workflowId={selected.workflowId} />
            <WorkflowCard
              workflow={selected}
              isCurrent={supersededIds.has(selected.workflowId)}
              predecessor={
                workflows.find((p) => p.supersededBy === selected.workflowId) ?? null
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}
