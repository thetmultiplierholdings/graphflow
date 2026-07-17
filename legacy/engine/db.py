"""SQLite ledger + workspace + catalog mirror.

Postgres-isms translated to SQLite:
  - deferred circular FK pair (artifacts.produced_by_node_run <->
    node_runs.output_artifact_id) via DEFERRABLE INITIALLY DEFERRED,
    enforced because every connection sets PRAGMA foreign_keys=ON;
  - node_run_id pre-allocation via MAX+1 inside BEGIN IMMEDIATE (SQLite
    is single-writer, so this is race-free);
  - ON CONFLICT DO NOTHING for the idempotent completion transaction.

LEDGER (artifacts, node_runs, node_run_inputs) is insert-only; the one
mutable ledger column is artifacts.label. WORKSPACE rows are editable;
detaching a workflow_run_artifacts row is the only DELETE in the system.
"""

from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from engine import storage
from engine.canonical import sha256_hex

DEFAULT_DB = "graphflow.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engagements (
  engagement_id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  temporal_workflow_type TEXT NOT NULL,
  task_queue TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_kinds (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  kind TEXT NOT NULL,
  leaf INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  PRIMARY KEY (workflow_id, kind)
);

CREATE TABLE IF NOT EXISTS nodes (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  node_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('engine','human')),
  output_kind TEXT NOT NULL,
  display_name TEXT,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  payload_ref TEXT,
  produced_by_node_run INTEGER
    REFERENCES node_runs(node_run_id) DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (engagement_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_browse ON artifacts (engagement_id, kind, created_at);

CREATE TABLE IF NOT EXISTS node_runs (
  node_run_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  memo_key TEXT NOT NULL,
  output_artifact_id INTEGER NOT NULL
    REFERENCES artifacts(artifact_id) DEFERRABLE INITIALLY DEFERRED,
  temporal_id TEXT NOT NULL,
  UNIQUE (engagement_id, memo_key),
  FOREIGN KEY (workflow_id, node_id) REFERENCES nodes(workflow_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_reverse_lineage ON node_runs (output_artifact_id);

CREATE TABLE IF NOT EXISTS node_run_inputs (
  node_run_id INTEGER NOT NULL REFERENCES node_runs(node_run_id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY (node_run_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_consumer ON node_run_inputs (artifact_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  workflow_run_id INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(engagement_id),
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  label TEXT NOT NULL,
  copied_from_workflow_run INTEGER REFERENCES workflow_runs(workflow_run_id),
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces ON workflow_runs (engagement_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_runs(workflow_run_id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts(artifact_id),
  source TEXT NOT NULL CHECK (source IN ('user','engine')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_impact ON workflow_run_artifacts (artifact_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def auto_label(kind: str) -> str:
    return f"{kind}_{datetime.now(timezone.utc).strftime('%d%m%y_%H%M%S')}"


def connect(db_path: str = DEFAULT_DB) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(db_path: str = DEFAULT_DB) -> str:
    conn = connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        row = conn.execute("SELECT value FROM meta WHERE key='instance_id'").fetchone()
        if row is None:
            instance = secrets.token_hex(4)
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('instance_id', ?)", (instance,)
            )
        else:
            instance = row["value"]
        return instance
    finally:
        conn.close()


def instance_id(conn: sqlite3.Connection) -> str:
    return conn.execute("SELECT value FROM meta WHERE key='instance_id'").fetchone()["value"]


def _ref(row: sqlite3.Row) -> dict:
    return {
        "artifact_id": row["artifact_id"],
        "hash": row["hash"],
        "kind": row["kind"],
        "label": row["label"],
        "media_type": row["media_type"],
    }


# ---------- catalog ----------

def publish_catalog(conn: sqlite3.Connection, registry, task_queue: str) -> list[str]:
    """CI-publish the code registry into the catalog mirror (upsert, never delete)."""
    published = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        for wf in registry.workflows.values():
            conn.execute(
                "INSERT INTO workflows (workflow_id, display_name, temporal_workflow_type, task_queue) "
                "VALUES (?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET "
                "display_name=excluded.display_name, temporal_workflow_type=excluded.temporal_workflow_type, "
                "task_queue=excluded.task_queue",
                (wf.workflow_id, wf.display_name, "GraphflowRun", task_queue),
            )
            for kind, leaf in wf.leaf_kinds().items():
                display = next((k.display for k in wf.kinds if k.kind == kind), "")
                conn.execute(
                    "INSERT INTO workflow_kinds (workflow_id, kind, leaf, display_name) VALUES (?,?,?,?) "
                    "ON CONFLICT(workflow_id, kind) DO UPDATE SET leaf=excluded.leaf, display_name=excluded.display_name",
                    (wf.workflow_id, kind, int(leaf), display),
                )
            for nd in wf.nodes():
                prev = conn.execute(
                    "SELECT code_hash FROM nodes WHERE workflow_id=? AND node_id=?",
                    (wf.workflow_id, nd.node_id),
                ).fetchone()
                if prev is not None and prev["code_hash"] != nd.code_hash:
                    published.append(
                        f"WARNING: in-place edit detected for {wf.workflow_id}/{nd.node_id} "
                        "(code_hash changed under an existing workflow_id — consider copying to _v2)"
                    )
                conn.execute(
                    "INSERT INTO nodes (workflow_id, node_id, executor, output_kind, display_name, code_hash) "
                    "VALUES (?,?,?,?,?,?) ON CONFLICT(workflow_id, node_id) DO UPDATE SET "
                    "executor=excluded.executor, output_kind=excluded.output_kind, "
                    "display_name=excluded.display_name, code_hash=excluded.code_hash",
                    (wf.workflow_id, nd.node_id, nd.executor, nd.output_kind, nd.display_name, nd.code_hash),
                )
            published.append(f"published {wf.workflow_id} ({len(wf.nodes())} nodes)")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return published


# ---------- engagement space ----------

def create_engagement(conn: sqlite3.Connection, label: str) -> int:
    conn.execute("BEGIN IMMEDIATE")
    cur = conn.execute(
        "INSERT INTO engagements (label, created_at) VALUES (?,?)", (label, now_iso())
    )
    conn.execute("COMMIT")
    return cur.lastrowid


def supply_artifact(
    conn: sqlite3.Connection,
    storage_root: str,
    engagement_id: int,
    kind: str,
    data: bytes,
    *,
    label: str | None = None,
    media_type: str = "text/plain",
    created_by: str = "user",
) -> dict:
    """External supply (upload / reference table / hand-built value):
    produced_by_node_run = NULL. Re-supplying identical bytes under the same
    kind lands on the existing row — the revive path (reported via the
    returned 'existed' flag)."""
    content_hash = sha256_hex(data)
    ref = storage.write_payload(storage_root, engagement_id, content_hash, data)
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            "SELECT 1 FROM artifacts WHERE engagement_id=? AND kind=? AND hash=?",
            (engagement_id, kind, content_hash),
        ).fetchone()
        conn.execute(
            "INSERT INTO artifacts (engagement_id, hash, kind, label, media_type, byte_size, "
            "payload_ref, produced_by_node_run, created_by, created_at) "
            "VALUES (?,?,?,?,?,?,?,NULL,?,?) "
            "ON CONFLICT(engagement_id, kind, hash) DO NOTHING",
            (engagement_id, content_hash, kind, label or auto_label(kind),
             media_type, len(data), ref, created_by, now_iso()),
        )
        row = conn.execute(
            "SELECT * FROM artifacts WHERE engagement_id=? AND kind=? AND hash=?",
            (engagement_id, kind, content_hash),
        ).fetchone()
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return dict(_ref(row), existed=existing is not None)


def create_workspace(
    conn: sqlite3.Connection,
    engagement_id: int,
    workflow_id: str,
    label: str,
    *,
    created_by: str = "user",
    copied_from: int | None = None,
) -> int:
    """Create a workspace; copying takes USER-sourced membership rows only —
    engine results are never copied (the new run recomputes or memo-hits them)."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            "INSERT INTO workflow_runs (engagement_id, workflow_id, label, "
            "copied_from_workflow_run, created_by, created_at) VALUES (?,?,?,?,?,?)",
            (engagement_id, workflow_id, label, copied_from, created_by, now_iso()),
        )
        wfr = cur.lastrowid
        if copied_from is not None:
            conn.execute(
                "INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at) "
                "SELECT ?, artifact_id, 'user', ?, ? FROM workflow_run_artifacts "
                "WHERE workflow_run_id=? AND source='user'",
                (wfr, created_by, now_iso(), copied_from),
            )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return wfr


def attach(
    conn: sqlite3.Connection,
    workflow_run_id: int,
    artifact_id: int,
    *,
    source: str = "user",
    added_by: str = "user",
) -> None:
    """User attach PROMOTES an engine row to user; engine attach never demotes."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        if source == "user":
            conn.execute(
                "INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO UPDATE SET "
                "source='user', added_by=excluded.added_by, added_at=excluded.added_at",
                (workflow_run_id, artifact_id, source, added_by, now_iso()),
            )
        else:
            conn.execute(
                "INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO NOTHING",
                (workflow_run_id, artifact_id, source, added_by, now_iso()),
            )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def detach(conn: sqlite3.Connection, workflow_run_id: int, artifact_id: int) -> None:
    """The user-facing delete — the ONLY delete in the system. The ledger keeps
    everything, which is why reintroducing the same bytes revives prior work."""
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "DELETE FROM workflow_run_artifacts WHERE workflow_run_id=? AND artifact_id=?",
        (workflow_run_id, artifact_id),
    )
    conn.execute("COMMIT")


def user_attachments(conn: sqlite3.Connection, workflow_run_id: int) -> list[dict]:
    """The run snapshot: USER-sourced attachments only (invariant I7)."""
    rows = conn.execute(
        "SELECT a.* FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id) "
        "WHERE wra.workflow_run_id=? AND wra.source='user' ORDER BY a.hash",
        (workflow_run_id,),
    ).fetchall()
    return [_ref(r) for r in rows]


def workspace_artifacts(conn: sqlite3.Connection, workflow_run_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT a.*, wra.source, (a.produced_by_node_run IS NOT NULL) AS produced "
        "FROM workflow_run_artifacts wra JOIN artifacts a USING (artifact_id) "
        "WHERE wra.workflow_run_id=? ORDER BY a.created_at, a.artifact_id",
        (workflow_run_id,),
    ).fetchall()
    return [dict(_ref(r), source=r["source"], produced=bool(r["produced"])) for r in rows]


def get_workspace(conn: sqlite3.Connection, workflow_run_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM workflow_runs WHERE workflow_run_id=?", (workflow_run_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"workflow_run {workflow_run_id} not found")
    return dict(row)


def get_artifact(conn: sqlite3.Connection, artifact_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM artifacts WHERE artifact_id=?", (artifact_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"artifact {artifact_id} not found")
    return dict(row)


def rename_artifact(conn: sqlite3.Connection, artifact_id: int, label: str) -> None:
    """The single mutable ledger column."""
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE artifacts SET label=? WHERE artifact_id=?", (label, artifact_id))
    conn.execute("COMMIT")


# ---------- ledger / memo ----------

def memo_lookup(conn: sqlite3.Connection, engagement_id: int, memo_key: str) -> dict | None:
    row = conn.execute(
        "SELECT a.* FROM node_runs nr JOIN artifacts a ON a.artifact_id = nr.output_artifact_id "
        "WHERE nr.engagement_id=? AND nr.memo_key=?",
        (engagement_id, memo_key),
    ).fetchone()
    return _ref(row) if row else None


def record_completion(
    conn: sqlite3.Connection,
    storage_root: str,
    *,
    engagement_id: int,
    workflow_run_id: int | None,
    workflow_id: str,
    node_id: str,
    code_hash: str,
    memo_key: str,
    output_kind: str,
    payload: bytes,
    media_type: str,
    created_by: str,
    temporal_id: str,
    input_artifact_ids: list[int],
) -> tuple[dict, bool]:
    """The completion transaction: ONE atomic, idempotent write filing
    output artifact + node_run + input list + workspace attachment. Returns
    (artifact ref, fresh) where fresh=False means the memo already had it."""
    content_hash = sha256_hex(payload)
    # Payload write is outside the tx (write-once, content-addressed: harmless
    # if the tx then discovers a memo hit).
    ref = storage.write_payload(storage_root, engagement_id, content_hash, payload)

    conn.execute("BEGIN IMMEDIATE")
    try:
        # Fast path: someone already answered this exact question.
        existing = conn.execute(
            "SELECT a.* FROM node_runs nr JOIN artifacts a ON a.artifact_id = nr.output_artifact_id "
            "WHERE nr.engagement_id=? AND nr.memo_key=?",
            (engagement_id, memo_key),
        ).fetchone()
        if existing is not None:
            if workflow_run_id is not None:
                conn.execute(
                    "INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at) "
                    "VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO NOTHING",
                    (workflow_run_id, existing["artifact_id"], "engine", "engine", now_iso()),
                )
            conn.execute("COMMIT")
            return _ref(existing), False

        # Slow path: file the fact. Pre-allocate the node_run id (single-writer
        # under BEGIN IMMEDIATE); the deferred FK lets the artifact point at it
        # before the node_run row exists.
        next_id = conn.execute(
            "SELECT COALESCE(MAX(node_run_id), 0) + 1 AS n FROM node_runs"
        ).fetchone()["n"]
        conn.execute(
            "INSERT INTO artifacts (engagement_id, hash, kind, label, media_type, byte_size, "
            "payload_ref, produced_by_node_run, created_by, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(engagement_id, kind, hash) DO NOTHING",
            (engagement_id, content_hash, output_kind, auto_label(output_kind), media_type,
             len(payload), ref, next_id, created_by, now_iso()),
        )
        out = conn.execute(
            "SELECT * FROM artifacts WHERE engagement_id=? AND kind=? AND hash=?",
            (engagement_id, output_kind, content_hash),
        ).fetchone()
        conn.execute(
            "INSERT INTO node_runs (node_run_id, engagement_id, workflow_id, node_id, "
            "code_hash, memo_key, output_artifact_id, temporal_id) VALUES (?,?,?,?,?,?,?,?)",
            (next_id, engagement_id, workflow_id, node_id, code_hash, memo_key,
             out["artifact_id"], temporal_id),
        )
        conn.executemany(
            "INSERT INTO node_run_inputs (node_run_id, artifact_id) VALUES (?,?) "
            "ON CONFLICT(node_run_id, artifact_id) DO NOTHING",
            [(next_id, a) for a in set(input_artifact_ids)],
        )
        if workflow_run_id is not None:
            conn.execute(
                "INSERT INTO workflow_run_artifacts (workflow_run_id, artifact_id, source, added_by, added_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(workflow_run_id, artifact_id) DO NOTHING",
                (workflow_run_id, out["artifact_id"], "engine", "engine", now_iso()),
            )
        conn.execute("COMMIT")
        return _ref(out), True
    except sqlite3.IntegrityError:
        # Lost the memo race (or a retry landed twice): roll back and resolve
        # to the winner via the fast path.
        conn.execute("ROLLBACK")
        winner = memo_lookup(conn, engagement_id, memo_key)
        if winner is None:
            raise
        if workflow_run_id is not None:
            attach(conn, workflow_run_id, winner["artifact_id"], source="engine", added_by="engine")
        return winner, False
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def read_artifact_payload(conn: sqlite3.Connection, storage_root: str, artifact_id: int) -> bytes:
    art = get_artifact(conn, artifact_id)
    if art["payload_ref"] is None:
        raise ValueError(f"artifact {artifact_id}: payload destroyed per policy")
    return storage.read_payload(storage_root, art["payload_ref"])


def stats(conn: sqlite3.Connection, engagement_id: int) -> dict:
    q = lambda sql, *p: conn.execute(sql, p).fetchone()[0]  # noqa: E731
    return {
        "artifacts": q("SELECT COUNT(*) FROM artifacts WHERE engagement_id=?", engagement_id),
        "node_runs": q("SELECT COUNT(*) FROM node_runs WHERE engagement_id=?", engagement_id),
        "human_answers": q(
            "SELECT COUNT(*) FROM node_runs nr JOIN nodes n "
            "ON n.workflow_id=nr.workflow_id AND n.node_id=nr.node_id "
            "WHERE nr.engagement_id=? AND n.executor='human'",
            engagement_id,
        ),
        "workspaces": q("SELECT COUNT(*) FROM workflow_runs WHERE engagement_id=?", engagement_id),
    }


# ---------- read models for the API service ----------

def list_engagements(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM engagements ORDER BY created_at, engagement_id"
    ).fetchall()
    return [dict(r) for r in rows]


def get_engagement(conn: sqlite3.Connection, engagement_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM engagements WHERE engagement_id=?", (engagement_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"engagement {engagement_id} not found")
    return dict(row)


def list_workspaces(conn: sqlite3.Connection, engagement_id: int) -> list[dict]:
    """Workspaces with user/engine member counts (idx_workspaces order)."""
    rows = conn.execute(
        "SELECT wr.*, "
        " (SELECT COUNT(*) FROM workflow_run_artifacts wra "
        "   WHERE wra.workflow_run_id = wr.workflow_run_id AND wra.source='user') AS user_docs, "
        " (SELECT COUNT(*) FROM workflow_run_artifacts wra "
        "   WHERE wra.workflow_run_id = wr.workflow_run_id AND wra.source='engine') AS engine_results "
        "FROM workflow_runs wr WHERE wr.engagement_id=? "
        "ORDER BY wr.created_at, wr.workflow_run_id",
        (engagement_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def browse_artifacts(
    conn: sqlite3.Connection, engagement_id: int, *, kind: str | None = None, q: str | None = None
) -> list[dict]:
    """The pool browser (idx_browse), newest first, optional kind/substring filter."""
    sql = "SELECT * FROM artifacts WHERE engagement_id=?"
    params: list = [engagement_id]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    if q:
        sql += " AND (label LIKE ? OR kind LIKE ? OR hash LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like])
    sql += " ORDER BY created_at DESC, artifact_id DESC"
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def list_node_runs(conn: sqlite3.Connection, engagement_id: int) -> list[dict]:
    """Ledger facts, newest first, each with its input artifact ids."""
    runs = conn.execute(
        "SELECT * FROM node_runs WHERE engagement_id=? ORDER BY node_run_id DESC",
        (engagement_id,),
    ).fetchall()
    out = []
    for r in runs:
        inputs = [
            row["artifact_id"]
            for row in conn.execute(
                "SELECT artifact_id FROM node_run_inputs WHERE node_run_id=? ORDER BY artifact_id",
                (r["node_run_id"],),
            ).fetchall()
        ]
        out.append(dict(r, input_artifact_ids=inputs))
    return out


def get_node_run(conn: sqlite3.Connection, node_run_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM node_runs WHERE node_run_id=?", (node_run_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"node_run {node_run_id} not found")
    inputs = [
        r["artifact_id"]
        for r in conn.execute(
            "SELECT artifact_id FROM node_run_inputs WHERE node_run_id=? ORDER BY artifact_id",
            (node_run_id,),
        ).fetchall()
    ]
    return dict(row, input_artifact_ids=inputs)


def artifact_lineage(conn: sqlite3.Connection, artifact_id: int) -> dict:
    """produced_by (idx_reverse_lineage) and consumed_by (idx_consumer)."""
    produced = conn.execute(
        "SELECT node_run_id FROM node_runs WHERE output_artifact_id=?", (artifact_id,)
    ).fetchone()
    consumers = conn.execute(
        "SELECT DISTINCT node_run_id FROM node_run_inputs WHERE artifact_id=? ORDER BY node_run_id",
        (artifact_id,),
    ).fetchall()
    return {
        "produced_by": get_node_run(conn, produced["node_run_id"]) if produced else None,
        "consumed_by": [get_node_run(conn, r["node_run_id"]) for r in consumers],
    }


def catalog_snapshot(conn: sqlite3.Connection) -> list[dict]:
    """The catalog mirror: every published workflow with its kinds and nodes."""
    out = []
    for wf in conn.execute("SELECT * FROM workflows ORDER BY workflow_id").fetchall():
        kinds = conn.execute(
            "SELECT kind, leaf, display_name FROM workflow_kinds WHERE workflow_id=? ORDER BY rowid",
            (wf["workflow_id"],),
        ).fetchall()
        nodes = conn.execute(
            "SELECT node_id, executor, output_kind, display_name, code_hash "
            "FROM nodes WHERE workflow_id=? ORDER BY rowid",
            (wf["workflow_id"],),
        ).fetchall()
        out.append(
            dict(
                wf,
                # Kinds declared without a display name fall back to the kind
                # string — the UI never renders an empty badge.
                kinds=[dict(k, display_name=k["display_name"] or k["kind"]) for k in kinds],
                nodes=[dict(n) for n in nodes],
            )
        )
    return out
