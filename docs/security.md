# Nearby Transfer Security Architecture & Threat Model

## 1. Security Principles

Nearby Transfer is engineered around a **Zero-Trust LAN Model**:
* **Untrusted Network**: We assume the local Wi-Fi / Ethernet is hostile, unencrypted, and subject to packet eavesdropping, ARP spoofing, and malicious broadcast injection.
* **Mutual Authentication**: Both peers authenticate each other using persistent Ed25519 identity keypairs.
* **Forward Secrecy**: Every transfer session derives an ephemeral session key using freshly generated X25519 keypairs.
* **Authenticated Encryption**: All chunk payloads use AES-256-GCM with position-bound Additional Authenticated Data (AAD).

---

## 2. Threat Model & Mitigations

| Threat | Attack Scenario | Mitigation |
| :--- | :--- | :--- |
| **Eavesdropping** | Attacker sniffs Wi-Fi packets to read files | AES-256-GCM payload encryption with 256-bit ECDH session keys |
| **Man-in-the-Middle (MitM)** | Attacker intercepts initial pairing exchange | 6-digit Short Authentication String (SAS) out-of-band visual verification |
| **Replay Attacks** | Attacker replays previous control messages or chunks | Monotonic sequence counters, 30s TTL limits, and task/session/offset AAD binding |
| **Chunk Swapping / Truncation** | Attacker reorders or truncates file chunks | AAD binds `(taskId, path, offset, sequence, plainLength)` to each chunk authentication tag |
| **Path Traversal / Escape** | Malicious sender sends `../../etc/shadow` | Mandatory POSIX relative path validation, prohibition of `..`, `\`, and absolute root escapes |
| **Resource Exhaustion DoS** | Flood of fake discovery datagrams or TCP connections | Connection limits (max 16 global, 4 per IP) and sliding-window rate limiters |

---

## 3. Cryptographic Key Lifecycle

1. **Ed25519 Identity Keypair**:
   * *Purpose*: Device identity, announcement signatures, pairing verification, control message authentication.
   * *Storage*: Stored in user data directory (`device.json` with 0600 permissions).
2. **X25519 Identity Keypair**:
   * *Purpose*: Persistent device identity encryption capability.
3. **Ephemeral X25519 Keypair**:
   * *Purpose*: Generated per transfer task. Used in ECDH exchange to guarantee forward secrecy.
4. **AES-256-GCM Session Key**:
   * *Derivation*: `HKDF-SHA256(sharedSecret, salt=manifestSha256, info=contextBinding)`.
   * *Lifecycle*: Erased via `sessionKey.fill(0)` immediately upon transfer completion or cancellation.
5. **Chunk Nonce**:
   * 96-bit (12-byte) cryptographically secure random nonce per chunk.
