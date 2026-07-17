"""Shared dependencies + row -> contract-shape mappers.

SQLite connections are opened per request and closed after (the db is tiny;
sync work inside async routes is done inline and quick). Temporal client and
instance id live on app.state (set once in the lifespan)."""

from __future__ import annotations

import os
import sqlite3

from fastapi import HTTPException, Request

from engine import db as dbm


def env_db_path() -> str:
    return os.environ.get("GRAPHFLOW_DB", "graphflow.sqlite3")


def env_storage_root() -> str:
    return os.environ.get("GRAPHFLOW_STORAGE", "mock_s3_gcs")


def env_embed_worker() -> bool:
    return os.environ.get("GRAPHFLOW_EMBED_WORKER", "1") != "0"


def request_connect(db_path: str) -> sqlite3.Connection:
    """dbm.connect with check_same_thread=False: FastAPI resolves sync
    dependencies in a threadpool thread, then async routes touch the conn on
    the event-loop thread. Each request uses its connection strictly
    sequentially, so cross-thread handoff is safe."""
    conn = sqlite3.connect(
        db_path, timeout=15, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def get_db(request: Request):
    conn = request_connect(request.app.state.db_path)
    try:
        yield conn
    finally:
        conn.close()


def or_404(fn, *args, **kwargs):
    """engine.db getters raise KeyError('x not found') for missing rows."""
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail=str(exc.args[0]) if exc.args else "not found"
        )


def artifact_meta(row: sqlite3.Row | dict) -> dict:
    """ArtifactMeta per the contract: payload_available, NEVER the payload."""
    return {
        "artifact_id": row["artifact_id"],
        "engagement_id": row["engagement_id"],
        "hash": row["hash"],
        "kind": row["kind"],
        "label": row["label"],
        "media_type": row["media_type"],
        "byte_size": row["byte_size"],
        "produced_by_node_run": row["produced_by_node_run"],
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "payload_available": row["payload_ref"] is not None,
    }


def node_run_out(conn: sqlite3.Connection, run: dict) -> dict:
    """NodeRunOut: ledger fact + its output as ArtifactMeta (answered-by/when
    come from the output artifact's created_by/created_at)."""
    out_art = dbm.get_artifact(conn, run["output_artifact_id"])
    return {
        "node_run_id": run["node_run_id"],
        "workflow_id": run["workflow_id"],
        "node_id": run["node_id"],
        "code_hash": run["code_hash"],
        "memo_key": run["memo_key"],
        "temporal_id": run["temporal_id"],
        "input_artifact_ids": run["input_artifact_ids"],
        "output": artifact_meta(out_art),
    }


def workspace_detail(conn: sqlite3.Connection, workflow_run_id: int) -> dict:
    """GET /workflow-runs/{id}: workspace fields + members
    (ArtifactMeta + {source, added_by, added_at})."""
    ws = or_404(dbm.get_workspace, conn, workflow_run_id)
    rows = conn.execute(
        "SELECT a.*, wra.source, wra.added_by, wra.added_at "
        "FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id) "
        "WHERE wra.workflow_run_id=? ORDER BY wra.added_at, a.artifact_id",
        (workflow_run_id,),
    ).fetchall()
    members = [
        dict(artifact_meta(r), source=r["source"], added_by=r["added_by"], added_at=r["added_at"])
        for r in rows
    ]
    return dict(ws, members=members)
