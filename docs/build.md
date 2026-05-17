# Build Guide

This guide describes how to build Nearby Transfer from source for Linux, Windows, and Android.

## Prerequisites

- Node.js 20 or newer for the desktop app.
- npm for installing desktop dependencies.
- Java 17 for Android builds.
- Android SDK platform 35 and build tools 35.0.0 for Android builds.
- `rpmbuild` on Linux if RPM packages are needed.

## Install Desktop Dependencies

```bash
npm ci
```

If Electron downloads are slow in your network, set an Electron mirror before installing or building:

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

## Verify Source

```bash
npm run check
npm test
```

`npm run check` runs JavaScript syntax checks. `npm test` runs the Node smoke tests for crypto and local encrypted transfer.

## Run Desktop App

```bash
npm start
```

Start the app on two devices on the same LAN. Firewalls must allow UDP `47777` for discovery and the dynamic TCP transfer port announced by the app.

## Build Linux Packages

```bash
npm run dist:linux
```

This uses `packaging/linux/electron-builder.yml`, which installs the Linux app under `/opt/nearby-transfer` while keeping the desktop display name `Nearby Transfer`.

Expected artifacts:

- `nearby-transfer-0.1.0-linux-amd64.deb`
- `nearby-transfer-0.1.0-linux-arm64.deb`
- `nearby-transfer-0.1.0-linux-x86_64.rpm`
- `nearby-transfer-0.1.0-linux-aarch64.rpm`

## Build Windows Packages

Windows release packages should be built on a Windows runner:

```bash
npm run dist:windows
```

The current project can build unsigned test packages. Public Windows releases should be code-signed before distribution to reduce SmartScreen warnings and improve installer integrity.

On Linux, zip test packages can be generated without Wine:

```bash
electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

The NSIS installer target requires a Windows runner or Wine when cross-building from Linux.

## Build Android Debug APK

```bash
gradle :android-app:assembleDebug
```

If Gradle is not installed globally, use a local Gradle distribution or the GitHub Actions workflow in `.github/workflows/build-android.yml`.

The debug APK is intended for local testing only. Configure release signing and build a release APK or AAB before public Android distribution.

## GitHub Actions

The repository includes workflows for source checks and platform artifacts:

- `.github/workflows/check.yml`
- `.github/workflows/build-linux.yml`
- `.github/workflows/build-windows.yml`
- `.github/workflows/build-android.yml`

Release-tag workflows may produce test artifacts unless signing secrets and release-specific build steps are configured.

## Large Files

Nearby Transfer does not enforce a small fixed file-size cap. Receivers verify that the actual decrypted byte count exactly matches the sender-declared size and that the plaintext SHA-256 hash matches before saving the file.

## Do Not Commit Generated Files

Do not commit dependency folders or build output:

- `node_modules/`
- `.gradle/`
- `android-app/build/`
- desktop package output directories
- generated `.deb`, `.rpm`, `.exe`, `.zip`, `.apk`, or `.aab` artifacts
