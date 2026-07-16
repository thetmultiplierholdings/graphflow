"""Node / workflow registry.

Workflows are code files; a new version is a new file, hence a new
workflow_id. The memo keys on per-node code_hash:

  code_hash = H(decorator metadata || dedented fn source
                || hash_with entries (functions by source, constants by
                   canonical JSON) || code_salt)

so nodes copy-pasted unchanged into a v2 file keep their memo hits —
including answers given by humans.
"""

from __future__ import annotations

import inspect
import textwrap
from dataclasses import dataclass, field
from typing import Any, Callable

from engine.canonical import canonical_bytes, sha256_hex


@dataclass
class Kind:
    kind: str
    display: str = ""


@dataclass
class HumanTask:
    """What a human node presents: the question and the acceptable answer."""

    instructions: str
    payload: dict  # rendered to the reviewer; may contain ArtifactHandle values
    result_required_keys: list[str] = field(default_factory=list)


@dataclass
class NodeDef:
    node_id: str
    fn: Callable
    executor: str  # 'engine' | 'human'
    output_kind: str
    param_names: list[str]
    hash_with: list[Any]
    code_salt: str
    dedupe: str  # 'none' | 'hard' (engine nodes; human nodes always hard)
    display_name: str
    module: str
    # Human nodes: submission validation beyond required keys. An accepted
    # answer is memoized forever (one answer per question per engagement), so
    # a malformed answer must be rejected at submission — never filed. Raises
    # ValueError to reject; surfaced to the reviewer as a synchronous 422.
    result_validator: Callable[[dict], None] | None = None
    _code_hash: str | None = None

    @property
    def code_hash(self) -> str:
        if self._code_hash is None:
            parts: list[bytes] = [
                canonical_bytes(
                    {
                        "node_id": self.node_id,
                        "output_kind": self.output_kind,
                        "executor": self.executor,
                    }
                ),
                textwrap.dedent(inspect.getsource(self.fn)).encode("utf-8"),
            ]
            for dep in self.hash_with:
                if callable(dep):
                    parts.append(textwrap.dedent(inspect.getsource(dep)).encode("utf-8"))
                else:
                    parts.append(canonical_bytes(dep))
            parts.append(self.code_salt.encode("utf-8"))
            self._code_hash = sha256_hex(b"\x00".join(parts))
        return self._code_hash


@dataclass
class WorkflowDef:
    workflow_id: str
    fn: Callable
    kinds: list[Kind]
    display_name: str
    module: str

    def nodes(self) -> list[NodeDef]:
        """Nodes declared in the same module as this workflow (the file owns them)."""
        return [n for n in REGISTRY.nodes.values() if n.module == self.module]

    def leaf_kinds(self) -> dict[str, bool]:
        produced = {n.output_kind for n in self.nodes()}
        return {k.kind: (k.kind not in produced) for k in self.kinds}


class Registry:
    def __init__(self) -> None:
        self.nodes: dict[str, NodeDef] = {}  # keyed by qualified '{module}:{node_id}'
        self.workflows: dict[str, WorkflowDef] = {}

    def add_node(self, nd: NodeDef) -> None:
        key = f"{nd.module}:{nd.node_id}"
        if key in self.nodes:
            raise ValueError(f"duplicate node_id {nd.node_id!r} in {nd.module}")
        self.nodes[key] = nd

    def add_workflow(self, wd: WorkflowDef) -> None:
        if wd.workflow_id in self.workflows:
            raise ValueError(f"duplicate workflow_id {wd.workflow_id!r}")
        self.workflows[wd.workflow_id] = wd

    def node_for_workflow(self, workflow_id: str, node_id: str) -> NodeDef:
        wd = self.workflows[workflow_id]
        key = f"{wd.module}:{node_id}"
        return self.nodes[key]


REGISTRY = Registry()


def _param_names(fn: Callable) -> list[str]:
    return [p for p in inspect.signature(fn).parameters]


def node(
    *,
    output_kind: str,
    hash_with: list[Any] | None = None,
    code_salt: str = "",
    dedupe: str = "none",
    display_name: str = "",
):
    """Register an engine node. The body runs inside a Temporal activity."""

    def deco(fn: Callable) -> Callable:
        nd = NodeDef(
            node_id=fn.__name__,
            fn=fn,
            executor="engine",
            output_kind=output_kind,
            param_names=_param_names(fn),
            hash_with=list(hash_with or []),
            code_salt=code_salt,
            dedupe=dedupe,
            display_name=display_name or fn.__name__.replace("_", " "),
            module=fn.__module__,
        )
        REGISTRY.add_node(nd)
        fn._engine_node = nd  # type: ignore[attr-defined]
        return fn

    return deco


def human_node(
    *,
    output_kind: str,
    title: str = "",
    hash_with: list[Any] | None = None,
    code_salt: str = "",
    result_validator: Callable[[dict], None] | None = None,
):
    """Register a human node. The fn returns a HumanTask (question + answer
    schema); the engine turns it into a waiting Temporal workflow. Human
    nodes always get hard start-dedupe — a duplicate ask is a correctness
    bug, not an efficiency bug. `result_validator` (raises ValueError to
    reject) guards submissions: accepted answers are memoized forever, so
    the answer contract is a ledger invariant, not a UI nicety."""

    def deco(fn: Callable) -> Callable:
        nd = NodeDef(
            node_id=fn.__name__,
            fn=fn,
            executor="human",
            output_kind=output_kind,
            param_names=_param_names(fn),
            hash_with=list(hash_with or []),
            code_salt=code_salt,
            dedupe="hard",
            display_name=title or fn.__name__.replace("_", " "),
            module=fn.__module__,
            result_validator=result_validator,
        )
        REGISTRY.add_node(nd)
        fn._engine_node = nd  # type: ignore[attr-defined]
        return fn

    return deco


def workflow_def(*, id: str, kinds: list[Kind], display_name: str = ""):
    """Register a workflow entrypoint. `id` must equal the filename stem
    (catalog publish enforces)."""

    def deco(fn: Callable) -> Callable:
        wd = WorkflowDef(
            workflow_id=id,
            fn=fn,
            kinds=kinds,
            display_name=display_name or id.replace("_", " "),
            module=fn.__module__,
        )
        stem = fn.__module__.rsplit(".", 1)[-1]
        if stem != id:
            raise ValueError(
                f"workflow id {id!r} must equal its filename stem {stem!r} "
                "(the filename IS the version)"
            )
        REGISTRY.add_workflow(wd)
        fn._engine_workflow = wd  # type: ignore[attr-defined]
        return fn

    return deco
