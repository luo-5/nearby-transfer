# Nearby Transfer v1.2.0 Release Notes

Welcome to **Nearby Transfer v1.2.0**! This major release brings full bilingual (English & Simplified Chinese) internationalization across Desktop and Android, comprehensive security hardening for LAN WebDAV & P2P transfers, enhanced transfer controls (bidirectional pause, resume, cancel), robust subfolder navigation on mobile, and superior multi-round stress resilience.

---

## 🌟 Highlights / 核心亮点

### 🌐 1. Full-Platform Bilingual Localization (全平台中英双语国际化)
- **Desktop (桌面端)**: Integrated sleek language toggle `[ 中文 | English ]` with complete DOM & dynamic string i18n engine. Native dialogs (`dialog.showMessageBox`, `dialog.showOpenDialog`) and batch transfer notifications automatically adapt to the user's selected language.
- **Android (安卓端)**: Added full string resources in `values/strings.xml` and `values-zh-rCN/strings.xml`. Foreground notifications, channel details, and Storage Access Framework (SAF) Document Provider titles dynamically render according to system locale.

### 🛡️ 2. Deep Security Hardening & Isolation (深度安全加固)
- **WebDAV Digital Signature Auth**: Added cryptographic proof-of-possession verification (Ed25519) to `/api/session` to prevent unauthorized device ID spoofing on shared local networks.
- **Scoped SSL/TLS on Android**: Refactored `WebDavClient` to isolate self-signed TLS socket factory and hostname verifier per connection instance, protecting the global JVM network security policy.
- **Windows Reserved Names & Symlink Safety**: Protected against Windows reserved filenames (`CON`, `PRN`, `AUX`, `NUL`, etc.) and eliminated infinite recursion on cyclic symlinks during folder drag-and-drop.

### ⚡ 3. Advanced Transfer Controls & History (传输控制与体验增强)
- **Bidirectional Controls**: Both sender and receiver can now seamlessly **Pause**, **Resume**, or **Cancel** streaming transfers at any point.
- **Quick File Access**: One-click "Open Folder" action on completed transfers in the desktop client to instantly locate received items.
- **History Management**: Added batch clear functionality for transfer records.

### 📱 4. Android Navigation & Background Service (安卓层级导航与前台保活)
- **Subfolder Breadcrumb Navigation**: Seamless dual-mode directory browsing (custom UI + SAF DocumentsProvider) with Android hardware back-button gesture support.
- **Foreground Transfer Service**: Android Foreground Service with persistent notifications prevents system task killing during large file background transfers.

---

## 📦 Multi-Platform Release Assets / 各平台安装包

| Platform | Architecture / Format | Package Name |
| :--- | :--- | :--- |
| **Android** | APK (ARM64 / ARMv7 / x86_64) | `nearby-transfer-1.2.0-android.apk` |
| **Windows** | x64 (NSIS Installer) | `nearby-transfer-1.2.0-win-x64.exe` |
| **Windows** | ARM64 (NSIS Installer) | `nearby-transfer-1.2.0-win-arm64.exe` |
| **Linux** | x64 (Debian / Ubuntu `.deb`) | `nearby-transfer-1.2.0-linux-amd64.deb` |
| **Linux** | x64 (RHEL / Fedora `.rpm`) | `nearby-transfer-1.2.0-linux-x86_64.rpm` |
| **Linux** | ARM64 (Debian / Ubuntu `.deb`) | `nearby-transfer-1.2.0-linux-arm64.deb` |
| **Linux** | ARM64 (RHEL / Fedora `.rpm`) | `nearby-transfer-1.2.0-linux-aarch64.rpm` |

---

## 🧪 Testing & Verification (自动化测试与验证)
- **37 Automated Desktop Test Suites**: 100% passed (including 5 rounds of deep batch drag-drop stress tests and 5 rounds of concurrent HTTPS WebDAV penetration/stress tests).
- **Android Unit Tests & Compilation**: 100% passed (`testDebugUnitTest` & `assembleDebug` clean builds).
