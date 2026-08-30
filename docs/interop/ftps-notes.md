# FTPS Support Roadmap

**Status:** Interface placeholder — not yet implemented
**Driver:** `src/protocols/drivers/ftps-secure-driver.js`
**Protocol ID:** `FTPS_SECURE`

## Current State

The `ftps-secure-driver` is an **experimental interface placeholder**. It extends
`BaseProtocolDriver` and advertises `rfc4217` / `tlsDataChannel` / `pasvMode`
capabilities, but `sendFile` and `receiveFile` return hardcoded success objects
without opening a socket, performing `AUTH TLS` / `PBSZ` / `PROT` negotiation,
or executing `STOR` / `RETR`. There is no FTPS server or client implementation.

## Design Decision

Node.js has no mature, zero-dependency FTPS server library. Implementing a
compliant FTPS server (RFC 4217 — FTP over TLS) from scratch requires:

1. A plain-text FTP control channel (port 21) with command parsing
   (`USER`, `PASS`, `AUTH`, `PBSZ`, `PROT`, `PASV`, `EPSV`, `STOR`, `RETR`,
   `LIST`, `TYPE`, etc.).
2. A TLS-wrapped control channel after `AUTH TLS` (explicit FTPS) or a
   TLS-wrapped data channel (implicit FTPS on port 990).
3. Passive-mode data channel management — allocating ephemeral ports,
   advertising them via `PASV`/`EPSV`, and accepting data connections.
4. `PROT P` (private) data channel encryption per RFC 4217 §4.

This is a substantial implementation effort that is **out of scope for M3**.

## Roadmap

| Phase | Task | Priority |
|-------|------|----------|
| 1 | Evaluate `ftp-srv` (npm) or `native-ftp` for a Node FTPS server base | Medium |
| 2 | If no suitable library, implement a minimal RFC 959 + RFC 4217 FTPS server using `node:tls` and `node:net` | Low |
| 3 | Implement `AUTH TLS` (explicit) on the control channel | Medium |
| 4 | Implement `PROT P` (private) on the data channel | Medium |
| 5 | Configure passive-mode port range (`PASV` ports 50000–50100) | Medium |
| 6 | Add FTPS interop tests against FileZilla client | Medium |
| 7 | Document PASV port range configuration in the CLI/Docker | Low |

## Interop Targets

- **FileZilla** (active and passive mode, explicit FTPS) — primary test client
- **WinSCP** — Windows-native
- **lftp** — CLI verification

## Configuration (planned)

```
nearby-transfer serve --ftps --port 990 --pasv-min 50000 --pasv-max 50100
```

## Docker

The Docker image does **not** include an FTPS server. If/when FTPS is
implemented, the Dockerfile would need to expose port 990 (implicit) or 21
(explicit) plus the PASV port range.

## Recommendation

Defer FTPS implementation until the shared-library and SMB paths have completed
their integration and compatibility gates. The current HTTPS shared-library
endpoint is intended for supported Nearby Transfer clients and is not a generic
zero-install WebDAV mount. SMB remains a roadmap item rather than a shipped
desktop transfer driver. The CLI container includes a separate optional Samba
sidecar, but that does not constitute desktop protocol integration and its
cross-client behavior still requires an explicit compatibility gate. FTPS may
add value for legacy clients and FileZilla users, but only after a real
implementation and client interoperability testing exist.
