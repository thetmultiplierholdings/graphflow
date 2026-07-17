"""API CRUD over the FastAPI app (httpx ASGITransport, real lifespan).

No workflow executions here — the embedded worker is OFF — but the lifespan
still connects a real Temporal client (the /status route needs it), so this
suite skips without TEMPORAL_API_KEY, same as the full integration story.

Scratch GRAPHFLOW_DB / GRAPHFLOW_STORAGE per module run; deleted on teardown.
"""

from __future__ import annotations

import os
import secrets
import shutil
from contextlib import suppress
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[1]
load_dotenv(REPO / ".env")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.asyncio(loop_scope="module"),
    pytest.mark.skipif(
        not os.environ.get("TEMPORAL_API_KEY"),
        reason="TEMPORAL_API_KEY not configured (.env) — the API lifespan needs Temporal",
    ),
]

_ENV_KEYS = ("GRAPHFLOW_DB", "GRAPHFLOW_STORAGE", "GRAPHFLOW_EMBED_WORKER")


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def api(tmp_path_factory):
    """(client, app) over a scratch db + storage, lifespan running, worker OFF."""
    scratch = tmp_path_factory.mktemp("graphflow_api_crud")
    token = secrets.token_hex(4)
    db_path = str(scratch / f"crud_{token}.sqlite3")
    storage = str(scratch / f"store_{token}")
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    os.environ["GRAPHFLOW_DB"] = db_path
    os.environ["GRAPHFLOW_STORAGE"] = storage
    os.environ["GRAPHFLOW_EMBED_WORKER"] = "0"  # CRUD only: no executions

    from api.main import app  # env is read at lifespan time, not import time

    try:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://testserver", timeout=60
            ) as client:
                yield client, app
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for suffix in ("", "-wal", "-shm"):
            with suppress(OSError):
                Path(db_path + suffix).unlink(missing_ok=True)
        shutil.rmtree(storage, ignore_errors=True)


# ---------- helpers ----------

async def _create_engagement(client: httpx.AsyncClient, label: str) -> dict:
    r = await client.post("/engagements", json={"label": label})
    assert r.status_code == 200, r.text
    return r.json()


async def _create_workspace(
    client: httpx.AsyncClient, eng: int, label: str,
    workflow_id: str = "tax_demo_workflow", copy_from: int | None = None,
) -> dict:
    body: dict = {"workflow_id": workflow_id, "label": label}
    if copy_from is not None:
        body["copy_from"] = copy_from
    r = await client.post(f"/engagements/{eng}/workflow-runs", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def _upload(
    client: httpx.AsyncClient, eng: int, name: str, data: bytes, kind: str,
    *, label: str | None = None, workflow_run_id: int | None = None,
    media_type: str = "text/plain",
) -> dict:
    form: dict = {"kind": kind}
    if label is not None:
        form["label"] = label
    if workflow_run_id is not None:
        form["workflow_run_id"] = str(workflow_run_id)
    r = await client.post(
        f"/engagements/{eng}/artifacts",
        data=form,
        files={"file": (name, data, media_type)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _engine_attach(app, workflow_run_id: int, artifact_id: int) -> None:
    """Plant an engine-sourced membership row directly in the scratch db
    (executing a workflow is the integration suite's job, not this one's)."""
    from engine import db as dbm

    conn = dbm.connect(app.state.db_path)
    try:
        dbm.attach(conn, workflow_run_id, artifact_id, source="engine", added_by="engine")
    finally:
        conn.close()


async def _members(client: httpx.AsyncClient, workflow_run_id: int) -> list[dict]:
    r = await client.get(f"/workflow-runs/{workflow_run_id}")
    assert r.status_code == 200, r.text
    return r.json()["members"]


# ---------- engagements ----------

async def test_engagement_create_list_get_404(api):
    client, _app = api
    eng = await _create_engagement(client, "CRUD Co — FY 2026")
    assert eng["label"] == "CRUD Co — FY 2026"
    assert eng["stats"] == {
        "workspaces": 0, "artifacts": 0, "node_runs": 0, "human_answers": 0,
    }

    r = await client.get("/engagements")
    assert r.status_code == 200
    listed = [e for e in r.json() if e["engagement_id"] == eng["engagement_id"]]
    assert len(listed) == 1
    assert listed[0]["label"] == eng["label"]
    assert listed[0]["stats"]["artifacts"] == 0

    r = await client.get(f"/engagements/{eng['engagement_id']}")
    assert r.status_code == 200
    assert r.json()["engagement_id"] == eng["engagement_id"]

    r = await client.get("/engagements/999999")
    assert r.status_code == 404
    assert "not found" in r.json()["detail"]


# ---------- upload / revive / kind scoping ----------

async def test_upload_attach_revive_and_kind_scoping(api):
    client, _app = api
    eng = (await _create_engagement(client, "upload-eng"))["engagement_id"]
    ws = (await _create_workspace(client, eng, "ws-upload"))["workflow_run_id"]

    data = b"STATEMENT - JAN\n2026-01-05 | DIVIDEND | 10.00\n"
    up = await _upload(
        client, eng, "stmt.txt", data, "brokerage_statement",
        label="stmt jan", workflow_run_id=ws,
    )
    assert up["revived"] is False
    art = up["artifact"]
    assert art["kind"] == "brokerage_statement"
    assert art["label"] == "stmt jan"
    assert art["byte_size"] == len(data)
    assert art["created_by"] == "user"
    assert art["payload_available"] is True
    assert "payload" not in art  # ArtifactMeta never carries bytes

    members = await _members(client, ws)
    mine = [m for m in members if m["artifact_id"] == art["artifact_id"]]
    assert len(mine) == 1 and mine[0]["source"] == "user"

    # identical re-upload -> revived, same artifact row
    again = await _upload(client, eng, "stmt.txt", data, "brokerage_statement")
    assert again["revived"] is True
    assert again["artifact"]["artifact_id"] == art["artifact_id"]

    # same bytes under a DIFFERENT kind -> a new artifact (kinds route resolution)
    other = await _upload(client, eng, "stmt.txt", data, "payment_slip")
    assert other["revived"] is False
    assert other["artifact"]["artifact_id"] != art["artifact_id"]
    assert other["artifact"]["hash"] == art["hash"]


# ---------- attach / promote / detach / cross-engagement ----------

async def test_attach_promotes_detach_deletes_cross_engagement_rejected(api):
    client, app = api
    eng = (await _create_engagement(client, "attach-eng"))["engagement_id"]
    ws = (await _create_workspace(client, eng, "ws-attach"))["workflow_run_id"]
    art = (await _upload(client, eng, "d.txt", b"DOC-A", "brokerage_statement"))["artifact"]

    # plant an engine-sourced row, then promote it via the API
    _engine_attach(app, ws, art["artifact_id"])
    members = await _members(client, ws)
    assert [m["source"] for m in members if m["artifact_id"] == art["artifact_id"]] == ["engine"]

    r = await client.post(
        f"/workflow-runs/{ws}/attachments", json={"artifact_id": art["artifact_id"]}
    )
    assert r.status_code == 204
    members = await _members(client, ws)
    assert [m["source"] for m in members if m["artifact_id"] == art["artifact_id"]] == ["user"]

    # detach -> 204, membership row gone; the ledger row survives
    r = await client.delete(f"/workflow-runs/{ws}/attachments/{art['artifact_id']}")
    assert r.status_code == 204
    assert await _members(client, ws) == []
    r = await client.get(f"/artifacts/{art['artifact_id']}")
    assert r.status_code == 200

    # cross-engagement attach -> 422
    eng2 = (await _create_engagement(client, "attach-eng-2"))["engagement_id"]
    foreign = (await _upload(client, eng2, "f.txt", b"DOC-B", "payment_slip"))["artifact"]
    r = await client.post(
        f"/workflow-runs/{ws}/attachments", json={"artifact_id": foreign["artifact_id"]}
    )
    assert r.status_code == 422
    assert "different engagement" in r.json()["detail"]


# ---------- copy_from ----------

async def test_copy_from_takes_user_rows_only(api):
    client, app = api
    eng = (await _create_engagement(client, "copy-eng"))["engagement_id"]
    src = (await _create_workspace(client, eng, "January"))["workflow_run_id"]

    user_art = (await _upload(
        client, eng, "doc.txt", b"USER DOC", "brokerage_statement", workflow_run_id=src,
    ))["artifact"]
    engine_art = (await _upload(client, eng, "res.txt", b"ENGINE RESULT", "ocr_txns"))["artifact"]
    _engine_attach(app, src, engine_art["artifact_id"])
    assert len(await _members(client, src)) == 2

    copy = await _create_workspace(client, eng, "February", copy_from=src)
    assert copy["copied_from_workflow_run"] == src
    members = copy["members"]
    assert [m["artifact_id"] for m in members] == [user_art["artifact_id"]]
    assert members[0]["source"] == "user"


# ---------- PATCH label / workflow_id, archive toggle ----------

async def test_patch_artifact_and_workspace_and_archive_toggle(api):
    client, _app = api
    eng = (await _create_engagement(client, "patch-eng"))["engagement_id"]
    ws = (await _create_workspace(client, eng, "before"))["workflow_run_id"]
    art = (await _upload(client, eng, "a.txt", b"PATCH ME", "payment_slip"))["artifact"]

    r = await client.patch(f"/artifacts/{art['artifact_id']}", json={"label": "renamed label"})
    assert r.status_code == 200
    assert r.json()["artifact"]["label"] == "renamed label"

    r = await client.patch(
        f"/workflow-runs/{ws}",
        json={"label": "after", "workflow_id": "tax_demo_workflow_v2"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["label"] == "after"
    assert body["workflow_id"] == "tax_demo_workflow_v2"

    # repoint to an unknown workflow -> 422
    r = await client.patch(f"/workflow-runs/{ws}", json={"workflow_id": "nope"})
    assert r.status_code == 422

    r = await client.post(f"/workflow-runs/{ws}/archive", json={"archived": True})
    assert r.status_code == 200
    assert r.json()["archived_at"] is not None
    r = await client.post(f"/workflow-runs/{ws}/archive", json={"archived": False})
    assert r.status_code == 200
    assert r.json()["archived_at"] is None


# ---------- catalog + the versioning invariant ----------

async def test_catalog_versioning_invariant(api):
    client, _app = api
    r = await client.get("/catalog")
    assert r.status_code == 200
    workflows = {w["workflow_id"]: w for w in r.json()["workflows"]}
    assert {"tax_demo_workflow", "tax_demo_workflow_v2"} <= set(workflows)

    v1, v2 = workflows["tax_demo_workflow"], workflows["tax_demo_workflow_v2"]
    assert v1["superseded_by"] == "tax_demo_workflow_v2"
    assert v2["superseded_by"] is None

    # THE versioning invariant (locks in the hash_with=[TAX_RATE] fix):
    # v2 is a file copy of v1 whose only behavioural edits are the rate value
    # (a declared hash_with dependency of calculate_tax) and the report's
    # rate literal — so exactly those two nodes get new hashes.
    h1 = {n["node_id"]: n["code_hash"] for n in v1["nodes"]}
    h2 = {n["node_id"]: n["code_hash"] for n in v2["nodes"]}
    assert set(h1) == set(h2) == {
        "ocr_brokerage_statement", "ocr_payment_slip", "verify_txns",
        "append_to_master", "calculate_tax", "build_report",
    }
    shared = {n for n in h1 if h1[n] == h2[n]}
    changed = {n for n in h1 if h1[n] != h2[n]}
    assert shared == {
        "ocr_brokerage_statement", "ocr_payment_slip", "verify_txns", "append_to_master",
    }
    assert changed == {"calculate_tax", "build_report"}

    for w in workflows.values():
        assert w["display_name"]
        for k in w["kinds"]:
            assert k["display_name"], f"empty kind display_name in {w['workflow_id']}: {k}"
        for n in w["nodes"]:
            assert n["executor"] in ("engine", "human")


# ---------- content round-trip ----------

async def test_artifact_content_roundtrip_and_404(api):
    client, _app = api
    eng = (await _create_engagement(client, "content-eng"))["engagement_id"]
    data = "unicode content — total 120.50\n".encode("utf-8")
    art = (await _upload(
        client, eng, "c.txt", data, "brokerage_statement", label="content check",
    ))["artifact"]

    r = await client.get(f"/artifacts/{art['artifact_id']}/content")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-type"].startswith("text/plain")
    assert "content check" in r.headers["content-disposition"]

    r = await client.get("/artifacts/999999/content")
    assert r.status_code == 404
    r = await client.get("/artifacts/999999")
    assert r.status_code == 404


# ---------- status: idle for a never-executed workspace ----------

async def test_status_idle_for_never_executed_workspace(api):
    client, _app = api
    eng = (await _create_engagement(client, "idle-eng"))["engagement_id"]
    ws = (await _create_workspace(client, eng, "never-run"))["workflow_run_id"]
    r = await client.get(f"/workflow-runs/{ws}/status")
    assert r.status_code == 200
    assert r.json() == {"status": "idle", "error": None}
