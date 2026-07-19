import { z } from 'zod';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { JsonValueSchema } from '../domain/json/JsonValue.js';
import type { ArtifactMetaOut } from './Serializers.js';

// Request schemas plus the small response wire types not covered by the Serializers mappers.
// Extra body keys are ignored (zod strips unknown keys by default).

export const EngagementCreateSchema = z.object({ label: z.string().min(1) });

export const WorkspaceCreateSchema = z.object({
  workflow_id: z.string().min(1),
  label: z.string().min(1),
  copy_from: z.number().int().nullable().optional(),
});

export const WorkspacePatchSchema = z.object({
  label: z.string().nullable().optional(),
  workflow_id: z.string().nullable().optional(),
});

export const ArchiveBodySchema = z.object({ archived: z.boolean() });

export const AttachBodySchema = z.object({ artifact_id: z.number().int() });

export const ArtifactPatchSchema = z.object({ label: z.string().min(1) });

export const HumanTaskSubmitSchema = z.object({
  reviewer: z.string().min(1),
  result: z.record(z.string(), JsonValueSchema),
});

// Path param ids are typed int; non-integer ids yield the 422 validation-array error shape.
export const EngagementIdParamsSchema = z.object({ engagement_id: z.coerce.number().int() });
export const WorkflowRunIdParamsSchema = z.object({ workflow_run_id: z.coerce.number().int() });
export const ArtifactIdParamsSchema = z.object({ artifact_id: z.coerce.number().int() });
export const AttachmentParamsSchema = z.object({
  workflow_run_id: z.coerce.number().int(),
  artifact_id: z.coerce.number().int(),
});
export const TaskIdParamsSchema = z.object({ task_id: z.string().min(1) });

export const BrowseQuerySchema = z.object({ kind: z.string().optional(), q: z.string().optional() });
export const HumanTasksQuerySchema = z.object({ engagement_id: z.coerce.number().int().optional() });
export const ExecuteQuerySchema = z.object({ supersede: z.enum(['true', 'false', '1', '0']).optional() });

export const isSupersede = (value: 'true' | 'false' | '1' | '0' | undefined): boolean =>
  value === 'true' || value === '1';

// ---------- response wire types ----------

export interface CatalogKindOut {
  kind: string;
  display_name: string;
  // The authored birth channel (upload | questionnaire | email | computed).
  source: string;
  // Derived per workflow: no node of the workflow produces the kind.
  leaf: boolean;
}

export interface CatalogNodeOut {
  node_id: string;
  display_name: string | null;
  executor: string;
  output_kind: string;
  // The declared input ports: param -> consumed kind, or null for a scalar argument.
  input_kinds: Record<string, string | null>;
}

export interface CatalogWorkflowOut {
  workflow_id: string;
  display_name: string;
  // First publish / last change to the workflow ROW itself, i.e. its display_name (null until
  // one happens) — node/kind edits bump their own rows, not this. Workflow level only; kind/node
  // stamps stay db-only.
  created_at: string;
  updated_at: string | null;
  superseded_by: string | null;
  kinds: CatalogKindOut[];
  nodes: CatalogNodeOut[];
}

export interface CatalogOut {
  workflows: CatalogWorkflowOut[];
}

export interface UploadOut {
  artifact: ArtifactMetaOut;
  revived: boolean;
}

export interface ExecuteOut {
  temporal_workflow_id: string;
}

export interface StatusOut {
  status: 'idle' | 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface HumanTaskOut {
  task_id: string;
  engagement_id: number;
  workflow_id: string;
  node_id: string;
  output_kind: string;
  display_name: string;
  instructions: string;
  payload: Record<string, JsonValue>;
  result_required_keys: string[];
  requested_by_workflow_run: number;
  input_artifact_ids: number[];
  start_time: string | null;
}
