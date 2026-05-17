# Android Client

The Android client targets Android 8-16, API 26 and newer.

## Current State

The repository includes a native Android client under `android-app/`. It is intentionally separate from the Electron desktop app because Electron does not target Android.

The current Android MVP can:

- Generate and persist its own Ed25519 identity key and X25519 encryption key on first launch.
- Announce and discover nearby desktop/Android clients with the same UDP multicast protocol.
- Select one file with Android's system file picker.
- Send encrypted files to a selected nearby device.
- Receive encrypted files over the local HTTP protocol and require user confirmation before saving.
- Save received files to Downloads/Nearby Transfer by default, or to a user-selected folder via Android's system folder picker.

## Compatibility Targets

- Minimum SDK: 26, Android 8.
- Target SDK: 35 initially, to be updated with current Android releases.
- Primary device ABI: arm64-v8a.
- Emulator ABI: x86_64 can be added when native dependencies are introduced.

## Protocol Compatibility

- UDP multicast discovery compatible with the desktop app.
- HTTP local-network upload compatible with the desktop app.
- Persistent device identity.
- X25519 transfer key agreement.
- Ed25519 transfer request signatures.
- AES-256-GCM framed file encryption.
- Mandatory receive confirmation for every incoming file.

## Save Location

- Android 10 and newer save to `Downloads/Nearby Transfer` through MediaStore by default.
- Android 8-9 save to a `Nearby Transfer` folder under the public Downloads directory by default.
- Users can choose a custom receive folder from the app. The selected folder permission is persisted with Android's Storage Access Framework.

## Remaining Work

- Add a foreground service for reliable discovery and receiving under Android background limits.
- Add Android instrumentation tests and real-device transfer matrix coverage.
