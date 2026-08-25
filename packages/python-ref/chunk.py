"""
Chunk-level authenticated encryption (AES-256-GCM) and position-bound AAD construction.
"""

import os
from typing import Tuple
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from session import CONTEXT, encode_fields

CHUNK_AAD_LABEL = "chunk-aad"
KEY_BYTES = 32
NONCE_BYTES = 12
AUTH_TAG_BYTES = 16
MAX_CHUNK_BYTES = 1024 * 1024


def build_chunk_aad(
    task_id: str,
    path: str,
    offset: int,
    sequence: int,
    plain_length: int,
) -> bytes:
    """
    Build the Additional Authenticated Data (AAD) for a chunk.
    Binds the chunk to context, label, taskId, path, offset, sequence, and length.
    """
    fields_part = encode_fields([CONTEXT, CHUNK_AAD_LABEL, task_id, path])
    offset_part = offset.to_bytes(8, "big")
    sequence_part = sequence.to_bytes(8, "big")
    length_part = plain_length.to_bytes(4, "big")
    return fields_part + offset_part + sequence_part + length_part


def encrypt_chunk(
    key: bytes,
    task_id: str,
    path: str,
    offset: int,
    sequence: int,
    plaintext: bytes,
    nonce: bytes = None,
) -> Tuple[bytes, bytes, bytes]:
    """
    Encrypt a plaintext chunk with AES-256-GCM.
    Returns (nonce, ciphertext, auth_tag).
    """
    if len(key) != KEY_BYTES:
        raise ValueError(f"Key must be exactly {KEY_BYTES} bytes")
    if len(plaintext) > MAX_CHUNK_BYTES:
        raise ValueError(f"Plaintext exceeds maximum chunk size ({MAX_CHUNK_BYTES})")
    if nonce is None:
        nonce = os.urandom(NONCE_BYTES)
    elif len(nonce) != NONCE_BYTES:
        raise ValueError(f"Nonce must be exactly {NONCE_BYTES} bytes")

    aad = build_chunk_aad(task_id, path, offset, sequence, len(plaintext))
    aesgcm = AESGCM(key)
    # cryptography AESGCM.encrypt returns ciphertext + 16-byte tag appended
    encrypted = aesgcm.encrypt(nonce, plaintext, aad)
    ciphertext = encrypted[:-AUTH_TAG_BYTES]
    auth_tag = encrypted[-AUTH_TAG_BYTES:]
    return nonce, ciphertext, auth_tag


def decrypt_chunk(
    key: bytes,
    nonce: bytes,
    task_id: str,
    path: str,
    offset: int,
    sequence: int,
    ciphertext: bytes,
    auth_tag: bytes,
) -> bytes:
    """
    Decrypt and authenticate an AES-256-GCM chunk.
    Throws Exception if authentication fails.
    """
    if len(key) != KEY_BYTES:
        raise ValueError(f"Key must be exactly {KEY_BYTES} bytes")
    if len(nonce) != NONCE_BYTES:
        raise ValueError(f"Nonce must be exactly {NONCE_BYTES} bytes")
    if len(auth_tag) != AUTH_TAG_BYTES:
        raise ValueError(f"Auth tag must be exactly {AUTH_TAG_BYTES} bytes")

    aad = build_chunk_aad(task_id, path, offset, sequence, len(ciphertext))
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ciphertext + auth_tag, aad)
