# Release Builds

Release artifacts are written to `../nearby-transfer-dist/` by the desktop packaging config.

## Local Linux Build

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm run dist:linux
```

Linux packages use a Linux-specific electron-builder config so the installed app directory is `/opt/nearby-transfer` without spaces. The desktop launcher still displays `Nearby Transfer`. This avoids Electron/Chromium zygote startup failures on Linux desktop environments when the install path contains spaces.

Expected artifacts:

- `nearby-transfer-0.1.0-linux-amd64.deb`
- `nearby-transfer-0.1.0-linux-arm64.deb`
- `nearby-transfer-0.1.0-linux-x86_64.rpm`
- `nearby-transfer-0.1.0-linux-aarch64.rpm`

The RPM build requires `rpmbuild`.

## Windows

Windows installers should be built on Windows runners. Linux cross-builds need Wine and are not recommended for release validation.

On Linux, Windows zip test packages can be generated without Wine:

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" electron-builder --config packaging/electron-builder.yml --win zip --x64 --arm64
```

Expected local test artifacts:

- `nearby-transfer-0.1.0-win-x64.zip`
- `nearby-transfer-0.1.0-win-arm64.zip`

The NSIS installer remains the Windows release target and is produced by `.github/workflows/build-windows.yml` on a Windows runner.

## Android

The Android project currently builds a debug APK with the native LAN discovery and encrypted transfer MVP. GitHub Actions installs Android SDK 35 and runs:

```bash
gradle :android-app:assembleDebug
```

The debug APK is intended for local testing. Release APK/AAB signing should be configured before public Android distribution.
