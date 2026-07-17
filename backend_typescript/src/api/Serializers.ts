import type Database from 'better-sqlite3';
import type { ArtifactRow, EngagementRow, EngagementStats, NodeRunWithInputs } from '../infrastructure/db/Db.js';
import { getArtifact, getWorkspace, stats } from '../infrastructure/db/Db.js';

// Row→wire mappers. Wire keys stay snake_case per frontend-contract-spec, which is the contract.
// ArtifactMeta NEVER exposes payload_ref (or bytes); payload_available is derived from it.

export interface ArtifactMetaOut {
  artifact_id: number;
  engagement_id: number;
  hash: string;
  kind: string;
  label: string | null;
  media_type: string;
  byte_size: number;
  produced_by_node_run: number | null;
  created_by: string;
  created_at: string;
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
  code_hash: string;
  memo_key: string;
  temporal_id: string;
  input_artifact_ids: number[];
  output: ArtifactMetaOut;
}

export interface WorkspaceDetailOut {
  workflow_run_id: number;
  engagement_id: number;
  workflow_id: string;
  label: string;
  copied_from_workflow_run: number | null;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  members: MemberOut[];
}

export interface EngagementOut extends EngagementRow {
  stats: EngagementStats;
}

export function artifactMeta(row: ArtifactRow): ArtifactMetaOut {
  return {
    artifact_id: row.artifact_id,
    engagement_id: row.engagement_id,
    hash: row.hash,
    kind: row.kind,
    label: row.label,
    media_type: row.media_type,
    byte_size: row.byte_size,
    produced_by_node_run: row.produced_by_node_run,
    created_by: row.created_by,
    created_at: row.created_at,
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
    code_hash: run.code_hash,
    memo_key: run.memo_key,
    temporal_id: run.temporal_id,
    input_artifact_ids: run.input_artifact_ids,
    output: artifactMeta(output),
  };
}

interface MemberRow extends ArtifactRow {
  source: 'user' | 'engine';
  added_by: string;
  added_at: string;
}

const MEMBERS_SQL = `
  SELECT a.*, wra.source, wra.added_by, wra.added_at
  FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id)
  WHERE wra.workflow_run_id=? ORDER BY wra.added_at, a.artifact_id`;

export function workspaceDetail(conn: Database.Database, workflowRunId: number): WorkspaceDetailOut {
  const ws = getWorkspace(conn, workflowRunId);
  const members = conn.prepare<[number], MemberRow>(MEMBERS_SQL).all(workflowRunId);
  return {
    workflow_run_id: ws.workflow_run_id,
    engagement_id: ws.engagement_id,
    workflow_id: ws.workflow_id,
    label: ws.label,
    copied_from_workflow_run: ws.copied_from_workflow_run,
    archived_at: ws.archived_at,
    created_by: ws.created_by,
    created_at: ws.created_at,
    members: members.map((m) => ({
      ...artifactMeta(m),
      source: m.source,
      added_by: m.added_by,
      added_at: m.added_at,
    })),
  };
}

export function engagementOut(conn: Database.Database, row: EngagementRow): EngagementOut {
  return { ...row, stats: stats(conn, row.engagement_id) };
}
