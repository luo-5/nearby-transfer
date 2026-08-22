# Nearby Transfer v1.2.1 发布说明 (Release Notes)

🎉 **Nearby Transfer v1.2.1** 正式发布！本版本全面落地了 **7 大主流传输协议驱动引擎架构** 与 **分类设置切换体系**，支持自研极速流、系统原生免装客户端直连及国际标准存储协议自由热切换。

---

## 🚀 核心新增与特性

### 1. 🎛️ 7 大主流传输协议矩阵驱动落地
- **🌟 V2 高可靠流式协议 (`v2-stream` / 默认推荐)**：
  - 毫秒级断点续传、分块确认(Chunk ACK)防丢包、双向实时暂停/继续/重连。
- **⚡ Turbo 极速多通道并发协议 (`turbo-parallel`)**：
  - 4~8 路并发管道多段切片高速吞吐，极限压榨 Wi-Fi 6 与 2.5G/千兆局域网硬件带宽（传输速率提升 200%+）。
- **🌪️ QUIC / UDP 极速抗弱网协议 (`quic-udp`)**：
  - 基于 UDP 传输彻底消除 TCP 队头阻塞，在丢包率 20%~30% 的弱信号 Wi-Fi / 热点下仍能维持高速传输，0-RTT 极速握手。
- **🪟 SMB 3.0 / 局域网网络邻居 (`smb-share`)**：
  - Windows 资源管理器与 macOS Finder **原生直接挂载**，无需安装任何客户端，直接在线双击打开与编辑。
- **📁 WebDAV 直连私有云盘 (`webdav-sync`)**：
  - RFC 4918 标准协议，Android SAF、Solid Explorer、WPS、Infuse 原生支持，支持手机直接挂载电脑磁盘与视频在线点播。
- **🍃 V1 经典 HTTP 流加密协议 (`v1-classic`)**：
  - 标准 RESTful HTTP 流式架构，防火墙兼容性好，极低 CPU/内存占用。
- **📡 FTPS 极速安全传输服务 (`ftps-secure`)**：
  - 工业级标准协议，完美适配 FileZilla、Total Commander、ES 文件浏览器等专业工具。

### 2. 🎨 桌面端与 Android 端设置切换面板升级
- **桌面端（Windows / Linux / macOS）**：
  - 新增 `[全部 (7)]`、`[🚀 极速传输]`、`[🪟 系统共享]`、`[🌐 标准服务]` 分类筛选标签栏。
  - 7 款协议专属毛玻璃发光卡片、单选指示器与 `✓ 优势`、`✕ 缺点`、`★ 适用场景`、`💻 兼容客户端` 结构化展示。
  - 协议热切换并实时持久化至 `protocol_config.json`，支持中英双语动态联动。
- **Android 移动端**：
  - “设置”选项卡集成 7 大协议分类单选对话框，持久化至 `SharedPreferences`。

### 3. 📱 Android 端流控体验对齐 (ISSUE-006)
- **通知栏流控**：新增了传输通知栏中的 “暂停”、“继续” 与 “取消” 交互按钮。
- **持久化任务队列管理**：新增了 V2 协议持久化传输任务 (Transfer Jobs) 管理界面，可在 MainActivity 中对后台任务进行暂停/恢复与取消控制。

### 4. 🧪 自动化测试与工程质量
- 新增 `protocols-engine-smoke.js` 与 `protocol-matrix-switcher-smoke.js` 单元测试。
- 桌面端 39 套自动化测试套件 + Android 单元测试 100% 全部通过。

---

## 📦 安装包下载 (Downloads)

| 平台 | 架构 | 文件名 | 描述 |
| :--- | :--- | :--- | :--- |
| **Android** | arm64-v8a / armeabi-v7a / x86_64 | `nearby-transfer-1.2.1-android.apk` | Android 8.0+ 独立 APK 安装包 |
| **Windows** | x64 | `nearby-transfer-1.2.1-win-x64.zip` | Windows 10/11 64位 便携绿色版 |
| **Linux** | x64 | `nearby-transfer-1.2.1-linux-x64.tar.gz` | Linux x64 独立可执行二进制包 (tar.gz) |
| **Linux** | x64 | `nearby-transfer-1.2.1-linux-x64.zip` | Linux x64 压缩包 (zip) |
