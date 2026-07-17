"""graphflow API — FastAPI over the SQLite ledger + real Temporal Cloud.

Run: uv run uvicorn api.main:app --port 8000

Env: GRAPHFLOW_DB (default graphflow.sqlite3), GRAPHFLOW_STORAGE (default
mock_s3_gcs), GRAPHFLOW_EMBED_WORKER (default 1: run the Temporal worker
inside this process). Temporal/Anthropic credentials come from .env via
engine.runtime — never logged."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.deps import env_db_path, env_embed_worker, env_storage_root
from api.routes import ALL_ROUTERS
from engine import db as dbm
from engine import runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_path = env_db_path()
    storage_root = env_storage_root()
    instance = dbm.init_db(db_path)

    # Registry must contain every workflow version before publish/worker.
    import workflows

    workflows.load_all()
    from engine.registry import REGISTRY

    conn = dbm.connect(db_path)
    try:
        for line in dbm.publish_catalog(conn, REGISTRY, runtime.task_queue()):
            print(f"  [catalog] {line}")
    finally:
        conn.close()

    client = await runtime.connect_client()
    app.state.db_path = db_path
    app.state.storage_root = storage_root
    app.state.instance = instance
    app.state.client = client

    worker = None
    worker_task: asyncio.Task | None = None
    if env_embed_worker():
        worker = runtime.build_worker(client, db_path, storage_root)
        worker_task = asyncio.create_task(worker.run())
        print(f"  [worker] embedded worker running (task queue {runtime.task_queue()!r})")
    try:
        yield
    finally:
        if worker is not None:
            await worker.shutdown()
            if worker_task is not None:
                await worker_task


app = FastAPI(title="graphflow API", lifespan=lifespan)

# Comma-separated extra origins (e.g. the Playwright e2e frontend on :3100).
_cors_origins = os.environ.get("GRAPHFLOW_CORS_ORIGINS", "http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in ALL_ROUTERS:
    app.include_router(router)
