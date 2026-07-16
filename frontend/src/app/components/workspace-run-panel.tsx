"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import {
  CheckIcon,
  CircleIcon,
  CpuIcon,
  FlagIcon,
  UserIcon,
  XIcon,
  ZapIcon,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RunStatusBadge } from "./run-status-badge"
import { StatusBadge } from "./status-badge"
import { formatDateTime } from "@/lib/graphflow/format"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { useCatalogStore } from "@/lib/stores/catalog-store"
import { useRunStore, type RunEventType } from "@/lib/stores/run-store"
import { cn } from "@/lib/utils"

// The watch-it-run experience: live node tallies and an event feed streamed
// from the API's SSE progress endpoint. This is where the memo-hit story
// becomes visible — re-running February flashes six chains by as memo hits
// and only the new documents execute.

function eventTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function EventIcon({ type }: { type: RunEventType }) {
  const cls = "size-3.5 shrink-0 mt-0.5"
  switch (type) {
    case "memo-hit":
      return <ZapIcon className={cn(cls, "text-primary")} />
    case "node-completed":
      return <CheckIcon className={cn(cls, "text-success")} />
    case "human-task-opened":
      return <UserIcon className={cn(cls, "text-warning")} />
    case "run-failed":
      return <XIcon className={cn(cls, "text-destructive")} />
    case "run-started":
      return <CircleIcon className={cn(cls, "text-muted-foreground")} />
    case "run-completed":
      return <FlagIcon className={cn(cls, "text-muted-foreground")} />
  }
}

interface WorkspaceRunPanelProps {
  workspaceId: string
}

export function WorkspaceRunPanel({ workspaceId }: WorkspaceRunPanelProps) {
  const workspace = useLedgerStore((s) => s.workspaces[workspaceId])
  const hasResults = useLedgerStore((s) =>
    Object.values(s.workspaceArtifacts).some(
      (wa) => wa.workspaceId === workspaceId && wa.source === "engine"
    )
  )
  const workflow = useCatalogStore((s) =>
    workspace ? s.workflows[workspace.workflowId] : undefined
  )
  const run = useRunStore((s) => s.runs[workspaceId])

  // Auto-scroll the event feed to the newest entry.
  const feedRef = useRef<HTMLDivElement>(null)
  const eventCount = run?.events.length ?? 0
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [eventCount])

  if (!workspace) return null

  if (!run) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No run this session. A workspace&rsquo;s status is derived, never stored — facts already
          in the ledger stay filed.
        </p>
        {hasResults && (
          <p className="mt-1 text-sm text-muted-foreground">
            Re-running memo-hits everything already answered.
          </p>
        )}
      </div>
    )
  }

  const nodes = workflow?.nodes ?? []
  const totalWaiting = Object.values(run.tallies).reduce((sum, t) => sum + t.waitingHuman, 0)
  const finished = run.status !== "running" && run.finishedAt !== null

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-3">
          Run Activity
          <RunStatusBadge status={run.status} />
        </CardTitle>
        <CardDescription>
          Started {formatDateTime(run.startedAt)}
          {finished && (
            <>
              {" · "}
              <span className="text-foreground font-medium">
                {run.summary.executed.length} executed
              </span>
              {" · "}
              <span className="text-foreground font-medium">
                {run.summary.memoHits.length} memo hits
              </span>
              {" · "}
              <span className="text-foreground font-medium">
                {run.summary.humanWaits.length} human questions asked
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {run.status === "failed" && run.error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-muted px-3 py-2.5">
            <XIcon className="size-4 shrink-0 mt-0.5 text-destructive" />
            <p className="text-sm text-destructive-strong">{run.error}</p>
          </div>
        )}

        {/* Node progress, in workflow declaration order */}
        <div className="space-y-1.5">
          <h3 className="kicker text-muted-foreground">Node Progress</h3>
          {nodes.map((node) => {
            const tally = run.tallies[node.nodeId]
            const active =
              tally && (tally.executed > 0 || tally.memoHits > 0 || tally.waitingHuman > 0)
            return (
              <div
                key={node.nodeId}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                {node.executor === "engine" ? (
                  <CpuIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <UserIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="text-sm flex-1 truncate">{node.displayName}</span>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {active ? (
                    <>
                      {tally.executed > 0 && (
                        <StatusBadge color="success" variant="muted">
                          {tally.executed} executed
                        </StatusBadge>
                      )}
                      {tally.memoHits > 0 && (
                        <StatusBadge color="primary" variant="muted">
                          {tally.memoHits} memo hits
                        </StatusBadge>
                      )}
                      {tally.waitingHuman > 0 && (
                        <StatusBadge color="warning" variant="muted">
                          {tally.waitingHuman} waiting on reviewer
                        </StatusBadge>
                      )}
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {totalWaiting > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-info-muted px-3 py-2.5 text-sm text-info-strong">
            <UserIcon className="size-4 shrink-0" />
            <span>
              Waiting on {totalWaiting} reviewer answer{totalWaiting === 1 ? "" : "s"} —{" "}
              <Link href="/inbox" className="font-medium underline underline-offset-2">
                open the Inbox
              </Link>{" "}
              to review.
            </span>
          </div>
        )}

        {/* Event feed — newest last, auto-scrolled */}
        <div className="space-y-1.5">
          <h3 className="kicker text-muted-foreground">Event Feed</h3>
          <div
            ref={feedRef}
            className="max-h-64 overflow-y-auto rounded-lg border bg-muted/30 p-1.5 space-y-0.5"
          >
            {run.events.map((event) => (
              <div key={event.id} className="flex items-start gap-2 rounded-md px-2 py-1">
                <span className="font-code text-xs text-muted-foreground shrink-0 pt-0.5">
                  {eventTime(event.at)}
                </span>
                <EventIcon type={event.type} />
                <span className="text-sm min-w-0">{event.message}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
