"""Mock S3/GCS object store: 'object storage' as a local directory.

Layout: {root}/{engagement_id}/{hash} — write-once objects, per-engagement
prefix so retention / legal hold / scrubbing operate on one folder.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

DEFAULT_ROOT = "mock_s3_gcs"


def payload_ref(engagement_id: int, content_hash: str) -> str:
    return f"{engagement_id}/{content_hash}"


def write_payload(root: str | Path, engagement_id: int, content_hash: str, data: bytes) -> str:
    """Write-once: if the object exists it is never rewritten (content-addressed,
    so identical name means identical bytes)."""
    ref = payload_ref(engagement_id, content_hash)
    path = Path(root) / ref
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        # Unique tmp per writer: concurrent identical-output executions must
        # not share a tmp file (Windows replace-while-open, torn writes). All
        # writers carry identical bytes, so whichever replace lands last wins
        # harmlessly.
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
    return ref


def read_payload(root: str | Path, ref: str) -> bytes:
    return (Path(root) / ref).read_bytes()
