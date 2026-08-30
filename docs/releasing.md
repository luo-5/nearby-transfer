# Release process

Nearby Transfer uses independent version lines and tag namespaces. A tag must match
the version in its target `package.json`; the workflow fails before publishing when
they differ.

| Target | Tag example | Workflow output |
| --- | --- | --- |
| Desktop application | `app-v1.3.1` | Verified Windows and Linux assets, SPDX SBOM, SHA-256 checksums, GitHub Release |
| `@luo-5/core` | `core-v0.2.2` | One npm package with provenance, tarball, checksum, package GitHub Release |
| `@luo-5/cli` and CLI container | `cli-v0.2.2` | One npm package with provenance plus GHCR multi-architecture container |
| `@luo-5/localsend-adapter` | `localsend-adapter-v0.1.2` | One npm package with provenance, tarball, checksum, package GitHub Release |

## Pre-release checklist

1. Update only the target version and its changelog/release notes.
2. Run `npm ci` followed by `npm run ci:verify` from a clean checkout.
3. For Android changes, run `./gradlew :android-app:testDebugUnitTest` and
   `./gradlew :android-app:assembleDebug` on Linux/macOS or the wrapper equivalents
   on Windows.
4. Confirm [`capabilities.md`](capabilities.md) matches the code paths being shipped.
5. Push the namespaced tag. Do not reuse or move a published tag.
6. Inspect the published release artifacts, SBOM, checksums, package contents,
   provenance, and signing status before announcing the release. Use a prerelease tag
   when the artifacts still need broader validation. GitHub releases are assembled as
   temporary drafts and published only after their exact asset set is verified.

Tags whose package version contains a SemVer prerelease suffix publish to npm's
`next` dist-tag, create a prerelease on GitHub, and never update the container
`latest` tag.

Publish `@luo-5/core` before the CLI or LocalSend adapter version that depends on
it. The dependent-package workflow checks that the declared core range is already
available from npm and refuses to publish otherwise. Stable package/container tags
must also be the highest stable tag in their namespace, preventing a historical tag
from moving `latest` backward.

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
platform builds succeed. Package workflows pack and inspect one tarball, upload it as
a workflow artifact, and publish that exact file. A rerun checks an existing npm
version's SHA-512 integrity: an identical package is skipped, while different bytes
fail closed. The GitHub Release is then created or updated from the same verified
tarball and checksum. Never reuse a version or tag for different contents.

Application and package release reruns download every existing asset, compare it with
the newly verified bytes, reject unexpected or changed assets, and only fill missing
ones. They never replace an existing asset. Checksum manifests contain bare filenames
so they can be verified directly in a download directory.
Container version tags are immutable and a rerun fails if that version already exists.
The moving `latest` tag is updated only by a new stable CLI version.
