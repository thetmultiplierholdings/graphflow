"use client"

import { useEffect, useMemo, useState } from "react"
import { FileTextIcon, PaperclipIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { KindBadge } from "./kind-badge"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"
import { SAMPLE_DOCS } from "@/lib/graphflow/sample-docs"
import { membershipKey } from "@/lib/schemas/workspace"
import { shortHash } from "@/lib/graphflow/format"

interface AttachDocumentsDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Attach documents to a workspace. Leaf kinds (documents the workflow
// consumes but never produces) are the default vocabulary; a toggle reveals
// intermediate kinds a power user may attach deliberately as an override.
// Uploads go through the API — identical bytes under the same kind land on
// the existing artifact row (the revive path).
export function AttachDocumentsDialog({ workspaceId, open, onOpenChange }: AttachDocumentsDialogProps) {
  const workspace = useLedgerStore((s) => s.workspaces[workspaceId])
  const artifacts = useLedgerStore((s) => s.artifacts)
  const memberships = useLedgerStore((s) => s.workspaceArtifacts)
  const uploadArtifact = useLedgerStore((s) => s.uploadArtifact)
  const attachUser = useLedgerStore((s) => s.attachUser)
  const refreshEngagementPool = useLedgerStore((s) => s.refreshEngagementPool)
  const workflow = useCatalogStore((s) =>
    workspace ? s.workflows[workspace.workflowId] : undefined
  )

  const [selectedDocs, setSelectedDocs] = useState<string[]>([])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pasteKind, setPasteKind] = useState<string>("")
  const [pasteLabel, setPasteLabel] = useState("")
  const [pasteText, setPasteText] = useState("")
  const [busy, setBusy] = useState(false)

  // The pool tab lists every artifact the engagement has ever seen — pull it
  // from the API when the dialog opens so the mirror actually has the pool.
  const engagementId = workspace?.engagementId
  useEffect(() => {
    if (open && engagementId) {
      void refreshEngagementPool(engagementId).catch(() => {})
    }
  }, [open, engagementId, refreshEngagementPool])

  const attachableKinds = useMemo(
    () => (workflow ? workflow.kinds.filter((k) => showAdvanced || k.leaf) : []),
    [workflow, showAdvanced]
  )
  // Derived, not synced: switching the override toggle off must invalidate a
  // previously selected intermediate kind rather than silently keeping it.
  const validPasteKind = attachableKinds.some((k) => k.kind === pasteKind) ? pasteKind : ""

  const poolCandidates = useMemo(() => {
    if (!workspace) return []
    const kindSet = new Set(attachableKinds.map((k) => k.kind))
    return Object.values(artifacts)
      .filter((a) => a.engagementId === workspace.engagementId && kindSet.has(a.kind))
      .filter((a) => memberships[membershipKey(workspaceId, a.id)]?.source !== "user")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [workspace, artifacts, memberships, workspaceId, attachableKinds])

  if (!workspace) return null

  const close = () => {
    setSelectedDocs([])
    setPasteText("")
    setPasteLabel("")
    setPasteKind("")
    onOpenChange(false)
  }

  const attachSamples = async () => {
    setBusy(true)
    try {
      let revived = 0
      let attached = 0
      for (const filename of selectedDocs) {
        const doc = SAMPLE_DOCS.find((d) => d.filename === filename)
        if (!doc) continue
        const result = await uploadArtifact({
          engagementId: workspace.engagementId,
          kind: doc.kind,
          payload: doc.content,
          label: filename.replace(".txt", ""),
          workspaceId,
        })
        attached += 1
        if (result.revived) revived += 1
      }
      toast.success(
        revived > 0
          ? `Attached ${attached} document${attached === 1 ? "" : "s"} (${revived} landed on existing artifacts — prior work revives via the memo).`
          : `Attached ${attached} document${attached === 1 ? "" : "s"}.`
      )
      close()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.")
    } finally {
      setBusy(false)
    }
  }

  const attachPasted = async () => {
    if (!validPasteKind || !pasteText.trim()) return
    setBusy(true)
    try {
      const { revived } = await uploadArtifact({
        engagementId: workspace.engagementId,
        kind: validPasteKind,
        payload: pasteText,
        label: pasteLabel.trim() || undefined,
        workspaceId,
      })
      toast.success(
        revived
          ? "Identical bytes under this kind already exist — attached the existing artifact (revive)."
          : "Document uploaded and attached."
      )
      close()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.")
    } finally {
      setBusy(false)
    }
  }

  const attachFromPool = async (artifactId: string) => {
    const wasEngine = memberships[membershipKey(workspaceId, artifactId)]?.source === "engine"
    try {
      await attachUser(workspaceId, artifactId)
      toast.success(
        wasEngine
          ? "Promoted to user-supplied — the next run treats it as an override."
          : "Attached from the engagement pool."
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Attach failed.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach Documents</DialogTitle>
          <DialogDescription>
            Attachments are content-addressed: identical bytes under the same kind always land on
            the same artifact, so re-attaching revives all prior work.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Label htmlFor="advanced-kinds" className="text-sm font-normal text-muted-foreground">
            Show intermediate kinds (attach as override)
          </Label>
          <Switch id="advanced-kinds" checked={showAdvanced} onCheckedChange={setShowAdvanced} />
        </div>

        <Tabs defaultValue="samples">
          <TabsList className="w-full">
            <TabsTrigger value="samples" className="flex-1">Sample Documents</TabsTrigger>
            <TabsTrigger value="paste" className="flex-1">Paste Text</TabsTrigger>
            <TabsTrigger value="pool" className="flex-1">Engagement Pool</TabsTrigger>
          </TabsList>

          <TabsContent value="samples" className="space-y-3">
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border p-2">
              {SAMPLE_DOCS.map((doc) => (
                <label
                  key={doc.filename}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={selectedDocs.includes(doc.filename)}
                    onCheckedChange={(checked) =>
                      setSelectedDocs((prev) =>
                        checked ? [...prev, doc.filename] : prev.filter((f) => f !== doc.filename)
                      )
                    }
                  />
                  <FileTextIcon className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm flex-1 truncate">{doc.filename}</span>
                  <KindBadge kind={doc.kind} workflowId={workspace.workflowId} />
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                disabled={selectedDocs.length === 0 || busy}
                onClick={() => void attachSamples()}
              >
                <PaperclipIcon className="size-4" />
                <span className="ml-1">
                  {busy ? "Attaching…" : `Attach${selectedDocs.length > 0 ? ` ${selectedDocs.length}` : ""}`}
                </span>
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="paste" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Kind</Label>
                <Select value={validPasteKind} onValueChange={setPasteKind}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a kind" />
                  </SelectTrigger>
                  <SelectContent>
                    {attachableKinds.map((k) => (
                      <SelectItem key={k.kind} value={k.kind}>
                        {k.display}
                        {!k.leaf && " (override)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Label (optional)</Label>
                <Input
                  value={pasteLabel}
                  onChange={(e) => setPasteLabel(e.target.value)}
                  placeholder="e.g. corrected_statement"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={8}
                className="font-code text-xs"
                placeholder={"MORGAN STANLEY BROKERAGE STATEMENT - JAN 2026\n--- TRANSACTIONS ---\n2026-01-05 | DIVIDEND AAPL | 120.50"}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                disabled={!validPasteKind || !pasteText.trim() || busy}
                onClick={() => void attachPasted()}
              >
                <PaperclipIcon className="size-4" />
                <span className="ml-1">{busy ? "Uploading…" : "Upload & Attach"}</span>
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="pool" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Every artifact this engagement has ever seen. Attaching an engine result promotes it
              to user-supplied — the override gesture.
            </p>
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border p-2">
              {poolCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Nothing attachable in the pool for the current kind filter.
                </p>
              ) : (
                poolCandidates.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <KindBadge kind={a.kind} workflowId={workspace.workflowId} />
                    <span className="text-sm flex-1 truncate">{a.label}</span>
                    <span className="font-code text-xs text-muted-foreground">
                      {shortHash(a.hash, 8)}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void attachFromPool(a.id)}>
                      Attach
                    </Button>
                  </div>
                ))
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Done</Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
