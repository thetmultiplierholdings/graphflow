"""GET /catalog — the published workflow catalog with version supersession.

`superseded_by` is derived by the filename convention (a version is a file): strip a trailing `_v{n}` to get the family stem (no suffix == v1);
the highest version in a family is current, every other member is
superseded_by the highest."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends

from api.deps import get_db
from engine import db as dbm

router = APIRouter(tags=["catalog"])

_VERSION_RE = re.compile(r"^(.+)_v(\d+)$")


def _family(workflow_id: str) -> tuple[str, int]:
    m = _VERSION_RE.match(workflow_id)
    return (m.group(1), int(m.group(2))) if m else (workflow_id, 1)


def superseded_map(workflow_ids: list[str]) -> dict[str, str | None]:
    families: dict[str, list[tuple[int, str]]] = {}
    for wid in workflow_ids:
        stem, version = _family(wid)
        families.setdefault(stem, []).append((version, wid))
    out: dict[str, str | None] = {}
    for members in families.values():
        current = max(members)[1]
        for _, wid in members:
            out[wid] = None if wid == current else current
    return out


@router.get("/catalog")
def get_catalog(conn=Depends(get_db)) -> dict:
    snapshot = dbm.catalog_snapshot(conn)
    superseded = superseded_map([w["workflow_id"] for w in snapshot])
    return {
        "workflows": [
            {
                "workflow_id": w["workflow_id"],
                "display_name": w["display_name"],
                "task_queue": w["task_queue"],
                "superseded_by": superseded[w["workflow_id"]],
                "kinds": [
                    {"kind": k["kind"], "display_name": k["display_name"], "leaf": bool(k["leaf"])}
                    for k in w["kinds"]
                ],
                "nodes": [
                    {
                        "node_id": n["node_id"],
                        "display_name": n["display_name"],
                        "executor": n["executor"],
                        "output_kind": n["output_kind"],
                        "code_hash": n["code_hash"],
                    }
                    for n in w["nodes"]
                ],
            }
            for w in snapshot
        ]
    }
