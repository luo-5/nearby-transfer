# Nearby Transfer v1.2.0 release notes

Accuracy correction: 2026-08-29

This corrected record distinguishes shipped assets from planned package formats and
test claims in the original draft.

## Published assets

The public v1.2.0 GitHub Release contains:

- `nearby-transfer-1.2.0-android.apk`
- `nearby-transfer-1.2.0-linux-x64.tar.gz`
- `nearby-transfer-1.2.0-linux-x64.zip`
- `nearby-transfer-1.2.0-win-x64.zip`

It does not contain the Windows NSIS/ARM64, deb, rpm, Linux ARM64, AppImage, or AAB
assets listed in the earlier draft. The Android asset's signing identity and build
type are not established by the public release workflow, so it must not be described
as a verified production-signed APK.

Release page: <https://github.com/luo-5/nearby-transfer/releases/tag/v1.2.0>

## Source highlights

- English and Simplified Chinese desktop/Android resources.
- WebDAV session authentication and Android connection-scoped TLS changes.
- Windows reserved-name and folder traversal handling.
- Transfer pause/resume/cancel UI and history controls.
- Android navigation and foreground-transfer service work.

These bullets describe source changes, not a certification that every path or client
combination was independently interoperable. Current behavior and limitations are in
[`docs/capabilities.md`](docs/capabilities.md).

## Verification interpretation

Repository tests executed selected desktop, WebDAV, and Android paths. Phrases such as
“100% secure,” “fully compliant,” or “all platforms supported” are not implied by a
passing test run. Future releases attach checksums/SBOM and state signing status in the
release asset manifest.
