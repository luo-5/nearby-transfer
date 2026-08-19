# Android Kotlin and Compose Migration

## Purpose

The Android MVP remains a Java application while v1.0 is built incrementally. The
production launcher is still `MainActivity`; discovery, incoming-transfer approval,
and the existing encrypted transfer flow are deliberately not routed through Compose.

The first Compose code is a separately declared, non-exported preview activity:
`io.github.nearbytransfer.android.migration.ComposeMigrationActivity`.

- **Debug builds:** `BuildConfig.ENABLE_COMPOSE_SHELL` is `true`; developers may open
  the preview explicitly with Android Studio or `adb shell am start -n
  io.github.nearbytransfer.android/.migration.ComposeMigrationActivity`.
- **Release builds:** the flag is `false`; if invoked accidentally, the activity closes
  immediately.
- **All builds:** `MainActivity` remains the only launcher activity.

This is a feature-flagged migration boundary, not a second transfer implementation.

## Initial layer boundaries

```text
core/model/       Stable platform-neutral entities and permissions
core/data/        Repository contracts; Room implementations will live below here
feature/*/        Compose feature state and screens
ui/theme/         Shared Compose visual primitives
migration/        Temporary entry point and build-flag boundary
```

`TrustedPeerRepository` is intentionally the only persistence boundary exposed to
features. A later Room migration should add a Room entity, DAO, database, and a
`TrustedPeerRepository` implementation under `core/data/local/`. It must persist only
public peer identity, trust state, timestamps, and grants—not local identity private
keys or short-lived sessions.

## Localization start point

New Compose text lives in Android resources:

- `src/main/res/values/strings.xml` — English default
- `src/main/res/values-zh-rCN/strings.xml` — Simplified Chinese

New Compose features must add both resources instead of hard-coding text. Existing Java
MVP strings are unchanged in this non-breaking migration step and can move gradually.

## Validation

Use the repository-provided toolchain when a system Gradle/JDK is unavailable:

```powershell
$env:JAVA_HOME = "$PWD\.tmp\tools\jdk-17"
$env:ANDROID_HOME = "$PWD\.tmp\tools\android-sdk"
& "$PWD\.tmp\tools\gradle-8.7\bin\gradle.bat" :android-app:testDebugUnitTest
& "$PWD\.tmp\tools\gradle-8.7\bin\gradle.bat" :android-app:assembleDebug
```

The debug APK must still start `MainActivity`. The Compose shell is exercised separately
until pairing, trusted-peer storage, and transfer behavior have feature parity.