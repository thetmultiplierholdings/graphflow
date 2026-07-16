"use client"

import { StatusBadge } from "./status-badge"
import { useCatalogStore } from "@/lib/stores/catalog-store"

// One colour per artifact kind so documents, intermediates and deliverables
// scan apart at a glance.
const KIND_COLORS: Record<string, "neutral" | "primary" | "warning" | "success" | "destructive" | "info"> = {
  brokerage_statement: "info",
  payment_slip: "info",
  ocr_txns: "neutral",
  verified_txns: "warning",
  master_txn_list: "neutral",
  tax_calc: "primary",
  final_report: "success",
}

export function KindBadge({ kind, workflowId }: { kind: string; workflowId?: string }) {
  // Subscribes to the catalog mirror so labels appear once /catalog loads.
  const workflows = useCatalogStore((s) => s.workflows)
  const lookup = (wfId: string) => workflows[wfId]?.kinds.find((k) => k.kind === kind)?.display
  const label =
    (workflowId ? lookup(workflowId) : undefined) ??
    Object.keys(workflows)
      .map(lookup)
      .find((d) => d !== undefined) ??
    kind
  return (
    <StatusBadge color={KIND_COLORS[kind] ?? "neutral"} variant="muted">
      {label}
    </StatusBadge>
  )
}
