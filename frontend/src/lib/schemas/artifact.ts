import { z } from "zod"

// Ledger row: immutable, content-addressed. The one mutable column is
// `label` (display rename; never hashed). UNIQUE (engagementId, kind, hash).
// Payload bytes live in the backend's object storage — the API only ever
// serves metadata (payloadAvailable) plus a separate /content endpoint.
export const ArtifactSchema = z.object({
  id: z.string(),
  engagementId: z.string(),
  hash: z.string(),
  kind: z.string(),
  label: z.string(),
  mediaType: z.string(),
  byteSize: z.number(),
  payloadAvailable: z.boolean(), // false = payload destroyed per policy
  producedByNodeRunId: z.string().nullable(), // null = user-supplied
  createdBy: z.string(),
  createdAt: z.string(),
})

export type Artifact = z.infer<typeof ArtifactSchema>

// The reference form passed around (never the bytes).
export interface ArtifactRef {
  artifactId: string
  hash: string
  kind: string
  label: string
  mediaType: string
}

export function toRef(a: Artifact): ArtifactRef {
  return {
    artifactId: a.id,
    hash: a.hash,
    kind: a.kind,
    label: a.label,
    mediaType: a.mediaType,
  }
}
