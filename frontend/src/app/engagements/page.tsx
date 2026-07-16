"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { FolderLockIcon, LoaderIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/app/components/status-badge"
import { NewEngagementDialog } from "@/app/components/new-engagement-dialog"
import { ledgerSelectors, useLedgerStore } from "@/lib/stores/ledger-store"
import { useHumanTaskStore } from "@/lib/stores/human-task-store"
import { formatDate } from "@/lib/graphflow/format"

export default function EngagementsPage() {
  const router = useRouter()
  const ledger = useLedgerStore()
  const tasks = useHumanTaskStore((s) => s.tasks)
  const refreshTasks = useHumanTaskStore((s) => s.refreshTasks)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refreshEngagements = ledger.refreshEngagements
  useEffect(() => {
    void Promise.allSettled([refreshEngagements(), refreshTasks()]).finally(() =>
      setLoaded(true)
    )
  }, [refreshEngagements, refreshTasks])

  const engagements = useMemo(
    () =>
      Object.values(ledger.engagements).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [ledger.engagements]
  )

  // Every listed task is open — visibility only ever returns waiting tasks.
  const openTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const task of Object.values(tasks)) {
      counts[task.engagementId] = (counts[task.engagementId] ?? 0) + 1
    }
    return counts
  }, [tasks])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-semibold">Engagements</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Each engagement is an isolated ledger — nothing is shared across them.
            </p>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <PlusIcon className="size-4" />
            <span className="ml-1">New Engagement</span>
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading engagements…
          </div>
        ) : engagements.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderLockIcon />
              </EmptyMedia>
              <EmptyTitle>No Engagements Yet</EmptyTitle>
              <EmptyDescription>
                Create an engagement to open an isolated ledger for a client and a year of work.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <PlusIcon className="size-4" />
                <span className="ml-1">New Engagement</span>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Workspaces</TableHead>
                  <TableHead>Artifacts</TableHead>
                  <TableHead>Completed Steps</TableHead>
                  <TableHead>Human Answers</TableHead>
                  <TableHead>Open Tasks</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {engagements.map((eng) => {
                  const stats = ledgerSelectors.engagementStats(ledger, eng.id)
                  const openCount = openTaskCounts[eng.id] ?? 0
                  return (
                    <TableRow
                      key={eng.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/engagements/${eng.id}`)}
                    >
                      <TableCell className="font-medium">{eng.label}</TableCell>
                      <TableCell>{stats.workspaces}</TableCell>
                      <TableCell>{stats.artifacts}</TableCell>
                      <TableCell>{stats.nodeRuns}</TableCell>
                      <TableCell>{stats.humanAnswers}</TableCell>
                      <TableCell>
                        {openCount > 0 ? (
                          <StatusBadge color="destructive" variant="muted">
                            {openCount} Open
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(eng.createdAt)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <NewEngagementDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
