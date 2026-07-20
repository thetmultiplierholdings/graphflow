import type Database from 'better-sqlite3';
import type {
  ArtifactFactsRow,
  ArtifactOrigin,
  EngagementRow,
  EngagementStats,
  LineageKind,
  NodeRunWithInputs,
  WorkflowRunListRow,
} from '../infrastructure/db/Db.js';
import { getArtifact, getWorkflowRun, stats } from '../infrastructure/db/Db.js';

// Row→wire mappers. Wire keys stay snake_case per frontend-contract-spec, which is the contract —
// with ONE documented exception: membership stamps are aliased (wra.created_by AS added_by,
// wra.created_at AS added_at), because a member row joins the artifact's own created_* with the
// membership's and the two would silently collide in the joined row (better-sqlite3 keeps the
// last duplicate column). deleted_at (dormant) never goes on the wire; every mapper here is an
// explicit projection, so a new column reaches the wire only by being added deliberately.
// ArtifactMeta NEVER exposes payload_ref (or bytes); payload_available is derived from it.
// produced_by_node_run and origin are DERIVED by the artifact_facts view — the wire key survives
// the stored column's deletion unchanged.

export interface ArtifactMetaOut {
  artifact_id: number;
  engagement_id: number;
  hash: string;
  nodeparamslot: string;
  display_name: string | null;
  media_type: string;
  byte_size: number;
  produced_by_node_run: number | null;
  origin: ArtifactOrigin;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  payload_available: boolean;
}

export interface MemberOut extends ArtifactMetaOut {
  source: 'user' | 'engine';
  added_by: string;
  added_at: string;
}

export interface NodeRunOut {
  node_run_id: number;
  workflow_id: string;
  node_id: string;
  memo_key: string;
  temporal_id: string;
  created_by: string;
  created_at: string;
  input_artifact_ids: number[];
  output: ArtifactMetaOut;
}

// lineage_kind/executed_at are stored; root_workflow_run_id/lineage_byid/lineage_display are
// DERIVED by the workflow_run_facts view (lineage_depth deliberately stays db-only). executed_at
// non-null = frozen: attachments immutable, further work is a copy/revision/simulation.
export interface WorkflowRunDetailOut {
  workflow_run_id: number;
  engagement_id: number;
  workflow_id: string;
  display_name: string;
  copied_from_workflow_run: number | null;
  lineage_kind: LineageKind;
  executed_at: string | null;
  root_workflow_run_id: number;
  lineage_byid: string;
  lineage_display: string;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  members: MemberOut[];
}

// The workflow-run list row: WorkflowRunDetailOut minus members, plus the member counts.
export interface WorkflowRunListOut {
  workflow_run_id: number;
  engagement_id: number;
  workflow_id: string;
  display_name: string;
  copied_from_workflow_run: number | null;
  lineage_kind: LineageKind;
  executed_at: string | null;
  root_workflow_run_id: number;
  lineage_byid: string;
  lineage_display: string;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  user_docs: number;
  engine_results: number;
}

export interface EngagementOut {
  engagement_id: number;
  display_name: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  stats: EngagementStats;
}

export function artifactMeta(row: ArtifactFactsRow): ArtifactMetaOut {
  return {
    artifact_id: row.artifact_id,
    engagement_id: row.engagement_id,
    hash: row.hash,
    nodeparamslot: row.nodeparamslot,
    display_name: row.display_name,
    media_type: row.media_type,
    byte_size: row.byte_size,
    produced_by_node_run: row.produced_by_node_run,
    origin: row.origin,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    payload_available: row.payload_ref !== null,
  };
}

// engagement_id/output_artifact_id are NOT top-level: engagement is implicit, the output artifact
// id lives inside output.artifact_id ("the answered-by/when of a fact IS the answer artifact's
// provenance").
export function nodeRunOut(conn: Database.Database, run: NodeRunWithInputs): NodeRunOut {
  const output = getArtifact(conn, run.output_artifact_id);
  return {
    node_run_id: run.node_run_id,
    workflow_id: run.workflow_id,
    node_id: run.node_id,
    memo_key: run.memo_key,
    temporal_id: run.temporal_id,
    created_by: run.created_by,
    created_at: run.created_at,
    input_artifact_ids: run.input_artifact_ids,
    output: artifactMeta(output),
  };
}

interface MemberRow extends ArtifactFactsRow {
  source: 'user' | 'engine';
  added_by: string;
  added_at: string;
}

// The aliases are mandatory, not cosmetic: unaliased wra.created_* would silently clobber the
// artifact's created_* in the joined row (last duplicate column wins). Members list in
// first-attach order — promotion stamps the membership's updated_* (db-only; `source` already
// signals promotion on the wire) and no longer re-sorts the member.
const MEMBERS_SQL = `
  SELECT a.*, wra.source, wra.created_by AS added_by, wra.created_at AS added_at
  FROM workflow_run_artifacts wra JOIN artifact_facts a USING (artifact_id)
  WHERE wra.workflow_run_id=? ORDER BY wra.created_at, a.artifact_id`;

export function workflowRunDetail(conn: Database.Database, workflowRunId: number): WorkflowRunDetailOut {
  const run = getWorkflowRun(conn, workflowRunId);
  const members = conn.prepare<[number], MemberRow>(MEMBERS_SQL).all(workflowRunId);
  return {
    workflow_run_id: run.workflow_run_id,
    engagement_id: run.engagement_id,
    workflow_id: run.workflow_id,
    display_name: run.display_name,
    copied_from_workflow_run: run.copied_from_workflow_run,
    lineage_kind: run.lineage_kind,
    executed_at: run.executed_at,
    root_workflow_run_id: run.root_workflow_run_id,
    lineage_byid: run.lineage_byid,
    lineage_display: run.lineage_display,
    archived_at: run.archived_at,
    created_by: run.created_by,
    created_at: run.created_at,
    updated_by: run.updated_by,
    updated_at: run.updated_at,
    members: members.map((m) => ({
      ...artifactMeta(m),
      source: m.source,
      added_by: m.added_by,
      added_at: m.added_at,
    })),
  };
}

export function workflowRunListOut(row: WorkflowRunListRow): WorkflowRunListOut {
  return {
    workflow_run_id: row.workflow_run_id,
    engagement_id: row.engagement_id,
    workflow_id: row.workflow_id,
    display_name: row.display_name,
    copied_from_workflow_run: row.copied_from_workflow_run,
    lineage_kind: row.lineage_kind,
    executed_at: row.executed_at,
    root_workflow_run_id: row.root_workflow_run_id,
    lineage_byid: row.lineage_byid,
    lineage_display: row.lineage_display,
    archived_at: row.archived_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    user_docs: row.user_docs,
    engine_results: row.engine_results,
  };
}

export function engagementOut(conn: Database.Database, row: EngagementRow): EngagementOut {
  return {
    engagement_id: row.engagement_id,
    display_name: row.display_name,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    stats: stats(conn, row.engagement_id),
  };
}
