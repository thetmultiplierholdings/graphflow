"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CopyIcon,
  FolderOpenIcon,
  LayersIcon,
  LoaderIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArtifactPreviewSheet } from "@/app/components/artifact-preview-sheet"
import { KindBadge } from "@/app/components/kind-badge"
import { NewWorkspaceDialog } from "@/app/components/new-workspace-dialog"
import { RunStatusBadge } from "@/app/components/run-status-badge"
import { StatusBadge } from "@/app/components/status-badge"
import { ledgerSelectors, useLedgerStore } from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"
import { formatBytes, formatDate, formatDateTime, shortHash } from "@/lib/graphflow/format"
import { cn } from "@/lib/utils"

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <Card size="sm" className="gap-0 py-4">
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

export default function EngagementDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const ledger = useLedgerStore()
  const workflows = useCatalogStore((s) => s.workflows)
  const refreshCatalog = useCatalogStore((s) => s.refresh)

  const [loaded, setLoaded] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [kindFilter, setKindFilter] = useState("all")
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)

  const engagement = ledger.engagements[id]
  const statuses = ledger.workspaceStatuses

  const refreshEngagement = ledger.refreshEngagement
  useEffect(() => {
    void Promise.allSettled([refreshEngagement(id), refreshCatalog()]).finally(() =>
      setLoaded(true)
    )
  }, [id, refreshEngagement, refreshCatalog])

  const nodeDisplayName = (workflowId: string, nodeId: string): string =>
    workflows[workflowId]?.nodes.find((n) => n.nodeId === nodeId)?.displayName ?? nodeId

  const stats = useMemo(
    () => ledgerSelectors.engagementStats(ledger, id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger.engagementStats, id]
  )

  const engagementWorkspaces = useMemo(
    () =>
      Object.values(ledger.workspaces)
        .filter((w) => w.engagementId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [ledger.workspaces, id]
  )
  const visibleWorkspaces = useMemo(
    () => engagementWorkspaces.filter((w) => showArchived || w.archivedAt === null),
    [engagementWorkspaces, showArchived]
  )

  // Live results: poll while any of this engagement's workspaces is running.
  const anyRunning = engagementWorkspaces.some((w) => statuses[w.id]?.status === "running")
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      void refreshEngagement(id).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [anyRunning, id, refreshEngagement])

  const engagementArtifacts = useMemo(
    () => Object.values(ledger.artifacts).filter((a) => a.engagementId === id),
    [ledger.artifacts, id]
  )
  const poolKinds = useMemo(
    () => [...new Set(engagementArtifacts.map((a) => a.kind))].sort(),
    [engagementArtifacts]
  )
  const filteredArtifacts = useMemo(() => {
    const q = search.trim().toLowerCase()
    return engagementArtifacts
      .filter((a) => {
        if (kindFilter !== "all" && a.kind !== kindFilter) return false
        if (
          q &&
          !a.label.toLowerCase().includes(q) &&
          !a.kind.toLowerCase().includes(q) &&
          !a.hash.toLowerCase().includes(q)
        )
          return false
        return true
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }, [engagementArtifacts, search, kindFilter])

  const engagementNodeRuns = useMemo(
    () =>
      Object.values(ledger.nodeRuns)
        .filter((r) => r.engagementId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    [ledger.nodeRuns, id]
  )

  if (!engagement) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading engagement…
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Engagement not found.</p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/engagements">All Engagements</Link>
            </Button>
          </>
        )}
      </div>
    )
  }

  const copyWorkspace = async (wsId: string) => {
    const ws = ledger.workspaces[wsId]
    if (!ws) return
    const label = `${ws.label} (copy)`
    try {
      const newId = await ledger.createWorkspace({
        engagementId: ws.engagementId,
        workflowId: ws.workflowId,
        label,
        copiedFrom: ws.id,
      })
      toast.success(`Workspace "${label}" created — user documents copied across.`)
      router.push(`/workspaces/${newId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Copy failed.")
    }
  }

  const toggleArchived = async (wsId: string) => {
    const ws = ledger.workspaces[wsId]
    if (!ws) return
    const archiving = ws.archivedAt === null
    try {
      await ledger.setWorkspaceArchived(wsId, archiving)
      toast.success(
        archiving
          ? `"${ws.label}" archived — its facts stay in the ledger.`
          : `"${ws.label}" unarchived.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.")
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-6 pb-5 border-b">
        <Button variant="ghost" size="sm" className="-ml-3 mb-2 text-muted-foreground" asChild>
          <Link href="/engagements">
            <ArrowLeftIcon className="size-4" />
            <span className="ml-1">All Engagements</span>
          </Link>
        </Button>
        <h1 className="font-heading text-2xl font-semibold">{engagement.label}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Created {formatDate(engagement.createdAt)}
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
        {/* Stat tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatTile value={stats.workspaces} label="Workspaces" />
          <StatTile value={stats.artifacts} label="Artifacts" />
          <StatTile value={stats.nodeRuns} label="Completed Steps" />
          <StatTile value={stats.humanAnswers} label="Human Answers" />
        </div>

        <Tabs defaultValue="workspaces">
          <TabsList>
            <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
            <TabsTrigger value="pool">Artifact Pool</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
          </TabsList>

          {/* ── Workspaces ─────────────────────────────────────────────── */}
          <TabsContent value="workspaces" className="space-y-4 pt-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="show-archived"
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                />
                <Label htmlFor="show-archived" className="font-normal text-muted-foreground">
                  Show archived
                </Label>
              </div>
              <Button size="sm" onClick={() => setNewWorkspaceOpen(true)}>
                <PlusIcon className="size-4" />
                <span className="ml-1">New Workspace</span>
              </Button>
            </div>

            {visibleWorkspaces.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <LayersIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {engagementWorkspaces.length > 0 ? "No Active Workspaces" : "No Workspaces Yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {engagementWorkspaces.length > 0
                      ? "Every workspace here is archived. Toggle “Show archived” to see them."
                      : "A workspace is a set of attached documents plus a workflow file and a Run button."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" onClick={() => setNewWorkspaceOpen(true)}>
                    <PlusIcon className="size-4" />
                    <span className="ml-1">New Workspace</span>
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="rounded-md border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Documents</TableHead>
                      <TableHead>Results</TableHead>
                      <TableHead>Copied From</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleWorkspaces.map((ws) => {
                      const wf = workflows[ws.workflowId]
                      const archived = ws.archivedAt !== null
                      const counts = ledger.workspaceCounts[ws.id] ?? { user: 0, engine: 0 }
                      const copiedFrom = ws.copiedFromId
                        ? ledger.workspaces[ws.copiedFromId]
                        : null
                      return (
                        <TableRow
                          key={ws.id}
                          className="cursor-pointer"
                          onClick={() => router.push(`/workspaces/${ws.id}`)}
                        >
                          <TableCell
                            className={cn("font-medium", archived && "text-muted-foreground")}
                          >
                            <span className="inline-flex items-center gap-2">
                              {ws.label}
                              {archived && (
                                <StatusBadge color="neutral" variant="muted">
                                  Archived
                                </StatusBadge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-2">
                              {wf?.displayName ?? ws.workflowId}
                              {wf?.supersededBy && (
                                <StatusBadge color="warning" variant="muted">
                                  Superseded
                                </StatusBadge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <RunStatusBadge status={statuses[ws.id]?.status ?? "idle"} />
                          </TableCell>
                          <TableCell>{counts.user}</TableCell>
                          <TableCell>{counts.engine}</TableCell>
                          <TableCell>
                            {copiedFrom ? (
                              <Link
                                href={`/workspaces/${copiedFrom.id}`}
                                className="text-sm underline-offset-4 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {copiedFrom.label}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDate(ws.createdAt)}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu modal={false}>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="size-8">
                                  <MoreHorizontalIcon className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => router.push(`/workspaces/${ws.id}`)}
                                >
                                  <FolderOpenIcon className="size-4" />
                                  Open
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void copyWorkspace(ws.id)}>
                                  <CopyIcon className="size-4" />
                                  Copy
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => void toggleArchived(ws.id)}>
                                  {archived ? (
                                    <ArchiveRestoreIcon className="size-4" />
                                  ) : (
                                    <ArchiveIcon className="size-4" />
                                  )}
                                  {archived ? "Unarchive" : "Archive"}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* ── Artifact Pool ──────────────────────────────────────────── */}
          <TabsContent value="pool" className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Everything this engagement has ever seen or computed — insert-only.
            </p>
            <div className="flex items-center gap-2">
              <div className="relative">
                <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search label, kind or hash..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 w-64 text-sm"
                />
              </div>
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger className="h-8 text-sm w-48">
                  <SelectValue placeholder="Kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Kinds</SelectItem>
                  {poolKinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground">
                {filteredArtifacts.length}{" "}
                {filteredArtifacts.length === 1 ? "artifact" : "artifacts"}
              </span>
            </div>

            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Hash</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredArtifacts.map((artifact) => {
                    const producedBy = artifact.producedByNodeRunId
                      ? ledger.nodeRuns[artifact.producedByNodeRunId]
                      : null
                    return (
                      <TableRow
                        key={artifact.id}
                        className="cursor-pointer"
                        onClick={() => setSelectedArtifactId(artifact.id)}
                      >
                        <TableCell>
                          <KindBadge kind={artifact.kind} />
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="block max-w-[240px] truncate">{artifact.label}</span>
                        </TableCell>
                        <TableCell className="font-code text-xs text-muted-foreground">
                          {shortHash(artifact.hash)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatBytes(artifact.byteSize)}
                        </TableCell>
                        <TableCell>
                          {producedBy ? (
                            <span>
                              <span className="text-muted-foreground">Engine · </span>
                              {nodeDisplayName(producedBy.workflowId, producedBy.nodeId)}
                            </span>
                          ) : (
                            <span>Uploaded by {artifact.createdBy}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(artifact.createdAt)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {filteredArtifacts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-16 text-center text-muted-foreground">
                        {engagementArtifacts.length === 0
                          ? "This engagement has not seen or computed any artifacts yet."
                          : "No artifacts match your filters."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* ── Ledger ─────────────────────────────────────────────────── */}
          <TabsContent value="ledger" className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Insert-only facts. Within this engagement, the same question is never computed twice.
            </p>
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Answered By</TableHead>
                    <TableHead>Output</TableHead>
                    <TableHead>Memo Key</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {engagementNodeRuns.map((nr) => {
                    const output = ledger.artifacts[nr.outputArtifactId]
                    return (
                      <TableRow key={nr.id}>
                        <TableCell>{nodeDisplayName(nr.workflowId, nr.nodeId)}</TableCell>
                        <TableCell className="font-code text-xs text-muted-foreground">
                          {nr.workflowId}
                        </TableCell>
                        <TableCell>
                          {nr.createdBy === "engine" ? (
                            <span className="text-muted-foreground">engine</span>
                          ) : (
                            <span className="font-medium">{nr.createdBy}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {output ? (
                            <button
                              onClick={() => setSelectedArtifactId(output.id)}
                              className="text-sm underline-offset-4 hover:underline text-left"
                            >
                              <span className="block max-w-[240px] truncate">{output.label}</span>
                            </button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-code text-xs text-muted-foreground">
                          {shortHash(nr.memoKey)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(nr.createdAt)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {engagementNodeRuns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-16 text-center text-muted-foreground">
                        No completed steps yet — run a workspace to file the first facts.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <NewWorkspaceDialog
        engagementId={id}
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
      />
      <ArtifactPreviewSheet
        artifactId={selectedArtifactId}
        onOpenChange={(open) => {
          if (!open) setSelectedArtifactId(null)
        }}
      />
    </div>
  )
}
