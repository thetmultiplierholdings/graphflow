"""Workspace routes: detail, rename/repoint, archive, attach/detach,
execute (202), derived status, and the SSE progress stream.

Status is derived, never stored: Temporal describe on
wfrun-{instance}-{id}; a missing execution means the workspace was simply
never executed -> "idle", never a 500."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from temporalio.client import WorkflowExecutionStatus, WorkflowHandle
from temporalio.service import RPCError, RPCStatusCode

from api import schemas
from api.deps import get_db, or_404, workspace_detail
from engine import db as dbm
from engine import runtime

router = APIRouter(tags=["workflow-runs"])

_STATUS_MAP = {
    WorkflowExecutionStatus.RUNNING: "running",
    WorkflowExecutionStatus.CONTINUED_AS_NEW: "running",
    WorkflowExecutionStatus.COMPLETED: "completed",
    WorkflowExecutionStatus.FAILED: "failed",
    WorkflowExecutionStatus.TERMINATED: "failed",
    WorkflowExecutionStatus.CANCELED: "failed",
    WorkflowExecutionStatus.TIMED_OUT: "failed",
}


# ---------- workspace CRUD ----------

@router.get("/workflow-runs/{workflow_run_id}")
def get_workflow_run(workflow_run_id: int, conn=Depends(get_db)) -> dict:
    return workspace_detail(conn, workflow_run_id)


@router.patch("/workflow-runs/{workflow_run_id}")
def patch_workflow_run(
    workflow_run_id: int, body: schemas.WorkspacePatch, conn=Depends(get_db)
) -> dict:
    or_404(dbm.get_workspace, conn, workflow_run_id)
    if body.workflow_id is not None:
        known = conn.execute(
            "SELECT 1 FROM workflows WHERE workflow_id=?", (body.workflow_id,)
        ).fetchone()
        if known is None:
            raise HTTPException(
                status_code=422, detail=f"workflow {body.workflow_id!r} is not in the catalog"
            )
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "UPDATE workflow_runs SET label=COALESCE(?, label), "
        "workflow_id=COALESCE(?, workflow_id) WHERE workflow_run_id=?",
        (body.label, body.workflow_id, workflow_run_id),
    )
    conn.execute("COMMIT")
    return workspace_detail(conn, workflow_run_id)


@router.post("/workflow-runs/{workflow_run_id}/archive")
def archive_workflow_run(
    workflow_run_id: int, body: schemas.ArchiveBody, conn=Depends(get_db)
) -> dict:
    or_404(dbm.get_workspace, conn, workflow_run_id)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "UPDATE workflow_runs SET archived_at=? WHERE workflow_run_id=?",
        (dbm.now_iso() if body.archived else None, workflow_run_id),
    )
    conn.execute("COMMIT")
    return workspace_detail(conn, workflow_run_id)


@router.post("/workflow-runs/{workflow_run_id}/attachments", status_code=204)
def attach_artifact(
    workflow_run_id: int, body: schemas.AttachBody, conn=Depends(get_db)
) -> Response:
    """Attach or promote to user-sourced (engine rows never demote)."""
    ws = or_404(dbm.get_workspace, conn, workflow_run_id)
    art = or_404(dbm.get_artifact, conn, body.artifact_id)
    if art["engagement_id"] != ws["engagement_id"]:
        raise HTTPException(
            status_code=422, detail="artifact belongs to a different engagement"
        )
    dbm.attach(conn, workflow_run_id, body.artifact_id, source="user", added_by="user")
    return Response(status_code=204)


@router.delete("/workflow-runs/{workflow_run_id}/attachments/{artifact_id}", status_code=204)
def detach_artifact(workflow_run_id: int, artifact_id: int, conn=Depends(get_db)) -> Response:
    """The only delete in the system."""
    or_404(dbm.get_workspace, conn, workflow_run_id)
    dbm.detach(conn, workflow_run_id, artifact_id)
    return Response(status_code=204)


# ---------- execution ----------

@router.post("/workflow-runs/{workflow_run_id}/execute", status_code=202)
async def execute_workflow_run(
    workflow_run_id: int, request: Request, supersede: bool = False
) -> dict:
    db_path = request.app.state.db_path
    conn = dbm.connect(db_path)
    try:
        or_404(dbm.get_workspace, conn, workflow_run_id)
        # An empty snapshot is legal to the engine (all-optional workflows),
        # but for this product a run with zero documents is always a mistake.
        if not dbm.user_attachments(conn, workflow_run_id):
            raise HTTPException(
                status_code=422,
                detail="this workspace has no documents attached — attach at "
                "least one before running",
            )
    finally:
        conn.close()
    try:
        handle = await runtime.start_workspace(
            request.app.state.client, db_path, workflow_run_id, supersede=supersede
        )
    except runtime.SnapshotChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except RuntimeError as exc:  # e.g. workflow not in catalog
        raise HTTPException(status_code=422, detail=str(exc))
    return {"temporal_workflow_id": handle.id}


def _run_handle(request: Request, workflow_run_id: int) -> WorkflowHandle:
    conn = dbm.connect(request.app.state.db_path)
    try:
        or_404(dbm.get_workspace, conn, workflow_run_id)
    finally:
        conn.close()
    wf_id = runtime.workspace_temporal_id(request.app.state.instance, workflow_run_id)
    return request.app.state.client.get_workflow_handle(wf_id)


async def _failure_message(handle: WorkflowHandle) -> str:
    """Best-effort error from the close event; generic if anything gets in the way."""
    try:
        history = await handle.fetch_history()
        for event in reversed(history.events):
            if event.HasField("workflow_execution_failed_event_attributes"):
                return event.workflow_execution_failed_event_attributes.failure.message
            if event.HasField("workflow_execution_terminated_event_attributes"):
                reason = event.workflow_execution_terminated_event_attributes.reason
                return f"run terminated: {reason}" if reason else "run terminated"
            if event.HasField("workflow_execution_timed_out_event_attributes"):
                return "run timed out"
            if event.HasField("workflow_execution_canceled_event_attributes"):
                return "run canceled"
    except Exception:
        pass
    return "run failed"


@router.get("/workflow-runs/{workflow_run_id}/status")
async def workflow_run_status(workflow_run_id: int, request: Request) -> dict:
    handle = _run_handle(request, workflow_run_id)
    try:
        desc = await handle.describe()
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            return {"status": "idle", "error": None}
        raise
    status = _STATUS_MAP.get(desc.status, "running")
    error = await _failure_message(handle) if status == "failed" else None
    return {"status": status, "error": error}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/workflow-runs/{workflow_run_id}/progress")
async def workflow_run_progress(workflow_run_id: int, request: Request) -> StreamingResponse:
    """SSE: a cumulative progress snapshot every ~1s (the frontend diffs
    snapshots to synthesise its event feed), terminated by `finished` or
    `failed`. If the execution does not exist yet, idle snapshots for ~10s
    then the stream closes."""
    handle = _run_handle(request, workflow_run_id)

    async def stream():
        idle_deadline = asyncio.get_running_loop().time() + 10.0
        while True:
            desc = None
            try:
                desc = await handle.describe()
            except RPCError as exc:
                if exc.status != RPCStatusCode.NOT_FOUND:
                    raise
            if desc is None:
                if asyncio.get_running_loop().time() > idle_deadline:
                    return
                yield _sse(
                    "progress",
                    {"status": "idle", "executed": [], "memo_hits": [],
                     "human_waits": [], "error": None},
                )
                await asyncio.sleep(1.0)
                continue

            status = _STATUS_MAP.get(desc.status, "running")
            progress: dict = {}
            try:
                # handle.query works on closed workflows while a worker is up.
                progress = await handle.query("progress") or {}
            except Exception:
                pass
            data = {
                "status": status,
                "executed": progress.get("executed", []),
                "memo_hits": progress.get("memo_hits", []),
                "human_waits": progress.get("human_waits", []),
                "error": None,
            }
            if status == "completed":
                yield _sse("progress", data)
                yield _sse("finished", data)
                return
            if status == "failed":
                data["error"] = await _failure_message(handle)
                yield _sse("progress", data)
                yield _sse("failed", data)
                return
            yield _sse("progress", data)
            await asyncio.sleep(1.0)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
