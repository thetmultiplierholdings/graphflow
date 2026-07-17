"""The two Temporal workflow definitions.

GraphflowRun        wfrun-{instance}-{workflow_run_id}
                 executes a registered workflow file over the user-attachment
                 snapshot; the code IS the DAG.
GraphflowHumanTask  node-{instance}-{engagement}-{memo_key}
                 one waiting task per distinct human question per engagement.
                 First step re-checks the memo (self-completes if already
                 answered). Submission is a workflow UPDATE (synchronous
                 validation: rejected submissions return the error to the
                 reviewer and the task keeps waiting).

Both classes use @workflow.init so queries/updates delivered before the run
method executes (worker backlog on the first workflow task) see initialized
state — without it, a validator could silently pass on empty requirements.
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from engine.canonical import canonical_bytes
    from engine.context import Ctx
    from engine.registry import REGISTRY

_SHORT = timedelta(seconds=30)


@workflow.defn(name="GraphflowRun")
class GraphflowRun:
    @workflow.init
    def __init__(self, inp: dict) -> None:
        self._inp = inp
        self._ctx: Ctx | None = None

    @workflow.run
    async def run(self, inp: dict) -> dict:
        wd = REGISTRY.workflows.get(inp["workflow_id"])
        if wd is None:
            raise ApplicationError(
                f"workflow {inp['workflow_id']!r} is not registered on this worker "
                "(catalog/worker deploy order?)",
                non_retryable=True,
            )
        # An empty snapshot is legal (all-optional workflows): per-kind
        # cardinality is enforced by the ctx accessors, not a blanket guard.
        self._ctx = Ctx(inp)
        await wd.fn(self._ctx)
        return self._ctx.summary()

    @workflow.query
    def progress(self) -> dict:
        return self._ctx.summary() if self._ctx else {}

    @workflow.query
    def snapshot(self) -> list[str]:
        """Sorted content hashes of the snapshot this run executes over —
        compared by execute_workspace to detect stale-snapshot re-runs."""
        return sorted(a["hash"] for a in self._inp["attachments"])


@workflow.defn(name="GraphflowHumanTask")
class GraphflowHumanTask:
    @workflow.init
    def __init__(self, inp: dict) -> None:
        self._inp = inp
        self._ref: dict | None = None
        self._done = False

    @workflow.run
    async def run(self, inp: dict) -> dict:
        # First step: the answer may already exist (start-after-completion race).
        existing = await workflow.execute_activity(
            "memo_lookup",
            args=[inp["engagement_id"], inp["memo_key"]],
            start_to_close_timeout=_SHORT,
        )
        if existing is not None:
            self._ref, self._done = existing, True
            # A legitimate submit may already be in flight (it saw open=True
            # before our memo check landed): let it finish so the reviewer
            # gets a response instead of a workflow-completed error.
            await workflow.wait_condition(workflow.all_handlers_finished)
            return self._ref
        await workflow.wait_condition(lambda: self._done)
        await workflow.wait_condition(workflow.all_handlers_finished)
        return self._ref

    @workflow.query
    def task_info(self) -> dict:
        return {"open": not self._done, **self._inp}

    @workflow.update
    async def submit(self, submission: dict) -> dict:
        """submission = {"reviewer": str, "result": {...}} — validated below;
        acceptance files the completion transaction with created_by=reviewer."""
        if self._done:
            return self._ref
        ref = await workflow.execute_activity(
            "record_human_completion",
            args=[self._inp, submission["result"], submission.get("reviewer", "unknown")],
            start_to_close_timeout=timedelta(seconds=60),
        )
        self._ref, self._done = ref, True
        return ref

    @submit.validator
    def _validate(self, submission: dict) -> None:
        if not isinstance(submission, dict) or not isinstance(submission.get("result"), dict):
            raise ApplicationError("submission must be {'reviewer': str, 'result': dict}")
        missing = [k for k in self._inp.get("result_required_keys", [])
                   if k not in submission["result"]]
        if missing:
            raise ApplicationError(f"result is missing required keys: {missing}")
        try:
            canonical_bytes(submission["result"])  # floats etc. rejected HERE,
        except ValueError as exc:                  # synchronously, to the reviewer
            raise ApplicationError(f"result is not canonicalizable: {exc}")
        # Per-node answer contract (registry result_validator): an accepted
        # answer is memoized forever, so malformed answers must be rejected
        # here — synchronously, to the reviewer — never filed.
        try:
            nd = REGISTRY.node_for_workflow(self._inp["workflow_id"], self._inp["node_id"])
        except KeyError:
            return  # node no longer registered on this worker; required keys still held
        if nd.result_validator is not None:
            try:
                nd.result_validator(submission["result"])
            except ValueError as exc:
                raise ApplicationError(f"result rejected: {exc}")
