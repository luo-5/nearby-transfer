"""
Wire frame encoding and decoding for bootstrap / control messages.
Format:
- 4 bytes total frame length (big endian) = 2 + headerLength + payloadLength
- 2 bytes header length (big endian)
- UTF-8 canonical JSON header
- Binary payload
"""

import json
from typing import Dict, Any, Tuple
from canonical_json import canonical_json

FRAME_LENGTH_BYTES = 4
HEADER_LENGTH_BYTES = 2
MAX_FRAME_SIZE = 16 * 1024 * 1024
MAX_HEADER_SIZE = 64 * 1024


def encode_wire_frame(header: Dict[str, Any], payload: bytes) -> bytes:
    """Encode a wire frame from a dictionary header and byte payload."""
    header_json_str = canonical_json(header)
    header_bytes = header_json_str.encode("utf-8")
    if len(header_bytes) > MAX_HEADER_SIZE:
        raise ValueError("Header size exceeds maximum allowed")

    frame_length = HEADER_LENGTH_BYTES + len(header_bytes) + len(payload)
    if frame_length > MAX_FRAME_SIZE:
        raise ValueError("Frame size exceeds maximum allowed")

    return (
        frame_length.to_bytes(FRAME_LENGTH_BYTES, "big")
        + len(header_bytes).to_bytes(HEADER_LENGTH_BYTES, "big")
        + header_bytes
        + payload
    )


def decode_wire_frame(data: bytes) -> Tuple[Dict[str, Any], bytes]:
    """Decode a complete wire frame into (header_dict, payload_bytes)."""
    if len(data) < FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES:
        raise ValueError("Wire frame is truncated")

    frame_length = int.from_bytes(data[0:4], "big")
    header_length = int.from_bytes(data[4:6], "big")

    if frame_length < HEADER_LENGTH_BYTES + header_length:
        raise ValueError("Invalid frame length in header")
    if len(data) < FRAME_LENGTH_BYTES + frame_length:
        raise ValueError("Data buffer does not contain full frame")

    header_start = 6
    header_end = header_start + header_length
    header_bytes = data[header_start:header_end]
    header_dict = json.loads(header_bytes.decode("utf-8"))

    payload = data[header_end : FRAME_LENGTH_BYTES + frame_length]
    return header_dict, payload
