import { create } from "zustand"
import type { WorkflowInfo } from "@/lib/graphflow/catalog"
import { fetchCatalog } from "@/lib/api/client"

// Mirror of GET /catalog — the published workflow files. Hydrated once per
// session (refresh() is cheap and idempotent; pages call it on mount).

interface CatalogStore {
  workflows: Record<string, WorkflowInfo>
  loaded: boolean
  refresh: () => Promise<void>
}

export const useCatalogStore = create<CatalogStore>()((set) => ({
  workflows: {},
  loaded: false,

  refresh: async () => {
    const list = await fetchCatalog()
    set({
      workflows: Object.fromEntries(list.map((wf) => [wf.workflowId, wf])),
      loaded: true,
    })
  },
}))
