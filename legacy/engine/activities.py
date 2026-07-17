"""Temporal activities: every DB / storage / client touch of the engine.

Engine node bodies execute here (sync, thread-pooled). Human tasks are
standalone Temporal workflows started here with hard id-dedupe
('node-{instance}-{engagement}-{memo_key}', conflict policy USE_EXISTING).
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.exceptions import ApplicationError

from engine import db as dbm
from engine.canonical import canonical_bytes
from engine.context import ArtifactHandle
from engine.registry import REGISTRY, HumanTask


def _decode(value: Any, loader) -> Any:
    if isinstance(value, dict):
        if "__artifact__" in value and len(value) == 1:
            return ArtifactHandle(value["__artifact__"], loader=loader)
        return {k: _decode(v, loader) for k, v in value.items()}
    if isinstance(value, list):
        return [_decode(v, loader) for v in value]
    return value


def _encode_payload_value(value: Any) -> Any:
    if isinstance(value, ArtifactHandle):
        return {"__artifact__": dict(value.ref)}
    if isinstance(value, dict):
        return {k: _encode_payload_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_encode_payload_value(v) for v in value]
    return value


def _to_output_bytes(result: Any) -> tuple[bytes, str]:
    if isinstance(result, bytes):
        return result, "application/octet-stream"
    if isinstance(result, str):
        return result.encode("utf-8"), "text/plain"
    return canonical_bytes(result), "application/json"


class GraphflowActivities:
    def __init__(self, db_path: str, storage_root: str, client: Client,
                 task_queue: str, instance: str):
        self.db_path = db_path
        self.storage_root = storage_root
        self.client = client
        self.task_queue = task_queue
        self.instance = instance

    def _conn(self):
        return dbm.connect(self.db_path)

    def _loader(self, conn):
        return lambda artifact_id: dbm.read_artifact_payload(
            conn, self.storage_root, artifact_id
        )

    # ---------- lookups / attach ----------

    @activity.defn(name="memo_lookup")
    def memo_lookup(self, engagement_id: int, memo_key: str) -> dict | None:
        conn = self._conn()
        try:
            return dbm.memo_lookup(conn, engagement_id, memo_key)
        finally:
            conn.close()

    @activity.defn(name="attach_artifact")
    def attach_artifact(self, workflow_run_id: int, artifact_id: int) -> None:
        conn = self._conn()
        try:
            dbm.attach(conn, workflow_run_id, artifact_id, source="engine", added_by="engine")
        finally:
            conn.close()

    # ---------- engine node execution ----------

    @activity.defn(name="run_engine_node")
    def run_engine_node(self, req: dict) -> dict:
        conn = self._conn()
        try:
            # Idempotency on activity retry: the question may already be answered.
            existing = dbm.memo_lookup(conn, req["engagement_id"], req["memo_key"])
            if existing is not None:
                return {"ref": existing, "fresh": False}

            nd = REGISTRY.node_for_workflow(req["workflow_id"], req["node_id"])
            kwargs = _decode(req["args_transport"], self._loader(conn))
            # Node-body exceptions propagate as ordinary (retryable) activity
            # failures — the 5-attempt policy absorbs transients. Authors raise
            # ApplicationError(type="NodeError") for permanently-bad inputs.
            result = nd.fn(**kwargs)
            if inspect.iscoroutine(result):
                result = asyncio.run(result)

            try:
                payload, media_type = _to_output_bytes(result)
            except ValueError as exc:
                raise ApplicationError(
                    f"node {nd.node_id} produced a non-canonical payload: {exc}",
                    type="NodeError",
                    non_retryable=True,
                ) from exc
            info = activity.info()
            temporal_id = f"{info.workflow_id}/{info.workflow_run_id}/{info.activity_id}"
            ref, fresh = dbm.record_completion(
                conn,
                self.storage_root,
                engagement_id=req["engagement_id"],
                workflow_run_id=req["workflow_run_id"],
                workflow_id=req["workflow_id"],
                node_id=req["node_id"],
                code_hash=nd.code_hash,
                memo_key=req["memo_key"],
                output_kind=nd.output_kind,
                payload=payload,
                media_type=media_type,
                created_by="engine",
                temporal_id=temporal_id,
                input_artifact_ids=req["input_artifact_ids"],
            )
            return {"ref": ref, "fresh": fresh}
        finally:
            conn.close()

    # ---------- human tasks ----------

    @activity.defn(name="ensure_human_task")
    async def ensure_human_task(self, req: dict) -> str:
        """Build the HumanTask (question) and start-or-attach the task workflow.
        Hard dedupe by workflow id; the task workflow itself re-checks the memo
        as its first step, closing the start-after-completion race."""
        conn = self._conn()
        try:
            nd = REGISTRY.node_for_workflow(req["workflow_id"], req["node_id"])
            kwargs = _decode(req["args_transport"], self._loader(conn))
            try:
                ht = nd.fn(**kwargs)
            except Exception as exc:
                # A crashing question-builder is deterministic: fail the run
                # visibly instead of retrying forever.
                raise ApplicationError(
                    f"human node {nd.node_id} failed building its task: {exc}",
                    type="NodeError",
                    non_retryable=True,
                ) from exc
            if not isinstance(ht, HumanTask):
                raise ApplicationError(
                    f"human node {nd.node_id} must return a HumanTask",
                    non_retryable=True,
                )
            task_input = {
                "engagement_id": req["engagement_id"],
                "workflow_id": req["workflow_id"],
                "node_id": req["node_id"],
                "code_hash": nd.code_hash,
                "memo_key": req["memo_key"],
                "output_kind": nd.output_kind,
                "display_name": nd.display_name,
                "instructions": ht.instructions,
                "payload": _encode_payload_value(ht.payload),
                "result_required_keys": ht.result_required_keys,
                "requested_by_workflow_run": req["workflow_run_id"],
                "input_artifact_ids": req["input_artifact_ids"],
            }
        finally:
            conn.close()

        task_wf_id = f"node-{self.instance}-{req['engagement_id']}-{req['memo_key']}"
        # No exception handling on purpose: with USE_EXISTING (+ default
        # allow-duplicate reuse) an existing or completed task never raises —
        # a start after completion spawns a run that self-completes via its
        # first-step memo check. Anything that DOES raise here is a genuine
        # failure and must surface so the activity retries instead of leaving
        # the requester polling for a task that was never created.
        await self.client.start_workflow(
            "GraphflowHumanTask",
            task_input,
            id=task_wf_id,
            task_queue=self.task_queue,
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
        )
        return task_wf_id

    @activity.defn(name="record_human_completion")
    def record_human_completion(self, task_input: dict, result: dict, reviewer: str) -> dict:
        conn = self._conn()
        try:
            try:
                payload = canonical_bytes(result)
            except ValueError as exc:
                # Deterministic: retrying cannot help. The submit validator
                # rejects this before it reaches us; this is the belt-and-braces.
                raise ApplicationError(
                    f"submission is not canonicalizable: {exc}", non_retryable=True
                ) from exc
            info = activity.info()
            temporal_id = f"{info.workflow_id}/{info.workflow_run_id}"
            ref, _fresh = dbm.record_completion(
                conn,
                self.storage_root,
                engagement_id=task_input["engagement_id"],
                workflow_run_id=task_input.get("requested_by_workflow_run"),
                workflow_id=task_input["workflow_id"],
                node_id=task_input["node_id"],
                code_hash=task_input["code_hash"],
                memo_key=task_input["memo_key"],
                output_kind=task_input["output_kind"],
                payload=payload,
                media_type="application/json",
                created_by=reviewer,
                temporal_id=temporal_id,
                input_artifact_ids=task_input["input_artifact_ids"],
            )
            return ref
        finally:
            conn.close()

    def all(self) -> list:
        return [
            self.memo_lookup,
            self.attach_artifact,
            self.run_engine_node,
            self.ensure_human_task,
            self.record_human_completion,
        ]
