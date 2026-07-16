import { z } from "zod"

// A workflow_runs row — editable intent, never facts. "The January estimate"
// is a workspace plus the artifacts it holds. Never deleted (provenance via
// copiedFromId must survive); archiving hides it.
export const WorkspaceSchema = z.object({
  id: z.string(),
  engagementId: z.string(),
  workflowId: z.string(),
  label: z.string(),
  copiedFromId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
})

export type Workspace = z.infer<typeof WorkspaceSchema>

// Membership row: which artifacts a workspace holds, and who put them there.
// source='user' rows feed the run snapshot; source='engine' rows are results
// on display. User attach promotes engine rows; engine attach never demotes.
// Detaching one of these is the ONLY delete in the system.
export const WorkspaceArtifactSchema = z.object({
  workspaceId: z.string(),
  artifactId: z.string(),
  source: z.enum(["user", "engine"]),
  addedBy: z.string(),
  addedAt: z.string(),
})

export type WorkspaceArtifact = z.infer<typeof WorkspaceArtifactSchema>

export function membershipKey(workspaceId: string, artifactId: string): string {
  return `${workspaceId}:${artifactId}`
}
