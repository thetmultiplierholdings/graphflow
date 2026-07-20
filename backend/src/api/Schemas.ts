import { z } from 'zod';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { JsonValueSchema } from '../domain/json/JsonValue.js';
import type { ArtifactMetaOut } from './Serializers.js';

// Request schemas plus the small response wire types not covered by the Serializers mappers.
// Extra body keys are ignored (zod strips unknown keys by default).

export const EngagementCreateSchema = z.object({ display_name: z.string().min(1) });

export const WorkflowRunCreateSchema = z.object({
  workflow_id: z.string().min(1),
  display_name: z.string().min(1),
  copy_from: z.number().int().nullable().optional(),
  // What the create MEANS. Defaults (resolveLineageKind in Db.ts): 'root' without copy_from,
  // 'copy' with. 'copy' starts a new family (may target a different workflow);
  // 'revision'/'simulation' extend the parent's family and must keep its workflow.
  lineage_kind: z.enum(['root', 'copy', 'revision', 'simulation']).optional(),
});

// workflow_id is immutable after create (a different DAG is a root-class copy, never a
// re-point) — PATCH accepts display_name only. Unknown keys are zod-stripped, so a stale client
// sending workflow_id is silently ignored rather than 422'd. min(1) matches the create schema:
// an empty name would corrupt the derived lineage_display of the whole family.
export const WorkflowRunPatchSchema = z.object({
  display_name: z.string().min(1).nullable().optional(),
});

export const ArchiveBodySchema = z.object({ archived: z.boolean() });

export const AttachBodySchema = z.object({ artifact_id: z.number().int() });

export const ArtifactPatchSchema = z.object({ display_name: z.string().min(1) });

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

export const BrowseQuerySchema = z.object({ nodeparamslot: z.string().optional(), q: z.string().optional() });
export const HumanTasksQuerySchema = z.object({ engagement_id: z.coerce.number().int().optional() });

// ---------- response wire types ----------

export interface CatalogNodeparamslotOut {
  nodeparamslot: string;
  display_name: string;
  // The authored birth channel (upload | questionnaire | email | computed).
  source: string;
  // Derived per workflow: no node of the workflow produces the nodeparamslot.
  leaf: boolean;
}

export interface CatalogNodeOut {
  node_id: string;
  display_name: string | null;
  executor: string;
  output_nodeparamslot: string;
  // The declared input ports: param -> consumed nodeparamslot, or null for a scalar argument.
  input_nodeparamslots: Record<string, string | null>;
}

export interface CatalogWorkflowOut {
  workflow_id: string;
  display_name: string;
  // First publish / last change to the workflow ROW itself, i.e. its display_name (null until
  // one happens) — node/nodeparamslot edits bump their own rows, not this. Workflow level only; nodeparamslot/node
  // stamps stay db-only.
  created_at: string;
  updated_at: string | null;
  superseded_by: string | null;
  nodeparamslots: CatalogNodeparamslotOut[];
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
  output_nodeparamslot: string;
  display_name: string;
  instructions: string;
  payload: Record<string, JsonValue>;
  result_required_keys: string[];
  requested_by_workflow_run: number;
  input_artifact_ids: number[];
  start_time: string | null;
}
