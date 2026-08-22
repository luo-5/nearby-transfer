# Nearby Transfer 跨设备开发交接索引 (v1.2.1 Handoff)

> **致接棒开发的新 Agent / 工程师**：
> 欢迎继续参与 **Nearby Transfer** 的开发！本项目是一个基于 Node.js / Electron（桌面端）与 Kotlin/Java（Android 移动端）的高性能局域网加密文件传输与 NAS 共享应用。
> 
> 当前代码库版本已正式发布 **v1.2.1**。请在开始工作前阅读本交接指南。

---

## 📌 核心仓库信息与 Git 规范

* **GitHub 仓库**：`https://github.com/luo-5/nearby-transfer.git`
* **活跃工作分支**：`next/1.0`
* **最新发布 Tag**：`v1.2.1`（已在 GitHub Releases 发布全平台安装包）
* **强制 Git 提交身份**：
  ```bash
  git config user.name "luo-5"
  git config user.email "lluo77250@gmail.com"
  ```
* **版本号规范**：严禁随意跳跃大版本号（当前为 `1.2.1`，下一个补丁版本为 `1.2.2` 或次版本 `1.3.0`）。

---

## 🏗️ 项目架构与最新技术成果 (v1.2.1)

### 1. 🎛️ 7 大主流传输协议驱动引擎 (`src/protocols/`)
项目采用驱动式多协议调度引擎，支持在设置面板中分类热切换：
* **🚀 极速类**：
  * `turbo-parallel`：4~8 路多管道并发切片传输，榨干局域网带宽。
  * `quic-udp`：基于 UDP 的 0-RTT 握手传输，彻底消除 TCP 队头阻塞，抗弱网丢包。
* **🪟 系统共享类**：
  * `smb-share`：Windows 资源管理器 / macOS Finder 原生直连免装客户端。
  * `webdav-sync`：RFC 4918 标准 WebDAV NAS 私有云盘同步，支持目录递归与实时 SSE 事件通知。
* **🌐 标准与兼容类**：
  * `v2-stream`：推荐默认协议，毫秒级断点续传与 Chunk ACK。
  * `v1-classic`：经典轻量 HTTP 加密流。
  * `ftps-secure`：工业级 TLS 安全 FTP。

### 2. 🪓 零运行时外部依赖架构 (Zero-Dependency)
* `src/v2/cert-manager.js` 使用纯 Node.js `node:crypto` 原生 DER 编码动态生成 X.509 TLS 自签名证书。
* **整个项目运行时没有安装任何第三方 npm 包（`dependencies: {}`）**，请在后续迭代中继续坚守这一极简安全标准！

### 3. 📱 Android 端架构与流控 (ISSUE-006 已闭环)
* **通知栏流控**：`TransferForegroundService.java` 支持通知栏原生 “暂停”、“继续” 与 “取消” 广播拦截。
* **持久化任务池**：`MainActivity.java` 内置 Transfer Jobs 监控看板。
* **⚠️ 线程安全铁律（Gotcha）**：
  `V2TransferJobPersistence.kt` 中的所有 Room 数据库操作均显式包含 `check(Looper.getMainLooper().thread !== Thread.currentThread())`。**严禁在 UI 线程直接调用任何 `V2TransferJobPersistence` 方法**，必须通过后台 `executor.execute(...)` 调度！

---

## 💻 新电脑环境准备与快速启动

新电脑需配置以下基础运行环境：
1. **Node.js**：>= 20.0.0 (推荐 Node 24 LTS)
2. **Java / JDK**：Java 17 (推荐 Eclipse Adoptium / Temurin 17)
3. **Android SDK**：API Level 35 (Android 15), Build-Tools 35.0.0

### 快速初始化与全量验证：
```powershell
# 1. 切换到工作分支
git checkout next/1.0

# 2. 安装桌面端开发工具链
npm install

# 3. 运行全平台一键测试脚本 (同时测试 Desktop 39 项 Smoke Tests + Android 31 项 Gradle 测试)
powershell -ExecutionPolicy Bypass -File .\run_tests.ps1
```

---

## 📦 打包与分发命令

* **桌面端打包 (Windows & Linux)**：
  ```powershell
  npm run dist:desktop
  ```
  产物将输出在 `../nearby-transfer-dist/`：
  * `nearby-transfer-1.2.1-win-x64.exe` (NSIS 安装包)
  * `nearby-transfer-1.2.1-linux-x64.tar.gz` & `.zip`
* **Android APK 打包**：
  ```powershell
  .\gradlew.bat :android-app:assembleDebug
  ```
  产物位于 `android-app/build/outputs/apk/debug/`。

---

## 🧭 核心代码与文档索引

| 模块 | 核心代码路径 | 说明 |
| :--- | :--- | :--- |
| **协议驱动引擎** | [`src/protocols/`](src/protocols/) | 7 大传输驱动与调度中心 |
| **桌面 UI & IPC** | [`src/main.js`](src/main.js), [`src/renderer/`](src/renderer/) | Electron 主进程与毛玻璃界面 |
| **V2 核心流协议** | [`src/v2/`](src/v2/) | 配对、Manifest、加密分块、WebDAV 服务 |
| **Android 主界面** | [`android-app/src/main/java/.../MainActivity.java`](android-app/src/main/java/io/github/nearbytransfer/android/MainActivity.java) | 原生界面与传输流控 |
| **Android 前台服务**| [`android-app/src/main/java/.../TransferForegroundService.java`](android-app/src/main/java/io/github/nearbytransfer/android/service/TransferForegroundService.java) | 前台保活与通知栏 Action 交互 |
| **最新发布说明** | [`RELEASE_NOTES_v1.2.1.md`](RELEASE_NOTES_v1.2.1.md) | v1.2.1 完整发布日志 |
| **极简开发 Skill** | `~/.gemini/config/skills/ponytail/` | 全局 Ponytail / YAGNI 梯子技能 |

---

🎯 **给新 Agent 的提示**：
当前仓库状态非常健康（100% 测试通过、Zero-Dependency 纯净架构）。进行后续开发时，请继续保持代码克制（遵循 Ponytail 原则），修改前先跑 `run_tests.ps1`，确保新特性不对现有协议与 Android 端产生 Regression！
