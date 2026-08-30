# Nearby Transfer

<p align="center">
  <img src="android-app/src/main/res/drawable/app_icon.png" alt="Nearby Transfer icon" width="128" height="128">
</p>

<p align="center">
  <strong>Direct, encrypted file transfer on your local network · 局域网加密文件直传</strong>
</p>

[![Stars](https://img.shields.io/github/stars/luo-5/nearby-transfer?style=flat-square)](https://github.com/luo-5/nearby-transfer/stargazers)
[![License](https://img.shields.io/github/license/luo-5/nearby-transfer?style=flat-square)](LICENSE)
[![npm packages](https://img.shields.io/badge/npm-3%20public%20packages-CB3837?style=flat-square&logo=npm&logoColor=white)](#npm-packages--npm-包)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Android](https://img.shields.io/badge/Android-8%2B-3DDC84?style=flat-square&logo=android&logoColor=white)](https://developer.android.com/)

**English** · Nearby Transfer is an open-source local-network file-transfer project. The current desktop path discovers nearby devices over UDP multicast, sends file contents directly over TCP without a relay or cloud service, encrypts the file stream, signs transfer requests, and asks the receiver to approve each incoming transfer. The repository also contains an HTTPS/WebDAV shared-folder mode, an Android client, protocol-v2 libraries, a CLI, and a LocalSend adapter.

**中文** · Nearby Transfer 是一个开源的局域网文件传输项目。当前桌面端通过 UDP 组播发现附近设备，文件内容经 TCP 在设备间直传，不使用中继或云服务；文件流会被加密，传输请求会被签名，每次接收均需由接收方确认。仓库还包含 HTTPS/WebDAV 共享目录、Android 客户端、协议 v2 库、命令行工具和 LocalSend 适配器。

[Download desktop v1.3.0 · 下载桌面版](https://github.com/luo-5/nearby-transfer/releases/tag/v1.3.0) ·
[Capability matrix · 能力矩阵](docs/capabilities.md) ·
[Build guide · 构建指南](docs/build.md) ·
[Security · 安全说明](SECURITY.md) ·
[Contributing · 参与贡献](CONTRIBUTING.md)

> [!IMPORTANT]
> The normal desktop send/receive flow currently uses the direct-transfer implementation in `src/core/`. Although the UI and registries list seven protocol names, changing that selector does not route the normal desktop transfer through seven production-ready implementations. Protocol-v2 integration and the alternate driver adapters remain under active development. See the [capability matrix](docs/capabilities.md) before relying on a specific path.
>
> 当前桌面端的常规收发流程实际使用 `src/core/` 中的直传实现。虽然界面和注册表列出了七种协议，但切换选项并不代表常规桌面传输已经拥有七套可用于生产的实现。协议 v2 集成和其他驱动适配器仍在开发中；依赖某条具体路径前，请先查看[能力矩阵](docs/capabilities.md)。

## Current maturity · 当前成熟度

| Surface · 功能面 | Status · 状态 | Current boundary · 当前边界 |
| --- | --- | --- |
| Desktop direct transfer · 桌面直传 | Available · 可用 | Direct LAN transfer with encrypted file contents, signed requests, integrity checks, and receiver confirmation. This is the current user-facing desktop data path. · 支持文件内容加密、请求签名、完整性校验和接收方确认，是当前桌面端实际使用的数据通路。 |
| HTTPS/WebDAV shared folder · HTTPS/WebDAV 共享目录 | Experimental · 实验性 | A separate self-signed HTTPS and Bearer-token service. Its trust model differs from direct transfer; use it only on a trusted LAN and do not expose it to the public internet. · 独立的自签名 HTTPS 与 Bearer Token 服务，其信任模型不同于直传；仅应在可信局域网使用，勿直接暴露到公网。 |
| Android client · Android 客户端 | Developer preview · 开发者预览 | Buildable for Android 8.0 / API 26 and later. The desktop `v1.3.0` release does not include an Android asset, and interoperability must be evaluated per path. · 可面向 Android 8.0 / API 26 及以上版本构建；桌面版 `v1.3.0` 未附带 Android 安装包，互操作性需按具体路径评估。 |
| `@luo-5/core` | Pre-1.0 preview · 1.0 前预览 | Protocol-v2 identity, discovery, pairing, crypto, and transfer primitives with focused tests. They are not the default desktop data path. · 提供协议 v2 的身份、发现、配对、加密和传输基础能力及专项测试，但尚非桌面端默认数据通路。 |
| `@luo-5/cli` | Developer preview · 开发者预览 | The current `sync` command recursively hashes and sends every file. Incremental planning, conflict policy, and persisted resume are not wired into that command. · 当前 `sync` 命令会递归计算哈希并发送全部文件，尚未接入增量规划、冲突策略和持久化恢复流程。 |
| LocalSend adapter · LocalSend 适配器 | Developer preview · 开发者预览 | Independently versioned interoperability package; review its own tests and security boundary before integration. · 独立版本化的互操作包；集成前请审查其测试和安全边界。 |
| Alternate protocol drivers · 其他协议驱动 | Experimental · 实验性 | The selector and seven-driver registry are scaffolding. Do not treat Turbo, QUIC, SMB, WebDAV-driver, classic-driver, or FTPS entries as six additional complete desktop transfer paths. · 选择器和七驱动注册表目前属于开发脚手架；请勿将 Turbo、QUIC、SMB、WebDAV 驱动、classic 驱动或 FTPS 条目视作六套额外的完整桌面传输实现。 |

The default branch can move ahead of published artifacts. Source-level fixes and hardening must not be attributed retroactively to older release assets.

默认分支可能领先于已发布文件。源码中的后续修复和安全加固不应被追溯描述为旧版本发布物已经具备的能力。

## Highlights · 主要特点

- **Local-first direct transfer · 本地优先直传** — no relay account or cloud upload is required for the desktop direct-transfer path. · 桌面直传路径无需中继账号或云端上传。
- **Encrypted file contents · 文件内容加密** — the current desktop path derives a per-transfer key, encrypts the stream, and verifies the final size and SHA-256 digest. · 当前桌面端为每次传输派生密钥、加密文件流，并校验最终大小与 SHA-256 摘要。
- **Receiver control · 接收方控制** — every incoming desktop transfer requires explicit approval and is written through a temporary file before publication. · 每次桌面端接收均需明确确认，文件会先写入临时文件再发布到目标位置。
- **Shared-folder mode · 共享目录模式** — the repository includes a separate HTTPS/WebDAV service for browsing and managing selected folders on a LAN. · 仓库包含独立的 HTTPS/WebDAV 服务，可在局域网内浏览和管理所选目录。
- **Reusable protocol work · 可复用协议组件** — protocol-v2 specifications, deterministic vectors, TypeScript primitives, a CLI, and an interoperability adapter are developed in the same repository. · 同一仓库中维护协议 v2 规范、确定性测试向量、TypeScript 基础库、CLI 和互操作适配器。

## Download · 下载

The repository publishes the desktop application and npm packages on separate version lines. The GitHub “latest release” may therefore point to an npm package. Use the dedicated desktop release link below.

仓库中的桌面应用与 npm 包采用独立版本线，因此 GitHub 的“最新发布”可能指向某个 npm 包。下载桌面应用请使用下方专用链接。

**Desktop application · 桌面应用:** [Nearby Transfer v1.3.0](https://github.com/luo-5/nearby-transfer/releases/tag/v1.3.0)

| Platform · 平台 | Published v1.3.0 assets · 已发布文件 |
| --- | --- |
| Windows x64 | [`nearby-transfer-1.3.0-win-x64.exe`](https://github.com/luo-5/nearby-transfer/releases/download/v1.3.0/nearby-transfer-1.3.0-win-x64.exe) |
| Linux x64 | [`tar.gz`](https://github.com/luo-5/nearby-transfer/releases/download/v1.3.0/nearby-transfer-1.3.0-linux-x64.tar.gz) · [`zip`](https://github.com/luo-5/nearby-transfer/releases/download/v1.3.0/nearby-transfer-1.3.0-linux-x64.zip) |
| Android | Build the debug APK from source; no Android asset is attached to `v1.3.0`. · 请从源码构建调试 APK；`v1.3.0` 未附带 Android 文件。 |

Public builds may be unsigned. Check the publisher and file origin before bypassing operating-system warnings. Android debug APKs are for local testing, not production distribution.

公开构建可能没有代码签名。绕过操作系统警告前，请确认发布者和文件来源。Android 调试 APK 仅供本地测试，不应用作正式分发版本。

## Run from source · 从源码运行

Requires [Node.js 24 or later](https://nodejs.org/).

需要 [Node.js 24 或更高版本](https://nodejs.org/)。

```bash
git clone https://github.com/luo-5/nearby-transfer.git
cd nearby-transfer
npm ci
npm start
```

The devices must be on the same LAN. Firewalls need to allow UDP port `47777` for discovery and the dynamic TCP transfer port announced by the receiving device.

设备必须位于同一局域网。防火墙需要允许用于发现的 UDP `47777` 端口，以及由接收设备公布的动态 TCP 传输端口。

## Verify and build · 验证与构建

```bash
npm run check
npm test
```

Build desktop artifacts on the matching host platform:

请在对应的宿主平台上构建桌面产物：

```bash
npm run dist:windows   # Windows x64: zip + portable executable
npm run dist:linux     # Linux x64: tar.gz + zip
```

Desktop output is written to `../nearby-transfer-dist/`. The current default scripts do not build ARM64, DEB, RPM, or a Windows NSIS target.

桌面产物写入 `../nearby-transfer-dist/`。当前默认脚本不会生成 ARM64、DEB、RPM 或 Windows NSIS 目标。

For Android, install Java 17 and Android SDK Platform 35, then run:

Android 构建需要 Java 17 和 Android SDK Platform 35：

```powershell
# Windows
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug
```

```bash
# Linux or macOS
./gradlew :android-app:testDebugUnitTest :android-app:assembleDebug
```

See the [build guide](docs/build.md) and [Android notes](docs/android.md) for details.

更多说明见[构建指南](docs/build.md)和 [Android 说明](docs/android.md)。

## npm Packages · npm 包

These public packages are independently versioned, pre-1.0 developer previews. Review the [capability matrix](docs/capabilities.md), package source, and tests before using them in security-sensitive software.

这些公开包独立版本化，目前仍是 1.0 前的开发者预览版。用于安全敏感的软件前，请审查[能力矩阵](docs/capabilities.md)、对应源码和测试。

| Package | npm status | Purpose · 用途 | Install | Source |
| --- | --- | --- | --- | --- |
| [`@luo-5/core`](https://www.npmjs.com/package/@luo-5/core) | [![npm version](https://img.shields.io/npm/v/%40luo-5%2Fcore?label=latest&logo=npm)](https://www.npmjs.com/package/@luo-5/core) | Electron/DOM-independent protocol-v2 primitives for identity, discovery, pairing, crypto, and transfer · 不依赖 Electron/DOM 的协议 v2 身份、发现、配对、加密和传输基础库 | `npm install @luo-5/core` | [`packages/core`](packages/core) |
| [`@luo-5/cli`](https://www.npmjs.com/package/@luo-5/cli) | [![npm version](https://img.shields.io/npm/v/%40luo-5%2Fcli?label=latest&logo=npm)](https://www.npmjs.com/package/@luo-5/cli) | Developer-preview commands for discovery, pairing, file transfer, and recursive directory transfer · 用于发现、配对、文件传输和递归目录传输的开发者预览命令行工具 | `npm install -g @luo-5/cli` | [`packages/cli`](packages/cli) |
| [`@luo-5/localsend-adapter`](https://www.npmjs.com/package/@luo-5/localsend-adapter) | [![npm version](https://img.shields.io/npm/v/%40luo-5%2Flocalsend-adapter?label=latest&logo=npm)](https://www.npmjs.com/package/@luo-5/localsend-adapter) | Developer-preview LocalSend interoperability adapter for LAN file exchange · 用于局域网文件交换的开发者预览 LocalSend 互操作适配器 | `npm install @luo-5/localsend-adapter` | [`packages/localsend-adapter`](packages/localsend-adapter) |

## Security and limitations · 安全与限制

- Direct-transfer **file contents** are encrypted. UDP discovery traffic and transfer metadata such as device and file information remain visible on the LAN. · 直传模式下的**文件内容**会被加密；UDP 发现流量以及设备、文件等传输元数据仍对局域网可见。
- A valid signature proves that a request matches the public key carried by that request; the current direct-transfer path does not by itself establish the protocol-v2 SAS trust relationship. Receiver confirmation remains important. · 有效签名只能证明请求与其携带的公钥匹配；当前直传路径本身并不会建立协议 v2 的 SAS 信任关系，因此接收方确认仍然十分重要。
- The WebDAV service uses a self-signed TLS certificate and a separate authorization model. Verify the certificate or pin it in the client, and never expose the service directly to the public internet. · WebDAV 服务使用自签名 TLS 证书和独立授权模型。请在客户端验证或固定证书，且不要将服务直接暴露到公网。
- Protocol-v2 transfer components default to `256 KiB` plaintext chunks and enforce a `1 MiB` maximum; resume and concurrency guarantees vary by client and integration path. · 协议 v2 传输组件默认使用 `256 KiB` 明文分块，并限制最大为 `1 MiB`；断点恢复和并发保证会因客户端及集成路径而异。
- No independent security audit is documented. Treat pre-1.0 packages and experimental drivers accordingly. · 仓库尚无公开的独立安全审计报告；使用 1.0 前 npm 包和实验性驱动时应据此评估风险。

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting and [`docs/security.md`](docs/security.md) for the protocol-v2 threat model. The threat-model document describes the v2 design; it is not a blanket guarantee for every client or transfer path.

漏洞报告流程见 [`SECURITY.md`](SECURITY.md)，协议 v2 威胁模型见 [`docs/security.md`](docs/security.md)。威胁模型文档描述的是 v2 设计，并不等同于对每个客户端或传输路径的统一保证。

## Protocol documentation · 协议文档

- [Protocol-v2 specification](docs/protocol/v2-spec.md)
- [Protocol-v2 source of truth](packages/protocol-spec/v2-spec.md)
- [Deterministic test vectors](packages/core/test/vectors/)

Passing focused tests is evidence for the exercised code paths, not a security certification or proof that every UI-visible driver is implemented.

专项测试通过只能说明被执行路径的行为，不代表安全认证，也不能证明界面中出现的每个驱动都已实现。

## Contributing · 参与贡献

Bug reports, focused pull requests, protocol review, interoperability testing, and documentation improvements are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md), review the [`CHANGELOG.md`](CHANGELOG.md), or open an [issue](https://github.com/luo-5/nearby-transfer/issues).

欢迎提交错误报告、范围明确的拉取请求、协议审查、互操作测试和文档改进。请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)、查看 [`CHANGELOG.md`](CHANGELOG.md)，或提交 [Issue](https://github.com/luo-5/nearby-transfer/issues)。

Security vulnerabilities should follow the private-reporting process in [`SECURITY.md`](SECURITY.md), not be disclosed in a detailed public issue.

安全漏洞请按照 [`SECURITY.md`](SECURITY.md) 中的私下报告流程处理，不要在公开 Issue 中披露详细利用信息。

## License · 许可证

Nearby Transfer is available under the [MIT License](LICENSE).

Nearby Transfer 使用 [MIT 许可证](LICENSE)。
