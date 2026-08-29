# Capability and security matrix

This document is the source of truth for what Nearby Transfer currently ships.
Implementation, test, and release status are intentionally separate: a component
can have unit tests without being connected to a user-facing transfer path.

Last reviewed: 2026-08-29.

## Client and package status

| Surface | Current status | Security boundary | Release status |
| --- | --- | --- | --- |
| Electron desktop file transfer | Available through `v1-classic`; this is the only selectable desktop transfer driver | File contents use the classic encrypted HTTP path. Discovery and transfer metadata are visible on the LAN, and v1 does not inherit every v2 control-plane guarantee | Windows x64 unsigned executable and Linux x64 tar/zip assets exist for v1.3.0 |
| Desktop protocol-v2 control plane | Pairing, trust, discovery, persistence, and transfer primitives are implemented and covered by focused tests; the v2 data plane is not connected to the default desktop send/receive flow | Signed identities, SAS derivation, bounded frames, authenticated chunks, and replay-aware controls apply to the tested v2 components | No claim of a complete v2 desktop release |
| Desktop WebDAV library | Available as a separate HTTPS shared-library service | Self-signed TLS, authenticated session acquisition, permission checks, bounded requests, and path confinement. It is not the same protocol as v2 end-to-end file transfer | Included in desktop builds; client compatibility is covered by the repository smoke suite, not certified as full RFC 4918 compliance |
| Android app | Buildable native client; the Java launcher remains the production UI while Compose and durable v2 services are migration foundations | Classic transfer and WebDAV behavior must be evaluated separately from v2 components. WebDAV uses certificate pinning/TOFU after first contact | CI builds a debug APK. A publicly verifiable release-signing workflow is not currently present |
| `@luo-5/core` | Active-development protocol-v2 library, version 0.2.x | Security properties apply when callers preserve identity binding, trust checks, limits, final hashes, and cleanup semantics | Published pre-1.0 npm package; API compatibility is not yet guaranteed |
| `@luo-5/cli` | Developer preview | Discovery and local transfer components are tested, but the CLI pairing command does not yet complete and persist a mutual pairing. Send/sync fail closed unless the discovered signing key matches an existing trust record | Published pre-1.0 npm package |
| `@luo-5/localsend-adapter` | LocalSend v2 interoperability adapter with local sender/receiver tests | Uses the LocalSend HTTP protocol and therefore does not inherit Nearby Transfer v2 end-to-end encryption. The receiver confines names, sizes, sessions, concurrency, temporary files, and non-overwrite publication | Published pre-1.0 npm package |
| Python reference | Deterministic vector verifier | Verifies selected protocol encodings and cryptographic outputs; it is not a network client | Source only |

## Desktop protocol selector

| Driver | Selectable | Notes |
| --- | ---: | --- |
| `v1-classic` | Yes | Current desktop send/receive implementation |
| `v2-stream` | No | Transfer executor is not connected to the desktop data path |
| `turbo-parallel` | No | Adapter scaffold |
| `quic-udp` | No | Adapter scaffold |
| `smb-share` | No | Adapter scaffold |
| `webdav-sync` | No | The separate WebDAV library works, but this selector driver is not connected |
| `ftps-secure` | No | Adapter scaffold |

Unavailable drivers are visible for roadmap context but are disabled and rejected
by the main process. Persisted unsupported selections fall back to `v1-classic`.

## Security guarantees by path

| Property | Classic desktop | Protocol-v2 components | WebDAV library | LocalSend adapter |
| --- | --- | --- | --- | --- |
| No cloud relay | Yes | Yes for current LAN transports | Yes | Yes |
| File-content confidentiality on the LAN | Encrypted file body | AES-256-GCM chunks when the complete v2 path is used correctly | TLS transport | Not guaranteed by the HTTP interoperability mode |
| Persistent identity signatures | Transfer request | Discovery, pairing, and controls | Signed session request plus TLS identity/pinning boundary | LocalSend tokens, not Nearby Transfer identities |
| Mutual user-verified pairing | No global claim | SAS primitives/control plane implemented; data-plane integration incomplete | Separate authorization model | No |
| Replay resistance | Limited to the classic implementation's checks | Sequence, expiry, task/session binding, and chunk AAD in tested components | Timestamp and nonce validation for signed session acquisition | Session/file tokens; no v2 replay claim |
| Resumable transfer | No global claim | Checkpoint and recovery components implemented | HTTP range/read behavior; not v2 checkpoint resume | No global claim |
| Receive-path confinement | Validated destination handling | Manifest/path validation and staging rules | Share-root confinement | Server-generated staging paths, bounded uploads, non-overwrite publication |

## Testing interpretation

- `npm run ci:verify` builds all npm packages, type-checks them, checks JavaScript
  syntax, runs package tests, and runs the desktop integration/smoke suite.
- `packages/python-ref/verify_vectors.py` verifies ten deterministic vector groups.
- Android JVM tests and debug APK builds are separate Gradle gates.
- Passing tests is evidence for the paths they execute. It is not a certification,
  formal security proof, production-readiness guarantee, or proof that every driver
  shown in the UI is implemented.

When implementation changes this matrix, update the matrix, README, SECURITY policy,
tests, and release notes in the same pull request.
