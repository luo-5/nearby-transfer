# Changelog

All notable changes to Nearby Transfer will be documented in this file.

## 1.3.0

### UX improvements

- **Pairing simplified to 2 steps**: both devices confirm the 6-digit SAS code, then trust is saved automatically — the separate "Save Trust" button is gone. The Ed25519 + SAS security model and the underlying state machine are unchanged.
- **Paired devices hidden from the pairing list**: trusted devices no longer appear in the "nearby devices" list with a pair button (desktop + Android). Discovery protocol untouched.
- **Device-first selection flow**: the device panel now renders above the file panel on both desktop and Android; the selected device is persisted to `localStorage` and auto-restored on next launch. When the selected peer goes offline, the selection is retained with an "offline" hint instead of being cleared.
- **Compact protocol selector**: the 7 large multi-line protocol cards are now a compact single-column list with collapsible details (accordion). Selecting a protocol and expanding its details are separate actions.
- **Protocol selector now persists**: fixed a missing `getProtocol`/`setProtocol` bridge in `preload.js` — the protocol choice previously only updated the UI but was never saved.

### Android hardening

- Removed all hardcoded fallback device IDs (`415847b501f88dbb`) in `MainActivity` and `NearbyDocumentsProvider`. When the device identity is not ready, the app shows "设备未初始化，请稍后重试" instead of authenticating with a fabricated ID that would 403.
- `MainActivity` now persists its real device ID to SharedPreferences, which the separate-process SAF provider reads.
- Discovery log spam fixed: `DiscoveryService.handleMessage` logs "发现设备" only on first discovery, not every 2s broadcast. `BoundedLogBuffer` collapses consecutive duplicate messages.

### Security and stability (from `next/1.0`, now merged to `main`)

- Hardened the incoming-transfer confirmation dialog so a 60-second timeout auto-rejects and a stale late user click is ignored; removed dead `pendingDialogs` plumbing that could not dismiss a native MessageBox.
- Made the desktop library PUT endpoint return `413 Payload Too Large` when a chunked upload crosses the 50 GiB cap, instead of resetting the connection or emitting a misleading 500.
- Desktop security patches: moved the running-ports file to `app.getPath('userData')`, restricted library auth tokens to the `Authorization: Bearer` header only, re-checked trusted-peer status on every library request and revoked stale tokens, and added symlink-escape protection (`_isPathWithinShare`) across list/PROPFIND/PUT paths.
- Android P0 fixes: converted `NearbyTransferDatabase` to an application-scoped singleton, fixed a coroutine scope leak in `V2StartupRecoveryRunner`, and replaced silent `catch (ignored)` blocks with `Log.w` in `TransferForegroundService` and `V2IncomingTransferCoordinator`.
- Restored `ACTION_STOP_TRANSFER` handling in `TransferForegroundService.onStartCommand` (regression from the Android P0 patch) and added a `resetInstance()` test seam for the Room singleton.
- Build: enabled `android.overridePathCheck` for the non-ASCII repo path and made `run_tests.ps1` honor an existing `ANDROID_SDK_ROOT`.

### Cross-platform testing

- Verified v2 encrypted file transfer across Ubuntu 26.04, CentOS Stream 9, and Windows — 6/6 pairs passed with SHA256 verification.
- Verified WebDAV shared library access (auth + PROPFIND + upload + download + delete) across all 3 OS pairs — 6/6 passed.
- Verified concurrent multi-device transfer and concurrent library access — 2/2 passed.
- Linux packaging (`npm run dist:linux`) verified on both Ubuntu and CentOS; electron launches under xvfb with no fatal errors.

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
