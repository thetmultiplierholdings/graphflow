import { z } from "zod"

// Mirror of a waiting GraphflowHumanTask Temporal workflow (the inbox IS
// Temporal visibility, not a ledger table). One waiting task per distinct
// human question per engagement. Only OPEN tasks are ever listed — a task
// disappears from visibility the moment it is answered; the answer itself
// lives in the ledger as a node run.
export const HumanTaskSchema = z.object({
  id: z.string(), // the Temporal workflow id
  engagementId: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  outputKind: z.string(),
  displayName: z.string(),
  instructions: z.string(),
  // Payload rendered to the reviewer; artifact values appear as
  // { __artifact__: ArtifactRef } exactly like the Temporal transport form.
  payload: z.record(z.string(), z.unknown()),
  resultRequiredKeys: z.array(z.string()),
  requestedByWorkspaceIds: z.array(z.string()),
  inputArtifactIds: z.array(z.string()),
  createdAt: z.string(),
})

export type HumanTask = z.infer<typeof HumanTaskSchema>
