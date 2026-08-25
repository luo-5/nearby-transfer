"""
Binary chunk frame encoder and decoder (NTV2CHNK format).
Fixed 48-byte header followed by variable-length fields:
- taskId (utf-8)
- relativePath (utf-8)
- nonce (12 bytes)
- authTag (16 bytes)
- ciphertext (plainLength bytes)
"""

import struct
from typing import Dict, Any, NamedTuple

MAGIC = b"NTV2CHNK"
VERSION = 1
HEADER_BYTES = 48
FLAGS = 0
NONCE_BYTES = 12
AUTH_TAG_BYTES = 16


class ChunkFrame(NamedTuple):
    task_id: str
    relative_path: str
    offset: int
    sequence: int
    plain_length: int
    nonce: bytes
    auth_tag: bytes
    ciphertext: bytes


def encode_chunk_frame(
    task_id: str,
    relative_path: str,
    offset: int,
    sequence: int,
    plain_length: int,
    nonce: bytes,
    auth_tag: bytes,
    ciphertext: bytes,
) -> bytes:
    """Encode chunk data into binary NTV2CHNK frame."""
    task_id_bytes = task_id.encode("utf-8")
    path_bytes = relative_path.encode("utf-8")

    if len(nonce) != NONCE_BYTES:
        raise ValueError(f"Nonce must be {NONCE_BYTES} bytes")
    if len(auth_tag) != AUTH_TAG_BYTES:
        raise ValueError(f"Auth tag must be {AUTH_TAG_BYTES} bytes")
    if len(ciphertext) != plain_length:
        raise ValueError("Ciphertext length must equal plainLength")

    frame_length = (
        HEADER_BYTES
        + len(task_id_bytes)
        + len(path_bytes)
        + NONCE_BYTES
        + AUTH_TAG_BYTES
        + len(ciphertext)
    )

    header = bytearray(HEADER_BYTES)
    header[0:8] = MAGIC
    header[8] = VERSION
    header[9] = FLAGS
    struct.pack_into(">H", header, 10, HEADER_BYTES)
    struct.pack_into(">I", header, 12, frame_length)
    struct.pack_into(">H", header, 16, len(task_id_bytes))
    struct.pack_into(">H", header, 18, len(path_bytes))
    struct.pack_into(">Q", header, 20, offset)
    struct.pack_into(">Q", header, 28, sequence)
    struct.pack_into(">I", header, 36, plain_length)
    struct.pack_into(">I", header, 40, len(ciphertext))
    header[44] = NONCE_BYTES
    header[45] = AUTH_TAG_BYTES
    struct.pack_into(">H", header, 46, 0)  # reserved

    return (
        bytes(header)
        + task_id_bytes
        + path_bytes
        + nonce
        + auth_tag
        + ciphertext
    )


def decode_chunk_frame(data: bytes) -> ChunkFrame:
    """Decode a binary NTV2CHNK frame."""
    if len(data) < HEADER_BYTES:
        raise ValueError("Chunk frame is truncated (less than 48 bytes)")

    if data[0:8] != MAGIC:
        raise ValueError("Invalid magic bytes in chunk frame")
    version = data[8]
    if version != VERSION:
        raise ValueError(f"Unsupported chunk frame version: {version}")

    header_len = struct.unpack_from(">H", data, 10)[0]
    if header_len != HEADER_BYTES:
        raise ValueError(f"Invalid header length: {header_len}")

    frame_length = struct.unpack_from(">I", data, 12)[0]
    task_id_len = struct.unpack_from(">H", data, 16)[0]
    path_len = struct.unpack_from(">H", data, 18)[0]
    offset = struct.unpack_from(">Q", data, 20)[0]
    sequence = struct.unpack_from(">Q", data, 28)[0]
    plain_length = struct.unpack_from(">I", data, 36)[0]
    ciphertext_len = struct.unpack_from(">I", data, 40)[0]
    nonce_len = data[44]
    auth_tag_len = data[45]

    expected_length = (
        HEADER_BYTES
        + task_id_len
        + path_len
        + nonce_len
        + auth_tag_len
        + ciphertext_len
    )
    if frame_length != expected_length or len(data) < frame_length:
        raise ValueError("Frame length mismatch or truncated data")

    cursor = HEADER_BYTES
    task_id = data[cursor : cursor + task_id_len].decode("utf-8")
    cursor += task_id_len
    relative_path = data[cursor : cursor + path_len].decode("utf-8")
    cursor += path_len
    nonce = data[cursor : cursor + nonce_len]
    cursor += nonce_len
    auth_tag = data[cursor : cursor + auth_tag_len]
    cursor += auth_tag_len
    ciphertext = data[cursor : cursor + ciphertext_len]

    return ChunkFrame(
        task_id=task_id,
        relative_path=relative_path,
        offset=offset,
        sequence=sequence,
        plain_length=plain_length,
        nonce=nonce,
        auth_tag=auth_tag,
        ciphertext=ciphertext,
    )
