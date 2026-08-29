# Nearby Transfer v1.3.0 release notes

GitHub Release published: 2026-08-23

Accuracy correction: 2026-08-29

License: MIT

This file records the assets and capability boundary that can be verified from the
public v1.3.0 release. An earlier draft described planned packages and test results as
if they were all shipped; those unsupported claims have been removed.

## Published assets

The public GitHub release contains exactly these three assets:

| Asset | Status |
| --- | --- |
| `nearby-transfer-1.3.0-win-x64.exe` | Windows x64 executable; unsigned |
| `nearby-transfer-1.3.0-linux-x64.tar.gz` | Linux x64 archive |
| `nearby-transfer-1.3.0-linux-x64.zip` | Linux x64 archive |

No Android APK, Debian package, RPM, AppImage, Windows zip, macOS package, AAB, SBOM,
or detached signature is attached to v1.3.0. Their presence in repository build plans
must not be interpreted as a published release asset.

The release page is the authoritative download location:
<https://github.com/luo-5/nearby-transfer/releases/tag/v1.3.0>

## Included functionality

- Electron desktop application for direct LAN transfer using the current
  `v1-classic` data path.
- HTTPS WebDAV shared-library service with OPTIONS, PROPFIND, GET, PUT, MKCOL,
  MOVE, DELETE, and byte-range behavior exercised by repository smoke tests.
- Protocol-v2 core, pairing, transfer, persistence, and recovery components under
  active integration.
- Experimental protocol registry entries that are visible for roadmap context but
  are not selectable transfer implementations.

See [`docs/capabilities.md`](docs/capabilities.md) for the current status of desktop,
Android, CLI, npm packages, WebDAV, LocalSend, and each protocol driver.

## Security and signing notes

- Windows v1.3.0 is not code-signed and is intended for testing/evaluation.
- Linux archives do not carry a platform package-manager signature.
- There is no public release-signing workflow for Android in v1.3.0.
- Checksums should be generated and attached by the release workflow for future
  releases. This corrected note does not reproduce unverified checksum claims from
  the earlier draft.

## Verification interpretation

The repository contains package tests, desktop smoke/integration suites, Python
cross-language vectors, and Android JVM tests. Passing those tests supports the code
paths they exercise; it is not a statement of industrial-grade readiness, complete
RFC certification, formal security verification, or universal cross-platform
interoperability.
