"use client"

import { useEffect, useState } from "react"
import { CheckIcon, LoaderIcon, PlusIcon, XIcon, ZapIcon } from "lucide-react"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { KindBadge } from "./kind-badge"
import { fetchArtifactContent, getArtifactLineage } from "@/lib/api/client"
import {
  buildAutoApprovalAsync,
  submitHumanTask,
  type SubmitResult,
} from "@/lib/api/operations"
import { CURRENT_USER } from "@/lib/graphflow/user"
import { type ArtifactRef } from "@/lib/schemas/artifact"
import { type HumanTask } from "@/lib/schemas/human-task"

interface TxnRow {
  date: string
  description: string
  amount: string
}

// Amounts must normalise to a plain decimal string like 1200.50.
const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/

function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s.trim())
}

interface ReviewTaskDialogProps {
  task: HumanTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// The reviewer experience: source document beside the OCR extraction, the
// extraction editable cell by cell. Submitting is a synchronous Temporal
// workflow update through the API — the run that asked resumes instantly,
// and every future workspace in the engagement reuses the answer.
export function ReviewTaskDialog({ task, open, onOpenChange }: ReviewTaskDialogProps) {
  return (
    <Dialog open={open && task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        {task && <ReviewTaskBody key={task.id} task={task} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  )
}

interface Extraction {
  docKind: string | null
  transactions: TxnRow[]
}

interface SourceDoc {
  kind: string | null
  text: string | null
}

function ReviewTaskBody({
  task,
  onOpenChange,
}: {
  task: HumanTask
  onOpenChange: (open: boolean) => void
}) {
  // The payload travels in the Temporal transport form: artifact values are
  // tagged { __artifact__: ref }. The expected shape carries the OCR result.
  const ocrRef = (task.payload.ocr as { __artifact__?: ArtifactRef } | undefined)?.__artifact__

  const [loading, setLoading] = useState(Boolean(ocrRef))
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [source, setSource] = useState<SourceDoc>({ kind: null, text: null })
  const [rows, setRows] = useState<TxnRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Load the OCR extraction, then walk its lineage to the original document
  // the reviewer verifies against: /artifacts/{ocrId} -> produced_by ->
  // first input artifact -> its content.
  useEffect(() => {
    if (!ocrRef?.artifactId) {
      setLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const text = await fetchArtifactContent(ocrRef.artifactId)
        const parsed = JSON.parse(text) as { doc_kind?: string; transactions?: unknown }
        if (!Array.isArray(parsed.transactions)) {
          if (!cancelled) setLoading(false)
          return
        }
        const transactions: TxnRow[] = parsed.transactions.map((t) => {
          const row = (t ?? {}) as Record<string, unknown>
          return {
            date: String(row.date ?? ""),
            description: String(row.description ?? ""),
            amount: String(row.amount ?? ""),
          }
        })
        if (cancelled) return
        setExtraction({
          docKind: typeof parsed.doc_kind === "string" ? parsed.doc_kind : null,
          transactions,
        })
        setRows(transactions)
        setLoading(false)

        // Source document (best effort — the extraction alone is workable).
        try {
          const lineage = await getArtifactLineage(ocrRef.artifactId)
          const sourceId = lineage.producedBy?.nodeRun.inputArtifactIds[0]
          if (!sourceId || cancelled) return
          const [sourceMeta, sourceText] = await Promise.all([
            getArtifactLineage(sourceId),
            fetchArtifactContent(sourceId),
          ])
          if (!cancelled) setSource({ kind: sourceMeta.artifact.kind, text: sourceText })
        } catch {
          // leave the source panel in its unavailable state
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [ocrRef?.artifactId])

  const filledRows = rows.filter((r) => r.date.trim() || r.description.trim() || r.amount.trim())

  const updateRow = (index: number, field: keyof TxnRow, value: string) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  const deleteRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index))
  const addRow = () => setRows((prev) => [...prev, { date: "", description: "", amount: "" }])

  // A rejected submission surfaces the error and the task keeps waiting —
  // the API's synchronous 422.
  const finish = (result: SubmitResult) => {
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(
      "Answer filed to the ledger — every workspace that asks this question will reuse it"
    )
    onOpenChange(false)
  }

  const submit = async (result: Record<string, unknown>) => {
    setSubmitting(true)
    try {
      finish(await submitHumanTask(task.id, result, CURRENT_USER))
    } finally {
      setSubmitting(false)
    }
  }

  // An accepted answer is memoized forever — the question is never asked
  // again in this engagement — so malformed rows must be caught here, not
  // filed. Amounts tolerate pasted formatting (commas, currency symbols) but
  // must normalise to a plain decimal string.
  const normaliseAmount = (raw: string) => raw.trim().replace(/[£$€ \s]/g, "").replace(/,/g, "")

  const approveEdited = () => {
    const filled = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.date.trim() || row.description.trim() || row.amount.trim())
    const cleaned: TxnRow[] = []
    for (const { row, index } of filled) {
      const date = row.date.trim()
      const description = row.description.trim()
      const amount = normaliseAmount(row.amount)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        setError(`Row ${index + 1}: date '${row.date}' must be YYYY-MM-DD.`)
        return
      }
      if (!description) {
        setError(`Row ${index + 1}: description is required.`)
        return
      }
      if (!isDecimalString(amount)) {
        setError(`Row ${index + 1}: amount '${row.amount}' is not a plain decimal — use e.g. 1200.50.`)
        return
      }
      cleaned.push({ date, description, amount })
    }
    setError(null)
    void submit({ approved: true, transactions: cleaned })
  }

  const autoApprove = async () => {
    setSubmitting(true)
    try {
      const result = await buildAutoApprovalAsync(task)
      if (!result) {
        setError("Auto-approval is unavailable — the OCR extraction could not be read.")
        return
      }
      finish(await submitHumanTask(task.id, result, CURRENT_USER))
    } finally {
      setSubmitting(false)
    }
  }

  const approveFallback = () => void submit({ approved: true })

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">{task.displayName}</DialogTitle>
        <DialogDescription>{task.instructions}</DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" />
          Loading the extraction…
        </div>
      ) : extraction ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="kicker">Source Document</h3>
              {source.kind && <KindBadge kind={source.kind} workflowId={task.workflowId} />}
            </div>
            {source.text != null ? (
              <pre className="rounded-lg border bg-muted/50 p-3 font-code text-xs whitespace-pre overflow-auto max-h-96">
                {source.text}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Source document unavailable — verify against the extraction alone.
              </p>
            )}
          </div>

          <div className="space-y-2 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="kicker">Extracted Transactions</h3>
              {extraction.docKind && (
                <span className="text-xs text-muted-foreground">{extraction.docKind}</span>
              )}
            </div>
            <div className="rounded-lg border overflow-hidden">
              <div className="max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[110px]">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-[104px] text-right">Amount</TableHead>
                      <TableHead className="w-9" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className="hover:bg-transparent">
                        <TableCell className="p-1.5">
                          <Input
                            value={row.date}
                            aria-label={`Row ${i + 1} date`}
                            onChange={(e) => updateRow(i, "date", e.target.value)}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="p-1.5">
                          <Input
                            value={row.description}
                            aria-label={`Row ${i + 1} description`}
                            onChange={(e) => updateRow(i, "description", e.target.value)}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="p-1.5">
                          <Input
                            value={row.amount}
                            aria-label={`Row ${i + 1} amount`}
                            onChange={(e) => updateRow(i, "amount", e.target.value)}
                            className="h-8 text-right font-code"
                          />
                        </TableCell>
                        <TableCell className="p-1.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete row ${i + 1}`}
                            onClick={() => deleteRow(i)}
                          >
                            <XIcon className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {rows.length === 0 && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                          No rows — add one, or Auto-Approve the original extraction.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={addRow}>
              <PlusIcon className="size-4" />
              <span className="mr-1">Add Row</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <h3 className="kicker">Task Payload</h3>
            <pre className="rounded-lg border bg-muted/50 p-3 font-code text-xs whitespace-pre overflow-auto max-h-96">
              {JSON.stringify(task.payload, null, 2)}
            </pre>
          </div>
          <p className="text-sm text-warning">
            This payload is not the expected OCR extraction, so it is shown raw. The answer must
            include the keys: {task.resultRequiredKeys.join(", ")}.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        {!loading && extraction ? (
          <>
            <Button variant="outline" disabled={submitting} onClick={() => void autoApprove()}>
              <ZapIcon className="size-4" />
              <span className="mr-1">Auto-Approve</span>
            </Button>
            <Button disabled={filledRows.length === 0 || submitting} onClick={approveEdited}>
              {submitting ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <CheckIcon className="size-4" />
              )}
              <span className="mr-1">Approve &amp; Submit</span>
            </Button>
          </>
        ) : (
          !loading && (
            <Button disabled={submitting} onClick={approveFallback}>
              <CheckIcon className="size-4" />
              <span className="mr-1">Approve</span>
            </Button>
          )
        )}
      </DialogFooter>
    </>
  )
}
