"use client"

import { CheckIcon, CircleIcon, LoaderIcon, XIcon } from "lucide-react"
import { StatusBadge } from "./status-badge"

export type WorkspaceRunStatus = "idle" | "running" | "completed" | "failed"

// A workspace's status is derived, never stored (invariant I4): it reflects
// the in-memory run, exactly as the real system derives it from Temporal.
export function RunStatusBadge({ status }: { status: WorkspaceRunStatus }) {
  if (status === "running") {
    return (
      <StatusBadge color="info" variant="muted">
        <LoaderIcon className="animate-spin" />
        Running
      </StatusBadge>
    )
  }
  if (status === "completed") {
    return (
      <StatusBadge color="success" variant="muted">
        <CheckIcon />
        Completed
      </StatusBadge>
    )
  }
  if (status === "failed") {
    return (
      <StatusBadge color="destructive" variant="muted">
        <XIcon />
        Failed
      </StatusBadge>
    )
  }
  return (
    <StatusBadge color="neutral" variant="muted">
      <CircleIcon />
      Idle
    </StatusBadge>
  )
}
