# Nearby Transfer 全量项目交接文档 (Agent Handover)

> **文档性质**：面向下一位接手 AI Agent / 核心开发者的权威项目交接与开发指南。  
> **交接日期**：2026-08-29  
> **交接基线提交**：`5ec1d93` (`main`；后续工作请以实际 `git status` 为准)
> **远程仓库**：`https://github.com/luo-5/nearby-transfer.git`  
> **仓库状态**：交接时工作区干净。本地 Node 24、Python 与 Android JVM 测试曾通过；GitHub Actions 和发布资产必须查看当前公开运行结果，不得根据本文件声称“100% 全平台通过”。

功能和安全状态以 [`docs/capabilities.md`](docs/capabilities.md) 为准。桌面端
当前只允许 `v1-classic` 传输；其他驱动不得仅因存在注册表或测试而称为已交付。

---

## 📌 一、 项目全景与定位

Nearby Transfer 是一个跨平台、高性能、零第三方云依赖的局域网端到端加密文件传输与 NAS WebDAV 共享生态系统。

### 核心技术栈
- **桌面端**：Node.js 24+ / Electron 43 / TypeScript / Vanilla CSS + HTML / tsup
- **核心引擎 (`@luo-5/core`)**：纯 TypeScript 实现，**零运行时 npm 依赖**（完全基于 `node:` 原生模块），包含协议状态机、加解密、流调度、限流器与同步算法。
- **命令行工具 (`@luo-5/cli`)**：跨平台 CLI，支持终端一键收发、配对与增量同步。
- **协议兼容层 (`@luo-5/localsend-adapter`)**：兼容 LocalSend v2 协议，支持跨生态设备互联互通。
- **Android 端**：Android SDK 35, Java 17 / Kotlin 2.0 / Jetpack Compose (实验开关) / Gradle 8.11。
- **跨语言参考**：Python 3.11+ 参考实现（通过 10 组确定性测试向量验证）。

---

## 📁 二、 仓库目录架构总览

```text
nearby-transfer-next-version/
├── package.json                      # Monorepo 根配置 (npm workspaces, scripts)
├── package-lock.json                 # 锁定全 monorepo 依赖
├── AGENT_HANDOVER.md                 # 【本交接文档】
│
├── src/                              # 桌面端 (Electron) 源码
│   ├── main.js                       # Electron 主进程入口 (IPC, 窗口管理)
│   ├── preload.js                    # ContextBridge 安全上下文桥接
│   ├── renderer/                     # 渲染进程前端 UI (HTML, CSS, JS)
│   ├── v2/                           # 桌面端 v2 协议业务适配层 (Pairing, LAN, Library)
│   └── vendor/                       # 【核心内嵌】
│       └── luo5-core/index.cjs       # 由 scripts/build-vendor.js 生成的 @luo-5/core CJS 单文件
│
├── packages/                         # Monorepo 子包
│   ├── core/                         # @luo-5/core 源码 (TypeScript 纯引擎)
│   ├── cli/                          # @luo-5/cli 源码 (TypeScript 命令行工具)
│   ├── localsend-adapter/            # @luo-5/localsend-adapter 源码 (LocalSend 兼容层)
│   ├── protocol-spec/                # v2 协议规约文档与确定性 JSON 测试向量
│   └── python-ref/                   # Python 参考实现与 verify_vectors.py
│
├── android-app/                      # Android 客户端工程
│   ├── src/main/java/.../            # 核心业务 (CryptoUtil, WebDavClient, NearbyDocumentsProvider)
│   ├── src/main/res/                 # UI 资源与布局
│   └── src/test/java/.../            # 306 个 Android 单元测试
│
├── packaging/                        # Electron 打包配置 (Windows, Linux, macOS)
├── test/                             # 桌面端冒烟、压测与 WebDAV 互通性测试套件 (41 个测试)
├── benchmarks/                       # 性能基准测试脚本 (Crypto, TCP, 序列化)
├── scripts/
│   ├── build-vendor.js               # 关键构建脚本：编译 @luo-5/core 并内嵌到 src/vendor
│   └── dev/                          # 归档整理的 78 个开发/压测/混沌实验脚本
│
├── docs/                             # 项目公开与内部文档
│   ├── internal/                     # 内部开发笔记、任务清单与历史规划
│   └── *.md                          # 压测报告、发布说明、就绪报告
│
└── .github/workflows/                # GitHub Actions 自动化 CI/CD
    ├── ci.yml                        # 跨系统 (Ubuntu/Win/macOS) Node 24 + Python 向量门禁
    ├── check.yml                     # 语法与 AST 检查门禁
    ├── codeql.yml                    # CodeQL 安全扫描 (每周一)
    ├── build-windows.yml             # Windows 安装包自动构建
    ├── build-linux.yml               # Linux (deb/rpm/AppImage) 构建
    ├── build-android.yml             # Android APK 自动构建
    ├── release.yml                   # 命名空间 package tag：只发布对应 npm 包
    ├── release-app.yml               # app-v* tag：验证后聚合 Windows/Linux Release
    └── docker.yml                    # CLI Docker 镜像自动构建发布至 ghcr.io
```

---

## ⚙️ 三、 核心架构机制与重要约定（接手必读）

### 1. Electron Vendoring 机制 (P0-3)
- **背景**：Electron Builder 在打包 `app.asar` 时不会自动打包来自 npm workspace symlink 的本地包（会导致生产环境运行时报 `MODULE_NOT_FOUND`）。
- **解决方案**：
  - 根目录脚本 `scripts/build-vendor.js` 使用 `tsup` 将 `@luo-5/core` 编译为 CommonJS 单文件，输出到 `src/vendor/luo5-core/index.cjs`。
  - `src/v2/` 目录下的桌面业务层全部通过 `require('../vendor/luo5-core/index.cjs')` 引入核心功能。
  - `package.json` 中的 `prestart`、`predist:windows`、`predist:linux`、`pretest` 均已绑定 `build:vendor`。
- **规则**：**只要修改了 `packages/core/` 的代码，运行桌面端前必须执行 `npm run build:vendor`**。

### 2. 签名认证握手协议 (P0-1 / T3)
- **端点**：WebDAV/API Session 申请端点 `/api/session`。
- **Payload 格式**：
  ```json
  {
    "deviceId": "<hex>",
    "timestamp": 1724900000000,
    "nonce": "<16-byte-hex>",
    "signature": "<base64-ed25519-signature>"
  }
  ```
- **签名源串**：`"nearby-transfer:library-auth:" + deviceId + ":" + timestamp + ":" + nonce`
- **防重放**：服务端校验时间戳差值（±60s）以及 Nonce 滑动窗口唯一性，未通过一律返回 401。

### 3. Android 证书固定与 TOFU 机制 (P0-2 / T4)
- **机制**：Android 端通过 `WebDavPinStore` 维护 `host:port -> cert_fingerprint` 映射（保存在 `webdav-pins.properties`）。
- **策略**：首次连接记录服务端自签名证书 SHA-256 指纹（TOFU）；后续连接指纹不匹配时**强制抛出 `CertificateException` 终止连接 (Fail-Closed)**，绝不降级。

### 4. 权限收敛策略 (P1-1 / P1-2)
- **配对默认值**：新配对的设备初始权限位掩码强制为 `0`（无读/写/删/同步权），必须在桌面端 UI 手动提权。
- **共享库策略**：默认共享目录策略为只读 (`readOnly: true`)。
- **撤销设备保护**：已被撤销的 Peer ID 再次发起配对请求时直接被拦截，必须先在已配对列表显式移除/解绑。

### 5. Android 运行时与 JVM 单元测试 BouncyCastle 初始化
- 在 `CryptoUtil.java` 中包含静态初始化块：
  ```java
  static {
      if (Security.getProvider("BC") == null) {
          Security.addProvider(new BouncyCastleProvider());
      }
  }
  ```
  保证无论是运行在 Android 真机系统还是在 JVM 宿主跑 Gradle 单元测试（`testDebugUnitTest`），显式请求 `"BC"` 提供者时均能准确识别。

---

## 🛠️ 四、 常用开发与验证命令速查表

| 操作需求 | 执行命令 | 说明 |
| :--- | :--- | :--- |
| **安装依赖** | `npm ci` | 干净安装根目录及 5 个 workspace 包依赖 |
| **编译核心库** | `npm run build:core` | 使用 tsup 编译 `@luo-5/core` (ESM/CJS/DTS) |
| **内嵌核心产物** | `npm run build:vendor` | 编译并输出到 `src/vendor/luo5-core/index.cjs` |
| **类型检查** | `npm run typecheck` | 执行 `@luo-5/core` 严格 TypeScript 类型检查 |
| **AST 语法检查** | `npm run lint` 或 `npm run check` | 对全部桌面与测试 JS 脚本进行 Node 语法检查 |
| **运行核心库测试** | `npm run test:core` | 执行 Core 124 个单元/属性/模糊测试 |
| **运行 CLI 测试** | `npm run test:cli` | 执行 CLI 命令、信任边界与同步测试 |
| **运行 LocalSend 测试**| `npm run test:localsend` | 执行适配层互通、路径与资源边界测试 |
| **运行统一 CI 门禁** | `npm run ci:verify` | 构建、三包类型检查/测试、JS 语法与桌面集成测试 |
| **运行桌面端冒烟套件** | `npm test` | 执行 41 个冒烟套件（包含 39 个 WebDAV RFC 4918 互通用例） |
| **马拉松浸泡压测** | `npm run test:soak` | 20 轮深度内存泄漏与大数据量吞吐压测 |
| **Python 跨语言验证**| `python packages/python-ref/verify_vectors.py` | 验证 10 组跨语言确定性测试向量 |
| **Android 单元测试** | `.\gradlew.bat :android-app:testDebugUnitTest` | 执行 Android 306 个单元与状态机测试 |
| **Android APK 构建** | `.\gradlew.bat :android-app:assembleDebug :android-app:assembleRelease` | 生成 Debug 和 Release 两种 APK 产物 |
| **Windows 桌面打包** | `npm run dist:windows` | 生成 Windows `.exe` 安装包、便携版和 `.zip` |
| **Linux 桌面打包** | `npm run dist:linux` | 生成 `.tar.gz` 和 `.zip` (需 Linux/WSL 环境) |

---

## 🚀 五、 后续演进建议与待办路线图 (Roadmap for Next Agent)

1. **Android 端 Compose UI 迁移 (Phase 1)**
   - 目前 Android 端主启动器为稳健的 Java MVP，`ENABLE_COMPOSE_SHELL` 开关已预留在 `build.gradle` (Debug 开启，Release 关闭)。
   - 后续可逐步将 Compose 现代化 UI 完善为默认启动界面。
2. **广域网 / 穿透传输能力 (Phase 2)**
   - 当前以局域网 Multicast + TCP 为主，后续可探索 WebRTC DataChannel 或 Relay 服务器中继支持。
3. **LocalSend 多设备批量群发优化 (Phase 3)**
   - 增强 `@luo-5/localsend-adapter` 的多目标广播与并发排队能力。
4. **版本发布与 Tag 触发 (Phase 4)**
   - 应用与 npm 包使用独立版本和命名空间 tag；禁止继续使用一个 `v*` tag
     同时发布全部内容。具体 tag、验证、签名边界和恢复流程见
     [`docs/releasing.md`](docs/releasing.md)。

---

## ⚠️ 六、 踩坑警示与关键禁忌 (Gotchas & Caveats)

1. ❌ **切勿提交任何敏感信息**：包括但不限于 `.env`、API Key、本地私钥或硬编码测试 IP。
2. ❌ **切勿手改 `src/vendor/luo5-core/index.cjs`**：该文件是构建生成产物，修改源码请在 `packages/core/src/` 中进行，然后执行 `npm run build:vendor`。
3. ❌ **GitHub Actions Action 版本保持 `@v4`**：不要随意将 official action 升级到不存在的标签（如 `@v7`）。
4. ✅ **提交遵循 Conventional Commits**：格式如 `feat(core): ...`、`fix(android): ...`、`chore: ...`。
