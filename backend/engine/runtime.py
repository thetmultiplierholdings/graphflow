"""Runtime wiring: .env -> Temporal Cloud client, worker assembly, run helper.

Real Temporal, no mocks. All workflow ids carry an instance prefix (random
hex minted at `init`) because the namespace may be shared with other users.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.service import RPCError
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from engine import db as dbm
from engine.activities import GraphflowActivities
from engine.temporal_workflows import GraphflowHumanTask, GraphflowRun

DEFAULT_STORAGE = "mock_s3_gcs"


def load_env() -> None:
    load_dotenv()


def task_queue() -> str:
    return os.environ.get("TEMPORAL_TASK_QUEUE", "thet-temporal-dev-ignore")


async def connect_client() -> Client:
    load_env()
    address = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    api_key = os.environ.get("TEMPORAL_API_KEY")
    if api_key:
        return await Client.connect(
            address, namespace=namespace, api_key=api_key, tls=True
        )
    return await Client.connect(address, namespace=namespace)


def build_worker(client: Client, db_path: str, storage_root: str = DEFAULT_STORAGE) -> Worker:
    # Workflow files register themselves on import — every version must be
    # present so old workspaces keep their referent.
    import workflows

    workflows.load_all()

    conn = dbm.connect(db_path)
    try:
        instance = dbm.instance_id(conn)
    finally:
        conn.close()

    acts = GraphflowActivities(db_path, storage_root, client, task_queue(), instance)
    return Worker(
        client,
        task_queue=task_queue(),
        workflows=[GraphflowRun, GraphflowHumanTask],
        activities=acts.all(),
        activity_executor=ThreadPoolExecutor(max_workers=16),
        workflow_runner=SandboxedWorkflowRunner(
            restrictions=SandboxRestrictions.default.with_passthrough_modules(
                "engine", "workflows"
            )
        ),
    )


def workspace_temporal_id(instance: str, workflow_run_id: int) -> str:
    return f"wfrun-{instance}-{workflow_run_id}"


class SnapshotChangedError(RuntimeError):
    """Open run + changed attachment snapshot; caller must opt into supersede
    (the API maps this to 409)."""


async def start_workspace(
    client: Client, db_path: str, workflow_run_id: int, *, supersede: bool = False
):
    """POST /workflow-runs/{id}/execute — start (or attach to) wfrun-{instance}-{id}
    with the current user-attachment snapshot. Returns the workflow handle
    without awaiting the result (the API's 202 path).

    Re-run concurrency: attaching to an OPEN run with an unchanged
    snapshot is idempotent (double-click safety); an open run with a CHANGED
    snapshot raises SnapshotChangedError unless supersede=True, which
    terminates it and restarts on the fresh snapshot (completed facts are
    already filed; in-flight completion transactions are idempotent)."""
    conn = dbm.connect(db_path)
    try:
        ws = dbm.get_workspace(conn, workflow_run_id)
        attachments = dbm.user_attachments(conn, workflow_run_id)
        instance = dbm.instance_id(conn)
        wf_row = conn.execute(
            "SELECT * FROM workflows WHERE workflow_id=?", (ws["workflow_id"],)
        ).fetchone()
        if wf_row is None:
            raise RuntimeError(
                f"workflow {ws['workflow_id']!r} is not in the catalog (run `init` first)"
            )
        declared = [
            r["kind"]
            for r in conn.execute(
                "SELECT kind FROM workflow_kinds WHERE workflow_id=?", (ws["workflow_id"],)
            ).fetchall()
        ]
    finally:
        conn.close()

    wf_id = workspace_temporal_id(instance, workflow_run_id)
    try:
        prior = client.get_workflow_handle(wf_id)
        desc = await prior.describe()
        if desc.status == WorkflowExecutionStatus.RUNNING:
            running = await prior.query("snapshot")
            current = sorted(a["hash"] for a in attachments)
            if running != current:
                if not supersede:
                    raise SnapshotChangedError(
                        f"workspace {workflow_run_id}: attachments changed while a "
                        "run is open — re-execute with supersede=True to terminate "
                        "it and restart on the fresh snapshot"
                    )
                await prior.terminate(reason="superseded: attachments changed")
    except RPCError:
        pass  # no prior execution under this id

    inp = {
        "engagement_id": ws["engagement_id"],
        "workflow_run_id": workflow_run_id,
        "workflow_id": ws["workflow_id"],
        "declared_kinds": declared,
        "attachments": attachments,
    }
    return await client.start_workflow(
        wf_row["temporal_workflow_type"],
        inp,
        id=wf_id,
        task_queue=wf_row["task_queue"],
        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
    )


async def execute_workspace(
    client: Client, db_path: str, workflow_run_id: int, *, supersede: bool = False
) -> dict:
    """Start (or attach to) the workspace run and await its summary (CLI path)."""
    handle = await start_workspace(client, db_path, workflow_run_id, supersede=supersede)
    return await handle.result()
