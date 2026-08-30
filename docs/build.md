# Build guide

This guide describes the build commands that exist on the current default branch.
Release assets can differ from a local build, so use the exact release page when
documenting what has already been published.

## Prerequisites

- Node.js 24 or later for the desktop application.
- npm for installing the lockfile-pinned dependencies.
- Java 17 for Android builds.
- Android SDK Platform 35 and Build Tools 35.0.0 for Android builds.
- No global Gradle installation is required; use the checked-in Gradle Wrapper.

## Install desktop dependencies

```bash
npm ci
```

If Electron downloads are slow on your network, configure a trusted Electron mirror
before installation. For example, in a POSIX shell:

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

## Verify source

```bash
npm run check
npm test
```

`npm run check` validates JavaScript syntax. `npm test` builds the vendored core package
and runs the desktop smoke and integration suites configured by the root package.
Additional package checks are available as `npm run typecheck`, `npm run test:core`, and
`npm run test:cli`.

## Run the desktop application

```bash
npm start
```

Start the application on devices connected to the same LAN. Firewalls must allow UDP
port `47777` for discovery and the dynamic TCP transfer port announced by the receiver.

## Build Linux archives

Run this command on Linux:

```bash
npm run dist:linux
```

The current script explicitly builds x64 `tar.gz` and `zip` archives and writes them to
`../nearby-transfer-dist/`:

- `nearby-transfer-1.3.0-linux-x64.tar.gz`
- `nearby-transfer-1.3.0-linux-x64.zip`

The default `dist:linux` script does **not** build ARM64, DEB, RPM, or AppImage targets.
If a future release changes the script, update this guide and the README in the same
commit.

## Build Windows packages

Run this command on Windows:

```powershell
npm run dist:windows
```

The current script builds x64 `zip` and portable-executable targets and writes them to
`../nearby-transfer-dist/`:

- `nearby-transfer-1.3.0-win-x64.zip`
- `nearby-transfer-1.3.0-win-x64.exe`

The default script does **not** build ARM64 or an NSIS installer. The repository's
default Windows configuration disables executable signing, so treat local output as an
unsigned test build unless you have configured and verified your own signing workflow.

For a custom electron-builder invocation, run the project-local binary through npm. For
example:

```bash
npm exec -- electron-builder --config packaging/electron-builder.yml --win zip --x64 --publish never
```

Cross-platform packages are best built on matching host platforms.

## Test and build Android

Use the checked-in Gradle 8.7 Wrapper. It downloads the official Gradle distribution
when needed and verifies it against the checksum pinned in
`gradle/wrapper/gradle-wrapper.properties`.

On Windows:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest
.\gradlew.bat :android-app:assembleDebug
```

On Linux or macOS:

```bash
./gradlew :android-app:testDebugUnitTest
./gradlew :android-app:assembleDebug
```

The Android module requires API 26 or later. A debug APK is intended for local testing
only. Configure release signing and build a release APK or AAB before public Android
distribution. See [`android.md`](android.md) for compatibility notes.

## GitHub Actions

The repository contains separate workflows for source checks, CodeQL, and platform
builds under [`.github/workflows/`](../.github/workflows/). Check the result of the exact
commit you plan to release; a workflow file existing in the repository does not imply
that its latest run passed.

## Large files

The desktop direct-transfer path does not enforce a small fixed file-size cap. The
receiver verifies that the decrypted byte count matches the sender-declared size and
that the plaintext SHA-256 digest matches before publishing the file. Available disk
space, filesystem limits, timeouts, and client-specific paths still apply.

## Do not commit generated files

Do not commit dependency folders or build output:

- `node_modules/`
- `.gradle/`
- `android-app/build/`
- desktop package output directories
- generated package archives, executables, APKs, or AABs
