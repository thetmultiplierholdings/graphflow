"""Canonical serialization + hashing.

Rules (normative, language-neutral — the contract for a future TS port):
  1. UTF-8; object keys sorted bytewise; no insignificant whitespace.
  2. Strings (values AND keys) are NFC-normalized before serialization.
  3. Floats are BANNED in hashed payloads: money/rates are decimal strings.
  4. Wall-clock timestamps do not belong inside hashed payloads.
  5. An artifact-valued argument serializes as {"$artifact": "<content hash>"}.
  6. Allowed value types: str, int, bool, None, dict (str keys), list.

Everything volatile (labels, created_at) lives in ledger columns, never in
hashed bytes — equal values must produce equal bytes or memoization dies.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any


class CanonicalizationError(ValueError):
    pass


def _check(value: Any, path: str) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        raise CanonicalizationError(
            f"float at {path}: floats are banned in hashed payloads; "
            "use decimal strings ('34.50')"
        )
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalizationError(f"non-string dict key at {path}: {k!r}")
            _check(v, f"{path}.{k}")
        return
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _check(v, f"{path}[{i}]")
        return
    raise CanonicalizationError(f"unsupported type {type(value).__name__} at {path}")


def _nfc(value: Any) -> Any:
    """Rule 2: canonically-equal Unicode must produce equal bytes."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, dict):
        return {unicodedata.normalize("NFC", k): _nfc(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_nfc(v) for v in value]
    return value


def canonical_bytes(value: Any) -> bytes:
    """Deterministic canonical JSON bytes for a JSON-safe value."""
    _check(value, "$")
    return json.dumps(
        _nfc(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_value(value: Any) -> str:
    return sha256_hex(canonical_bytes(value))


def memo_key(code_hash: str, input_hash: str) -> str:
    """memo_key = H(code_hash || input_hash). Engagement scoping is applied
    at lookup time via UNIQUE (engagement_id, memo_key) — never inside the hash."""
    return sha256_hex((code_hash + input_hash).encode("ascii"))
