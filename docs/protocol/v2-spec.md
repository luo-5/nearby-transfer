# Nearby Transfer Protocol v2 Specification

**Version:** 2 (protocol version integer) · **Document revision:** 1
**Initial reference baseline:** `@luo-5/core@0.1.0`; the actively developed implementation is in `packages/core/` and its current version is defined by that package manifest.
**License:** MIT

---

## 1. Overview & Design Goals

Nearby Transfer Protocol v2 (hereafter "v2") is a peer-to-peer, end-to-end-encrypted
file transfer protocol designed for the local network. It requires **no central
server**, **no relay**, and **no account**. Two devices discover each other over UDP
multicast, establish mutual trust through an out-of-band pairing code, and transfer
files over a TCP connection protected by per-chunk authenticated encryption.

### 1.1 Design goals

| Goal | How v2 achieves it |
|---|---|
| **End-to-end encryption** | Every file chunk is encrypted with AES-256-GCM under a session key derived from an ephemeral X25519 ECDH exchange. No plaintext crosses the wire. |
| **Zero server / LAN only** | Discovery uses UDP multicast on a link-local group; transfer uses direct TCP. No public-internet endpoint is contacted for transfer. |
| **Mutual authentication** | Each device owns an Ed25519 signing keypair whose fingerprint is verified against a 6-digit SAS pairing code compared out-of-band. |
| **Replay & rollback resistance** | Control messages carry monotonic sequence numbers, issuance/expiry time windows, and position-bound authenticated data so chunks cannot be reordered, replayed, or rolled back. |
| **Portability** | Manifest paths are relative POSIX paths validated against Windows reserved names so a single manifest is safe on every platform. |
| **Resumability** | Transfer resume and progress messages carry per-file committed offsets, enabling interruption-tolerant restart without re-transferring completed data. |
| **Zero runtime dependencies** | The reference implementation uses only Node.js built-in modules (`node:crypto`, `node:net`, `node:dgram`, `node:http`). |

### 1.2 Cryptographic primitives

| Purpose | Primitive |
|---|---|
| Device signing keys | Ed25519 (RFC 8032) |
| Session key agreement | X25519 ECDH (RFC 7748) |
| Key derivation | HKDF-SHA256 (RFC 5869) |
| Chunk encryption | AES-256-GCM (AEAD, RFC 5116) with 96-bit nonce |
| Hashing | SHA-256 |

All signatures are raw 64-byte Ed25519 signatures, base64 or base64url encoded for
transport (encoding depends on the carrying message — see §3, §5, §6).

### 1.3 Notation

- `u8`, `u16`, `u32`, `u64` — unsigned big-endian integers of 1, 2, 4, 8 bytes.
- `‖` — byte concatenation.
- `sha256(x)` — the 32-byte SHA-256 digest of byte string `x`.
- `hex(x)` — lowercase hexadecimal of byte string `x`.
- `b64u(x)` — unpadded base64url (RFC 4648 §5) of byte string `x`.
- `canonicalJSON(obj)` — the canonical JSON serialization defined in §2.1.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **DeviceId** | A 16-character lowercase hexadecimal identifier derived from a device's Ed25519 signing public key (§3.2). |
| **Fingerprint** | A human-readable 24-character string (six 4-hex groups joined by `-`) derived from the signing public key (§3.3). |
| **PairingId** | A 16-byte random value, base64url-encoded to 22 characters, identifying one pairing attempt (§5.1). |
| **TaskId** | A 16-byte random value, base64url-encoded to 22 characters, identifying one transfer task (§6.1). |
| **SessionId** | A 16-byte random value, base64url-encoded to 22 characters, identifying one transfer session (§6.3). |
| **Manifest** | A canonical-JSON document listing the files and directories in a transfer task (§6.2). |
| **Chunk** | A bounded (≤ 1 MiB) plaintext fragment of a file, encrypted individually with AES-256-GCM (§7). |
| **Control frame** | An Ed25519-signed message governing stream lifecycle: hello, start, pause, resume, complete, cancel (§8). |
| **Wire frame** | A length-prefixed envelope carrying a canonical-JSON header and an optional binary payload over TCP (§6.4). |
| **MUX frame** | A multiplexing envelope that demarcates control/chunk/progress frames on a single TCP stream (§9). |
| **SAS code** | A 6-digit decimal pairing code derived from a transcript binding both parties (§5.2). |

---

## 3. Device Identity

Each device holds two keypairs:

1. **Signing keypair** — Ed25519. The signing public key is the root of identity:
   it derives the DeviceId and Fingerprint and signs every protocol message.
2. **Encryption keypair** — X25519. Used for ephemeral session key agreement
   during transfer (§7.1). The encryption public key is advertised in discovery.

Both public keys are distributed as PEM strings: signing keys use SPKI DER inside
PEM (`-----BEGIN PUBLIC KEY-----`), private keys use PKCS#8 DER inside PEM
(`-----BEGIN PRIVATE KEY-----`).

### 3.1 Key generation

Signing and encryption keypairs are generated with `crypto.generateKeyPairSync`.
A device persists both private keys and both public keys (as PEM) in its local
configuration. The private keys **never leave the device**.

### 3.2 DeviceId derivation

```
DeviceId = hex( sha256( signingPublicKeyPem ) )[ 0 : 16 ]
```

The DeviceId is the first 16 hexadecimal characters (8 bytes) of the SHA-256 of
the **PEM string** (UTF-8 bytes of the PEM, including newlines). It is always
lowercase. A valid DeviceId matches `/^[a-f0-9]{16}$/`.

### 3.3 Fingerprint derivation

```
hexFull = UPPER( hex( sha256( signingPublicKeyPem ) ) )
Fingerprint = hexFull[0:4] + "-" + hexFull[4:8] + "-" + ... + hexFull[20:24]
```

The fingerprint is the first six 4-hex-character groups of the uppercase hex
SHA-256, joined by hyphens — 24 characters plus 5 hyphens. A valid fingerprint
matches `/^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/`.

### 3.4 Public identity

The **public identity** is the set of fields a device advertises so peers can
verify and recognize it:

| Field | Type | Constraint |
|---|---|---|
| `deviceId` | string | 16 lowercase hex; must equal `deriveDeviceId(signingPublicKey)` |
| `deviceName` | string | non-empty, ≤ 128 chars, well-formed UTF-8, no NUL |
| `fingerprint` | string | must equal `fingerprintFor(signingPublicKey)` |
| `signingPublicKey` | PEM string | Ed25519 SPKI, ≤ 4096 chars |
| `encryptionPublicKey` | PEM string | X25519 SPKI, ≤ 4096 chars |

Receivers **must** validate that `deviceId` and `fingerprint` are consistent with
`signingPublicKey` before trusting an identity. A mismatch indicates tampering or
corruption.

### 3.5 Signing & verification

```
signature = Ed25519-Sign( message, signingPrivateKey )   // 64 raw bytes
verify    = Ed25519-Verify( message, signature, signingPublicKey )  // → boolean
```

Verification returns `false` (never throws) on any malformed input, so callers can
treat a failed signature identically to a logical rejection.

---

## 4. Discovery Protocol

Devices find each other on the LAN by periodically broadcasting a signed
announcement over UDP multicast.

### 4.1 Transport

| Parameter | Value |
|---|---|
| Address | `239.255.77.77` (IPv4 multicast group) |
| Port | `47777` |
| Socket type | UDP, `reuseAddr: true` |
| Multicast TTL | 1 (link-local) |
| Multicast loopback | enabled |
| Max datagram | 16 384 bytes (16 KiB) |

Each device joins the multicast group on every non-virtual, non-tunnel IPv4
interface and sends announcements to all joined interfaces.

### 4.2 Announcement cadence

| Parameter | Value |
|---|---|
| Announce interval | 2000 ms |
| Peer TTL | 10 000 ms (a peer unseen for 10 s is pruned) |
| Max clock skew | 30 000 ms (announcements outside ±30 s of local time are rejected) |

### 4.3 Announcement format

An announcement is canonical JSON (§2.1) with this shape:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "discovery-announce",
  "issuedAt": 1700000000000,        // unix epoch milliseconds, positive safe integer
  "identity": { /* PublicIdentity, §3.4 */ },
  "port": 47777,                    // TCP port the device listens on for pairing/transfer
  "capabilities": ["library-server"], // sorted, ≤16 entries, see §4.4
  "signature": "<base64 Ed25519>"   // base64 (standard, padded) — NOT base64url
}
```

The `signature` field is the Ed25519 signature over the **signing payload**: the
canonical JSON of the announcement **with the `signature` field removed**.

```
signingPayload = canonicalJSON({ app, protocolVersion, type, issuedAt, identity, port, capabilities })
signature = b64( Ed25519-Sign( UTF8(signingPayload), signingPrivateKey ) )
```

> **Note on encoding:** discovery and pairing signatures use standard base64
> (padded). Transfer/stream signatures use unpadded base64url (§6, §8). The
> difference is historical; both carry identical 64-byte Ed25519 signatures.

### 4.4 Capabilities

Capabilities are short string tokens advertising optional features. Each token
matches `/^[a-z][a-z0-9-]*$/`, is ≤ 64 characters, and the array is sorted with no
duplicates (max 16 entries). A receiver silently ignores unknown capabilities.

### 4.5 Reception & verification

On receiving a datagram, a device:

1. Rejects datagrams outside 1–16 384 bytes.
2. Decodes canonical JSON and checks the exact key set (`app`, `protocolVersion`,
   `type`, `issuedAt`, `identity`, `port`, `capabilities`, `signature`).
3. Validates the protocol envelope (`app = "nearby-transfer"`,
   `protocolVersion = 2`, `type = "discovery-announce"`).
4. Rejects announcements whose `issuedAt` differs from local time by more than
   30 s (clock-skew guard).
5. Ignores its own announcement (same `deviceId`).
6. Verifies the Ed25519 signature against the announced `identity.signingPublicKey`.
7. Records/updates the peer entry keyed by `deviceId`, emitting a `peer` event only
   when the endpoint (host, port, deviceName, fingerprint, capabilities) changed.

### 4.6 Peer expiry

A background prune pass runs at the announce interval. Peers whose `lastSeen` is
older than the peer TTL (10 s) are removed and a `peers` event is emitted.

---

## 5. Pairing Protocol

Pairing establishes persistent, signed mutual trust between two devices. After
pairing, a device stores the peer's public identity and will accept transfers and
library sessions from it without re-confirming the SAS code.

### 5.1 PairingId

```
PairingId = b64u( random(16) )   // 22 base64url characters
```

A fresh PairingId is generated for each pairing attempt. It binds all three pairing
messages (offer, confirm, cancel) of that attempt.

### 5.2 SAS pairing code

Both parties independently derive the same 6-digit code from a transcript binding
the PairingId to both public identities. Comparing this code out-of-band detects a
man-in-the-middle.

```
transcript = canonicalJSON({
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "pairing-code",
  "pairingId": <PairingId>,
  "initiator": <PublicIdentity of the offer sender>,
  "responder": <PublicIdentity of the offer receiver>
})

domain = "nearby-transfer/v2/pairing-code\0"   // note the trailing NUL byte
hash   = sha256( UTF8(domain) ‖ UTF8(transcript) )
code   = ( hash.readUInt32BE(0) ) mod 1_000_000   // first 4 bytes, big-endian, mod 10^6
SAS    = zeroPad( code, 6 )                        // e.g. "004217"
```

The `initiator` is the device that sent the pairing offer; the `responder` is the
device that received it. Both compute the identical code because the transcript is
symmetric in the pair (same PairingId, same two identities in fixed roles). A
valid code matches `/^[0-9]{6}$/`.

### 5.3 Pairing offer

The initiator sends a pairing offer to the responder:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "pairing-offer",
  "pairingId": "<22-char base64url>",
  "issuedAt": 1700000000000,
  "identity": { /* initiator PublicIdentity */ },
  "capabilities": ["library-server"],
  "signature": "<base64 Ed25519 over the offer minus signature>"
}
```

The signing payload is the canonical JSON of the offer with the `signature` field
removed; the signature is standard base64.

### 5.4 Pairing confirmation

After both parties display and agree the SAS code matches, the responder sends a
confirmation:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "pairing-confirm",
  "pairingId": "<22-char base64url>",
  "issuedAt": 1700000000000,
  "deviceId": "<responder DeviceId>",
  "pairingCode": "004217",
  "signature": "<base64 Ed25519, verified against responder's signingPublicKey>"
}
```

The confirmation is signed by the responder and verified against the responder's
signing public key (which the initiator knows from the offer/identity exchange).

### 5.5 Pairing cancel

Either party may cancel:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "pairing-cancel",
  "pairingId": "<22-char base64url>",
  "issuedAt": 1700000000000,
  "deviceId": "<cancelling DeviceId>",
  "reason": "user-cancelled",   // one of: connection-closed, rejected, timeout, user-cancelled
  "signature": "<base64 Ed25519>"
}
```

### 5.6 Trust persistence

Once pairing confirms, each device persists a **trust record** containing the
peer's full public identity (deviceId, deviceName, fingerprint, signingPublicKey,
encryptionPublicKey). Trusted peers are accepted for transfer and library sessions
without re-pairing. A device may revoke trust at any time (removing the record).

### 5.7 Pairing message transport

Pairing messages are carried as wire frames (§6.4) over the TCP connection
established after discovery. The pairing control codec encodes/decodes the
canonical-JSON payload; the wire frame provides the length-prefixed envelope and
the canonical-JSON header (`{app, protocolVersion, type}`).

---

## 6. Transfer Protocol

A transfer moves one set of files from a sender to a receiver over a single TCP
connection. The transfer is identified by a TaskId and (after manifest exchange)
a SessionId.

### 6.1 TaskId

```
TaskId = b64u( random(16) )   // 22 base64url characters, matches /^[A-Za-z0-9_-]{22}$/
```

The TaskId is generated by the sender and must be canonical base64url (decodes to
exactly 16 bytes and re-encodes identically).

### 6.2 Transfer manifest

The manifest enumerates the files and directories in the task:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-manifest",
  "taskId": "<22-char base64url>",
  "conflictStrategy": "auto-rename",
  "entries": [
    { "kind": "directory", "path": "docs" },
    { "kind": "file", "path": "docs/readme.md", "size": 1024, "sha256": "<64 hex>" }
  ],
  "totalFiles": 1,
  "totalBytes": 1024
}
```

**Entry kinds:**
- Directory: `{ "kind": "directory", "path": <relative POSIX> }`
- File: `{ "kind": "file", "path": <relative POSIX>, "size": <u53>, "sha256": <64 hex> }`

**Path rules** (enforced for cross-platform safety):
- Relative POSIX path — no leading `/`, no backslashes, no drive letters.
- Components separated by `/`; no empty, `.` or `..` components.
- No Windows-invalid characters (`<>:"\/|?*` or control chars).
- Each component ≤ 255 UTF-8 bytes; full path ≤ 4096 UTF-8 bytes.

**Limits:**
| Limit | Value |
|---|---|
| Max entries | 10 000 |
| Max files | 8 192 |
| Max single file | 1 TiB (1 099 511 627 776 bytes) |
| Max total | 4 TiB (4 398 046 511 104 bytes) |
| Conflict strategy | `auto-rename` (only value in v2) |

The manifest is canonical-JSON serialized for signing and persistence. All file
parents must be declared as directory entries. Entries are sorted by path (UTF-16
code-unit order). `totalFiles` and `totalBytes` are recomputed and must match the
file entries.

### 6.3 Manifest envelope (session bootstrap)

The sender wraps the manifest in a signed envelope carrying the ephemeral X25519
public key used for session key agreement:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-manifest",
  "manifest": { /* §6.2 */ },
  "senderDeviceId": "<16 hex>",
  "receiverDeviceId": "<16 hex>",
  "senderEphemeralPublicKey": "<b64u of 32-byte X25519 public key>",
  "sessionId": "<b64u of 16-byte random>",
  "issuedAt": 1700000000000,
  "expiresAt": 1700000060000,    // ≤ 5 min after issuedAt
  "signature": "<b64u of 64-byte Ed25519>"
}
```

- `senderEphemeralPublicKey` decodes to exactly 32 bytes (an X25519 public key).
- `sessionId` decodes to exactly 16 bytes.
- `expiresAt − issuedAt` must be in (0, 300 000] ms (5-minute max TTL).
- `signature` is base64url, verified against the **sender's long-term signing public key**.
- The signing payload is the envelope with the `signature` field removed, in
  canonical-JSON form.

### 6.4 Wire frame (TCP envelope)

All TCP control traffic uses length-prefixed wire frames:

```
┌──────────────┬──────────────┬─────────────────┬───────────────┐
│ frameLength  │ headerLength │ header (JSON)    │ payload       │
│ u32 BE       │ u16 BE       │ (headerLength B) │ (variable)    │
└──────────────┴──────────────┴─────────────────┴───────────────┘
```

- `frameLength` = bytes after this field = `2 + headerLength + payloadLength`.
- `headerLength` = UTF-8 byte length of the canonical-JSON header (1–16 384).
- `header` = canonical JSON: `{"app":"nearby-transfer","protocolVersion":2,"type":"<MessageType>"}`.
- `payload` = optional bytes (e.g., an encoded transfer message).
- Max frame size: 16 MiB. Max header: 16 KiB. Max buffered: 4 B + 16 MiB.

The header `type` must be one of the `MESSAGE_TYPES` (§2 of `constants.ts`). The
decoder rejects non-canonical JSON, BOMs, and frames whose length prefix doesn't
match the supplied bytes. A streaming decoder accumulates chunks and yields
complete frames, throwing on truncation at EOF.

### 6.5 Transfer decision

The receiver responds to the manifest envelope with a decision:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-decision",
  "taskId": "<22-char b64u>",
  "sessionId": "<22-char b64u>",
  "senderDeviceId": "<receiver DeviceId>",   // the decision sender
  "receiverDeviceId": "<manifest sender DeviceId>",
  "decision": "accepted",   // accepted | rejected | busy | unauthorized | invalid-manifest | expired | unsupported
  "issuedAt": 1700000000000,
  "expiresAt": 1700000060000,
  "signature": "<b64u Ed25519>"
}
```

Note the role inversion: in a decision, `senderDeviceId` is the **decision sender**
(the original manifest receiver) and `receiverDeviceId` is the manifest sender.
Sender and receiver device IDs must differ.

### 6.6 Transfer resume (interrupted restart)

After an interruption, the receiver sends a resume describing per-file committed
offsets:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-resume",
  "taskId": "<22-char b64u>",
  "sessionId": "<22-char b64u>",
  "senderDeviceId": "<resume sender>",
  "receiverDeviceId": "<resume receiver>",
  "manifestHash": "<64 hex sha256 of canonical-JSON manifest>",
  "files": [
    { "path": "docs/readme.md", "size": 1024, "committedOffset": 512, "completed": false }
  ],
  "nextSequence": 7,           // monotonic control sequence
  "totalTransferred": 512,     // must equal sum of committedOffset across files
  "issuedAt": 1700000000000,
  "expiresAt": 1700000060000,
  "signature": "<b64u Ed25519>"
}
```

- `manifestHash` = `sha256( UTF8( canonicalJSON(manifest) ) )` as 64 lowercase hex.
- `files[].committedOffset ≤ size`; if `completed`, `committedOffset` must equal `size`.
- `totalTransferred` must equal the sum of all `committedOffset`.
- The file set must remain stable across resume/progress messages in one session.
- Max payload for resume/progress messages: 1 MiB.

### 6.7 Transfer progress (acknowledgement)

After each chunk (or batch), the receiver acknowledges progress for one file:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-progress",
  "taskId": "<22-char b64u>",
  "sessionId": "<22-char b64u>",
  "senderDeviceId": "<progress sender>",
  "receiverDeviceId": "<progress receiver>",
  "manifestHash": "<64 hex>",
  "path": "docs/readme.md",
  "fileSize": 1024,
  "committedOffset": 768,
  "completed": false,
  "nextSequence": 8,
  "totalTransferred": 768,
  "issuedAt": 1700000000000,
  "expiresAt": 1700000060000,
  "signature": "<b64u Ed25519>"
}
```

Progress references exactly one file (the file just received). The checkpoint
monotonicity rules (§6.8) ensure offsets, totals, and sequences never move
backwards and that `totalTransferred` always equals the checkpoint total plus the
committed delta.

### 6.8 Monotonic control checkpoints

Resume and progress messages are validated against a **control checkpoint** that
binds `taskId`, `senderDeviceId`, `receiverDeviceId`, and `manifestHash` (these
must never change within a session). Across consecutive control messages:

- `nextSequence` must not decrease.
- `totalTransferred` must not decrease.
- Per-file `committedOffset` must not decrease; `completed` must not revert.
- `totalTransferred` must equal `previousTotal + Σ(committedOffset deltas)`.
- `nextSequence` delta must be ≥ the number of files whose offset/completed changed.

A `transfer-resume` creates the initial checkpoint; `transfer-progress` advances it
for a single file. This prevents replay of stale acknowledgements and rollback of
committed offsets.

### 6.9 Transfer complete

When all chunks are sent and acknowledged, the sender issues a completion:

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-complete",
  "taskId": "<22-char b64u>",
  "senderDeviceId": "<completion sender>",
  "receiverDeviceId": "<completion receiver>",
  "status": "success",        // success | failed
  "diagnostic": "success",    // see below
  "sha256": "<64 hex>",       // present iff status = success
  "bytes": 1024,              // total bytes transferred
  "sequence": 9,              // final control sequence
  "issuedAt": 1700000000000,
  "expiresAt": 1700000060000,
  "signature": "<b64u Ed25519>"
}
```

**Diagnostics:**
- On success: `diagnostic = "success"` and `sha256` is the verified file digest (or
  the manifest hash for multi-file — implementation-defined); a non-null `sha256`
  is forbidden on failure.
- On failure, `diagnostic` ∈ {`hash-mismatch`, `size-mismatch`,
  `sequence-mismatch`, `cancelled`, `io-error`, `protocol-error`}.

---

## 7. Chunk Encryption

### 7.1 Session key derivation

The sender generates a fresh X25519 **ephemeral** keypair for each transfer and
sends only the ephemeral public key in the manifest envelope (§6.3). The session
key is derived from an ECDH between the sender's ephemeral private key and the
receiver's long-term encryption public key (advertised in discovery).

```
sharedSecret = X25519( senderEphemeralPrivateKey, receiverEncryptionPublicKey )

salt = bytes-from-hex( manifestSha256 )          // 32 bytes
info = encodeFields([                            // length-prefixed UTF-8 fields
  "nearby-transfer/v2/file-content",              //   context
  "session-key",                                  //   label
  senderDeviceId, receiverDeviceId, taskId, manifestSha256
])

sessionKey = HKDF-SHA256( IKM = sharedSecret, salt, info, L = 32 )
```

- The shared secret is rejected (and zeroed) if it is all-zero (degenerate key).
- `info` encodes each field as a `u32 BE` length prefix followed by UTF-8 bytes.
- `manifestSha256` is the 64-hex SHA-256 of the canonical-JSON manifest, also
  used as the HKDF salt (hex-decoded to 32 bytes).

Because the manifest hash, task ID, and both device IDs are bound into `info`, the
session key is unique to this task and these parties — it cannot be reused across
tasks even with the same key material.

### 7.2 Chunk encryption (AES-256-GCM)

Each file is split into chunks of at most 1 MiB (1 048 576 bytes). Each chunk is
encrypted independently:

```
aad = buildChunkAAD({
  taskId, path, offset, sequence, plainLength
})

nonce = random(12)                                    // generated by the encryptor
(ciphertext, authTag) = AES-256-GCM-Encrypt(
  key = sessionKey, nonce, AAD = aad, plaintext = chunk
)
```

- `key` is the 32-byte session key.
- `nonce` is 12 bytes, freshly random per chunk — **the encryptor always generates
  the nonce; callers never supply one**, eliminating cross-chunk IV reuse.
- `authTag` is 16 bytes.
- Because AES-GCM is a stream cipher, `len(ciphertext) == len(plaintext)`.

### 7.3 Chunk AAD construction

The additional authenticated data binds each chunk to its position, preventing
reordering or replay at a different offset:

```
aad = encodeFields([ "nearby-transfer/v2/file-content", "chunk-aad", taskId, path ])
    ‖ u64-BE(offset)
    ‖ u64-BE(sequence)
    ‖ u32-BE(plainLength)
```

`encodeFields` writes each string as `u32-BE(byteLength) ‖ UTF-8(bytes)`. A chunk
that decrypts successfully but at the wrong offset/path/sequence will fail AAD
verification.

### 7.4 Chunk decryption

```
plaintext = AES-256-GCM-Decrypt(
  key = sessionKey, nonce, AAD = aad,
  ciphertext, authTag
)
```

Decryption requires the exact same `taskId`, `path`, `offset`, `sequence`, and
`plainLength`; mismatches cause authentication failure (the implementation throws
rather than returning bad data). `len(ciphertext)` must equal the authenticated
`plainLength`.

### 7.5 Constants

| Constant | Value |
|---|---|
| `KEY_BYTES` | 32 |
| `NONCE_BYTES` | 12 |
| `AUTH_TAG_BYTES` | 16 |
| `MAX_CHUNK_BYTES` | 1 048 576 (1 MiB) |
| `MAX_SEQUENCE` | 2^53 − 1 (Number.MAX_SAFE_INTEGER) |

---

## 8. Stream Control

The transfer stream session is governed by Ed25519-signed control frames that
manage lifecycle, flow control, and cancellation.

### 8.1 Commands

| Command | Direction | Sent by | Meaning |
|---|---|---|---|
| `stream-hello` | either | both | Initial authenticated handshake; must precede all other commands. |
| `stream-start` | send | sender | Tells receiver to begin accepting chunks. |
| `stream-pause` | receive | receiver | Requests sender to pause; receiver replies `paused`. |
| `stream-paused` | send | sender | Acknowledges pause. |
| `stream-resume` | receive | receiver | Requests sender to resume; receiver replies `resumed`. |
| `stream-resumed` | send | sender | Acknowledges resume. |
| `stream-complete` | send | sender | All chunks sent; receiver finalizes and replies `complete-ack`. |
| `stream-complete-ack` | receive | receiver | Confirms finalization; sender closes the stream. |
| `stream-cancel` | either | either | Aborts the session (carries a `code`). |

**Direction** is `send` or `receive`, fixed per codec for the life of the session.
A sender's commands have direction `send`; the receiver's have `receive`. The codec
enforces that the local direction is consistent across all locally-issued commands
and that remote commands arrive with the opposite direction.

**Cancel codes:** `cancelled`, `timeout`, `protocol-error`, `transfer-error`.

### 8.2 Signed control frame

```jsonc
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-stream-control",
  "command": "stream-start",
  "controlProtocol": 1,
  "taskId": "<22-char b64u>",
  "sessionId": "<22-char b64u>",
  "fromDeviceId": "<16 hex sender of this frame>",
  "toDeviceId": "<16 hex recipient>",
  "direction": "send",
  "sequence": 0,              // monotonic per direction
  "issuedAt": 1700000000000,
  "expiresAt": 1700000030000, // ≤ 5 min; default TTL 30 s
  "signature": "<b64u 64-byte Ed25519>"
  // "code": "timeout"        // present only for stream-cancel
}
```

- `controlProtocol` is `1` (the only version in v2).
- `sequence` is a non-negative safe integer, monotonic per direction; the receiver
  expects exactly `0, 1, 2, …` in order and rejects out-of-order or duplicate
  sequence numbers.
- `signature` is **unpadded base64url** (86 chars), over the canonical JSON of the
  frame with `signature` removed.
- `issuedAt`/`expiresAt` form a validity window (max 5 min; default 30 s). Frames
  expired by more than 30 s of clock skew are rejected.

### 8.3 Codec lifecycle

A stream control codec is created per session with the local device's signing
private key and the remote peer's signing public key. It maintains two independent
monotonic counters (local and remote). `verifyControl` is single-use per decoded
frame and consumes the expected remote sequence, preventing replay.

---

## 9. Multiplexing

A single TCP connection carries control frames, encrypted chunks, and progress
messages multiplexed through a framed envelope.

### 9.1 MUX frame format

```
┌───────────────┬───────────┬──────────┬─────────────────┬──────────────┐
│ magic         │ version   │ kind     │ flags           │ payloadLen   │
│ "NTV2MUX1" 8B │ u8 = 1    │ u8       │ u16 BE = 0      │ u32 BE       │
└───────────────┴───────────┴──────────┴─────────────────┴──────────────┘
│ payload (payloadLen bytes)                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Magic:** ASCII `NTV2MUX1` (8 bytes).
- **Version:** `1`.
- **Kind:** `1` = control, `2` = chunk, `3` = progress.
- **Flags:** reserved, must be zero.
- **Payload length bounds** depend on kind:
  - control (1): ≤ 16 KiB (a signed control frame, §8.2)
  - chunk (2): ≤ `MAX_FRAME_BYTES` (§7 + §6 chunk frame)
  - progress (3): ≤ 1 MiB (a transfer-progress/resume message)

### 9.2 Session model

One MUX stream carries **exactly one task in exactly one negotiated direction**.
The session state machine transitions:

```
handshaking → (hello exchanged) → starting/awaiting-start
  → sending/receiving → awaiting-ack/closing → completed
  (or → cancelling → cancelled / → failing → failed at any point)
```

The sender sends `stream-hello` then `stream-start`, streams chunk frames, sends
`stream-complete`, awaits `stream-complete-ack`, then ends the stream. The
receiver acknowledges each chunk with a progress MUX frame. Either side may send
`stream-cancel` at any time.

### 9.3 Timeouts

| Timer | Default |
|---|---|
| Handshake | 10 s |
| Idle (between frames) | 30 s |
| Write | 30 s |
| Operation | 30 s |
| Pause | 120 s |
| Closing (after end()) | 10 s |

Exceeding a timer fails the session with the corresponding code.

---

## 10. Security Considerations

### 10.1 Man-in-the-middle (MITM) protection

The SAS 6-digit pairing code (§5.2) is the primary MITM defense. Because a MITM
must relay two independent X25519 exchanges, it would compute two different
session keys and thus the two parties would derive **different** SAS codes — the
mismatch is detected by out-of-band comparison. Pairing is only complete after
both parties confirm the code matches and the confirmation is Ed25519-signed.

### 10.2 Replay protection

- **Discovery:** `issuedAt` is checked against a 30 s clock-skew window; stale
  announcements are dropped.
- **Transfer messages:** every message has `issuedAt`/`expiresAt` (max 5 min TTL)
  and is checked against a 30 s clock-skew window; expired messages are rejected.
- **Stream control:** monotonic per-direction sequence numbers (exact-order
  enforcement) plus the issuedAt/expiresAt window prevent replay and reordering.
- **Control checkpoints (§6.8):** resume/progress monotonicity rules prevent
  rollback of committed offsets and total transferred.

### 10.3 Chunk position binding

Each encrypted chunk's AAD (§7.3) binds `taskId ‖ path ‖ offset ‖ sequence ‖
plainLength`. A chunk cannot be replayed at a different file path, offset, or
sequence without failing GCM authentication. The encryptor-generated random nonce
prevents IV reuse within a key.

### 10.4 Path traversal & symlink protection

- **Manifest paths** are validated as relative POSIX with no `..`, no leading `/`,
  no backslashes, no Windows drive letters, and no Windows-reserved characters
  (§6.2). Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) are blocked.
- **Library service** (the WebDAV file server) resolves every target path with
  `realpath` against the share root and rejects any path that escapes the share
  (`_isPathWithinShare`), including symlink escape and not-yet-existing PUT/MKCOL
  targets (resolved against the nearest existing ancestor).

### 10.5 Size limits

| Resource | Limit |
|---|---|
| Discovery datagram | 16 KiB |
| Wire frame | 16 MiB |
| Transfer manifest payload | 4 MiB |
| Resume/progress payload | 1 MiB |
| Encrypted chunk | 1 MiB plaintext |
| Single file | 1 TiB |
| Total transfer | 4 TiB |
| Library upload | 50 GiB |

Exceeding a limit is rejected with a typed error (413 for HTTP, RangeError for
binary codecs) rather than silently truncating.

### 10.6 Key hygiene

- Session shared secrets are zeroed immediately after HKDF derivation.
- Ephemeral X25519 keys are per-task; the long-term encryption private key never
  transits the network.
- All-zero ECDH shared secrets (degenerate points) are rejected.

---

## 11. Error Codes & Diagnostics

### 11.1 Transfer decision codes

| Code | Meaning |
|---|---|
| `accepted` | Receiver accepted the manifest; proceed to transfer. |
| `rejected` | Receiver declined (e.g., user refused). |
| `busy` | Receiver is already transferring; retry later. |
| `unauthorized` | Sender is not a trusted peer. |
| `invalid-manifest` | Manifest failed validation. |
| `expired` | Manifest envelope's time window lapsed. |
| `unsupported` | Receiver does not support a requested feature. |

### 11.2 Completion diagnostics

| Diagnostic | Status | Meaning |
|---|---|---|
| `success` | success | All files verified; SHA-256 matches. |
| `hash-mismatch` | failed | A file's decrypted SHA-256 ≠ manifest digest. |
| `size-mismatch` | failed | A file's byte count ≠ manifest size. |
| `sequence-mismatch` | failed | Chunk sequence/offset violated monotonicity. |
| `cancelled` | failed | Session cancelled by either party. |
| `io-error` | failed | Filesystem or network I/O failure. |
| `protocol-error` | failed | Invalid frame, bad signature, or state violation. |

### 11.3 Stream cancel codes

`cancelled`, `timeout`, `protocol-error`, `transfer-error`.

### 11.4 Pairing cancel reasons

`connection-closed`, `rejected`, `timeout`, `user-cancelled`.

### 11.5 Validation philosophy

Every codec distinguishes **type errors** (`TypeError` — wrong shape, missing
field, non-canonical JSON), **range errors** (`RangeError` — out-of-bounds
length/count), and **syntax errors** (`SyntaxError` — malformed JSON or non-canonical
serialization). Verification functions (`verify*`) return `false` rather than
throwing, so a failed signature is indistinguishable from a logical rejection to
the caller. The reference implementation rejects non-canonical JSON on the wire by
re-serializing and comparing byte-for-byte, defeating alternate encodings
(whitespace, key reordering, duplicate keys, number spellings).

---

## Appendix A: Canonical JSON

v2 uses a restricted JSON subset for deterministic serialization. Rules:

1. **Objects:** keys sorted lexicographically by UTF-16 code unit; no duplicate keys.
2. **Numbers:** must be safe integers (≤ 2^53−1); floating-point is forbidden.
3. **Strings:** must be well-formed UTF-8 (no unpaired surrogates); serialized with
   `JSON.stringify` escaping.
4. **No whitespace:** no spaces, newlines, or tabs outside string values.
5. **No BOM:** a leading UTF-8 BOM is rejected.
6. **Plain objects only:** no `Date`, `Buffer`, `TypedArray`, or class instances.

Parsing rejects any syntactically-valid JSON that is not byte-for-byte canonical by
re-serializing the parsed value and comparing to the input string.

## Appendix B: Message Type Registry

| Type | Carrier | Signed by | Section |
|---|---|---|---|
| `discovery-announce` | UDP multicast | announcer signing key | §4 |
| `pairing-offer` | TCP wire frame | initiator signing key | §5.3 |
| `pairing-confirm` | TCP wire frame | responder signing key | §5.4 |
| `pairing-cancel` | TCP wire frame | canceller signing key | §5.5 |
| `transfer-manifest` | TCP wire frame / MUX | sender signing key | §6.3 |
| `transfer-decision` | TCP wire frame / MUX | receiver signing key | §6.5 |
| `transfer-resume` | TCP wire frame / MUX | receiver signing key | §6.6 |
| `transfer-progress` | MUX progress frame | receiver signing key | §6.7 |
| `transfer-chunk` | MUX chunk frame | (session key, AEAD) | §7 |
| `transfer-complete` | TCP wire frame / MUX | sender signing key | §6.9 |
| `transfer-stream-control` | MUX control frame | frame sender signing key | §8 |
| `library-session` | HTTPS | (library auth, out of scope) | — |

## Appendix C: Binary Magic Values

| Magic | ASCII | Purpose |
|---|---|---|
| `NTV2CHNK` | chunk frame | Per-chunk encrypted frame (§7, wire) |
| `NTV2MUX1` | MUX envelope | Stream multiplexing (§9) |

---

*End of specification.*
