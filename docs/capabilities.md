# Capability and maturity matrix

This document separates three questions that are easy to conflate:

1. Is an implementation present in the current default-branch source?
2. Is that implementation connected to a user-facing path and covered by relevant tests?
3. Is the same implementation present in a published release artifact?

A focused test proves only the path it executes. It is not a security certification,
a formal proof, or evidence that every UI-visible option is implemented. Likewise,
changes made after a tag are not properties of the older release assets.

Last reviewed against `main`: 2026-08-30.

## Maturity labels

- **Available** — connected to a current user-facing path.
- **Developer preview** — implemented in source, but APIs, integration, or security
  boundaries can still change.
- **Experimental** — partial integration, prototype, or scaffold; do not rely on it for
  production transfer.
- **Planned** — design or roadmap work without a complete current path.

## Application and package surfaces

| Surface | Maturity | What the current default branch does | Important boundary | Published status |
| --- | --- | --- | --- | --- |
| Electron desktop direct transfer | **Available** | `src/main.js` routes normal sends through `src/core/transfer.js`. Peers are discovered with UDP multicast; a selected regular file is sent directly over TCP. The file stream is encrypted, the request is signed, the receiver approves it, and the final size and SHA-256 digest are checked before a temporary file is published. | The request carries the public key used to verify its signature. That is not the same as binding the sender to a previously verified protocol-v2 SAS identity. Discovery and transfer metadata remain visible on the LAN. | Public desktop `v1.3.0` assets are available for Windows x64 and Linux x64. Default-branch changes made after the tag are not included in those assets. |
| Desktop HTTPS/WebDAV shared folder | **Experimental** | A separate self-signed HTTPS service provides app-specific session authorization, share listing, browsing, range reads, and permission-gated write methods. Current source requires a signed session request from a trusted peer and makes the default share read-only. | This is a client/server shared-folder service, not the encrypted direct-transfer protocol. Clients must verify or pin the self-signed certificate. Do not expose it directly to the public internet or assume arbitrary third-party WebDAV compatibility. | The current default branch contains hardening commits made after `v1.3.0`; do not attribute those changes to the `v1.3.0` binaries. |
| Android client | **Developer preview** | A native client is buildable for Android 8.0 / API 26 and later, with corresponding discovery, transfer, and shared-library components. | Desktop, Android, direct-transfer, WebDAV, and protocol-v2 paths have different integration status. Cross-platform compatibility must be demonstrated for the exact pair of paths in use. | The Android source currently declares `versionName 1.2.1`. Desktop release `v1.3.0` has no Android asset; repository builds produce a debug APK for local testing. |
| `@luo-5/core` | **Developer preview** | Electron/DOM-independent TypeScript primitives cover protocol-v2 identity, discovery, pairing, crypto, manifests, stream framing, transfer state, and focused tests. | Correct security depends on callers preserving identity binding, trust checks, limits, final integrity checks, and safe file publication. These primitives are not the normal desktop data path. | npm `latest` was `0.2.1` at review time. The `main` manifest still declares `0.2.0`; use the package release tag when auditing the published tarball. |
| `@luo-5/cli` | **Developer preview** | Commands exist for devices, pairing, trust records, send, receive, and recursive directory transfer. The current `sync` command scans the tree, calculates a full SHA-256 for every file, and sends every entry. | The `sync` command does not currently wire in incremental change planning, conflict policies, or persisted resume state. Treat it as recursive directory transfer, not a complete bidirectional synchronization engine. | npm `latest` was `0.2.1` at review time. The `main` manifest still declares `0.2.0`; use the package release tag when auditing the published tarball. |
| `@luo-5/localsend-adapter` | **Developer preview** | A separately tested TypeScript interoperability adapter implements LocalSend-oriented discovery and sender/receiver foundations. | LocalSend discovery, trust, transport security, and receive-publication rules are not protocol-v2 guarantees. Review the exact published version before integration. | npm `latest` was `0.1.1` at review time. The `main` manifest still declares `0.1.0`; use the package release tag when auditing the published tarball. |
| Python reference | **Developer preview** | Verifies deterministic protocol encodings and cryptographic vectors. | It is a verifier, not a network client. | Source only. |

## Desktop protocol selector

The desktop UI and registries list seven names, but the normal user-facing send path does
not dispatch through those driver objects. The selector currently stores the chosen name;
normal sends continue through `src/core/transfer.js`.

| Entry | Current state |
| --- | --- |
| `v2-stream` | Protocol-v2 transfer primitives are implemented in `@luo-5/core`, but the root desktop adapter returns metadata and the normal desktop send path does not route through it. |
| `turbo-parallel` | Experimental scaffold; the desktop adapter calculates metadata/slices but does not transfer file bytes. |
| `quic-udp` | Experimental scaffold; the desktop adapter returns metadata but does not perform a QUIC file transfer. |
| `smb-share` | Experimental scaffold; the desktop adapter constructs SMB metadata but does not copy file bytes. |
| `webdav-sync` | Experimental selector scaffold. The separate WebDAV shared-folder service exists, but it is not this driver's completed send/receive implementation. |
| `v1-classic` | Experimental selector adapter. The working desktop direct-transfer path lives separately in `src/core/transfer.js` and is not selected through this adapter. |
| `ftps-secure` | Experimental scaffold; the desktop adapter returns metadata but does not perform an FTPS file transfer. |

## Transfer properties by path

| Property | Desktop direct transfer | Protocol-v2 components | WebDAV shared folder | CLI `sync` command |
| --- | --- | --- | --- | --- |
| No cloud relay | Yes | Yes for the current LAN transports | Yes | Yes for the current LAN transport |
| File-content confidentiality | Encrypted stream | AES-256-GCM chunks when integrated correctly | TLS transport | Uses the protocol-v2 transfer executor |
| User-verified persistent identity | No protocol-v2 SAS binding in this path | SAS and trust components exist; application integration varies | Uses its own trusted-peer/session boundary | Do not assume a complete mutual-pairing workflow without testing the exact clients |
| Discovery metadata confidentiality | No | No | Not applicable to the HTTP service itself | No |
| Resume guarantee | Pause/resume controls affect the active stream; no cross-process resume claim | Checkpoint components exist; end-to-end guarantees depend on integration | HTTP range reads are separate from transfer checkpoints | No persisted resume workflow is wired into `sync` |
| Directory behavior | The normal chooser sends regular files; UI batch handling is separate | Manifests support relative paths | Browses and manages a selected share | Recursively hashes and sends all regular files |
| Chunk size | Classic stream framing is separate | `256 KiB` default plaintext chunk, `1 MiB` maximum | HTTP request/response framing | Inherits protocol-v2 transfer limits |
| Outgoing concurrency | No global multi-device guarantee | The desktop scheduler currently permits exactly one outgoing job | Separate HTTP server concurrency model | One invoked transfer job per command |

## Release and version lines

- **Desktop application:** public tag `v1.3.0`; assets are Windows x64 `.exe` and
  Linux x64 `.tar.gz` / `.zip`.
- **Android application:** source currently declares `1.2.1`; no Android artifact is
  attached to desktop tag `v1.3.0`.
- **Protocol specification:** `v2`; this is a wire/design version, not the desktop app
  release number.
- **npm packages:** independently versioned, pre-1.0 packages. At review time npm
  `latest` was `@luo-5/core@0.2.1`, `@luo-5/cli@0.2.1`, and
  `@luo-5/localsend-adapter@0.1.1`.

Published package tags:

- [`core-v0.2.1`](https://github.com/luo-5/nearby-transfer/tree/core-v0.2.1/packages/core)
- [`cli-v0.2.1`](https://github.com/luo-5/nearby-transfer/tree/cli-v0.2.1/packages/cli)
- [`localsend-adapter-v0.1.1`](https://github.com/luo-5/nearby-transfer/tree/localsend-adapter-v0.1.1/packages/localsend-adapter)

When a capability changes, update this matrix, the README, relevant security notes,
tests, and release notes together.
