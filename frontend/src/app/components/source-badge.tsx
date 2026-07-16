"use client"

import { UserIcon, CpuIcon } from "lucide-react"
import { StatusBadge } from "./status-badge"

// Who put an artifact in the workspace: a user (feeds the run snapshot) or
// the engine (results on display). User attach promotes; engine never demotes.
export function SourceBadge({ source }: { source: "user" | "engine" }) {
  if (source === "user") {
    return (
      <StatusBadge color="primary" variant="outline">
        <UserIcon />
        User
      </StatusBadge>
    )
  }
  return (
    <StatusBadge color="neutral" variant="outline">
      <CpuIcon />
      Engine
    </StatusBadge>
  )
}
