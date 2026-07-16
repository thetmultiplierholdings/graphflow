"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"

const START_EMPTY = "__start_empty__"

interface NewWorkspaceDialogProps {
  engagementId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Creates a workflow_run: a flat set of attached artifacts + a workflow file
// + a Run button. Copying takes user-supplied documents only.
export function NewWorkspaceDialog({ engagementId, open, onOpenChange }: NewWorkspaceDialogProps) {
  const router = useRouter()
  const workspaces = useLedgerStore((s) => s.workspaces)
  const createWorkspace = useLedgerStore((s) => s.createWorkspace)
  const catalogWorkflows = useCatalogStore((s) => s.workflows)

  // Superseded workflow files stop being offered for NEW workspaces (UI
  // policy); existing workspaces keep their referent and can still be
  // repointed from the workspace's version menu.
  const offeredWorkflows = useMemo(
    () => Object.values(catalogWorkflows).filter((wf) => wf.supersededBy === null),
    [catalogWorkflows]
  )

  const [workflowId, setWorkflowId] = useState("")
  const [label, setLabel] = useState("")
  const [copyFrom, setCopyFrom] = useState(START_EMPTY)
  const [creating, setCreating] = useState(false)

  // Derived default: the first non-superseded workflow once the catalog loads.
  const effectiveWorkflowId =
    workflowId && offeredWorkflows.some((wf) => wf.workflowId === workflowId)
      ? workflowId
      : (offeredWorkflows[0]?.workflowId ?? "")

  const engagementWorkspaces = useMemo(
    () =>
      Object.values(workspaces)
        .filter((w) => w.engagementId === engagementId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [workspaces, engagementId]
  )

  const canCreate = label.trim().length > 0 && effectiveWorkflowId !== "" && !creating

  const close = () => {
    setWorkflowId("")
    setLabel("")
    setCopyFrom(START_EMPTY)
    onOpenChange(false)
  }

  const create = async () => {
    if (!canCreate) return
    const trimmed = label.trim()
    setCreating(true)
    try {
      const id = await createWorkspace({
        engagementId,
        workflowId: effectiveWorkflowId,
        label: trimmed,
        copiedFrom: copyFrom === START_EMPTY ? null : copyFrom,
      })
      toast.success(`Workspace "${trimmed}" created.`)
      close()
      router.push(`/workspaces/${id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create the workspace.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>
            A workspace is a flat set of attached documents, a workflow file and a Run button.
            Prior answers revive via the memo — the same question is never computed twice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-workspace-workflow">Workflow</Label>
            <Select value={effectiveWorkflowId} onValueChange={setWorkflowId}>
              <SelectTrigger id="new-workspace-workflow" className="w-full">
                <SelectValue placeholder="Select a workflow" />
              </SelectTrigger>
              <SelectContent>
                {offeredWorkflows.map((wf) => (
                  <SelectItem key={wf.workflowId} value={wf.workflowId}>
                    {wf.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-workspace-label">Label</Label>
            <Input
              id="new-workspace-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. January estimate"
              onKeyDown={(e) => {
                if (e.key === "Enter") void create()
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-workspace-copy-from">Copy Documents From</Label>
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger id="new-workspace-copy-from" className="w-full">
                <SelectValue placeholder="Start empty" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={START_EMPTY}>Start empty</SelectItem>
                {engagementWorkspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Copying brings across user-supplied documents only — engine results are recomputed
              (or memo-hit) on the next run.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            <PlusIcon className="size-4" />
            <span className="ml-1">{creating ? "Creating…" : "Create Workspace"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
