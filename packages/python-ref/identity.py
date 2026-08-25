"""
Device identity cryptography: Ed25519 signing keypairs, deviceId derivation,
fingerprint calculation, and message signing/verification.
"""

import hashlib
from typing import Tuple
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature


def generate_ed25519_keypair() -> Tuple[str, str]:
    """Generate a new random Ed25519 keypair in canonical PEM format."""
    private_key = ed25519.Ed25519PrivateKey.generate()
    return keypair_to_pem(private_key)


def ed25519_keypair_from_seed(seed: bytes) -> Tuple[str, str]:
    """Derive an Ed25519 keypair from a 32-byte seed."""
    if len(seed) != 32:
        raise ValueError("Ed25519 seed must be exactly 32 bytes")
    private_key = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    return keypair_to_pem(private_key)


def keypair_to_pem(private_key: ed25519.Ed25519PrivateKey) -> Tuple[str, str]:
    """Convert an Ed25519 private key to (public_pem, private_pem)."""
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


def derive_device_id(signing_public_key_pem: str) -> str:
    """
    Derive the 16-hex-character device id from an Ed25519 signing public key PEM.
    First 16 chars of SHA-256(PEM).
    """
    digest = hashlib.sha256(signing_public_key_pem.encode("utf-8")).hexdigest()
    return digest[:16].lower()


def fingerprint_for(public_key_pem: str) -> str:
    """
    Compute the human-readable fingerprint (6 groups of 4 uppercase hex chars).
    """
    hex_str = hashlib.sha256(public_key_pem.encode("utf-8")).hexdigest().upper()
    groups = [hex_str[i : i + 4] for i in range(0, 24, 4)]
    return "-".join(groups)


def sign(message: bytes, signing_private_key_pem: str) -> bytes:
    """Sign an arbitrary message with an Ed25519 private key (PEM)."""
    private_key = serialization.load_pem_private_key(
        signing_private_key_pem.encode("utf-8"),
        password=None,
    )
    if not isinstance(private_key, ed25519.Ed25519PrivateKey):
        raise TypeError("Private key must be Ed25519")
    return private_key.sign(message)


def verify(message: bytes, signature: bytes, signing_public_key_pem: str) -> bool:
    """Verify an Ed25519 signature. Returns True on success, False on failure."""
    try:
        public_key = serialization.load_pem_public_key(
            signing_public_key_pem.encode("utf-8")
        )
        if not isinstance(public_key, ed25519.Ed25519PublicKey):
            return False
        public_key.verify(signature, message)
        return True
    except (InvalidSignature, Exception):
        return False
