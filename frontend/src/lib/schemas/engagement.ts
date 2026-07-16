import { z } from "zod"

// The isolation boundary. Memo entries and artifacts are never shared
// across engagements — ever.
export const EngagementSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
})

export type Engagement = z.infer<typeof EngagementSchema>

// Aggregate counts the API returns alongside engagement rows.
export interface EngagementStats {
  workspaces: number
  artifacts: number
  nodeRuns: number
  humanAnswers: number
}

export const EMPTY_STATS: EngagementStats = {
  workspaces: 0,
  artifacts: 0,
  nodeRuns: 0,
  humanAnswers: 0,
}
