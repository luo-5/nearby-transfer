# Nearby Transfer v1.3.0 Release Notes

**Release Date:** August 29, 2026  
**Version:** `v1.3.0`  
**License:** MIT  
**Status:** Industrial Grade Production Release 🚀

---

## 🌟 What's New in v1.3.0

Nearby Transfer `v1.3.0` is a major milestone release delivering **full cross-platform ecosystem interoperability**, **RFC 4918 WebDAV streaming**, **LocalSend v2 protocol adaptation**, **7-engine transport abstraction**, and **native release packages across Windows, Linux, and Android**.

### 1. 🌐 Complete WebDAV & Client Interoperability
- **RFC 4918 WebDAV Full Specification Compliance**:
  - Native support for `OPTIONS`, `PROPFIND` (Depth: 0/1/infinity with XML response formatting), `GET`, `PUT`, `MKCOL`, `MOVE`, and `DELETE`.
  - Full Unicode and Chinese filename encoding support in XML hrefs and filesystem paths.
- **HTTP 206 Partial Content & Range Requests**:
  - Implemented `Range: bytes=start-end` request parsing and `206 Partial Content` responses with `Content-Range` and `Accept-Ranges: bytes`.
  - Enables smooth video/audio seeking and resumable media streaming directly from browsers and media players (e.g. VLC, Infuse, Kodi).
- **rclone Deep Stress Interoperability**:
  - Validated with `rclone copy`, `sync`, and `check` across 10 concurrent streams, nested directory trees, and large binary payloads with 100% bit-for-bit SHA-256 parity.

### 2. ⚡ Modern Web Browser Portal
- **Zero-Install Web Portal**:
  - Instant access from any browser on iOS, macOS, Windows, Linux, or Android without installing extra software.
  - RESTful share management and directory tree browsing APIs.
  - Drag-and-drop file and folder uploading with chunked streaming.
  - Real-time Server-Sent Events (SSE) for instant filesystem synchronization notifications.

### 3. 🚀 High-Performance Crypto & Transfer Core
- **AES-256-GCM + AAD Throughput**:
  - **769.14 MB/s** decryption throughput and **712.88 MB/s** encryption throughput on 1MB chunk streams.
- **Canonical JSON Serialization**:
  - Microsecond-level serialization at **596,700 ops/sec** for control messages.
- **Local TCP Loopback Transfer Speed**:
  - **217.63 MB/s** (1.74 Gbps wire speed) under full session cryptographic encapsulation.

### 4. 📦 Multi-Platform Native Release Packages
- **Windows**:
  - NSIS installer: `nearby-transfer-1.3.0-win-x64.exe` (99.6 MB)
  - Portable archive: `nearby-transfer-1.3.0-win-x64.zip` (2.0 MB)
- **Linux**:
  - Debian/Ubuntu: `nearby-transfer-1.3.0-linux-amd64.deb` (96 MB) — *Verified via `dpkg -i` on Ubuntu 24.04*
  - RedHat/CentOS/Fedora: `nearby-transfer-1.3.0-linux-x86_64.rpm` (85 MB) — *Verified via `rpm -Uvh` on CentOS 7/9*
  - Universal AppImage: `nearby-transfer-1.3.0-linux-x86_64.AppImage` (122 MB)
  - Tarball: `nearby-transfer-1.3.0-linux-x64.tar.gz` (116 MB)
  - ZIP: `nearby-transfer-1.3.0-linux-x64.zip` (116 MB)
- **Android**:
  - Signed Release APK: `nearby-transfer-1.3.0-android.apk` (10.0 MB) with ProGuard/R8 code shrinking and Android 14+ compatibility.

---

## 🔒 Cryptographic Checksums (SHA-256)

| Artifact Name | Platform | SHA-256 Checksum |
| :--- | :--- | :--- |
| `nearby-transfer-1.3.0-win-x64.exe` | Windows x64 (Installer) | `eab11b50c9825097e1b6586c038b1a559590f20a6653f8ba4176922410625e46` |
| `nearby-transfer-1.3.0-win-x64.zip` | Windows x64 (Portable) | `bfab9cbbf4b6897c3f95ffc45524e36fda1e752e0cca3fccc94cdb37d037d581` |
| `nearby-transfer-1.3.0-linux-amd64.deb` | Linux (Debian/Ubuntu) | `0a43038d2d8e0eddccf944e001165c32ade9e360c7d4acd4da927196996c0aaf` |
| `nearby-transfer-1.3.0-linux-x86_64.rpm` | Linux (CentOS/RHEL/Fedora) | `b9d8a16563697a825b04b22187e3217d79f1c4b7742a059dc327c7a306b1a171` |
| `nearby-transfer-1.3.0-linux-x86_64.AppImage` | Linux (Universal) | `979693f13ef6bae807d861ba50e45eee9b4baafd6949b17644381a3c484e78ee` |
| `nearby-transfer-1.3.0-linux-x64.tar.gz` | Linux x64 (Tarball) | `1ddfbf7a62524ab758b42423882ba1cee0051f4cbcef9993b7ffe269d9080095` |
| `nearby-transfer-1.3.0-linux-x64.zip` | Linux x64 (ZIP) | `d321fc5652d28badd473d5b9bfd9c051ab3f19d136009b9800621f4c05189b99` |
| `nearby-transfer-1.3.0-android.apk` | Android 8.0 - 15+ | `807b803e5aebdffc3bfde289b65b39d6e2226db594a144ab05b9c58518321196` |

---

## 🧪 Verification & Test Suite Summary

- **Total Test Cases Passed**: **256 / 256 (100% Green)**
- **Monorepo Packages**:
  - `@luo-5/core`: 124 unit, property, and invariant tests
  - `@luo-5/cli`: 21 CLI command tests
  - `@luo-5/localsend-adapter`: 11 protocol adapter tests
- **Desktop Smoke Suites**: 41 test suites covering pairing, streaming, session crypto, chunking, and storage
- **Ecosystem & Interop**:
  - `webdav-interop-smoke.js`: 39 assertions
  - `browser-portal-e2e.js`: 17 assertions
  - `rclone` RFC 4918 real-world sync: 34 files, 10 parallel streams, 0 differences
- **Multi-VM Chaos Matrix**: 53 matrix cases across Ubuntu (`.128`), CentOS (`.130`), Windows VM (`.129`)
- **Real Physical Hardware**: Tested against Redmi K50 (HyperOS / Android 14) and Samsung Galaxy S10+ (Android 12)
