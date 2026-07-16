"use client"

import { useEffect, useMemo, useState } from "react"
import { CheckIcon, DownloadIcon, LoaderIcon, PencilIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { KindBadge } from "./kind-badge"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"
import { artifactContentUrl, fetchArtifactContent } from "@/lib/api/client"
import { formatBytes, formatDateTime } from "@/lib/graphflow/format"
import { type Artifact } from "@/lib/schemas/artifact"

// Downloads stream from the API's /content endpoint (the server sets
// Content-Disposition from the label).
export function downloadArtifact(artifact: Pick<Artifact, "id" | "label" | "payloadAvailable">) {
  if (!artifact.payloadAvailable) {
    toast.error("Payload destroyed per policy — nothing to download.")
    return
  }
  const link = document.createElement("a")
  link.href = artifactContentUrl(artifact.id)
  link.download = artifact.label
  document.body.appendChild(link)
  link.click()
  link.remove()
}

interface PayloadState {
  forId: string | null // which artifact the text/error belong to
  text: string | null
  error: string | null
}

function PayloadPreview({ artifact, payload }: { artifact: Artifact; payload: PayloadState }) {
  if (!artifact.payloadAvailable) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Payload destroyed per policy. The ledger keeps the hash, kind and lineage.
      </p>
    )
  }
  if (payload.forId !== artifact.id) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin" />
        Loading payload…
      </div>
    )
  }
  if (payload.error) {
    return <p className="text-sm text-destructive">{payload.error}</p>
  }
  let text = payload.text ?? ""
  if (artifact.mediaType === "application/json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // show raw
    }
  }
  return (
    <pre className="rounded-lg border bg-muted/50 p-3 text-xs font-code whitespace-pre overflow-x-auto max-h-80 overflow-y-auto">
      {text}
    </pre>
  )
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm text-right min-w-0 break-all">{children}</span>
    </div>
  )
}

interface ArtifactPreviewSheetProps {
  artifactId: string | null
  onOpenChange: (open: boolean) => void
}

// The artifact drawer: identity (content hash — the whole point), payload
// preview (fetched from the API on open), rename (the one mutable ledger
// column), download, and lineage (produced by / inputs / consumed by),
// navigable artifact to artifact.
export function ArtifactPreviewSheet({ artifactId, onOpenChange }: ArtifactPreviewSheetProps) {
  const [currentId, setCurrentId] = useState(artifactId)
  const [lastArtifactId, setLastArtifactId] = useState(artifactId)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [payload, setPayload] = useState<PayloadState>({ forId: null, text: null, error: null })
  const artifacts = useLedgerStore((s) => s.artifacts)
  const nodeRuns = useLedgerStore((s) => s.nodeRuns)
  const renameArtifact = useLedgerStore((s) => s.renameArtifact)
  const fetchArtifactLineage = useLedgerStore((s) => s.fetchArtifactLineage)
  const workflows = useCatalogStore((s) => s.workflows)

  const nodeName = (workflowId: string, nodeId: string) =>
    workflows[workflowId]?.nodes.find((n) => n.nodeId === nodeId)?.displayName ?? nodeId

  // Opening a different artifact resets the drawer (render-time state
  // adjustment — no effect needed).
  if (artifactId !== lastArtifactId) {
    setLastArtifactId(artifactId)
    setCurrentId(artifactId)
    setEditingLabel(null)
  }

  const artifact = currentId ? artifacts[currentId] : null
  const payloadArtifactId = artifact?.payloadAvailable ? artifact.id : null

  // Lineage on open/navigate: pulls the artifact + its producer/consumers
  // (and their outputs) into the mirror so the sections below render from
  // store data.
  useEffect(() => {
    if (!currentId) return
    void fetchArtifactLineage(currentId).catch(() => {})
  }, [currentId, fetchArtifactLineage])

  // Payload content is fetched separately (never inline in metadata). The
  // loading state is derived: payload.forId lags behind payloadArtifactId
  // until the fetch settles.
  useEffect(() => {
    if (!payloadArtifactId) return
    let cancelled = false
    fetchArtifactContent(payloadArtifactId)
      .then((text) => {
        if (!cancelled) setPayload({ forId: payloadArtifactId, text, error: null })
      })
      .catch((err) => {
        if (!cancelled)
          setPayload({
            forId: payloadArtifactId,
            text: null,
            error: err instanceof Error ? err.message : "Failed to load payload.",
          })
      })
    return () => {
      cancelled = true
    }
  }, [payloadArtifactId])

  const producedBy = useMemo(
    () => (artifact?.producedByNodeRunId ? nodeRuns[artifact.producedByNodeRunId] : null),
    [artifact, nodeRuns]
  )
  const consumedBy = useMemo(
    () =>
      artifact
        ? Object.values(nodeRuns)
            .filter((nr) => nr.inputArtifactIds.includes(artifact.id))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : [],
    [artifact, nodeRuns]
  )

  const linkTo = (id: string) => {
    setCurrentId(id)
    setEditingLabel(null)
  }

  const saveLabel = (label: string) => {
    void renameArtifact(artifact!.id, label).catch((err) =>
      toast.error(err instanceof Error ? err.message : "Rename failed.")
    )
    setEditingLabel(null)
  }

  return (
    <Sheet open={artifactId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {artifact ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2 pr-6">
                {editingLabel !== null ? (
                  <div className="flex items-center gap-1 flex-1">
                    <Input
                      value={editingLabel}
                      autoFocus
                      onChange={(e) => setEditingLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editingLabel.trim()) {
                          saveLabel(editingLabel.trim())
                        }
                        if (e.key === "Escape") setEditingLabel(null)
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!editingLabel.trim()}
                      onClick={() => saveLabel(editingLabel.trim())}
                    >
                      <CheckIcon className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setEditingLabel(null)}>
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <SheetTitle className="truncate">{artifact.label}</SheetTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setEditingLabel(artifact.label)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
              <SheetDescription className="flex items-center gap-2">
                <KindBadge kind={artifact.kind} />
                <span className="font-code text-xs">{artifact.hash.slice(0, 12)}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-6">
              <div className="space-y-2">
                <MetaRow label="Content Hash">
                  <span className="font-code text-xs">{artifact.hash}</span>
                </MetaRow>
                <MetaRow label="Media Type">{artifact.mediaType}</MetaRow>
                <MetaRow label="Size">{formatBytes(artifact.byteSize)}</MetaRow>
                <MetaRow label="Created By">{artifact.createdBy}</MetaRow>
                <MetaRow label="Created At">{formatDateTime(artifact.createdAt)}</MetaRow>
              </div>

              <Button variant="outline" size="sm" onClick={() => downloadArtifact(artifact)}>
                <DownloadIcon className="size-4" />
                <span className="ml-1">Download</span>
              </Button>

              <Separator />

              <div className="space-y-2">
                <h3 className="kicker">Payload</h3>
                <PayloadPreview artifact={artifact} payload={payload} />
              </div>

              <Separator />

              <div className="space-y-3">
                <h3 className="kicker">Lineage</h3>
                {producedBy ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      Produced by{" "}
                      <span className="font-medium">
                        {nodeName(producedBy.workflowId, producedBy.nodeId)}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        ({producedBy.createdBy === "engine" ? "engine" : producedBy.createdBy},{" "}
                        {formatDateTime(producedBy.createdAt)})
                      </span>
                    </p>
                    {producedBy.inputArtifactIds.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">From inputs:</p>
                        {producedBy.inputArtifactIds.map((id) => {
                          const input = artifacts[id]
                          if (!input) return null
                          return (
                            <button
                              key={id}
                              onClick={() => linkTo(id)}
                              className="flex items-center gap-2 w-full text-left rounded-md border px-2 py-1.5 hover:bg-muted transition-colors"
                            >
                              <KindBadge kind={input.kind} />
                              <span className="text-sm truncate">{input.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Supplied by {artifact.createdBy} (user upload — not produced by a node).
                  </p>
                )}

                {consumedBy.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Consumed by:</p>
                    {consumedBy.map((nr) => {
                      const output = artifacts[nr.outputArtifactId]
                      return (
                        <button
                          key={nr.id}
                          onClick={() => output && linkTo(output.id)}
                          className="flex items-center justify-between gap-2 w-full text-left rounded-md border px-2 py-1.5 hover:bg-muted transition-colors"
                        >
                          <span className="text-sm truncate">
                            {nodeName(nr.workflowId, nr.nodeId)}
                          </span>
                          {output && <KindBadge kind={output.kind} />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>Artifact not found</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}
