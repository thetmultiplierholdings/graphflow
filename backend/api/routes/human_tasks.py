"""Human-task inbox = Temporal visibility, not a table.

GET lists open GraphflowHumanTask workflows on our task queue carrying this
instance's id prefix, enriched concurrently via the `task_info` query.
POST submits via a synchronous workflow UPDATE: validator rejections come
back as 422 with the reviewer-facing message; the task keeps waiting."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from temporalio.client import WorkflowUpdateFailedError
from temporalio.service import RPCError, RPCStatusCode

from api import schemas
from api.deps import artifact_meta, get_db, or_404
from engine import db as dbm
from engine import runtime

router = APIRouter(tags=["human-tasks"])


@router.get("/human-tasks")
async def list_human_tasks(request: Request, engagement_id: int | None = None) -> list[dict]:
    client = request.app.state.client
    prefix = f"node-{request.app.state.instance}-"
    query = (
        f"TaskQueue = '{runtime.task_queue()}' AND WorkflowType = 'GraphflowHumanTask' "
        "AND ExecutionStatus = 'Running'"
    )
    visible = [wf async for wf in client.list_workflows(query) if wf.id.startswith(prefix)]

    async def enrich(wf) -> dict | None:
        try:
            info = await client.get_workflow_handle(wf.id).query("task_info")
        except Exception:
            return None  # raced to completion, or transient — skip this sweep
        if not info.get("open"):
            return None
        return {
            "task_id": wf.id,
            "engagement_id": info.get("engagement_id"),
            "workflow_id": info.get("workflow_id"),
            "node_id": info.get("node_id"),
            "output_kind": info.get("output_kind"),
            "display_name": info.get("display_name"),
            "instructions": info.get("instructions"),
            "payload": info.get("payload"),
            "result_required_keys": info.get("result_required_keys", []),
            "requested_by_workflow_run": info.get("requested_by_workflow_run"),
            "input_artifact_ids": info.get("input_artifact_ids", []),
            "start_time": wf.start_time.isoformat() if wf.start_time else None,
        }

    tasks = [t for t in await asyncio.gather(*(enrich(wf) for wf in visible)) if t is not None]
    if engagement_id is not None:
        tasks = [t for t in tasks if t["engagement_id"] == engagement_id]
    return tasks


@router.post("/human-tasks/{task_id}/submit")
async def submit_human_task(
    task_id: str,
    body: schemas.HumanTaskSubmit,
    request: Request,
    conn=Depends(get_db),
) -> dict:
    if not task_id.startswith(f"node-{request.app.state.instance}-"):
        raise HTTPException(status_code=404, detail="task not found")
    handle = request.app.state.client.get_workflow_handle(task_id)
    try:
        ref = await handle.execute_update(
            "submit", {"reviewer": body.reviewer, "result": body.result}
        )
    except WorkflowUpdateFailedError as exc:
        # Validator rejection: the reviewer-facing ApplicationError message.
        cause = exc.cause
        message = getattr(cause, "message", None) or str(cause)
        raise HTTPException(status_code=422, detail=message)
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            # Unknown id, or the workflow already completed.
            raise HTTPException(status_code=404, detail="task not found or already completed")
        raise
    art = or_404(dbm.get_artifact, conn, ref["artifact_id"])
    return {"artifact": artifact_meta(art)}
