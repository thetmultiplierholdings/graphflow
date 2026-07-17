"""Engagement-scoped routes: engagements, artifact pool (browse + multipart
upload), workspaces list/create, node-run ledger."""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile

from api import schemas
from api.deps import artifact_meta, get_db, node_run_out, or_404, workspace_detail
from engine import db as dbm

router = APIRouter(tags=["engagements"])


def _engagement_out(conn, engagement_id: int) -> dict:
    eng = or_404(dbm.get_engagement, conn, engagement_id)
    return dict(eng, stats=dbm.stats(conn, engagement_id))


@router.get("/engagements")
def list_engagements(conn=Depends(get_db)) -> list[dict]:
    return [
        dict(e, stats=dbm.stats(conn, e["engagement_id"]))
        for e in dbm.list_engagements(conn)
    ]


@router.post("/engagements")
def create_engagement(body: schemas.EngagementCreate, conn=Depends(get_db)) -> dict:
    engagement_id = dbm.create_engagement(conn, body.label)
    return _engagement_out(conn, engagement_id)


@router.get("/engagements/{engagement_id}")
def get_engagement(engagement_id: int, conn=Depends(get_db)) -> dict:
    return _engagement_out(conn, engagement_id)


# ---------- artifact pool ----------

@router.get("/engagements/{engagement_id}/artifacts")
def browse_artifacts(
    engagement_id: int,
    kind: str | None = None,
    q: str | None = None,
    conn=Depends(get_db),
) -> list[dict]:
    or_404(dbm.get_engagement, conn, engagement_id)
    return [artifact_meta(r) for r in dbm.browse_artifacts(conn, engagement_id, kind=kind, q=q)]


def _filename_stem(filename: str) -> str:
    # Browsers may send a full client path; strip directories both ways.
    name = PureWindowsPath(PurePosixPath(filename).name).name
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return stem


@router.post("/engagements/{engagement_id}/artifacts")
async def upload_artifact(
    engagement_id: int,
    request: Request,
    file: UploadFile,
    kind: str = Form(...),
    label: str | None = Form(None),
    workflow_run_id: int | None = Form(None),
    conn=Depends(get_db),
) -> dict:
    """Multipart upload: store bytes -> land on (engagement, kind, hash)
    (revived=True when the row already existed); optional attach source=user
    in the same call."""
    or_404(dbm.get_engagement, conn, engagement_id)
    if not kind or not kind.strip():
        raise HTTPException(status_code=422, detail="kind must be a non-empty string")
    if workflow_run_id is not None:
        ws = or_404(dbm.get_workspace, conn, workflow_run_id)
        if ws["engagement_id"] != engagement_id:
            raise HTTPException(
                status_code=422,
                detail=f"workflow_run {workflow_run_id} belongs to a different engagement",
            )
    data = await file.read()
    if not label and file.filename:
        label = _filename_stem(file.filename)
    ref = dbm.supply_artifact(
        conn,
        request.app.state.storage_root,
        engagement_id,
        kind.strip(),
        data,
        label=label or None,
        media_type=file.content_type or "application/octet-stream",
        created_by="user",
    )
    if workflow_run_id is not None:
        dbm.attach(conn, workflow_run_id, ref["artifact_id"], source="user", added_by="user")
    art = dbm.get_artifact(conn, ref["artifact_id"])
    return {"artifact": artifact_meta(art), "revived": bool(ref["existed"])}


# ---------- workspaces ----------

@router.get("/engagements/{engagement_id}/workflow-runs")
def list_workflow_runs(engagement_id: int, conn=Depends(get_db)) -> list[dict]:
    or_404(dbm.get_engagement, conn, engagement_id)
    return dbm.list_workspaces(conn, engagement_id)


@router.post("/engagements/{engagement_id}/workflow-runs")
def create_workflow_run(
    engagement_id: int, body: schemas.WorkspaceCreate, conn=Depends(get_db)
) -> dict:
    or_404(dbm.get_engagement, conn, engagement_id)
    known = conn.execute(
        "SELECT 1 FROM workflows WHERE workflow_id=?", (body.workflow_id,)
    ).fetchone()
    if known is None:
        raise HTTPException(
            status_code=422, detail=f"workflow {body.workflow_id!r} is not in the catalog"
        )
    if body.copy_from is not None:
        src = or_404(dbm.get_workspace, conn, body.copy_from)
        if src["engagement_id"] != engagement_id:
            raise HTTPException(
                status_code=422,
                detail="copy_from must be a workspace in the same engagement",
            )
    workflow_run_id = dbm.create_workspace(
        conn,
        engagement_id,
        body.workflow_id,
        body.label,
        created_by="user",
        copied_from=body.copy_from,
    )
    return workspace_detail(conn, workflow_run_id)


# ---------- ledger ----------

@router.get("/engagements/{engagement_id}/node-runs")
def list_node_runs(engagement_id: int, conn=Depends(get_db)) -> list[dict]:
    or_404(dbm.get_engagement, conn, engagement_id)
    return [node_run_out(conn, r) for r in dbm.list_node_runs(conn, engagement_id)]
