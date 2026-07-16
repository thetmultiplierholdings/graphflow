"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  GitBranchIcon,
  LoaderIcon,
  MoreVerticalIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ArtifactPreviewSheet, downloadArtifact } from "@/app/components/artifact-preview-sheet"
import { AttachDocumentsDialog } from "@/app/components/attach-documents-dialog"
import { KindBadge } from "@/app/components/kind-badge"
import { RunStatusBadge } from "@/app/components/run-status-badge"
import { StatusBadge } from "@/app/components/status-badge"
import { WorkspaceRunPanel } from "@/app/components/workspace-run-panel"
import { executeWorkspace, resumeRunIfActive } from "@/lib/api/operations"
import { formatDate, shortHash } from "@/lib/graphflow/format"
import {
  ledgerSelectors,
  useLedgerStore,
  type WorkspaceMember,
} from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"

// The workspace screen: "the January estimate" — attached documents, engine
// results on display, and the watch-it-run panel underneath. Runs execute in
// the real backend; this page attaches to their progress stream (and
// re-attaches on reload — runs survive refreshes now).

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const ledger = useLedgerStore()
  const workflows = useCatalogStore((s) => s.workflows)
  const refreshCatalog = useCatalogStore((s) => s.refresh)

  const [loaded, setLoaded] = useState(false)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const workspace = ledger.workspaces[id]
  const status = ledger.workspaceStatuses[id]?.status ?? "idle"

  const refreshWorkspace = ledger.refreshWorkspace
  const refreshEngagements = ledger.refreshEngagements
  useEffect(() => {
    void Promise.allSettled([
      refreshWorkspace(id),
      refreshEngagements(), // breadcrumb needs the engagement label on direct loads
      refreshCatalog(),
      resumeRunIfActive(id), // runs survive reloads: re-attach if one is open
    ]).finally(() => setLoaded(true))
  }, [id, refreshWorkspace, refreshEngagements, refreshCatalog])

  // While a run is open, poll the derived status (and re-attach the stream
  // if it dropped) every ~3s.
  useEffect(() => {
    if (status !== "running") return
    const timer = setInterval(() => {
      void resumeRunIfActive(id)
    }, 3000)
    return () => clearInterval(timer)
  }, [status, id])

  const members = useMemo<WorkspaceMember[]>(
    () => (workspace ? ledgerSelectors.workspaceMembers(ledger, id) : []),
    [ledger, id, workspace]
  )

  if (!workspace) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading workspace…
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              This workspace does not exist in the ledger.
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/engagements">All Engagements</Link>
            </Button>
          </>
        )}
      </div>
    )
  }

  const engagement = ledger.engagements[workspace.engagementId]
  const workflow = workflows[workspace.workflowId]
  const copiedFrom = workspace.copiedFromId ? ledger.workspaces[workspace.copiedFromId] : null
  const archived = workspace.archivedAt !== null

  const documents = members.filter((m) => m.source === "user")
  const engineMembers = members.filter((m) => m.source === "engine")
  const finalReports = engineMembers.filter((m) => m.kind === "final_report")
  const intermediates = engineMembers.filter((m) => m.kind !== "final_report")

  // Intermediates grouped by kind, in the workflow's declaration order.
  const intermediateGroups: { kind: string; items: WorkspaceMember[] }[] = []
  {
    const order = (workflow?.kinds ?? []).map((k) => k.kind)
    const kinds = [...new Set(intermediates.map((m) => m.kind))].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b)
    )
    for (const kind of kinds) {
      intermediateGroups.push({ kind, items: intermediates.filter((m) => m.kind === kind) })
    }
  }

  const runWorkspace = async (supersede = false) => {
    setStarting(true)
    try {
      const result = await executeWorkspace(id, { supersede })
      if ("conflict" in result) {
        setConflictMessage(result.message)
        return
      }
      if (!result.ok) toast.error(result.error)
    } finally {
      setStarting(false)
    }
  }

  const saveLabel = async () => {
    const label = editingLabel?.trim()
    setEditingLabel(null)
    if (!label || label === workspace.label) return
    try {
      await ledger.renameWorkspace(id, label)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed.")
    }
  }

  const copyWorkspace = async () => {
    try {
      const newId = await ledger.createWorkspace({
        engagementId: workspace.engagementId,
        workflowId: workspace.workflowId,
        label: `${workspace.label} (copy)`,
        copiedFrom: workspace.id,
      })
      toast.success("Workspace copied — user documents carried over; results regenerate on Run.")
      router.push(`/workspaces/${newId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Copy failed.")
    }
  }

  const switchWorkflow = async (workflowId: string) => {
    if (workflowId === workspace.workflowId) return
    try {
      await ledger.repointWorkflow(id, workflowId)
      toast.success("Repointed — regenerating will re-execute only nodes whose code changed")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Repoint failed.")
    }
  }

  const toggleArchived = async () => {
    try {
      await ledger.setWorkspaceArchived(id, !archived)
      toast.success(archived ? "Workspace unarchived." : "Workspace archived.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.")
    }
  }

  const detach = async (member: WorkspaceMember) => {
    try {
      await ledger.detachArtifact(id, member.id)
      toast.success("Detached — re-attaching identical bytes revives all prior work")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Detach failed.")
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b px-8 pt-6 pb-5">
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/engagements">Engagements</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/engagements/${workspace.engagementId}`}>
                  {engagement?.label ?? workspace.engagementId}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{workspace.label}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {editingLabel !== null ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={editingLabel}
                    autoFocus
                    className="h-9 w-72"
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveLabel()
                      if (e.key === "Escape") setEditingLabel(null)
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!editingLabel.trim()}
                    onClick={() => void saveLabel()}
                    aria-label="Save label"
                  >
                    <CheckIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingLabel(null)}
                    aria-label="Cancel rename"
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <h1 className="font-heading text-2xl font-semibold truncate">
                    {workspace.label}
                  </h1>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setEditingLabel(workspace.label)}
                    aria-label="Rename workspace"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                </>
              )}
              <RunStatusBadge status={status} />
              {archived && (
                <StatusBadge color="destructive" variant="muted">
                  <ArchiveIcon />
                  Archived
                </StatusBadge>
              )}
            </div>

            <div className="mt-1.5 flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
              <span>{workflow?.displayName ?? workspace.workflowId}</span>
              <span className="font-code text-xs">{workspace.workflowId}</span>
              {copiedFrom && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <Link
                    href={`/workspaces/${copiedFrom.id}`}
                    className="hover:text-foreground transition-colors"
                  >
                    copied from {copiedFrom.label}
                  </Link>
                </>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span>Created {formatDate(workspace.createdAt)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              disabled={status === "running" || starting}
              onClick={() => void runWorkspace()}
            >
              {status === "running" || starting ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <PlayIcon className="size-4" />
              )}
              <span className="mr-1">{status === "running" ? "Running…" : "Run"}</span>
            </Button>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-8" aria-label="Workspace actions">
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void copyWorkspace()}>
                  <CopyIcon className="size-4" />
                  Copy Workspace
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <GitBranchIcon className="size-4 text-muted-foreground" />
                    Switch Workflow Version
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {Object.values(workflows).map((wf) => {
                      const current = wf.workflowId === workspace.workflowId
                      return (
                        <DropdownMenuItem
                          key={wf.workflowId}
                          onClick={() => void switchWorkflow(wf.workflowId)}
                        >
                          {current ? (
                            <CheckIcon className="size-4" />
                          ) : (
                            <span className="size-4" />
                          )}
                          {wf.displayName}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void toggleArchived()}>
                  {archived ? (
                    <ArchiveRestoreIcon className="size-4" />
                  ) : (
                    <ArchiveIcon className="size-4" />
                  )}
                  {archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2 items-start">
            {/* Documents (user-sourced — the run snapshot) */}
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Documents</CardTitle>
                <CardDescription>
                  User-supplied documents — these form the run snapshot.
                </CardDescription>
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setAttachOpen(true)}>
                    <PaperclipIcon className="size-4" />
                    <span className="mr-1">Attach</span>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {documents.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No documents attached. The run snapshot is built from user-supplied documents
                    only.
                  </p>
                ) : (
                  documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => setSelectedArtifactId(doc.id)}
                    >
                      <KindBadge kind={doc.kind} workflowId={workspace.workflowId} />
                      <span className="text-sm font-medium flex-1 truncate">{doc.label}</span>
                      <span className="font-code text-xs text-muted-foreground shrink-0">
                        {shortHash(doc.hash)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`Detach ${doc.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void detach(doc)
                        }}
                      >
                        <XIcon className="size-4" />
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Results (engine-sourced — on display, never in the snapshot) */}
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Results</CardTitle>
                <CardDescription>
                  Engine results on display — they never feed the next run&rsquo;s snapshot.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {engineMembers.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Nothing produced yet. Press Run to execute the workflow over the attached
                    documents.
                  </p>
                ) : (
                  <>
                    {finalReports.length > 0 && (
                      <div className="space-y-1.5">
                        {finalReports.map((report) => (
                          <div
                            key={report.id}
                            className="flex items-center gap-3 rounded-md bg-success-muted px-3 py-2.5 cursor-pointer transition-opacity hover:opacity-90"
                            onClick={() => setSelectedArtifactId(report.id)}
                          >
                            <FileTextIcon className="size-4 shrink-0 text-success-strong" />
                            <span className="text-sm font-medium flex-1 truncate text-success-strong">
                              {report.label}
                            </span>
                            <span className="font-code text-xs text-muted-foreground shrink-0">
                              {shortHash(report.hash)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              aria-label={`Download ${report.label}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                downloadArtifact(report)
                              }}
                            >
                              <DownloadIcon className="size-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {intermediateGroups.map((group) => (
                      <div key={group.kind} className="space-y-1.5">
                        {group.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors"
                            onClick={() => setSelectedArtifactId(item.id)}
                          >
                            <KindBadge kind={item.kind} workflowId={workspace.workflowId} />
                            <span className="text-sm flex-1 truncate">{item.label}</span>
                            <span className="font-code text-xs text-muted-foreground shrink-0">
                              {shortHash(item.hash)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* The watch-it-run experience */}
          <WorkspaceRunPanel workspaceId={id} />
        </div>
      </div>

      <AttachDocumentsDialog workspaceId={id} open={attachOpen} onOpenChange={setAttachOpen} />
      <ArtifactPreviewSheet
        artifactId={selectedArtifactId}
        onOpenChange={(open) => {
          if (!open) setSelectedArtifactId(null)
        }}
      />

      {/* Open run + changed snapshot: 409 — offer terminate-and-restart. */}
      <AlertDialog
        open={conflictMessage !== null}
        onOpenChange={(o) => {
          if (!o) setConflictMessage(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attachments changed while a run is open</AlertDialogTitle>
            <AlertDialogDescription>
              {conflictMessage ??
                "The open run started from a different set of attachments."}{" "}
              Superseding terminates the open run and restarts on the current snapshot — facts
              already filed stay filed and will memo-hit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the open run</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConflictMessage(null)
                void runWorkspace(true)
              }}
            >
              Supersede and restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
