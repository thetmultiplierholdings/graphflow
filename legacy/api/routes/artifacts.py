"""Artifact routes: lineage detail, raw content download, rename."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api import schemas
from api.deps import artifact_meta, get_db, node_run_out, or_404
from engine import db as dbm
from engine import storage

router = APIRouter(tags=["artifacts"])


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: int, conn=Depends(get_db)) -> dict:
    """Lineage for the preview drawer: the artifact, the node run that
    produced it (null for user-supplied), and every node run that consumed it."""
    art = or_404(dbm.get_artifact, conn, artifact_id)
    lineage = dbm.artifact_lineage(conn, artifact_id)
    return {
        "artifact": artifact_meta(art),
        "produced_by": node_run_out(conn, lineage["produced_by"]) if lineage["produced_by"] else None,
        "consumed_by": [node_run_out(conn, r) for r in lineage["consumed_by"]],
    }


def _content_filename(label: str | None, artifact_id: int, media_type: str) -> str:
    # Header values must be latin-1 safe; collapse anything exotic to '_'.
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", label or "").strip(" ._") or f"artifact_{artifact_id}"
    ext = ".json" if media_type == "application/json" else ".txt"
    return base if base.lower().endswith(ext) else base + ext


@router.get("/artifacts/{artifact_id}/content")
def get_artifact_content(artifact_id: int, request: Request, conn=Depends(get_db)) -> Response:
    art = or_404(dbm.get_artifact, conn, artifact_id)
    if art["payload_ref"] is None:
        raise HTTPException(status_code=410, detail="payload destroyed per policy")
    data = storage.read_payload(request.app.state.storage_root, art["payload_ref"])
    filename = _content_filename(art["label"], artifact_id, art["media_type"])
    return Response(
        content=data,
        media_type=art["media_type"],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch("/artifacts/{artifact_id}")
def rename_artifact(artifact_id: int, body: schemas.ArtifactPatch, conn=Depends(get_db)) -> dict:
    """label is the one mutable ledger column."""
    or_404(dbm.get_artifact, conn, artifact_id)
    dbm.rename_artifact(conn, artifact_id, body.label)
    return {"artifact": artifact_meta(dbm.get_artifact(conn, artifact_id))}
