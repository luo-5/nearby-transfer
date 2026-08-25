"""
Canonical JSON serialization and parsing according to Nearby Transfer v2 spec.
Deterministic, sorted keys, no whitespace, safe integers only.
"""

import json
from typing import Any, Dict, List, Union

CanonicalValue = Union[None, bool, int, str, List[Any], Dict[str, Any]]

MIN_SAFE_INTEGER = -9007199254740991  # -(2^53 - 1)
MAX_SAFE_INTEGER = 9007199254740991   # 2^53 - 1


def canonical_json(value: CanonicalValue) -> str:
    """Serialize a value to byte-for-byte canonical JSON."""
    return _serialize(value, "$")


def parse_canonical_json(serialized: str, label: str = "Protocol JSON") -> CanonicalValue:
    """Parse and verify that the input string is canonical JSON."""
    if not isinstance(serialized, str):
        raise TypeError(f"{label} must be a string")
    try:
        parsed = json.loads(serialized)
    except Exception as e:
        raise ValueError(f"{label} is not valid JSON: {e}") from e

    re_serialized = canonical_json(parsed)
    if re_serialized != serialized:
        raise ValueError(f"{label} is not canonical JSON")
    return parsed


def _serialize(value: Any, path: str) -> str:
    if value is None:
        return "null"

    if isinstance(value, bool):
        return "true" if value else "false"

    if isinstance(value, int):
        if value < MIN_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
            raise TypeError(f"Protocol value at {path} must be a safe integer")
        return str(value)

    if isinstance(value, float):
        raise TypeError(f"Protocol value at {path} has an unsupported type (float)")

    if isinstance(value, str):
        _assert_well_formed_string(value, path)
        return json.dumps(value, ensure_ascii=False)

    if isinstance(value, (list, tuple)):
        items = [_serialize(item, f"{path}[{i}]") for i, item in enumerate(value)]
        return f"[{','.join(items)}]"

    if isinstance(value, dict):
        # Sort keys by UTF-16 code units / Unicode codepoint
        sorted_keys = sorted(value.keys())
        entries = []
        for key in sorted_keys:
            if not isinstance(key, str):
                raise TypeError(f"Object key at {path} must be a string")
            _assert_well_formed_string(key, f"{path}.<key>")
            val = value[key]
            if val is None and key not in value:
                raise TypeError(f"Protocol value at {path}.{key} is undefined")
            serialized_key = json.dumps(key, ensure_ascii=False)
            serialized_val = _serialize(val, f"{path}.{key}")
            entries.append(f"{serialized_key}:{serialized_val}")
        return f"{{{','.join(entries)}}}"

    raise TypeError(f"Protocol value at {path} has an unsupported type: {type(value)}")


def _assert_well_formed_string(value: str, path: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise TypeError(f"Protocol string at {path} contains an invalid surrogate: {e}") from e
