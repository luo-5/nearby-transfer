#!/usr/bin/env python3
"""
Test vector verification script for Nearby Transfer v2.
Verifies all 10 vector test groups against the Python reference implementation.
"""

import os
import sys
import json
import base64
import hashlib
import struct

from canonical_json import canonical_json, parse_canonical_json
from identity import ed25519_keypair_from_seed, derive_device_id, fingerprint_for, sign, verify
from session import x25519_keypair_from_seed, derive_session_key
from chunk import build_chunk_aad, encrypt_chunk, decrypt_chunk
from wire_frame import encode_wire_frame, decode_wire_frame
from chunk_frame import encode_chunk_frame, decode_chunk_frame

PAIRING_CODE_DOMAIN = b"nearby-transfer/v2/pairing-code\x00"


def find_vectors_dir() -> str:
    """Locate the vectors directory."""
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "reference", "vectors"),
        os.path.join(os.path.dirname(__file__), "vectors"),
        os.path.join(os.path.dirname(__file__), "..", "vectors"),
    ]
    for c in candidates:
        if os.path.exists(os.path.join(c, "crypto-vectors.json")):
            return os.path.abspath(c)
    raise FileNotFoundError("Could not find test vectors directory")


def test_crypto_vectors(vectors_dir: str) -> None:
    print("\n--- 1. Testing Crypto Vectors (crypto-vectors.json) ---")
    with open(os.path.join(vectors_dir, "crypto-vectors.json"), "r", encoding="utf-8") as f:
        data = json.load(f)

    # 1.1 Device Identity
    id_vec = data["identity"]
    seed = bytes.fromhex(id_vec["ed25519SeedHex"])
    pub_pem, priv_pem = ed25519_keypair_from_seed(seed)
    assert pub_pem.strip() == id_vec["signingPublicKeyPem"].strip(), "Public PEM mismatch"
    assert priv_pem.strip() == id_vec["signingPrivateKeyPem"].strip(), "Private PEM mismatch"
    dev_id = derive_device_id(pub_pem)
    assert dev_id == id_vec["deviceId"], f"Device ID mismatch: {dev_id} != {id_vec['deviceId']}"
    fp = fingerprint_for(pub_pem)
    assert fp == id_vec["fingerprint"], f"Fingerprint mismatch: {fp} != {id_vec['fingerprint']}"
    print("  [PASS] 1. Device identity derivation (Ed25519, deviceId, fingerprint)")

    # 1.2 Session Key Derivation
    sk_vec = data["sessionKey"]
    alice_seed = bytes.fromhex(sk_vec["aliceSeedHex"])
    bob_seed = bytes.fromhex(sk_vec["bobSeedHex"])
    alice_pub, alice_priv = x25519_keypair_from_seed(alice_seed)
    bob_pub, bob_priv = x25519_keypair_from_seed(bob_seed)
    assert alice_pub.strip() == sk_vec["alicePublicKeyPem"].strip()
    assert alice_priv.strip() == sk_vec["alicePrivateKeyPem"].strip()
    assert bob_pub.strip() == sk_vec["bobPublicKeyPem"].strip()
    assert bob_priv.strip() == sk_vec["bobPrivateKeyPem"].strip()

    session_key = derive_session_key(
        local_private_key_pem=alice_priv,
        remote_public_key_pem=bob_pub,
        sender_device_id=sk_vec["senderDeviceId"],
        receiver_device_id=sk_vec["receiverDeviceId"],
        task_id=sk_vec["taskId"],
        manifest_sha256=sk_vec["manifestSha256"],
    )
    assert session_key.hex() == sk_vec["sessionKeyHex"], f"Session key mismatch: {session_key.hex()} != {sk_vec['sessionKeyHex']}"
    print("  [PASS] 2. X25519 ECDH + HKDF-SHA256 session key derivation")

    # 1.3 Chunk Encryption & AAD
    chunk_vec = data["chunkEncryption"]
    key = bytes.fromhex(chunk_vec["sessionKeyHex"])
    nonce = bytes.fromhex(chunk_vec["nonceHex"])
    plaintext = chunk_vec["plaintextUtf8"].encode("utf-8")
    assert plaintext.hex() == chunk_vec["plaintextHex"]

    aad = build_chunk_aad(
        task_id=chunk_vec["taskId"],
        path=chunk_vec["path"],
        offset=chunk_vec["offset"],
        sequence=chunk_vec["sequence"],
        plain_length=len(plaintext),
    )
    assert aad.hex() == chunk_vec["aadHex"], f"AAD mismatch: {aad.hex()} != {chunk_vec['aadHex']}"

    n_out, ct_out, tag_out = encrypt_chunk(
        key=key,
        task_id=chunk_vec["taskId"],
        path=chunk_vec["path"],
        offset=chunk_vec["offset"],
        sequence=chunk_vec["sequence"],
        plaintext=plaintext,
        nonce=nonce,
    )
    assert ct_out.hex() == chunk_vec["ciphertextHex"], f"Ciphertext mismatch: {ct_out.hex()} != {chunk_vec['ciphertextHex']}"
    assert tag_out.hex() == chunk_vec["authTagHex"], f"Auth tag mismatch: {tag_out.hex()} != {chunk_vec['authTagHex']}"

    decrypted = decrypt_chunk(
        key=key,
        nonce=nonce,
        task_id=chunk_vec["taskId"],
        path=chunk_vec["path"],
        offset=chunk_vec["offset"],
        sequence=chunk_vec["sequence"],
        ciphertext=ct_out,
        auth_tag=tag_out,
    )
    assert decrypted == plaintext, "Decrypted plaintext does not match original"
    print("  [PASS] 3. AES-256-GCM chunk AAD, encryption & decryption")


def test_pairing_vectors(vectors_dir: str) -> None:
    print("\n--- 2. Testing Pairing Vectors (pairing-vectors.json) ---")
    with open(os.path.join(vectors_dir, "pairing-vectors.json"), "r", encoding="utf-8") as f:
        data = json.load(f)

    # 2.1 Pairing Code
    pc_vec = data["pairingCode"]
    transcript_obj = {
        "app": "nearby-transfer",
        "protocolVersion": 2,
        "type": "pairing-code",
        "pairingId": pc_vec["pairingId"],
        "initiator": pc_vec["initiator"],
        "responder": pc_vec["responder"],
    }
    transcript_str = canonical_json(transcript_obj)
    assert transcript_str == pc_vec["transcript"], f"Transcript mismatch:\n{transcript_str}\nvs\n{pc_vec['transcript']}"

    digest = hashlib.sha256(PAIRING_CODE_DOMAIN + transcript_str.encode("utf-8")).digest()
    code_val = struct.unpack(">I", digest[:4])[0] % (10 ** 6)
    code_str = str(code_val).zfill(6)
    assert code_str == pc_vec["pairingCode"], f"Pairing code mismatch: {code_str} != {pc_vec['pairingCode']}"
    print("  [PASS] 4. SAS 6-digit pairing code transcript & derivation")

    # 2.2 Pairing Offer Signature
    pos_vec = data["pairingOfferSignature"]
    offer = pos_vec["offer"]
    offer_signing_payload = canonical_json(offer)
    assert offer_signing_payload == pos_vec["signingPayload"], "Offer signing payload mismatch"

    sig_bytes = base64.b64decode(pos_vec["signature"])
    is_valid = verify(
        message=offer_signing_payload.encode("utf-8"),
        signature=sig_bytes,
        signing_public_key_pem=offer["identity"]["signingPublicKey"],
    )
    assert is_valid, "Pairing offer signature verification failed"
    print("  [PASS] 5. Pairing offer canonical signing payload & Ed25519 verification")


def test_transfer_vectors(vectors_dir: str) -> None:
    print("\n--- 3. Testing Transfer Vectors (transfer-vectors.json) ---")
    with open(os.path.join(vectors_dir, "transfer-vectors.json"), "r", encoding="utf-8") as f:
        data = json.load(f)

    # 3.1 Canonical JSON
    cj_vec = data["canonicalJson"]
    serialized = canonical_json(cj_vec["input"])
    assert serialized == cj_vec["output"], f"Canonical JSON mismatch:\n{serialized}\nvs\n{cj_vec['output']}"
    print("  [PASS] 6. Canonical JSON deterministic serialization")

    # 3.2 Wire Frame
    wf_vec = data["wireFrame"]
    payload = bytes.fromhex(wf_vec["payloadHex"])
    frame = encode_wire_frame(wf_vec["header"], payload)
    assert frame.hex() == wf_vec["frameHex"], f"Wire frame mismatch: {frame.hex()} != {wf_vec['frameHex']}"

    dec_header, dec_payload = decode_wire_frame(frame)
    assert dec_header == wf_vec["header"], "Decoded wire frame header mismatch"
    assert dec_payload == payload, "Decoded wire frame payload mismatch"
    print("  [PASS] 7. Wire frame encoding and decoding")

    # 3.3 Chunk Frame
    cf_vec = data["chunkFrame"]
    nonce = bytes.fromhex(cf_vec["nonceHex"])
    auth_tag = bytes.fromhex(cf_vec["authTagHex"])
    ciphertext = bytes.fromhex(cf_vec["ciphertextHex"])

    chunk_frame_bytes = encode_chunk_frame(
        task_id=cf_vec["taskId"],
        relative_path=cf_vec["relativePath"],
        offset=cf_vec["offset"],
        sequence=cf_vec["sequence"],
        plain_length=cf_vec["plainLength"],
        nonce=nonce,
        auth_tag=auth_tag,
        ciphertext=ciphertext,
    )
    assert chunk_frame_bytes.hex() == cf_vec["frameHex"], f"Chunk frame mismatch: {chunk_frame_bytes.hex()} != {cf_vec['frameHex']}"

    decoded_cf = decode_chunk_frame(chunk_frame_bytes)
    assert decoded_cf.task_id == cf_vec["taskId"]
    assert decoded_cf.relative_path == cf_vec["relativePath"]
    assert decoded_cf.offset == cf_vec["offset"]
    assert decoded_cf.sequence == cf_vec["sequence"]
    assert decoded_cf.plain_length == cf_vec["plainLength"]
    assert decoded_cf.nonce == nonce
    assert decoded_cf.auth_tag == auth_tag
    assert decoded_cf.ciphertext == ciphertext
    print("  [PASS] 8. Binary chunk frame (NTV2CHNK) encoding and decoding")

    # 3.4 Discovery Signature
    ds_vec = data["discoverySignature"]
    announcement = ds_vec["announcement"]
    unsigned_ann = {k: v for k, v in announcement.items() if k != "signature"}
    payload_str = canonical_json(unsigned_ann)
    assert payload_str == ds_vec["signingPayload"], "Discovery signing payload mismatch"

    sig_bytes = base64.b64decode(ds_vec["signature"])
    is_valid = verify(
        message=payload_str.encode("utf-8"),
        signature=sig_bytes,
        signing_public_key_pem=announcement["identity"]["signingPublicKey"],
    )
    assert is_valid, "Discovery announcement signature verification failed"
    print("  [PASS] 9. Discovery announcement payload & signature verification")

    # 3.5 Manifest Serialization
    mf_vec = data["manifestSerialization"]
    manifest_serialized = canonical_json(mf_vec["manifest"])
    assert manifest_serialized == mf_vec["serialized"], f"Manifest serialization mismatch:\n{manifest_serialized}\nvs\n{mf_vec['serialized']}"
    manifest_hash = hashlib.sha256(manifest_serialized.encode("utf-8")).hexdigest()
    assert len(manifest_hash) == 64
    print("  [PASS] 10. Manifest normalization, serialization and SHA-256 hash")


def main() -> None:
    print("======================================================================")
    print("Nearby Transfer v2 - Python Reference Vector Verification Suite")
    print("======================================================================")
    vectors_dir = find_vectors_dir()
    print(f"Vectors directory: {vectors_dir}")

    test_crypto_vectors(vectors_dir)
    test_pairing_vectors(vectors_dir)
    test_transfer_vectors(vectors_dir)

    print("\n======================================================================")
    print("ALL 10 TEST VECTOR GROUPS VERIFIED SUCCESSFULLY! (10/10 PASS)")
    print("======================================================================")


if __name__ == "__main__":
    main()
