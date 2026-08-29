# Changelog

All notable changes to Nearby Transfer will be documented in this file.

## [Unreleased] - Audit Remediation - 2026-08-29

### Security
- **LocalSend receiver confinement**: untrusted manifest names and IDs are validated,
  temporary paths are server-generated, completed files never overwrite an existing
  destination, and request/file/session/concurrency limits plus expiry cleanup bound
  receiver resource use.
- **Library handshake now requires a signature** (`/api/session`): requests must carry
  `deviceId`, `timestamp`, `nonce`, and an Ed25519 `signature` over
  `nearby-transfer:library-auth:<deviceId>:<timestamp>:<nonce>`; timestamps outside a
  60 s window and reused nonces are rejected, with a 10 req/min per-IP rate limit and a
  64 KB body cap. Previously a body with only `deviceId` yielded a bearer token
  (authentication bypass). Android clients now sign the handshake. **Breaking: desktop
  and Android must ship together.**
- **Android library client pins the desktop TLS certificate** (`WebDavClient`): the
  trust-all `X509TrustManager` / `HostnameVerifier` is gone. The first connection per
  endpoint records the presented certificate (persisted in `webdav-pins.properties` via
  `WebDavPinStore`); every later connection fails closed unless the certificate matches.
  The desktop also records its WebDAV certificate SHA-256 (`webdavCertFp`) into the
  trusted-peer record at pairing completion (SQLite migration v3).
- **Least-privilege pairing**: newly paired peers are granted **no** permissions by
  default (`trusted-peer-store`); re-pairing no longer resets or widens existing grants,
  and the desktop pairing UI directs users to enable permissions explicitly. **Behavior
  change: enable permissions on the trusted device card after pairing.**
- **Default shared library is read-only**; write access requires explicitly choosing a
  share directory (persisted as `writable` in `library_config.json`). Resetting restores
  read-only.
- **Re-pairing a revoked device is rejected** (`TRUSTED_PEER_REVOKED`) until the record
  is deleted from the trusted list.
- WebDAV `COPY`/`MOVE` now honor the same no-overwrite default as `PUT` (`Overwrite: F`
  unless explicitly requested).
- Removed the wildcard `Access-Control-Allow-Origin` from the SSE stream.
- Removed the global BouncyCastle provider re-ordering on Android (`CryptoUtil`).

### Fixed
- Desktop protocol selection now fails closed for adapters that are not connected to the
  real send/receive path. Stale experimental selections fall back to `v1-classic`, and the
  UI labels unavailable protocols instead of reporting a successful switch.
- **Packaged desktop app missing `@luo-5/core`**: the 20 `src/v2` strangler-fig adapters
  now require the core library from a vendored build (`src/vendor/luo5-core`, produced by
  `scripts/build-vendor.js` and wired via `prestart`/`predist`/`pretest`), so
  electron-builder ships a working bundle again.
- **`npm ci` failed on a fresh clone**: `package-lock.json` regenerated to include all
  workspace packages (`@luo-5/protocol-spec`, `@luo-5/core`).
- Main-process error logs are written to `<userData>/logs/main_error.log` instead of a
  read-only asar path / CWD.
- Drag-and-drop multi-selection total size is computed once over all files (was
  double-counted across directories).
- Malformed percent-encoding in library service paths returns `400` instead of hanging
  the connection.

### Changed
- CI, package engines, and release builds now use the actual Node 24 runtime. A single
  `npm run ci:verify` command builds all packages, type-checks and tests Core/CLI/
  LocalSend, automatically syntax-checks `src/` and `test/`, and runs desktop suites.
- Full dependency audit is clean after pinning the fixed esbuild toolchain.
- Application and npm releases use separate namespaced tags. Package releases publish
  only the selected workspace with provenance, license, tarball, and checksum;
  application releases aggregate verified Windows/Linux assets with an SBOM and
  checksums. Android debug builds are not public release assets.
- Capability, security, support, governance, maintainer, roadmap, and release documents
  now state the implemented boundary and real v1.2.x/v1.3.0 asset manifests.
- CLI send/sync now fail closed unless the discovered signing key matches an existing
  trust record; the preview-only pair command no longer reports a successful pairing.
- Repository layout: one-off development scripts moved to `scripts/dev/` (private VM
  addresses parameterized via env vars), working notes moved to `docs/internal/`,
  committed `__pycache__` artifacts removed; README/`docs/audit.md` use the real package
  name `@luo-5/core`; `packages/core` README documents install and usage.

## [@luo-5/core & @luo-5/cli 0.2.0] - 2026-08-25

### Added
- CLI `sync` command: recursive directory sync with incremental detection, conflict resolution, and resume
- `createTransferReceiver`: receive-side transfer executor (mirror of sender executor)
- `sync-state.ts`: quick hash (first 1 MiB) + full hash for incremental change detection
- `resume-store.ts`: JSON-based resume state persistence by taskId
- `conflict-resolver.ts`: overwrite / rename-new / skip conflict strategies
- End-to-end integration tests: single-file (256 KB) and multi-file (64+128 KB) SHA-256 verification
- `timing-safe-compare.ts`: constant-time string/buffer comparison utilities
- Security test suite (12 tests): timing-safe comparison, path traversal prevention, DoS frame limits, nonce uniqueness
- Strangler fig adapters: 6 v2 JS modules migrated to re-export from `@luo-5/core`

### Fixed
- Bootstrap-to-stream-session handoff on same TCP connection via `leftoverData` buffer (critical blocker resolved)
- Stream session: accept progress messages in `awaiting-ack` state
- Executor: skip checkpoint advancement when no initial resume checkpoint exists
- Ed25519 key OID prefix (`2b6570` instead of X25519's `2b656e`)
- Ephemeral key export format (raw 32-byte base64url instead of PEM)

### Changed
- npm package version `0.1.0` → `0.2.0` (core + CLI)
- 6 desktop v2 JS modules replaced with `@luo-5/core` re-export adapters (1269 lines removed)

### Security
- Timing-safe comparison utility for preventing side-channel attacks
- Verified: `crypto.verify` for signatures (constant-time), `crypto.randomBytes(12)` for nonces (96-bit), DoS limits (16 MB / 1 MB / 4 MB), path traversal prevention in receive-planner

## 1.3.0 - 2026-08-23

### Added
- WebDAV shared-library operations exercised by repository smoke tests: OPTIONS,
  PROPFIND, GET, PUT, MKCOL, MOVE, DELETE, byte ranges, Unicode paths, and SSE events.
- Browser portal and LocalSend interoperability components.
- Protocol-v2 core, pairing, persistence, transfer, and recovery foundations under
  active application integration.
- Device-first desktop selection and compact protocol-roadmap UI.

### Release assets
- Published `nearby-transfer-1.3.0-win-x64.exe` (unsigned),
  `nearby-transfer-1.3.0-linux-x64.tar.gz`, and
  `nearby-transfer-1.3.0-linux-x64.zip`.
- No Android, deb, rpm, AppImage, macOS, SBOM, checksum catalog, or detached signature
  was attached to the public v1.3.0 release.

### Clarified
- The desktop data path remained `v1-classic`; the other six selector entries were
  experimental/integration scaffolds rather than complete interchangeable drivers.
- Repository tests and development benchmarks are evidence for the executed paths,
  not formal RFC compliance, universal interoperability, or a production-readiness
  certification. See `RELEASE_NOTES_v1.3.0.md` and `docs/capabilities.md`.

## 1.2.1

- Released the 7-protocol driver engine (`turbo-parallel`, `quic-udp`, `smb-share`, `webdav-sync`, `v2-stream`, `v1-classic`, `ftps-secure`) with category-based hot switching.
- Kept the zero-runtime-dependency desktop architecture (pure `node:crypto` self-signed TLS via `src/v2/cert-manager.js`).
- Aligned Android transfer controls (notification pause/resume/cancel, foreground service) with desktop.

## 1.2.0

- Added bilingual (zh/en) i18n, enhanced security, and transfer pause/resume/cancel controls across desktop and Android.
- Added disk-space precheck, Android foreground service, multi-NIC reload, and batch file drag-and-drop.
- Added receiver-side cancel, batch history clearing, Android back navigation, and WebDAV cancel/pause.

## 1.1.0

- Released recursive multi-level directory sync, breadcrumb navigation, and the desktop library manager for NAS WebDAV.

## 1.0.0 - In development

### Foundation

- Added the version 2 protocol contract, deterministic canonical JSON rules, and a signed pairing-offer foundation.
- Added a cross-platform pairing-code test vector verified by desktop Node and Android JVM tests.
- Added a versioned SQLite trusted-peer store with explicit transfer and file-library grants.
- Added bounded, durable pairing-session state with signed responder offers and signed code confirmations.
- Added a validated multi-file/folder transfer manifest with Windows-safe paths and no-overwrite conflict handling.
- Added a narrow desktop pairing IPC facade that keeps private keys and remote-confirmation acceptance in the main process.
- Documented the v1.0 module boundaries, trust model, migration policy, and planned authenticated message families.

### Secure transfer and recovery

- Added strict v2 wire framing, authenticated transfer messages, encrypted chunk readers and writers, and shared desktop/Android test vectors.
- Added cross-platform Ed25519 transfer-message and replay-protected stream-control codecs with deterministic interoperability vectors.
- Added a fail-closed, per-attempt session-bound desktop bootstrap and an opt-in Android listener path that authenticates trusted senders, rechecks authorization, persists incoming jobs, and requires bounded explicit approval before socket handoff.
- Added durable transfer source manifests, monotonic checkpoints, resumable stream sessions, and persistent desktop transfer jobs.
- Added no-overwrite receive planning, safe receive-root validation, symlink rejection, and a single-concurrency desktop scheduler foundation.
- Hardened legacy desktop and Android request parsing, connection lifecycle, pending-transfer bounds, and concurrent destination allocation.

### Android migration

- Added Room-backed trusted peers, resumable transfer jobs, publication journals, and tested schema migrations.
- Added restart-safe staging access, recoverable MediaStore and SAF publication, startup recovery, and cancellation-aware cleanup.
- Added signed v2 discovery and pairing services while keeping the Compose migration shell isolated behind a build flag.
- Split the Android launcher into focused transfer, device, and settings views, with compact state-driven panels and a bounded scrolling diagnostics log.

### Device management

- Added signed LAN pairing sessions, persistent trust records, permission grants, revocation, display-name editing, and trusted-device controls on desktop and Android.
- Added stricter discovery identity binding and resilient multicast interface selection across desktop and Android.

### Quality and maintenance

- Added deterministic failure, lifecycle, concurrency, corruption, migration, and recovery tests across Node and Android JVM suites.
- Added a reproducible Gradle Wrapper, CI unit-test gates, dependency updates, least-privilege workflow permissions, and repository agent guidance.

## 0.2.0 - folded into 1.1.0 / 1.2.0

### Security and reliability

- Upgraded the desktop Electron build toolchain and refreshed the dependency lockfile.
- Hardened desktop and Android UDP discovery announcement validation, including protocol, key, fingerprint, and size checks.
- Added limits for pending desktop transfer requests and stronger validation for malformed encrypted frames.
- Normalized Windows destination filenames to avoid reserved device names and unsupported trailing characters.

### Quality and maintenance

- Added smoke and Android unit tests for transfer limits, encrypted-frame failures, discovery parsing, and Windows-safe filenames.
- Run Android unit tests before producing the debug APK in CI.
- Added Dependabot, least-privilege workflow permissions, and workflow timeouts.

## 0.1.0

- Added desktop MVP with LAN peer discovery.
- Added encrypted file transfer with X25519, HKDF-SHA256, and AES-256-GCM frames.
- Added Ed25519-signed transfer requests.
- Added mandatory receive confirmation and safe configurable receive-directory saving.
- Added Linux and Windows packaging configuration for x64 and arm64.
- Added GitHub-ready open-source project files and CI workflows.
- Added Android native MVP with device keys, LAN discovery, encrypted send/receive, and manual receive confirmation.
