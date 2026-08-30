# Nearby Transfer

[![Stars](https://img.shields.io/github/stars/luo-5/nearby-transfer?style=for-the-badge&color=ffd700&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer)
[![Forks](https://img.shields.io/github/forks/luo-5/nearby-transfer?style=for-the-badge&color=7b68ee&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer)
[![License](https://img.shields.io/github/license/luo-5/nearby-transfer?style=for-the-badge&color=00d9a3&labelColor=1a1a2e)](./LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/luo-5/nearby-transfer?style=for-the-badge&color=ff6b6b&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer/commits)
[![Downloads](https://img.shields.io/github/downloads/luo-5/nearby-transfer/total?style=for-the-badge&color=4ecdc4&labelColor=1a1a2e)](https://github.com/luo-5/nearby-transfer/releases)
[![Node](https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1a1a2e)](https://nodejs.org)
[![Android](https://img.shields.io/badge/Android-8%2B-3DDC84?style=for-the-badge&logo=android&logoColor=black&labelColor=1a1a2e)](https://developer.android.com)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?style=for-the-badge&logo=electron&logoColor=white&labelColor=1a1a2e)](https://www.electronjs.org)

The **Downloads** badge counts GitHub Release asset downloads. It does not include npm
package downloads; npm publishes separate per-package statistics.

**English** · Nearby Transfer is a local-network file transfer and NAS WebDAV library app for nearby devices. The current Electron desktop data path uses the classic encrypted transfer protocol; protocol-v2 cryptography, pairing, persistence, and transfer components are being integrated behind it. Android, CLI, and LocalSend support have different maturity and security boundaries, documented in the [capability matrix](docs/capabilities.md).

**中文** · Nearby Transfer 是一款面向局域网近场设备的文件传输与 NAS WebDAV 共享应用。当前 Electron 桌面端的数据通路使用经典加密传输协议；协议 v2 的密码学、配对、持久化和传输组件仍在逐步接入。Android、CLI 和 LocalSend 兼容层的成熟度与安全边界并不相同，详见[能力矩阵](docs/capabilities.md)。

## Features · 功能

- **Encrypted direct transfer · 加密直传** — the current desktop path sends file contents directly over the LAN without a relay. Protocol-v2 provides Ed25519 identity, X25519 key agreement, and AES-256-GCM chunk primitives but is not yet the desktop default data path.
- **V2 pairing foundation · V2 配对基础** — signed offers, 6-digit SAS derivation, trust persistence, and replay-aware control messages are implemented and tested as v2 components; application integration remains in progress.
- **Resumable transfer foundation · 断点续传基础** — protocol-v2 includes chunk checkpoints and recovery state machines. Do not assume every current client or protocol path can resume yet.
- **Protocol migration · 协议迁移** — the desktop transfer flow currently uses `v1-classic`. The `v2-stream`, Turbo, QUIC, SMB, WebDAV-driver, and FTPS adapters remain visible as experimental roadmap entries but cannot be selected until their send/receive paths are integrated.
- **Shared library (limited WebDAV) · 共享库** — supported Nearby Transfer clients negotiate a signed session and then use a Bearer token over self-signed HTTPS. This is not a generic password-free mount for arbitrary WebDAV clients; the default share is read-only and a user-selected share is writable.
- **Concurrent receive handling · 并发接收** — the receiver tracks multiple incoming transfers; the current desktop send UI starts a transfer to one selected peer at a time.
- **Cross-platform foundations · 跨平台基础** — Electron, Android, and Node implementations live in one repository and share protocol fixtures. End-to-end compatibility is tracked per client rather than claimed globally.
- **Directory sync preview · 目录同步预览** — the CLI contains directory scanning, hashing, conflict, and resume components, but its trust and pairing workflow is not yet ready for general use.
- **Scoped security hardening · 分范围安全加固** — protocol-v2 components enforce bounded frames, random chunk nonces, authenticated metadata, and receive-path validation. These guarantees do not automatically apply to the classic, WebDAV, or LocalSend paths.

## Quick Start · 快速开始

**Desktop · 桌面端**

```bash
# install the lockfile-pinned dependencies (Node.js >= 24)
npm ci

# run the app
npm start

# run the repository release gate
npm run ci:verify

```

Build on the matching platform. On Windows:

```powershell
npm run dist:windows # portable executable + zip (unsigned)
```

On Linux:

```bash
npm run dist:linux # x64 Debian package
```

Release assets for the latest version are on the [Releases page](https://github.com/luo-5/nearby-transfer/releases).

**Android · 安卓端**

Open `android-app/` in Android Studio, or build from the repository root with
`./gradlew :android-app:assembleDebug` on Linux/macOS and
`.\gradlew.bat :android-app:assembleDebug` on Windows. Install the resulting APK.
Android 8.0 (API 26) or later is required.

## Current Status · 当前状态

The latest documented application release is **v1.3.0**; this worktree prepares
**v1.3.1**. The desktop app currently sends files through the classic encrypted HTTP stream. V2 pairing, transfer primitives, and resumable job infrastructure are under active integration, while the WebDAV shared-library service is available separately. The remaining protocol adapters are experimental scaffolds rather than complete transfer implementations. The npm packages are pre-1.0 and may change. See the [capability and security matrix](docs/capabilities.md) before choosing a client or protocol.

### Current classic transfer flow

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
| Linux | Debian/Ubuntu-compatible distribution | x64 currently automated | deb |
| Windows | Windows 10-11 | x64 currently automated | unsigned portable exe, zip |
| Android | Android 8+, API 26+ | device ABI depends on the Gradle build | debug APK from CI; signed public release not automated |

Unsigned Windows builds are intended for testing. Public Windows releases should use platform code signing.

## Run

```bash
npm ci
npm start
```

## Verify

```bash
npm run ci:verify
```

## Build Guide

See [`docs/build.md`](docs/build.md) for complete Linux, Windows, and Android build steps, signing notes, and release artifact guidance.
Release tags and independent application/package version lines are documented in
[`docs/releasing.md`](docs/releasing.md).

Current implementation boundaries are tracked in the
[`capability matrix`](docs/capabilities.md); planned work is tracked in
[`ROADMAP.md`](ROADMAP.md), and contributor workflows are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

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

The current `dist:linux` command uses `electron-builder` and creates an x64 Debian
package. The package installer configures Electron's Chromium sandbox and the Ubuntu
24+ AppArmor profile. Raw `tar.gz` and `zip` bundles are not published because they
cannot safely install the required sandbox ownership and policy.

## Build Desktop Packages

```bash
npm run dist:linux
npm run dist:windows
```

Cross-platform packages are best built on matching CI runners. The repository includes GitHub Actions workflows for Linux, Windows, and Android artifacts.

On Linux, Windows zip test packages can be generated without Wine by running:

```bash
npm exec -- electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

The current Windows release target is an unsigned portable executable plus zip. NSIS is future packaging work.

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
