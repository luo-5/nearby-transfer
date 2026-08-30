# Current classic desktop protocol

This document describes the classic protocol used by the current Electron desktop send/receive path. Protocol-v2 components and their integration target are documented separately under [`protocol/`](protocol/).

## Compatibility note

Current desktop and Android builds use **classic discovery announcement version 2**. It replaces the unsigned version-1 announcement and is intentionally wire incompatible with older discovery builds. Update both endpoints together. This discovery version is independent of the classic transfer request's existing `protocolVersion` field.

## Discovery

Devices announce themselves through UDP multicast on `239.255.77.77:47777` at a two-second interval. Peers expire after ten seconds.

Each canonical version-2 announcement contains the application identifier, message type, device ID and name, transfer port, Ed25519 signing public key, X25519 public key, fingerprint, timestamp, and an Ed25519 signature. Receivers verify:

- the protocol version and message type;
- the signing and encryption key types;
- device ID and fingerprint derivation from the signing key;
- the canonical announcement signature; and
- that the timestamp is within the accepted freshness window.

Announcements that are unsigned, stale, malformed, or identity-inconsistent are not added to the peer list.

## Transfer request

The sender opens a local HTTP request to the receiver:

```text
POST /transfer/request
```

The request includes file metadata, sender identity metadata, an ephemeral X25519 public key, and an Ed25519 signature. The receiver verifies the request, derives the shared transfer key, and asks the user to accept. File data is not uploaded unless the request is accepted.

## Upload

After acceptance, the sender streams encrypted frames to:

```text
POST /transfer/upload/:transferId
```

Each frame contains a big-endian ciphertext length, a 12-byte AES-GCM nonce, a 16-byte authentication tag, and ciphertext. The receiver writes to a temporary file, verifies the final SHA-256 hash and expected size, and publishes the result without overwriting an existing file.

Classic transfers restart from the beginning after interruption; protocol-v2 recovery components do not currently change that user-facing behavior.
