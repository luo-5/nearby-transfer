# Release Builds

Release artifacts are written to the output directory selected by the build command.

## Local Linux Build

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm run dist:linux
```

Linux packages use a Linux-specific electron-builder config so the installed app directory is `/opt/nearby-transfer` without spaces. The desktop launcher still displays `Nearby Transfer`. This avoids Electron/Chromium zygote startup failures on Linux desktop environments when the install path contains spaces.

Expected artifact:

- `nearby-transfer-<version>-linux-amd64.deb`

The Linux workflow installs this package on its Ubuntu runner and requires the app to
remain running under Xvfb with Chromium sandboxing enabled. Raw archives are not
published because they cannot perform the root-owned sandbox and AppArmor installation
steps. RPM, AppImage, and arm64 builds are not current release outputs.

## Windows

Windows installers should be built on Windows runners. Linux cross-builds need Wine and are not recommended for release validation.

On Linux, Windows zip test packages can be generated without Wine:

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

Expected local test artifacts:

- `nearby-transfer-<version>-win-x64.zip`
- `nearby-transfer-<version>-win-arm64.zip`

The current Windows release workflow produces an unsigned x64 portable executable and
zip. NSIS and arm64 remain future release work until their build, signing, and install
paths are verified.

## Android

The Android project currently builds a debug APK with the native LAN discovery and encrypted transfer MVP. GitHub Actions installs Android SDK 35 and runs:

```bash
./gradlew :android-app:testDebugUnitTest
./gradlew :android-app:assembleDebug
```

The debug APK is intended for local testing. Release APK/AAB signing should be configured before public Android distribution.
