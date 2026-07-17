"""Ctx — the memoize-or-execute walk, run inside Temporal workflow code.

Workflow code is deterministic: every DB / IO touch happens in an activity.
Per ctx.node call:
    input_hash = H(canonical argument map)      (artifacts by content hash)
    memo_key   = H(code_hash || input_hash)
    lookup (engagement_id, memo_key) -> hit: reuse; miss: execute (engine
    activity, or human-task workflow + poll) -> idempotent completion tx.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

from engine.canonical import hash_value, memo_key as make_memo_key

_ENGINE_RETRY = RetryPolicy(maximum_attempts=5, non_retryable_error_types=["NodeError"])
_SHORT = timedelta(seconds=30)
_NODE_TIMEOUT = timedelta(seconds=120)


class ArtifactHandle:
    """Immutable handle to an artifact. In workflow code it is reference-only;
    inside node bodies (activities) it gains payload access via a loader."""

    __slots__ = ("ref", "_loader")

    def __init__(self, ref: dict, loader=None):
        self.ref = ref
        self._loader = loader

    @property
    def artifact_id(self) -> int:
        return self.ref["artifact_id"]

    @property
    def hash(self) -> str:
        return self.ref["hash"]

    @property
    def kind(self) -> str:
        return self.ref["kind"]

    @property
    def label(self) -> str:
        return self.ref.get("label") or ""

    @property
    def media_type(self) -> str:
        return self.ref.get("media_type") or "application/octet-stream"

    def bytes(self) -> bytes:
        if self._loader is None:
            raise RuntimeError(
                "payload access is only legal inside node bodies (activities), "
                "never in workflow code"
            )
        return self._loader(self.artifact_id)

    def text(self) -> str:
        return self.bytes().decode("utf-8")

    def json(self) -> Any:
        return json.loads(self.text())

    def __repr__(self) -> str:  # pragma: no cover
        return f"ArtifactHandle({self.kind}#{self.artifact_id} {self.hash[:8]})"


def _encode(value: Any) -> tuple[Any, Any, list[int]]:
    """-> (hash_form, transport_form, input_artifact_ids).
    hash_form: artifacts as {"$artifact": hash}; artifact lists sorted by hash.
    transport_form: artifacts tagged {"__artifact__": ref} for the activity."""
    if isinstance(value, ArtifactHandle):
        return {"$artifact": value.hash}, {"__artifact__": dict(value.ref)}, [value.artifact_id]
    if isinstance(value, (list, tuple)):
        items = list(value)
        if items and all(isinstance(v, ArtifactHandle) for v in items):
            items = sorted(items, key=lambda h: h.hash)  # canonical rule 6
        hashes, transports, ids = [], [], []
        for v in items:
            h, t, i = _encode(v)
            hashes.append(h)
            transports.append(t)
            ids.extend(i)
        return hashes, transports, ids
    if isinstance(value, dict):
        hashes, transports, ids = {}, {}, []
        for k, v in value.items():
            h, t, i = _encode(v)
            hashes[k] = h
            transports[k] = t
            ids.extend(i)
        return hashes, transports, ids
    return value, value, []


class Ctx:
    def __init__(self, inp: dict):
        self.engagement_id: int = inp["engagement_id"]
        self.workflow_run_id: int = inp["workflow_run_id"]
        self.workflow_id: str = inp["workflow_id"]
        self._declared: set[str] = set(inp["declared_kinds"])
        self._attachments = [ArtifactHandle(r) for r in inp["attachments"]]
        self.executed: list[str] = []
        self.memo_hits: list[str] = []
        self.human_waits: list[str] = []

    # ---------- attachment resolution (user-sourced snapshot only, I7) ----------

    def attached(self, kind: str) -> list[ArtifactHandle]:
        if kind not in self._declared:
            raise ApplicationError(
                f"kind {kind!r} is not declared by workflow {self.workflow_id!r}",
                non_retryable=True,
            )
        return sorted(
            (h for h in self._attachments if h.kind == kind), key=lambda h: h.hash
        )

    def attached_one(self, kind: str) -> ArtifactHandle:
        items = self.attached(kind)
        if len(items) != 1:
            raise ApplicationError(
                f"expected exactly one {kind!r} attachment, found {len(items)}",
                non_retryable=True,
            )
        return items[0]

    def attached_one_or_none(self, kind: str) -> ArtifactHandle | None:
        items = self.attached(kind)
        if len(items) > 1:
            raise ApplicationError(
                f"expected at most one {kind!r} attachment, found {len(items)}",
                non_retryable=True,
            )
        return items[0] if items else None

    # pure aliases: named for the override pattern
    user_supplied = attached
    user_supplied_one = attached_one
    user_supplied_one_or_none = attached_one_or_none

    # ---------- the walk ----------

    async def node(self, fn, *args: Any, **kwargs: Any) -> ArtifactHandle:
        nd = getattr(fn, "_engine_node", None)
        if nd is None:
            raise ApplicationError(
                f"{fn!r} is not a registered node (missing @node/@human_node)",
                non_retryable=True,
            )
        arg_map: dict[str, Any] = dict(zip(nd.param_names, args))
        for k, v in kwargs.items():
            if k not in nd.param_names:
                raise ApplicationError(
                    f"unknown parameter {k!r} for node {nd.node_id}", non_retryable=True
                )
            arg_map[k] = v
        for p in nd.param_names:
            arg_map.setdefault(p, None)  # absent optional input: explicit null (rule 7)

        hash_form, transport, input_ids = _encode(arg_map)
        input_hash = hash_value(hash_form)
        mk = make_memo_key(nd.code_hash, input_hash)

        ref = await workflow.execute_activity(
            "memo_lookup",
            args=[self.engagement_id, mk],
            start_to_close_timeout=_SHORT,
        )
        if ref is not None:
            self.memo_hits.append(nd.node_id)
            await self._attach(ref)
            return ArtifactHandle(ref)

        req = {
            "engagement_id": self.engagement_id,
            "workflow_run_id": self.workflow_run_id,
            "workflow_id": self.workflow_id,
            "node_id": nd.node_id,
            "memo_key": mk,
            "args_transport": transport,
            "input_artifact_ids": input_ids,
        }

        if nd.executor == "engine":
            out = await workflow.execute_activity(
                "run_engine_node",
                args=[req],
                start_to_close_timeout=_NODE_TIMEOUT,
                retry_policy=_ENGINE_RETRY,
            )
            ref = out["ref"]
            (self.executed if out["fresh"] else self.memo_hits).append(nd.node_id)
            if not out["fresh"]:
                await self._attach(ref)
            return ArtifactHandle(ref)

        # human node: ensure the (deduped) task exists, then wait for the answer
        self.human_waits.append(nd.node_id)
        await workflow.execute_activity(
            "ensure_human_task",
            args=[req],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(
                maximum_attempts=10, non_retryable_error_types=["NodeError"]
            ),
        )
        delay = 1.0
        while ref is None:
            await workflow.sleep(delay)
            delay = min(delay * 2, 30.0)
            ref = await workflow.execute_activity(
                "memo_lookup",
                args=[self.engagement_id, mk],
                start_to_close_timeout=_SHORT,
            )
        self.executed.append(nd.node_id)
        await self._attach(ref)
        return ArtifactHandle(ref)

    async def _attach(self, ref: dict) -> None:
        await workflow.execute_activity(
            "attach_artifact",
            args=[self.workflow_run_id, ref["artifact_id"]],
            start_to_close_timeout=_SHORT,
        )

    def summary(self) -> dict:
        return {
            "workflow_run_id": self.workflow_run_id,
            "executed": self.executed,
            "memo_hits": self.memo_hits,
            "human_waits": self.human_waits,
        }
