# Changelog

All notable changes to Nearby Transfer will be documented in this file.

## 1.0.0 - In development

### Foundation

- Added the version 2 protocol contract, deterministic canonical JSON rules, and a signed pairing-offer foundation.
- Added a cross-platform pairing-code test vector verified by desktop Node and Android JVM tests.`n- Added a versioned SQLite trusted-peer store with explicit transfer and file-library grants.
- Documented the v1.0 module boundaries, trust model, migration policy, and planned authenticated message families.

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
