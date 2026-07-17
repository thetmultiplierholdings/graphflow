import pytest

from engine.canonical import CanonicalizationError, canonical_bytes, hash_value, memo_key


def test_sorted_keys_byte_exact():
    assert canonical_bytes({"b": 1, "a": "x"}) == b'{"a":"x","b":1}'


def test_equal_values_equal_bytes():
    assert canonical_bytes({"a": [1, {"z": None, "y": True}]}) == canonical_bytes(
        {"a": [1, {"y": True, "z": None}]}
    )


def test_float_banned():
    with pytest.raises(CanonicalizationError):
        canonical_bytes({"amount": 12.5})


def test_non_string_key_banned():
    with pytest.raises(CanonicalizationError):
        canonical_bytes({1: "x"})


def test_artifact_form_hashes_stably():
    a = hash_value({"doc": {"$artifact": "ab" * 32}})
    b = hash_value({"doc": {"$artifact": "ab" * 32}})
    assert a == b


def test_nfc_normalization():
    # precomposed U+00E9 vs decomposed e + combining U+0301:
    # canonically equal Unicode must produce equal bytes (rule 2)
    pre = "café"
    dec = "café"
    assert pre != dec  # different codepoints in the source...
    assert canonical_bytes({"name": pre}) == canonical_bytes({"name": dec})
    assert hash_value({pre: 1}) == hash_value({dec: 1})


def test_memo_key_composition():
    assert memo_key("c" * 64, "i" * 64) != memo_key("d" * 64, "i" * 64)
    assert memo_key("c" * 64, "i" * 64) == memo_key("c" * 64, "i" * 64)
