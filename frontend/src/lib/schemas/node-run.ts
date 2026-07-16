import { z } from "zod"

// Ledger row: a completed step — a memo entry saying "this exact question
// produced this exact answer". UNIQUE (engagementId, memoKey). Insert-only;
// recorded only when complete (nothing pending lives in the ledger).
export const NodeRunSchema = z.object({
  id: z.string(),
  engagementId: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  codeHash: z.string(),
  memoKey: z.string(),
  outputArtifactId: z.string(),
  inputArtifactIds: z.array(z.string()),
  temporalId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})

export type NodeRun = z.infer<typeof NodeRunSchema>
