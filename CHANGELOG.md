# Changelog

All notable changes to Nearby Transfer will be documented in this file.

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

## 0.2.0 - Unreleased

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
