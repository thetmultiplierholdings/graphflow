import { create } from "zustand"
import { listHumanTasks } from "@/lib/api/client"
import { type HumanTask } from "@/lib/schemas/human-task"

// Mirror of Temporal visibility: the inbox IS "list open task workflows",
// not a database table. Each refresh replaces the map wholesale — a task
// that disappears between refreshes was answered (its answer is a ledger
// fact, visible in the engagement's Ledger tab). Polled by the sidebar
// badge (~5s) and the inbox (~3s).

interface HumanTaskStore {
  tasks: Record<string, HumanTask>
  loaded: boolean
  refreshTasks: (engagementId?: string) => Promise<void>
}

export const useHumanTaskStore = create<HumanTaskStore>()((set) => ({
  tasks: {},
  loaded: false,

  refreshTasks: async (engagementId?: string) => {
    const list = await listHumanTasks(engagementId)
    set({ tasks: Object.fromEntries(list.map((t) => [t.id, t])), loaded: true })
  },
}))

// Every listed task IS open (visibility only ever returns waiting task
// workflows) — this just sorts them soonest-created first.
export function openTasks(tasks: Record<string, HumanTask>): HumanTask[] {
  return Object.values(tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
