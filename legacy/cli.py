"""graphflow CLI — init / worker / demo / tasks / submit / show / download.

`demo` is the end-to-end acceptance story against REAL Temporal:
  1. January workspace: 3 brokerage statements + 3 payment slips -> run.
     Six mock-HITL verify tasks open as real Temporal workflows; the
     in-process auto-approver answers them. Fold -> calculator -> report.
  2. Run January AGAIN: every node memo-hits, zero node bodies execute,
     zero human tasks appear.
  3. February = copy of January + 1 extra statement + 1 extra slip -> run.
     Only the two new chains + fold + calculator + report execute; the six
     old chains (human answers included) are memo hits.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

from engine import db as dbm
from engine import runtime

DB_PATH = os.environ.get("GRAPHFLOW_DB", "graphflow.sqlite3")
STORAGE = os.environ.get("GRAPHFLOW_STORAGE", "mock_s3_gcs")

BROKERAGE = ["morgan_stanley.txt", "goldman_sachs.txt", "fidelity.txt"]
SLIPS = ["payslip_jan.txt", "payslip_feb.txt", "payslip_mar.txt"]
EXTRA = [("extra_ubs.txt", "brokerage_statement"), ("extra_payslip_apr.txt", "payment_slip")]


def _publish() -> None:
    import workflows

    workflows.load_all()  # registers every version on import
    from engine.registry import REGISTRY

    conn = dbm.connect(DB_PATH)
    try:
        for line in dbm.publish_catalog(conn, REGISTRY, runtime.task_queue()):
            print(f"  [catalog] {line}")
    finally:
        conn.close()


def cmd_init(_args) -> None:
    instance = dbm.init_db(DB_PATH)
    print(f"  [init] db={DB_PATH} instance_id={instance}")
    _publish()


# ---------- auto-approver: the mock HITL ----------

def _build_approval(info: dict) -> dict | None:
    """A 'reviewer' that opens the task payload, reads the OCR extraction from
    the local payload store, and approves it unchanged."""
    payload = info.get("payload") or {}
    ocr_ref = payload.get("ocr")
    if not (isinstance(ocr_ref, dict) and "__artifact__" in ocr_ref):
        return None
    conn = dbm.connect(DB_PATH)
    try:
        raw = dbm.read_artifact_payload(conn, STORAGE, ocr_ref["__artifact__"]["artifact_id"])
    finally:
        conn.close()
    ocr = json.loads(raw.decode("utf-8"))
    return {"approved": True, "transactions": ocr["transactions"]}


async def auto_approve_loop(client, instance: str, stop: asyncio.Event,
                            reviewer: str = "auto-approver") -> None:
    tq = runtime.task_queue()
    prefix = f"node-{instance}-"
    query = (
        f"TaskQueue = '{tq}' AND WorkflowType = 'GraphflowHumanTask' "
        "AND ExecutionStatus = 'Running'"
    )
    while not stop.is_set():
        try:
            async for wf in client.list_workflows(query):
                if not wf.id.startswith(prefix):
                    continue
                handle = client.get_workflow_handle(wf.id)
                try:
                    info = await handle.query("task_info")
                    if not info.get("open"):
                        continue
                    result = _build_approval(info)
                    if result is None:
                        continue
                    await handle.execute_update(
                        "submit", {"reviewer": reviewer, "result": result}
                    )
                    print(f"  [HITL] auto-approved {info.get('node_id')} "
                          f"(task ...{wf.id[-10:]})")
                except Exception:
                    continue  # task raced to completion, or transient — next sweep
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


# ---------- workspace helpers ----------

def _supply_and_attach(conn, engagement_id: int, wfr: int, filename: str, kind: str) -> None:
    data = (Path("sample_docs") / filename).read_bytes()
    ref = dbm.supply_artifact(
        conn, STORAGE, engagement_id, kind, data,
        label=filename.replace(".txt", ""), created_by="demo-user",
    )
    dbm.attach(conn, wfr, ref["artifact_id"], source="user", added_by="demo-user")
    print(f"  [upload] {filename} -> {kind} artifact#{ref['artifact_id']} ({ref['hash'][:10]})")


def _print_summary(tag: str, summary: dict) -> None:
    print(f"\n  [{tag}] run finished:")
    print(f"    node bodies EXECUTED : {len(summary['executed']):>2}  {summary['executed']}")
    print(f"    memo HITS            : {len(summary['memo_hits']):>2}  {summary['memo_hits']}")
    print(f"    human questions asked: {len(summary['human_waits']):>2}  {summary['human_waits']}")


def _print_report(conn, wfr: int, tag: str) -> None:
    arts = dbm.workspace_artifacts(conn, wfr)
    reports = [a for a in arts if a["kind"] == "final_report"]
    if not reports:
        print(f"  [{tag}] no final_report artifact in workspace")
        return
    latest = reports[-1]
    text = dbm.read_artifact_payload(conn, STORAGE, latest["artifact_id"]).decode("utf-8")
    print(f"\n  [{tag}] final report (artifact#{latest['artifact_id']}, "
          f"label={latest['label']}):\n")
    print("  " + "\n  ".join(text.splitlines()))


# ---------- commands ----------

async def _demo() -> None:
    cmd_init(None)
    client = await runtime.connect_client()
    print(f"  [temporal] connected (task queue: {runtime.task_queue()})")

    conn = dbm.connect(DB_PATH)
    instance = dbm.instance_id(conn)

    worker = runtime.build_worker(client, DB_PATH, STORAGE)
    worker_task = asyncio.create_task(worker.run())
    stop = asyncio.Event()
    approver_task = asyncio.create_task(auto_approve_loop(client, instance, stop))

    try:
        eng = dbm.create_engagement(conn, f"acme-demo-{instance}")
        print(f"\n== SCENARIO 1: January from scratch (engagement {eng}) ==")
        jan = dbm.create_workspace(conn, eng, "tax_demo_workflow", "January estimate",
                                   created_by="demo-user")
        for f in BROKERAGE:
            _supply_and_attach(conn, eng, jan, f, "brokerage_statement")
        for f in SLIPS:
            _supply_and_attach(conn, eng, jan, f, "payment_slip")

        summary = await runtime.execute_workspace(client, DB_PATH, jan)
        _print_summary("January #1", summary)
        _print_report(conn, jan, "January")

        print("\n== SCENARIO 2: run January AGAIN (everything memo-hits) ==")
        summary2 = await runtime.execute_workspace(client, DB_PATH, jan)
        _print_summary("January #2", summary2)
        assert summary2["executed"] == [], "re-run must execute zero node bodies"
        print("    -> zero node bodies executed, zero humans disturbed. The memo held.")

        print("\n== SCENARIO 3: February = copy of January + 2 new documents ==")
        feb = dbm.create_workspace(conn, eng, "tax_demo_workflow", "February estimate",
                                   created_by="demo-user", copied_from=jan)
        for f, kind in EXTRA:
            _supply_and_attach(conn, eng, feb, f, kind)
        summary3 = await runtime.execute_workspace(client, DB_PATH, feb)
        _print_summary("February", summary3)
        _print_report(conn, feb, "February")

        s = dbm.stats(conn, eng)
        print(f"\n  [ledger] engagement {eng}: {s['node_runs']} node_runs "
              f"({s['human_answers']} human answers), {s['artifacts']} artifacts, "
              f"{s['workspaces']} workspaces")
        print("  [done] demo complete.")
    finally:
        stop.set()
        await approver_task
        await worker.shutdown()
        await worker_task
        conn.close()


def cmd_demo(_args) -> None:
    asyncio.run(_demo())


# ---------- seed: the demo dataset for the API + frontend ----------

async def _terminate_stale_runs(client, old_instance: str) -> None:
    """Terminate any open Temporal workflows carrying the OLD instance prefix
    so orphaned runs don't burn the shared task queue forever."""
    prefixes = (f"wfrun-{old_instance}-", f"node-{old_instance}-")
    query = f"TaskQueue = '{runtime.task_queue()}' AND ExecutionStatus = 'Running'"
    try:
        async for wf in client.list_workflows(query):
            if not wf.id.startswith(prefixes):
                continue
            try:
                await client.get_workflow_handle(wf.id).terminate(
                    reason="graphflow seed --fresh"
                )
                print(f"  [fresh] terminated {wf.id}")
            except Exception:
                pass  # already closed, or racing — ignore
    except Exception:
        pass


async def _seed(fresh: bool) -> None:
    client = await runtime.connect_client()
    print(f"  [temporal] connected (task queue: {runtime.task_queue()})")

    if fresh and Path(DB_PATH).exists():
        old_instance = None
        try:
            conn = dbm.connect(DB_PATH)
            try:
                old_instance = dbm.instance_id(conn)
            finally:
                conn.close()
        except Exception:
            pass
        if old_instance:
            await _terminate_stale_runs(client, old_instance)
        for suffix in ("", "-wal", "-shm"):
            Path(DB_PATH + suffix).unlink(missing_ok=True)
        shutil.rmtree(STORAGE, ignore_errors=True)
        print(f"  [fresh] deleted {DB_PATH} and {STORAGE}/")

    cmd_init(None)
    conn = dbm.connect(DB_PATH)
    instance = dbm.instance_id(conn)

    worker = runtime.build_worker(client, DB_PATH, STORAGE)
    worker_task = asyncio.create_task(worker.run())
    stop = asyncio.Event()
    approver_task = asyncio.create_task(
        auto_approve_loop(client, instance, stop, reviewer="Priya Sharma")
    )

    open_task_ids: list[str] = []
    try:
        # -- Acme: January executed to completion (Priya approves the six verifies)
        acme = dbm.create_engagement(conn, "Acme Ltd — UK Tax FY 2025/26")
        print(f"\n  [seed] engagement {acme}: Acme Ltd — UK Tax FY 2025/26")
        jan = dbm.create_workspace(conn, acme, "tax_demo_workflow", "January estimate",
                                   created_by="thet")
        for f in BROKERAGE:
            _supply_and_attach(conn, acme, jan, f, "brokerage_statement")
        for f in SLIPS:
            _supply_and_attach(conn, acme, jan, f, "payment_slip")
        summary = await runtime.execute_workspace(client, DB_PATH, jan)
        _print_summary("seed/January", summary)

        reports = [a for a in dbm.workspace_artifacts(conn, jan)
                   if a["kind"] == "final_report"]
        if reports:
            dbm.rename_artifact(conn, reports[-1]["artifact_id"],
                                "January estimate — sent to client")
            print("  [seed] renamed final report -> 'January estimate — sent to client'")

        # -- Acme: February = copy of January + 2 extra docs, NOT executed
        feb = dbm.create_workspace(conn, acme, "tax_demo_workflow", "February estimate",
                                   created_by="thet", copied_from=jan)
        for f, kind in EXTRA:
            _supply_and_attach(conn, acme, feb, f, kind)
        print(f"  [seed] workspace {feb} 'February estimate' staged (not executed)")

        # Auto-approver OFF from here: Blue Harbour's verify tasks must stay open.
        stop.set()
        await approver_task

        # -- Blue Harbour: run started, left waiting on its 2 verify tasks
        bh = dbm.create_engagement(conn, "Blue Harbour LLP — UK Tax FY 2025/26")
        print(f"\n  [seed] engagement {bh}: Blue Harbour LLP — UK Tax FY 2025/26")
        q1 = dbm.create_workspace(conn, bh, "tax_demo_workflow_v2", "Q1 estimate",
                                  created_by="thet")
        _supply_and_attach(conn, bh, q1, "bh_schwab.txt", "brokerage_statement")
        _supply_and_attach(conn, bh, q1, "bh_payslip_feb.txt", "payment_slip")
        handle = await runtime.start_workspace(client, DB_PATH, q1)
        print(f"  [seed] started {handle.id} — leaving it waiting on human review")

        # Wait for the run's 2 verify tasks to open. Visibility is eventually
        # consistent (completed tasks can linger as 'Running'), so confirm
        # each candidate via the task_info query: genuinely open AND belonging
        # to the Blue Harbour engagement.
        query = (f"TaskQueue = '{runtime.task_queue()}' "
                 "AND WorkflowType = 'GraphflowHumanTask' AND ExecutionStatus = 'Running'")
        prefix = f"node-{instance}-"
        deadline = asyncio.get_running_loop().time() + 180
        while asyncio.get_running_loop().time() < deadline:
            open_task_ids = []
            async for wf in client.list_workflows(query):
                if not wf.id.startswith(prefix):
                    continue
                try:
                    info = await client.get_workflow_handle(wf.id).query("task_info")
                except Exception:
                    continue  # raced to completion, or transient
                if info.get("open") and info.get("engagement_id") == bh:
                    open_task_ids.append(wf.id)
            if len(open_task_ids) >= 2:
                break
            await asyncio.sleep(2.0)
        if len(open_task_ids) < 2:
            raise RuntimeError("timed out waiting for Blue Harbour's verify tasks to open")

        # -- summary (labels + counts, no secrets)
        print("\n  [seed] done:")
        for eng_id in (acme, bh):
            e = dbm.get_engagement(conn, eng_id)
            s = dbm.stats(conn, eng_id)
            print(f"    {e['label']}: {s['workspaces']} workspaces, "
                  f"{s['artifacts']} artifacts, {s['node_runs']} node_runs "
                  f"({s['human_answers']} human answers)")
        print(f"    open human tasks (Blue Harbour, durable in Temporal): "
              f"{len(open_task_ids)}")
    finally:
        if not stop.is_set():
            stop.set()
            await approver_task
        await worker.shutdown()
        await worker_task
        conn.close()


def cmd_seed(args) -> None:
    asyncio.run(_seed(args.fresh))


def cmd_worker(_args) -> None:
    async def _run():
        dbm.init_db(DB_PATH)
        _publish()
        client = await runtime.connect_client()
        worker = runtime.build_worker(client, DB_PATH, STORAGE)
        print(f"  [worker] running on task queue {runtime.task_queue()!r} (Ctrl+C to stop)")
        await worker.run()

    asyncio.run(_run())


def cmd_tasks(_args) -> None:
    async def _run():
        client = await runtime.connect_client()
        conn = dbm.connect(DB_PATH)
        instance = dbm.instance_id(conn)
        conn.close()
        tq = runtime.task_queue()
        query = (f"TaskQueue = '{tq}' AND WorkflowType = 'GraphflowHumanTask' "
                 "AND ExecutionStatus = 'Running'")
        n = 0
        async for wf in client.list_workflows(query):
            if not wf.id.startswith(f"node-{instance}-"):
                continue
            info = await client.get_workflow_handle(wf.id).query("task_info")
            if not info.get("open"):
                continue
            n += 1
            print(f"  [{n}] {wf.id}")
            print(f"      node: {info.get('node_id')}  ({info.get('display_name')})")
            print(f"      instructions: {info.get('instructions')}")
        if n == 0:
            print("  no open human tasks")

    asyncio.run(_run())


def cmd_submit(args) -> None:
    async def _run():
        client = await runtime.connect_client()
        handle = client.get_workflow_handle(args.task_id)
        info = await handle.query("task_info")
        result = _build_approval(info)
        if result is None:
            print("  cannot build an auto-approval for this task payload")
            return
        ref = await handle.execute_update(
            "submit", {"reviewer": args.reviewer, "result": result}
        )
        print(f"  submitted; answer artifact#{ref['artifact_id']}")

    asyncio.run(_run())


def cmd_show(args) -> None:
    conn = dbm.connect(DB_PATH)
    try:
        ws = dbm.get_workspace(conn, args.workflow_run_id)
        print(f"  workspace {ws['workflow_run_id']}: {ws['label']} "
              f"({ws['workflow_id']}, engagement {ws['engagement_id']})")
        for a in dbm.workspace_artifacts(conn, args.workflow_run_id):
            origin = "produced" if a["produced"] else "supplied"
            print(f"    #{a['artifact_id']:<4} {a['kind']:<20} [{a['source']}/{origin}] "
                  f"{a['label']}  {a['hash'][:10]}")
    finally:
        conn.close()


def cmd_download(args) -> None:
    conn = dbm.connect(DB_PATH)
    try:
        data = dbm.read_artifact_payload(conn, STORAGE, args.artifact_id)
        Path(args.out).write_bytes(data)
        print(f"  wrote {len(data)} bytes to {args.out}")
    finally:
        conn.close()


def main() -> None:
    p = argparse.ArgumentParser(prog="graphflow", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create db + publish catalog").set_defaults(fn=cmd_init)
    sub.add_parser("worker", help="run the Temporal worker").set_defaults(fn=cmd_worker)
    sub.add_parser("demo", help="run the end-to-end demo").set_defaults(fn=cmd_demo)
    sp = sub.add_parser("seed", help="seed the demo dataset (Acme + Blue Harbour)")
    sp.add_argument("--fresh", action="store_true",
                    help="terminate this db's open Temporal runs, then delete "
                         "the db and payload store before seeding")
    sp.set_defaults(fn=cmd_seed)
    sub.add_parser("tasks", help="list open human tasks").set_defaults(fn=cmd_tasks)
    sp = sub.add_parser("submit", help="approve a human task")
    sp.add_argument("task_id")
    sp.add_argument("--reviewer", default="cli-reviewer")
    sp.set_defaults(fn=cmd_submit)
    sp = sub.add_parser("show", help="show a workspace's artifacts")
    sp.add_argument("workflow_run_id", type=int)
    sp.set_defaults(fn=cmd_show)
    sp = sub.add_parser("download", help="download an artifact payload")
    sp.add_argument("artifact_id", type=int)
    sp.add_argument("out")
    sp.set_defaults(fn=cmd_download)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
