# Nearby Transfer v1.2.1 release notes

Accuracy correction: 2026-08-29

The v1.2.1 release added a seven-entry protocol registry and selector UI. Those entries
were roadmap adapters, not seven complete and interchangeable production transfer
implementations. The classic path remained the working desktop transfer data path.

## Published assets

The public v1.2.1 GitHub Release contains:

- `nearby-transfer-1.2.1-android.apk`
- `nearby-transfer-1.2.1-linux-x64.tar.gz`
- `nearby-transfer-1.2.1-linux-x64.zip`
- `nearby-transfer-1.2.1-win-x64.exe`
- `nearby-transfer-1.2.1-win-x64.zip`

Release page: <https://github.com/luo-5/nearby-transfer/releases/tag/v1.2.1>

The public workflow does not prove that the Android APK was release-signed or that the
Windows executable was code-signed. No macOS, ARM64 desktop, deb, rpm, AppImage, AAB,
SBOM, or detached-signature asset is attached.

## Source highlights

- Protocol registry, category filters, selector cards, and configuration persistence.
- Android transfer-control and persisted-job UI foundations.
- Additional registry and selector smoke tests.

The original draft's QUIC loss-rate, Turbo throughput, SMB/FTPS client compatibility,
and “200%+” performance statements were not backed by shipped end-to-end drivers and
have been removed. Current selectable-driver status is maintained in
[`docs/capabilities.md`](docs/capabilities.md).
