# Build Guide

This guide describes how to build Nearby Transfer from source for Linux, Windows, and Android.

## Prerequisites

- Node.js 24 or newer for the desktop app. Protocol-v2 persistence uses the built-in
  `node:sqlite` module.
- npm for installing desktop dependencies.
- Java 17 for Android builds.
- Android SDK platform 35 and build tools 35.0.0 for Android builds.
- No global Gradle installation is required; use the checked-in Gradle Wrapper.

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
npm run ci:verify
```

This builds all published packages, runs all package type checks and tests, checks
JavaScript syntax under `src/` and `test/`, and runs the desktop smoke/integration
suite.

## Run Desktop App

```bash
npm start
```

Start the app on two devices on the same LAN. Firewalls must allow UDP `47777` for discovery and the dynamic TCP transfer port announced by the app.

## Build Linux Packages

```bash
npm run dist:linux
```

The standard command builds an installable x64 Debian package.

Expected artifacts:

- `nearby-transfer-<version>-linux-amd64.deb`

The Debian installer configures Electron's Chromium sandbox and an AppArmor profile on
supported Ubuntu releases. Raw Linux archives are not public release artifacts because
extracting an archive cannot securely establish the sandbox ownership and policy.
RPM, AppImage, and additional architectures remain release-roadmap work until matching
CI and real-system installation tests are added.

## Build Windows Packages

Windows release packages should be built on a Windows runner:

```bash
npm run dist:windows
```

The current script builds an unsigned portable executable and zip for x64. Public
Windows releases should be code-signed before distribution to reduce SmartScreen
warnings and improve publisher identity.

On Linux, zip test packages can be generated without Wine:

```bash
electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

NSIS is configured as future packaging work but is not requested by the standard
`dist:windows` script.

## Test and Build Android

Use the checked-in Gradle 8.7 Wrapper. It downloads the official Gradle distribution when needed and verifies it against the pinned SHA-256 checksum in `gradle/wrapper/gradle-wrapper.properties`.

On Windows:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest
.\gradlew.bat :android-app:assembleDebug
```

On Linux and macOS:

```bash
./gradlew :android-app:testDebugUnitTest
./gradlew :android-app:assembleDebug
```

The debug APK is intended for local testing only. Configure release signing and build a release APK or AAB before public Android distribution.
## GitHub Actions

The repository includes workflows for source checks and platform artifacts:

- `.github/workflows/check.yml`
- `.github/workflows/build-linux.yml`
- `.github/workflows/build-windows.yml`
- `.github/workflows/build-android.yml`
- `.github/workflows/release-app.yml`
- `.github/workflows/release.yml`

Application tags use `app-v<version>`. Individual npm packages use `core-v<version>`,
`cli-v<version>`, or `localsend-adapter-v<version>`. See [`releasing.md`](releasing.md).
Android debug APKs are verification artifacts and are excluded from public application
releases until signing is configured.

## Large Files

Nearby Transfer does not enforce a small fixed file-size cap. Receivers verify that the actual decrypted byte count exactly matches the sender-declared size and that the plaintext SHA-256 hash matches before saving the file.

## Do Not Commit Generated Files

Do not commit dependency folders or build output:

- `node_modules/`
- `.gradle/`
- `android-app/build/`
- desktop package output directories
- generated `.deb`, `.rpm`, `.exe`, `.zip`, `.apk`, or `.aab` artifacts
