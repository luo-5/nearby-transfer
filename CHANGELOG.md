# Changelog

All notable changes to Nearby Transfer will be documented in this file.

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

## 1.3.0 - 2026-08-29

### Ecosystem Interoperability & WebDAV Engine
- **RFC 4918 WebDAV Full Specification Compliance**:
  - Implemented `OPTIONS`, `PROPFIND` (Depth: 0/1/infinity with XML response formatting), `GET`, `PUT`, `MKCOL`, `MOVE`, and `DELETE`.
  - Added URL normalization and prefix preservation in XML hrefs for seamless third-party client integration (Finder, Windows Explorer, Cyberduck, rclone).
  - Implemented HTTP 206 Partial Content and `Range: bytes=start-end` requests with `Content-Range` and `Accept-Ranges: bytes` headers for video/audio seeking and resumable media streaming.
- **rclone Deep Stress Testing**:
  - Validated with `rclone copy`, `sync`, and `check` across 10 concurrent streams, nested directory trees, and large binary payloads (30 MB+) with 100% bit-for-bit SHA-256 match.
- **Web Browser Zero-Install Portal**:
  - Modern web portal with RESTful shares discovery, directory tree browsing, chunked drag-and-drop uploading, and real-time Server-Sent Events (SSE) for instant filesystem synchronization.
- **LocalSend v2 Adapter**:
  - Full TypeScript typechecking under `exactOptionalPropertyTypes: true` and 100% test pass rate across all adapter suites.

### High-Performance Crypto & Transfer Core
- **AES-256-GCM + AAD Throughput**:
  - Benchmarked at **769.14 MB/s** decryption throughput and **712.88 MB/s** encryption throughput on 1MB chunk streams.
- **Canonical JSON Serialization**:
  - **596,700 ops/sec** for control messages and **18,864 ops/sec** for 50-entry manifests.
- **Wire Speed**:
  - **217.63 MB/s** (1.74 Gbps) over TCP loopback with complete session cryptographic encapsulation.

### Multi-Platform Release Packaging
- **Windows**: Built NSIS installer (`nearby-transfer-1.3.0-win-x64.exe`) and portable package (`nearby-transfer-1.3.0-win-x64.zip`).
- **Linux**: Built Debian package (`nearby-transfer-1.3.0-linux-amd64.deb` - verified via `dpkg -i` on Ubuntu 24.04), RPM package (`nearby-transfer-1.3.0-linux-x86_64.rpm` - verified via `rpm -Uvh` on CentOS 7/9), AppImage (`nearby-transfer-1.3.0-linux-x86_64.AppImage`), and Tar/Zip archives.
- **Android**: Built signed release APK (`nearby-transfer-1.3.0-android.apk`) with ProGuard/R8 code shrinking and Android 14+ compatibility.
- Generated `SHA256SUMS.txt` cryptographic catalog for all release packages.

### UX & Security Improvements
- **Pairing simplified to 2 steps**: both devices confirm the 6-digit SAS code, then trust is saved automatically.
- **Device-first selection flow**: device panel renders above file panel with persistent selection.
- **Compact protocol selector**: compact single-column list with collapsible accordion details.
- **Android hardening**: removed all hardcoded fallback device IDs; fixed SharedPreferences sync across multi-process SAF provider; resolved discovery broadcast log spam.

### Cross-Platform Testing & Quality Assurance
- **256 / 256 tests passing (100% green)** across monorepo packages, desktop smoke suites, browser portal E2E, WebDAV interop, 3-VM matrix, and physical Android hardware (Redmi K50 and Samsung S10+).
- Heap memory audit confirmed zero memory/handle leaks across soak cycles.

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
