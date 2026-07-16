"""Terminate every open Temporal workflow belonging to a scratch graphflow db.

The Temporal namespace is SHARED: every workflow id carries the db instance
prefix ('wfrun-{instance}-' / 'node-{instance}-'), so termination is scoped
to exactly the given database's workflows and nothing else.

Usage (with cwd = <repo>/backend, so uv + .env resolve there):
    uv run python ../frontend/e2e/cleanup_temporal.py graphflow_e2e.sqlite3
Called by the Playwright e2e suite (global setup + afterAll teardown).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# `python .../frontend/e2e/cleanup_temporal.py` puts THIS directory on
# sys.path, not the backend dir where the engine package lives. parents[2] is
# the repo root; the backend package tree lives under repo_root/backend.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from engine import db as dbm  # noqa: E402
from engine import runtime  # noqa: E402


async def main(db_path: str) -> None:
    conn = dbm.connect(db_path)
    try:
        instance = dbm.instance_id(conn)
    finally:
        conn.close()

    client = await runtime.connect_client()
    prefixes = (f"wfrun-{instance}-", f"node-{instance}-")
    query = f"TaskQueue = '{runtime.task_queue()}' AND ExecutionStatus = 'Running'"

    # Visibility is eventually consistent (a task workflow started moments
    # ago may not be listed yet), so sweep until a pass finds nothing.
    terminated = 0
    for sweep in range(4):
        if sweep > 0:
            await asyncio.sleep(2)
        found = 0
        async for wf in client.list_workflows(query):
            if not wf.id.startswith(prefixes):
                continue
            found += 1
            try:
                await client.get_workflow_handle(wf.id).terminate(reason="graphflow e2e cleanup")
                terminated += 1
                print(f"  [e2e-cleanup] terminated {wf.id}")
            except Exception:
                pass  # already closed, or racing another cleanup — fine
        if found == 0 and sweep > 0:
            break
    print(f"  [e2e-cleanup] instance {instance}: terminated {terminated} open workflow(s)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: cleanup_temporal.py <db_path>")
    asyncio.run(main(sys.argv[1]))
