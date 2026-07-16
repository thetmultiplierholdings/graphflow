"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ClockIcon, InboxIcon, LoaderIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { StatusBadge } from "@/app/components/status-badge"
import { ReviewTaskDialog } from "@/app/components/review-task-dialog"
import { openTasks, useHumanTaskStore } from "@/lib/stores/human-task-store"
import { useLedgerStore } from "@/lib/stores/ledger-store"
import { timeAgo } from "@/lib/graphflow/format"
import { type HumanTask } from "@/lib/schemas/human-task"

// The inbox IS Temporal visibility: every row is a waiting human-task
// workflow, polled every ~3s. Only open questions appear — an answered
// task drops off the list, and its answer lives in the engagement's Ledger
// tab as an insert-only fact.
export default function InboxPage() {
  const tasks = useHumanTaskStore((s) => s.tasks)
  const refreshTasks = useHumanTaskStore((s) => s.refreshTasks)
  const engagements = useLedgerStore((s) => s.engagements)
  const workspaces = useLedgerStore((s) => s.workspaces)
  const refreshEngagements = useLedgerStore((s) => s.refreshEngagements)
  const refreshWorkspace = useLedgerStore((s) => s.refreshWorkspace)

  const [loaded, setLoaded] = useState(false)
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)

  useEffect(() => {
    void Promise.allSettled([refreshTasks(), refreshEngagements()]).finally(() =>
      setLoaded(true)
    )
    const timer = setInterval(() => {
      void refreshTasks().catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [refreshTasks, refreshEngagements])

  // openTasks sorts soonest-created first.
  const open = useMemo(() => openTasks(tasks), [tasks])

  // "Requested by" links need workspace labels, which the mirror only has
  // after visiting an engagement — pull any missing ones on demand.
  useEffect(() => {
    const missing = new Set(
      open.flatMap((t) => t.requestedByWorkspaceIds).filter((wsId) => !workspaces[wsId])
    )
    for (const wsId of missing) void refreshWorkspace(wsId).catch(() => {})
  }, [open, workspaces, refreshWorkspace])

  const reviewTask: HumanTask | null = reviewTaskId ? (tasks[reviewTaskId] ?? null) : null

  const engagementChip = (engagementId: string) => (
    <StatusBadge color="neutral" variant="outline">
      {engagements[engagementId]?.label ?? `Engagement ${engagementId}`}
    </StatusBadge>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-5 border-b">
        <h1 className="font-heading text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open review questions across all engagements. Each distinct question is asked at most
          once per engagement — forever. Answers are filed to the engagement ledger.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-8">
        <section className="space-y-3">
          <h2 className="kicker">Open ({open.length})</h2>
          {!loaded ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Loading tasks…
            </div>
          ) : open.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>Inbox zero</EmptyTitle>
                <EmptyDescription>No open review questions.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="rounded-lg border divide-y">
              {open.map((task) => (
                <div key={task.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{task.displayName}</span>
                      {engagementChip(task.engagementId)}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {task.instructions}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
                      <span>
                        Requested by{" "}
                        {task.requestedByWorkspaceIds.map((wsId, i) => (
                          <Fragment key={wsId}>
                            {i > 0 && ", "}
                            <Link
                              href={`/workspaces/${wsId}`}
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              {workspaces[wsId]?.label ?? `workspace ${wsId}`}
                            </Link>
                          </Fragment>
                        ))}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="inline-flex items-center gap-1">
                        <ClockIcon className="size-3 shrink-0" />
                        <span suppressHydrationWarning>{timeAgo(task.createdAt)}</span>
                      </span>
                    </div>
                  </div>
                  <Button size="sm" className="shrink-0" onClick={() => setReviewTaskId(task.id)}>
                    Review
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <ReviewTaskDialog
        task={reviewTask}
        open={reviewTask !== null}
        onOpenChange={(o) => {
          if (!o) setReviewTaskId(null)
        }}
      />
    </div>
  )
}
