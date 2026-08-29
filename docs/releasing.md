# Release process

Nearby Transfer uses independent version lines and tag namespaces. A tag must match
the version in its target `package.json`; the workflow fails before publishing when
they differ.

| Target | Tag example | Workflow output |
| --- | --- | --- |
| Desktop application | `app-v1.3.1` | Verified Windows and Linux assets, SPDX SBOM, SHA-256 checksums, GitHub Release |
| `@luo-5/core` | `core-v0.2.1` | One npm package with provenance, tarball, checksum, package GitHub Release |
| `@luo-5/cli` and CLI container | `cli-v0.2.1` | One npm package with provenance plus GHCR multi-architecture container |
| `@luo-5/localsend-adapter` | `localsend-adapter-v0.1.1` | One npm package with provenance, tarball, checksum, package GitHub Release |

## Pre-release checklist

1. Update only the target version and its changelog/release notes.
2. Run `npm ci` followed by `npm run ci:verify` from a clean checkout.
3. For Android changes, run `./gradlew :android-app:testDebugUnitTest` and
   `./gradlew :android-app:assembleDebug` on Linux/macOS or the wrapper equivalents
   on Windows.
4. Confirm [`capabilities.md`](capabilities.md) matches the code paths being shipped.
5. Push the namespaced tag. Do not reuse or move a published tag.
6. Inspect the draft artifacts, SBOM, checksums, package contents, provenance, and
   signing status before announcing the release.

## Current signing boundary

- Linux application releases use an installed `.deb` whose post-install script enables
  the Electron Chromium sandbox and loads a supported AppArmor profile. Raw Linux
  archives are not release assets.
- Windows artifacts are unsigned until a protected code-signing identity is wired
  into the release workflow. Release notes must say so.
- Android CI produces a debug APK for verification only. It is deliberately excluded
  from the application release workflow until protected release signing and artifact
  verification are implemented.
- macOS packaging/notarization is not automated and must not be listed as supported.

## Recovery

The application workflow publishes only after repository verification and both
platform builds succeed. Package workflows pack and inspect the selected package
before publishing. If npm publication succeeds but GitHub Release creation fails,
rerun only the failed job or create the matching immutable GitHub Release from the
workflow tarball and checksum; never republish the same npm version with different
contents.
