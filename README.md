# Nearby Transfer

Nearby Transfer is an encrypted local-network file transfer app for nearby devices. The current targets are Linux and Windows through Electron, plus an Android client as a separate app that reuses the same protocol.

## Current MVP

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

```bash
gradle :android-app:assembleDebug
```

The Android project is a native client under `android-app/` that reuses the same discovery and encrypted transfer protocol. See `docs/android.md` for Android compatibility notes.

## Notes

- This MVP uses UDP multicast for discovery instead of mDNS to keep the first implementation dependency-light.
- Firewalls may block discovery or transfer ports until the app is allowed on the local network.
- Received files are saved to the system Downloads folder by default. Use the in-app save-location control to choose a different folder.
- Android is implemented as a separate native client and reuses the desktop discovery and encrypted transfer protocol.
- Public Windows releases should be code-signed, and Android debug APKs should not be used for public distribution.
