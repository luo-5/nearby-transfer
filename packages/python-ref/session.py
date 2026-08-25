"""
Session key agreement (X25519 ECDH + HKDF-SHA256) for the v2 transfer protocol.
"""

from typing import List, Tuple
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CONTEXT = "nearby-transfer/v2/file-content"
SESSION_LABEL = "session-key"
KEY_BYTES = 32


def generate_x25519_keypair() -> Tuple[str, str]:
    """Generate a new random X25519 keypair in canonical PEM format."""
    private_key = x25519.X25519PrivateKey.generate()
    return x25519_keypair_to_pem(private_key)


def x25519_keypair_from_seed(seed: bytes) -> Tuple[str, str]:
    """Derive an X25519 keypair from a 32-byte seed."""
    if len(seed) != 32:
        raise ValueError("X25519 seed must be exactly 32 bytes")
    private_key = x25519.X25519PrivateKey.from_private_bytes(seed)
    return x25519_keypair_to_pem(private_key)


def x25519_keypair_to_pem(private_key: x25519.X25519PrivateKey) -> Tuple[str, str]:
    """Convert an X25519 private key to (public_pem, private_pem)."""
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    return public_pem, private_pem


def encode_fields(fields: List[str]) -> bytes:
    """Encode a sequence of string fields as [u32-len || utf8-bytes] concatenated."""
    chunks = []
    for field in fields:
        field_bytes = field.encode("utf-8")
        chunks.append(len(field_bytes).to_bytes(4, "big"))
        chunks.append(field_bytes)
    return b"".join(chunks)


def derive_session_key(
    local_private_key_pem: str,
    remote_public_key_pem: str,
    sender_device_id: str,
    receiver_device_id: str,
    task_id: str,
    manifest_sha256: str,
) -> bytes:
    """
    Derive a 32-byte session key from an X25519 ECDH exchange,
    bound to the transfer context via HKDF-SHA256.
    """
    local_private_key = serialization.load_pem_private_key(
        local_private_key_pem.encode("utf-8"),
        password=None,
    )
    if not isinstance(local_private_key, x25519.X25519PrivateKey):
        raise TypeError("Local private key must be X25519")

    remote_public_key = serialization.load_pem_public_key(
        remote_public_key_pem.encode("utf-8")
    )
    if not isinstance(remote_public_key, x25519.X25519PublicKey):
        raise TypeError("Remote public key must be X25519")

    shared_secret = local_private_key.exchange(remote_public_key)

    salt = bytes.fromhex(manifest_sha256)
    info = encode_fields([
        CONTEXT,
        SESSION_LABEL,
        sender_device_id,
        receiver_device_id,
        task_id,
        manifest_sha256,
    ])

    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=salt,
        info=info,
    )
    return hkdf.derive(shared_secret)
