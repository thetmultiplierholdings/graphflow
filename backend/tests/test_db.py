"""Ledger semantics: revive, kind-scoped content addressing, idempotent
completion transaction, attach promotion, copy-user-rows-only."""

import pytest

from engine import db as dbm


@pytest.fixture
def env(tmp_path):
    db_path = str(tmp_path / "test.sqlite3")
    storage = str(tmp_path / "store")
    dbm.init_db(db_path)
    conn = dbm.connect(db_path)
    # minimal catalog so FKs hold
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "INSERT INTO workflows VALUES ('wf','WF','GraphflowRun','q')")
    conn.execute(
        "INSERT INTO nodes VALUES ('wf','n1','engine','out_kind','N1','ch1')")
    conn.execute("COMMIT")
    eng = dbm.create_engagement(conn, "test-eng")
    yield conn, storage, eng
    conn.close()


def test_supply_revive_same_kind_same_row(env):
    conn, storage, eng = env
    a = dbm.supply_artifact(conn, storage, eng, "brokerage_statement", b"BYTES")
    b = dbm.supply_artifact(conn, storage, eng, "brokerage_statement", b"BYTES")
    assert a["artifact_id"] == b["artifact_id"]  # the revive path


def test_same_bytes_different_kind_is_new_row(env):
    conn, storage, eng = env
    a = dbm.supply_artifact(conn, storage, eng, "brokerage_statement", b"BYTES")
    b = dbm.supply_artifact(conn, storage, eng, "payment_slip", b"BYTES")
    assert a["artifact_id"] != b["artifact_id"]  # kinds route resolution


def _complete(conn, storage, eng, wfr, memo="m1", payload=b'{"x":1}'):
    return dbm.record_completion(
        conn, storage,
        engagement_id=eng, workflow_run_id=wfr, workflow_id="wf", node_id="n1",
        code_hash="ch1", memo_key=memo, output_kind="out_kind", payload=payload,
        media_type="application/json", created_by="engine", temporal_id="t/1/1",
        input_artifact_ids=[],
    )


def test_completion_is_idempotent(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    ref1, fresh1 = _complete(conn, storage, eng, wfr)
    ref2, fresh2 = _complete(conn, storage, eng, wfr)
    assert fresh1 is True and fresh2 is False
    assert ref1["artifact_id"] == ref2["artifact_id"]
    n = conn.execute("SELECT COUNT(*) FROM node_runs").fetchone()[0]
    assert n == 1


def test_completion_links_producer(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    ref, _ = _complete(conn, storage, eng, wfr)
    art = dbm.get_artifact(conn, ref["artifact_id"])
    nr = conn.execute("SELECT * FROM node_runs WHERE node_run_id=?",
                      (art["produced_by_node_run"],)).fetchone()
    assert nr["output_artifact_id"] == ref["artifact_id"]  # the circular pair holds


def test_memo_lookup(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    assert dbm.memo_lookup(conn, eng, "m1") is None
    ref, _ = _complete(conn, storage, eng, wfr)
    assert dbm.memo_lookup(conn, eng, "m1")["artifact_id"] == ref["artifact_id"]
    # hard isolation: another engagement sees nothing
    eng2 = dbm.create_engagement(conn, "other")
    assert dbm.memo_lookup(conn, eng2, "m1") is None


def test_attach_promotion_never_demotes(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    a = dbm.supply_artifact(conn, storage, eng, "k", b"D")
    dbm.attach(conn, wfr, a["artifact_id"], source="engine", added_by="engine")
    dbm.attach(conn, wfr, a["artifact_id"], source="user", added_by="alice")  # promote
    dbm.attach(conn, wfr, a["artifact_id"], source="engine", added_by="engine")  # no demote
    row = conn.execute(
        "SELECT source FROM workflow_run_artifacts WHERE workflow_run_id=?", (wfr,)
    ).fetchone()
    assert row["source"] == "user"


def test_copy_takes_user_rows_only(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "January")
    doc = dbm.supply_artifact(conn, storage, eng, "k", b"DOC")
    dbm.attach(conn, wfr, doc["artifact_id"], source="user")
    _complete(conn, storage, eng, wfr)  # engine result lands in the workspace
    assert len(dbm.workspace_artifacts(conn, wfr)) == 2

    feb = dbm.create_workspace(conn, eng, "wf", "February", copied_from=wfr)
    copied = dbm.workspace_artifacts(conn, feb)
    assert [a["artifact_id"] for a in copied] == [doc["artifact_id"]]
    assert copied[0]["source"] == "user"


def test_detach_is_the_only_delete(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    doc = dbm.supply_artifact(conn, storage, eng, "k", b"DOC")
    dbm.attach(conn, wfr, doc["artifact_id"], source="user")
    dbm.detach(conn, wfr, doc["artifact_id"])
    assert dbm.workspace_artifacts(conn, wfr) == []
    # ledger untouched
    assert dbm.get_artifact(conn, doc["artifact_id"])["hash"] == doc["hash"]


def test_user_attachments_sorted_by_hash(env):
    conn, storage, eng = env
    wfr = dbm.create_workspace(conn, eng, "wf", "ws")
    a = dbm.supply_artifact(conn, storage, eng, "k", b"AAA")
    b = dbm.supply_artifact(conn, storage, eng, "k", b"BBB")
    dbm.attach(conn, wfr, a["artifact_id"], source="user")
    dbm.attach(conn, wfr, b["artifact_id"], source="user")
    hashes = [r["hash"] for r in dbm.user_attachments(conn, wfr)]
    assert hashes == sorted(hashes)
