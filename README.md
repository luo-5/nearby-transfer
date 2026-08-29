# Nearby Transfer

[![Stars](https://img.shields.io/github/stars/luo-5/nearby-transfer?style=for-the-badge&color=ffd700&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer)
[![Forks](https://img.shields.io/github/forks/luo-5/nearby-transfer?style=for-the-badge&color=7b68ee&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer)
[![License](https://img.shields.io/github/license/luo-5/nearby-transfer?style=for-the-badge&color=00d9a3&labelColor=1a1a2e)](./LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/luo-5/nearby-transfer?style=for-the-badge&color=ff6b6b&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer/commits)
[![Downloads](https://img.shields.io/github/downloads/luo-5/nearby-transfer/total?style=for-the-badge&color=4ecdc4&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer/releases)
[![Node](https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1a1a2e)](https://nodejs.org)
[![Android](https://img.shields.io/badge/Android-8%2B-3DDC84?style=for-the-badge&logo=android&logoColor=black&labelColor=1a1a2e)](https://developer.android.com)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?style=for-the-badge&logo=electron&logoColor=white&labelColor=1a1a2e)](https://www.electronjs.org)

**English** · Nearby Transfer is an encrypted local-network file transfer and NAS WebDAV library-sync app for nearby devices. It runs as an Electron desktop app on Linux and Windows, with a separate Android client that reuses the same v2 protocol. Files move directly between devices over the LAN — no relay server, no cloud — encrypted end-to-end with Ed25519 identities, X25519 key agreement, and AES-256-GCM chunk encryption.

**中文** · Nearby Transfer 是一款面向局域网近场设备的加密文件传输与 NAS WebDAV 共享库同步应用。桌面端基于 Electron，支持 Linux 与 Windows；Android 端为独立应用，复用同一套 v2 协议。文件在设备间经局域网直传，无需中继服务器、不经过云端，全程采用 Ed25519 身份签名、X25519 密钥协商与 AES-256-GCM 分块加密。

## Features · 功能

- **Encrypted direct transfer · 加密直传** — device-to-device over TCP/UDP on the LAN, no relay or cloud. Ed25519-signed identities, X25519 ECDH session keys, AES-256-GCM per-chunk encryption.
- **6-digit SAS pairing · 6 位配对码** — mutual verification with a short authentication string before trust is saved; replay-protected signed confirmations.
- **Resumable chunked transfer · 断点续传** — 4 MiB chunks with committed-offset checkpoints; transfers resume after interruption.
- **Protocol migration · 协议迁移** — the desktop transfer flow currently uses `v1-classic`. The `v2-stream`, Turbo, QUIC, SMB, WebDAV-driver, and FTPS adapters remain visible as experimental roadmap entries but cannot be selected until their send/receive paths are integrated.
- **Shared library (WebDAV) · 共享库** — turn a device into an HTTPS WebDAV NAS; browse, upload, download, and delete with Bearer-token auth over self-signed TLS.
- **Concurrent multi-device · 多设备并发** — send to and receive from several peers simultaneously.
- **Cross-platform · 跨平台** — desktop (Electron, Linux/Windows) and Android share one protocol; interoperable across all three.
- **Directory sync · 目录同步** — CLI `sync` command recursively transfers directories with incremental detection (quick 1 MiB hash + full SHA-256), conflict resolution (rename-new/overwrite/skip), and resume support.
- **Security hardened · 安全加固** — timing-safe comparisons prevent side-channel attacks; DoS protection via frame size limits (16 MB wire / 1 MB chunk / 4 MB message); 96-bit random nonces per chunk (no IV reuse); path traversal prevention in receive planner.

## Quick Start · 快速开始

**Desktop · 桌面端**

```bash
# install dependencies (Node.js >= 24)
npm install

# run the app
npm start

# run the smoke test suite
npm test

# build installers
npm run dist:windows   # Windows NSIS installer
npm run dist:linux     # Linux tar.gz + zip
```

Pre-built installers for the latest release are on the [Releases page](https://github.com/luo-5/nearby-transfer/releases).

**Android · 安卓端**

Open `android-app/` in Android Studio (or run `./gradlew.bat :android-app:assembleDebug`) and install the resulting APK. Requires Android 8.0 (API 26) or later.

## Current Status · 当前状态

Released at **v1.3.0**. The desktop app currently sends files through the classic encrypted HTTP stream. V2 pairing, transfer primitives, and resumable job infrastructure are under active integration, while the WebDAV shared-library service is available separately. The remaining protocol adapters are experimental scaffolds rather than complete transfer implementations. Work is underway to extract the protocol core into a reusable TypeScript package (`@luo-5/core`) and to grow the ecosystem (CLI, Docker, LocalSend interop) per the roadmap.

### v0.2 Transfer Flow

- Finds other running app instances on the same LAN with UDP multicast.
- Sends files directly between devices without a relay server.
- Encrypts file content with X25519 key agreement and AES-256-GCM chunk encryption.
- Signs transfer requests with an Ed25519 device identity key.
- Shows a receive confirmation dialog for every incoming transfer.
- Saves accepted files to the system Downloads folder by default, with a user-selectable receive location.
- Provides packaging targets for Linux, Windows, and Android.

## Platform Targets

| Platform | Supported range | Architectures | Packages |
| --- | --- | --- | --- |
| Linux RPM family | RHEL/Rocky/Alma/CentOS Stream 8-10 | x64, arm64 | rpm |
| Linux DEB family | Ubuntu 22.04-26.04 or newer compatible releases | x64, arm64 | deb |
| Windows | Windows 10-11 | x64, arm64 | exe installer, zip test package |
| Android | Android 8-16, API 26+ | arm64-v8a first, x86_64 for emulator later | apk/aab planned |

Unsigned Windows builds are intended for testing. Public Windows releases should use platform code signing.

## Run

```bash
npm install
npm start
```

## Verify

```bash
npm run check
npm test
```

## Build Guide

See [`docs/build.md`](docs/build.md) for complete Linux, Windows, and Android build steps, signing notes, and release artifact guidance.

For the v1.0 rewrite plan, current implementation boundary, and moving the
working directory to another computer, see
[`docs/next-version-handoff.md`](docs/next-version-handoff.md).

For a one-page path index covering the handoff, UI, Android, desktop, protocol,
and test entry points, see [`HANDOFF.md`](HANDOFF.md).

## Protocol Specification · 协议规范

The complete v2 protocol specification — covering device identity (Ed25519),
UDP multicast discovery, 6-digit SAS pairing, resumable encrypted transfer
(X25519 ECDH + AES-256-GCM), signed stream control, and stream multiplexing —
is in [`docs/protocol/v2-spec.md`](docs/protocol/v2-spec.md). The source of truth
lives in [`packages/protocol-spec/v2-spec.md`](packages/protocol-spec/v2-spec.md).

Deterministic test vectors (identity, session key, chunk encryption, SAS pairing
code, canonical JSON, wire frame, chunk frame, discovery/pairing signatures,
manifest serialization) are in
[`packages/core/test/vectors/`](packages/core/test/vectors/) and verified by
`npm run test:core`. Regenerate them with
`npx tsx packages/core/scripts/generate-all-vectors.ts`.

## Build Linux Packages

```bash
npm run dist:linux
```

The Linux build uses `electron-builder` and creates `deb` and `rpm` artifacts under `../nearby-transfer-dist/`.
Linux packages install under `/opt/nearby-transfer` while keeping the desktop display name `Nearby Transfer`.

## Build Desktop Packages

```bash
npm run dist:linux
npm run dist:windows
```

Cross-platform packages are best built on matching CI runners. The repository includes GitHub Actions workflows for Linux, Windows, and Android artifacts.

On Linux, Windows zip test packages can be generated without Wine by running:

```bash
electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

The Windows NSIS installer requires Wine when cross-building from Linux, or a native Windows runner.

## Build Android APK

On Windows:

```powershell
.\gradlew.bat :android-app:assembleDebug
```

On Linux and macOS:

```bash
./gradlew :android-app:assembleDebug
```

The Android project is a native client under `android-app/` that reuses the same discovery and encrypted transfer protocol. See `docs/android.md` for Android compatibility notes.

## Notes

- This MVP uses UDP multicast for discovery instead of mDNS to keep the first implementation dependency-light.
- Firewalls may block discovery or transfer ports until the app is allowed on the local network.
- Received files are saved to the system Downloads folder by default. Use the in-app save-location control to choose a different folder.
- Android is implemented as a separate native client and reuses the desktop discovery and encrypted transfer protocol.
- Public Windows releases should be code-signed, and Android debug APKs should not be used for public distribution.
