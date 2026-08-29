# Security architecture and threat model

This document describes security boundaries by protocol path. It does not claim that
one path's guarantees automatically apply to every client or adapter. Current
integration status is tracked in [`capabilities.md`](capabilities.md).

## Threat assumptions

Nearby Transfer assumes that the local Wi-Fi or Ethernet network can contain passive
observers and active malicious peers. Network announcements, metadata, frame lengths,
identifiers, filenames, persisted records, and client-provided hashes are untrusted.

The project does not protect a device after its operating-system account, process,
private identity keys, or release-signing credentials have been compromised.

## Security boundaries

### Classic desktop transfer

- File contents are encrypted before the classic HTTP upload body is sent.
- Transfer requests are signed with the sender's persistent device identity.
- The receiver asks the user before accepting an incoming transfer.
- Discovery and transfer metadata are visible on the LAN.
- The classic path must not be described as providing all protocol-v2 SAS, replay,
  checkpoint, or forward-secrecy properties.

### Protocol-v2 components

The v2 implementation contains and tests:

- Ed25519 device identities and signed discovery/pairing/control messages;
- X25519 key agreement and HKDF-SHA256 session-key derivation;
- AES-256-GCM chunk encryption with task, path, offset, sequence, and length bound as
  additional authenticated data;
- expiry windows and monotonic sequences for control messages;
- bounded wire, message, and chunk frames;
- manifest path validation, final plaintext hashes, checkpoints, and recovery state.

These properties depend on callers preserving verified identity-to-key binding,
checking trust and permissions, rejecting stale state, and cleaning up secrets and
temporary files. The complete v2 data plane is not yet connected to the default
desktop transfer flow.

### WebDAV shared library

- The service uses HTTPS with a self-signed certificate.
- Session acquisition verifies a signed request, timestamp, and one-time nonce.
- Trusted-peer permissions restrict read and upload operations.
- Android remembers the first observed certificate fingerprint and fails closed on a
  later mismatch.
- Share-root path checks, request limits, connection limits, and cleanup remain
  required even after authentication.

WebDAV transport security is a separate boundary from v2 encrypted file transfer.

### LocalSend interoperability

The adapter currently announces and serves LocalSend's HTTP mode. Session/file tokens,
bounded request bodies, generated staging paths, filename validation, size checks,
session expiry, concurrency limits, and non-overwrite publication protect the receiver.
The adapter does not claim Nearby Transfer v2 end-to-end confidentiality.

## Threats and mitigations

| Threat | Required mitigation | Applies to |
| --- | --- | --- |
| Passive file-content capture | Authenticated encryption or TLS on the selected path | Classic payload, v2 chunks, WebDAV TLS; not LocalSend HTTP |
| Identity substitution | Derive and verify device IDs, verify signatures, bind persisted trust to the observed key | V2 and trusted WebDAV sessions |
| Replay or rollback | Expiry windows, one-time nonces, monotonic sequences, task/session binding, monotonic checkpoints | V2 controls/transfers and WebDAV session acquisition as documented |
| Chunk swapping/truncation | AAD binding and final plaintext SHA-256 | V2 chunks |
| Path escape/overwrite | Canonical relative names, validated roots, generated staging paths, symlink/reparse checks, non-overwrite publication | All receive and library paths |
| Resource exhaustion | Frame/body/file/session limits, global/per-IP concurrency, timeouts, backpressure, cleanup | All network services |
| Permission confusion | Default-deny grants, explicit user approval, revocation checks | Pairing, transfer, and WebDAV authorization |
| Supply-chain substitution | Locked dependencies, full CI, npm provenance, checksums/SBOM/signing status when published | Packages and release assets |

## Key lifecycle

- Persistent Ed25519 and X25519 identity keys belong in application-private storage
  with restrictive file permissions where the platform supports them.
- Ephemeral X25519 keys and derived AES session keys should be scoped to one transfer
  and cleared after success, cancellation, or failure.
- Private keys, session keys, file contents, bearer tokens, signing credentials, and
  real pairing secrets must never be logged or committed.
- Deterministic test-vector keys are non-production material and must be clearly
  labelled as such.

## Residual risks

- Six-digit SAS verification requires users to compare the code correctly.
- First-contact TOFU cannot detect an attacker who controls the very first WebDAV
  connection; later fingerprint changes fail closed.
- Unsigned desktop builds can trigger platform warnings and provide weaker publisher
  identity than code-signed artifacts.
- Debug Android APKs are development artifacts, not public production releases.
- Automated tests are not a formal security proof or independent audit.
