"""The full story through HTTP over REAL Temporal Cloud:

create -> upload -> execute (202) -> verify tasks open -> malformed answers
rejected (422, task stays open) -> approve via the API -> completed -> report
totals exact -> re-execute is a pure memo replay (0 executed, 7 memo hits) ->
copy + 1 extra doc -> only the marginal chain + fold/calc/report execute.

httpx ASGITransport over the app with the real lifespan (embedded worker ON).
Scratch GRAPHFLOW_DB / GRAPHFLOW_STORAGE per run; every Temporal workflow started
under the scratch instance prefix is terminated on teardown.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import time
from contextlib import suppress
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[1]
SAMPLE_DOCS = REPO / "sample_docs"
load_dotenv(REPO / ".env")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.asyncio(loop_scope="module"),
    pytest.mark.skipif(
        not os.environ.get("TEMPORAL_API_KEY"),
        reason="TEMPORAL_API_KEY not configured (.env) — needs real Temporal Cloud",
    ),
]

_ENV_KEYS = ("GRAPHFLOW_DB", "GRAPHFLOW_STORAGE", "GRAPHFLOW_EMBED_WORKER", "TEMPORAL_TASK_QUEUE")

TASKS_DEADLINE = 120.0     # tasks appearing in visibility
RUN_DEADLINE = 180.0       # run completion (human-wait poll backs off up to 30s)


async def _terminate_scratch_workflows(client, instance: str, db_path: str) -> None:
    """Terminate every open Temporal workflow carrying this scratch instance's
    prefix so nothing burns the shared task queue after the suite exits.

    Visibility is eventually consistent (a workflow started seconds ago can be
    missing from list_workflows), so: (1) terminate the wfrun ids DIRECTLY —
    they are derivable from the scratch db, no visibility needed; (2) sweep
    visibility for the node-* human tasks several times with delays."""
    from engine import db as dbm
    from engine import runtime

    with suppress(Exception):
        conn = dbm.connect(db_path)
        try:
            run_ids = [r[0] for r in conn.execute(
                "SELECT workflow_run_id FROM workflow_runs").fetchall()]
        finally:
            conn.close()
        for run_id in run_ids:
            with suppress(Exception):
                await client.get_workflow_handle(
                    runtime.workspace_temporal_id(instance, run_id)
                ).terminate(reason="pytest integration cleanup")

    prefixes = (f"wfrun-{instance}-", f"node-{instance}-")
    query = f"TaskQueue = '{runtime.task_queue()}' AND ExecutionStatus = 'Running'"
    for sweep in range(3):
        if sweep:
            await asyncio.sleep(4.0)  # let the visibility index catch up
        with suppress(Exception):
            async for wf in client.list_workflows(query):
                if not wf.id.startswith(prefixes):
                    continue
                with suppress(Exception):
                    await client.get_workflow_handle(wf.id).terminate(
                        reason="pytest integration cleanup"
                    )


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def api(tmp_path_factory):
    scratch = tmp_path_factory.mktemp("graphflow_api_int")
    token = secrets.token_hex(4)
    db_path = str(scratch / f"int_{token}.sqlite3")
    storage = str(scratch / f"store_{token}")
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    os.environ["GRAPHFLOW_DB"] = db_path
    os.environ["GRAPHFLOW_STORAGE"] = storage
    os.environ["GRAPHFLOW_EMBED_WORKER"] = "1"  # executions run in-process
    # The namespace AND the default task queue are shared — the live dev
    # stack's embedded worker polls the same queue against a DIFFERENT db.
    # A scratch queue keeps our workflow/activity tasks on OUR worker only.
    # (runtime.task_queue() reads env at call time; load_dotenv never
    # overrides an already-set variable.)
    base_queue = os.environ.get("TEMPORAL_TASK_QUEUE", "thet-temporal-dev-ignore")
    os.environ["TEMPORAL_TASK_QUEUE"] = f"{base_queue}-pytest-{token}"

    from api.main import app

    try:
        async with app.router.lifespan_context(app):
            try:
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(
                    transport=transport,
                    base_url="http://testserver",
                    timeout=httpx.Timeout(connect=30, read=300, write=30, pool=30),
                ) as client:
                    yield client
            finally:
                # while the Temporal client is still alive and the db exists
                await _terminate_scratch_workflows(
                    app.state.client, app.state.instance, db_path
                )
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


# ---------- expected-value helpers (Decimal end to end, like the engine) ----------

def _doc_amounts(path: Path) -> list[Decimal]:
    """Same line shape the mock OCR parses: 'YYYY-MM-DD | DESC | 123.45'."""
    amounts = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) == 3 and len(parts[0]) == 10 and parts[0][4] == "-":
            amounts.append(Decimal(parts[2]))
    return amounts


def _expected_totals(doc_paths: list[Path], rate: str = "0.25") -> tuple[str, str]:
    total = sum((a for p in doc_paths for a in _doc_amounts(p)), Decimal("0"))
    tax = (total * Decimal(rate)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return str(total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)), str(tax)


def _report_totals(report_text: str) -> tuple[str | None, str | None]:
    total = tax = None
    for line in report_text.splitlines():
        s = line.strip()
        if s.startswith("TOTAL"):
            total = s.split()[-1]
        elif s.startswith("TAX DUE"):
            tax = s.split()[-1]
    return total, tax


# ---------- HTTP helpers ----------

async def _upload(client: httpx.AsyncClient, eng: int, path: Path, kind: str,
                  workflow_run_id: int) -> dict:
    r = await client.post(
        f"/engagements/{eng}/artifacts",
        data={"kind": kind, "workflow_run_id": str(workflow_run_id)},
        files={"file": (path.name, path.read_bytes(), "text/plain")},
    )
    assert r.status_code == 200, r.text
    return r.json()["artifact"]


async def _open_tasks(client: httpx.AsyncClient, eng: int) -> list[dict]:
    r = await client.get("/human-tasks", params={"engagement_id": eng})
    assert r.status_code == 200, r.text
    return r.json()


async def _poll_tasks(client: httpx.AsyncClient, eng: int, *, count: int,
                      workflow_run_id: int) -> list[dict]:
    deadline = time.monotonic() + TASKS_DEADLINE
    tasks: list[dict] = []
    while time.monotonic() < deadline:
        tasks = [
            t for t in await _open_tasks(client, eng)
            if t["requested_by_workflow_run"] == workflow_run_id
        ]
        if len(tasks) >= count:
            return tasks
        await asyncio.sleep(2.0)
    raise AssertionError(
        f"timed out after {TASKS_DEADLINE}s waiting for {count} open verify "
        f"task(s) of workspace {workflow_run_id}; last saw {len(tasks)}"
    )


async def _poll_status(client: httpx.AsyncClient, workflow_run_id: int,
                       want: str = "completed") -> dict:
    deadline = time.monotonic() + RUN_DEADLINE
    last: dict = {}
    while time.monotonic() < deadline:
        r = await client.get(f"/workflow-runs/{workflow_run_id}/status")
        assert r.status_code == 200, r.text
        last = r.json()
        if last["status"] == want:
            return last
        assert last["status"] != "failed", f"run failed: {last['error']}"
        await asyncio.sleep(2.0)
    raise AssertionError(
        f"timed out after {RUN_DEADLINE}s waiting for workspace "
        f"{workflow_run_id} status {want!r}; last {last}"
    )


async def _approve_task(client: httpx.AsyncClient, task: dict,
                        reviewer: str = "Test Reviewer") -> dict:
    """The API-driven reviewer: fetch the OCR extraction through the API,
    approve it unchanged (exactly what the frontend's auto-approval does)."""
    ocr_ref = task["payload"]["ocr"]["__artifact__"]
    r = await client.get(f"/artifacts/{ocr_ref['artifact_id']}/content")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/json")
    ocr = json.loads(r.content)
    r = await client.post(
        f"/human-tasks/{task['task_id']}/submit",
        json={"reviewer": reviewer,
              "result": {"approved": True, "transactions": ocr["transactions"]}},
    )
    assert r.status_code == 200, r.text
    return r.json()["artifact"]


async def _read_progress(client: httpx.AsyncClient, workflow_run_id: int,
                         attempts: int = 3) -> dict:
    """Read the SSE stream until the terminal event; return the final snapshot.
    A transient query failure yields an empty snapshot on the finished tick —
    a genuinely finished run always has executed or memo_hits, so retry then."""
    last_exc: BaseException | None = None
    for _ in range(attempts):
        events: list[tuple[str, dict]] = []
        try:
            async with asyncio.timeout(RUN_DEADLINE):
                async with client.stream(
                    "GET", f"/workflow-runs/{workflow_run_id}/progress"
                ) as resp:
                    assert resp.status_code == 200
                    assert resp.headers["content-type"].startswith("text/event-stream")
                    event_name = None
                    async for line in resp.aiter_lines():
                        if line.startswith("event: "):
                            event_name = line[len("event: "):].strip()
                        elif line.startswith("data: ") and event_name:
                            events.append((event_name, json.loads(line[len("data: "):])))
                            if event_name in ("finished", "failed"):
                                break
        except (TimeoutError, httpx.HTTPError) as exc:
            last_exc = exc
            await asyncio.sleep(2.0)
            continue
        assert events, "progress stream closed without any event"
        name, data = events[-1]
        assert name == "finished", f"terminal event {name!r}: {data}"
        if data["executed"] or data["memo_hits"]:
            return data
        await asyncio.sleep(2.0)  # empty snapshot: query raced — retry
    raise AssertionError(
        f"no usable progress snapshot for workspace {workflow_run_id} "
        f"after {attempts} attempts (last error: {last_exc!r})"
    )


# ---------- the story ----------

async def test_full_story_over_real_temporal(api):
    client = api
    timings: dict[str, float] = {}
    t0 = time.monotonic()

    def lap(name: str) -> None:
        timings[name] = round(time.monotonic() - t0, 1)

    # 1. engagement + workspace + 1 brokerage statement + 1 payment slip
    r = await client.post("/engagements", json={"label": "pytest — API integration"})
    assert r.status_code == 200, r.text
    eng = r.json()["engagement_id"]
    r = await client.post(
        f"/engagements/{eng}/workflow-runs",
        json={"workflow_id": "tax_demo_workflow", "label": "March estimate"},
    )
    assert r.status_code == 200, r.text
    ws = r.json()["workflow_run_id"]

    docs = [SAMPLE_DOCS / "morgan_stanley.txt", SAMPLE_DOCS / "payslip_jan.txt"]
    await _upload(client, eng, docs[0], "brokerage_statement", ws)
    await _upload(client, eng, docs[1], "payment_slip", ws)
    lap("setup+upload")

    # 2. execute -> 202; poll until the 2 verify tasks open
    r = await client.post(f"/workflow-runs/{ws}/execute")
    assert r.status_code == 202, r.text
    assert r.json()["temporal_workflow_id"].startswith("wfrun-")

    tasks = await _poll_tasks(client, eng, count=2, workflow_run_id=ws)
    assert len(tasks) == 2
    for t in tasks:
        assert t["engagement_id"] == eng
        assert t["node_id"] == "verify_txns"
        assert t["output_kind"] == "verified_txns"
        assert t["result_required_keys"] == ["approved", "transactions"]
        assert "__artifact__" in t["payload"]["ocr"]
        assert t["instructions"]
    lap("tasks-open")

    # 3. NEGATIVE — the answer contract. Malformed rows -> 422, task stays open.
    bad = {
        "reviewer": "Test Reviewer",
        "result": {
            "approved": True,
            "transactions": [{"date": "bad", "description": "", "amount": "12,00"}],
        },
    }
    r = await client.post(f"/human-tasks/{tasks[0]['task_id']}/submit", json=bad)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, str) and detail  # reviewer-facing message
    assert "date" in detail  # first violation reported: date must be YYYY-MM-DD

    # missing required keys -> 422 too
    r = await client.post(
        f"/human-tasks/{tasks[0]['task_id']}/submit",
        json={"reviewer": "Test Reviewer", "result": {"approved": True}},
    )
    assert r.status_code == 422, r.text
    assert "transactions" in r.json()["detail"]

    # Rejection never closes the task. A single sweep of /human-tasks may
    # transiently drop a task (the route skips tasks whose task_info query
    # blips), so poll: a genuinely completed task can never come back as
    # open, so reappearing proves the rejected task is still waiting.
    still_open = await _poll_tasks(client, eng, count=2, workflow_run_id=ws)
    assert tasks[0]["task_id"] in {t["task_id"] for t in still_open}
    lap("negative-submits")

    # 4. approve both properly (OCR content fetched via the API)
    for t in tasks:
        answer = await _approve_task(client, t)
        assert answer["kind"] == "verified_txns"
        assert answer["created_by"] == "Test Reviewer"
    lap("approved")

    # 5. run completes; the report's TOTAL and TAX DUE are exact
    await _poll_status(client, ws, "completed")
    lap("run1-completed")

    # a second submit to an already-completed task -> 404
    r = await client.post(
        f"/human-tasks/{tasks[0]['task_id']}/submit",
        json={"reviewer": "Test Reviewer",
              "result": {"approved": True, "transactions": []}},
    )
    assert r.status_code == 404, r.text

    r = await client.get(f"/workflow-runs/{ws}")
    assert r.status_code == 200
    reports = [m for m in r.json()["members"] if m["kind"] == "final_report"]
    assert reports, "workspace members must contain the final_report"
    r = await client.get(f"/artifacts/{reports[-1]['artifact_id']}/content")
    assert r.status_code == 200
    report_text = r.content.decode("utf-8")
    expected_total, expected_tax = _expected_totals(docs)  # Decimal, ROUND_HALF_UP
    got_total, got_tax = _report_totals(report_text)
    assert got_total == expected_total, f"TOTAL {got_total} != {expected_total}"
    assert got_tax == expected_tax, f"TAX DUE {got_tax} != {expected_tax}"
    lap("report-verified")

    # 6. re-execute: a pure memo replay — zero node bodies, zero humans disturbed
    r = await client.post(f"/workflow-runs/{ws}/execute")
    assert r.status_code == 202, r.text
    progress = await _read_progress(client, ws)
    assert progress["status"] == "completed"
    assert progress["executed"] == []
    assert progress["human_waits"] == []
    # 7 memo hits: 2 ocr + 2 verify + fold + calc + report
    assert len(progress["memo_hits"]) == 7, progress["memo_hits"]
    assert sorted(set(progress["memo_hits"])) == [
        "append_to_master", "build_report", "calculate_tax",
        "ocr_brokerage_statement", "ocr_payment_slip", "verify_txns",
    ]
    assert progress["memo_hits"].count("verify_txns") == 2
    lap("rerun-memo-replay")

    # 7. copy the workspace + ONE extra statement: only the marginal work runs
    r = await client.post(
        f"/engagements/{eng}/workflow-runs",
        json={"workflow_id": "tax_demo_workflow", "label": "April estimate",
              "copy_from": ws},
    )
    assert r.status_code == 200, r.text
    ws2 = r.json()["workflow_run_id"]
    copied = r.json()["members"]
    assert len(copied) == 2 and all(m["source"] == "user" for m in copied)

    extra = SAMPLE_DOCS / "extra_ubs.txt"
    await _upload(client, eng, extra, "brokerage_statement", ws2)

    r = await client.post(f"/workflow-runs/{ws2}/execute")
    assert r.status_code == 202, r.text

    # exactly ONE new verify task (the extra statement's chain)
    new_tasks = await _poll_tasks(client, eng, count=1, workflow_run_id=ws2)
    assert len(new_tasks) == 1
    assert new_tasks[0]["engagement_id"] == eng
    await _approve_task(client, new_tasks[0])
    await _poll_status(client, ws2, "completed")

    progress2 = await _read_progress(client, ws2)
    # Marginal execution: the new document's OCR (engine) + its verify (the
    # 1 human answered) + the 3 downstream engine nodes fold/calc/report.
    # The two OLD chains (ocr + human answer, x2 docs) are pure memo hits.
    assert sorted(progress2["executed"]) == [
        "append_to_master", "build_report", "calculate_tax",
        "ocr_brokerage_statement", "verify_txns",
    ], progress2["executed"]
    assert progress2["human_waits"] == ["verify_txns"]  # exactly 1 human answered
    assert sorted(progress2["memo_hits"]) == [
        "ocr_brokerage_statement", "ocr_payment_slip", "verify_txns", "verify_txns",
    ], progress2["memo_hits"]

    # and the new report total includes the extra document
    r = await client.get(f"/workflow-runs/{ws2}")
    reports2 = [m for m in r.json()["members"] if m["kind"] == "final_report"]
    assert reports2
    r = await client.get(f"/artifacts/{reports2[-1]['artifact_id']}/content")
    assert r.status_code == 200
    expected_total2, expected_tax2 = _expected_totals(docs + [extra])
    got_total2, got_tax2 = _report_totals(r.content.decode("utf-8"))
    assert got_total2 == expected_total2, f"TOTAL {got_total2} != {expected_total2}"
    assert got_tax2 == expected_tax2, f"TAX DUE {got_tax2} != {expected_tax2}"
    assert got_total2 != got_total  # the extra document moved the number
    lap("copy-run-verified")

    print(f"\n[timings seconds since start] {timings}")
