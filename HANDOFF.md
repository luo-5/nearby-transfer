# Nearby Transfer development index

这是迁移到另一台电脑后应首先打开的索引。当前 v1.0 工作分支是
`next/1.0`，所有开发规范、文档和代码都在当前仓库目录内，不依赖原电脑的
绝对路径。

## 先读这几个文件

1. [`AGENTS.md`](AGENTS.md)：代码规范、安全边界、测试要求和提交规范。
2. [`docs/next-version-handoff.md`](docs/next-version-handoff.md)：v1.0 当前进度、
   未完成的运行时工作、迁移电脑和真实设备测试清单。
3. [`docs/ui-handoff.md`](docs/ui-handoff.md)：给 UI Agent 的专项交接，包含当前
   Android UI、固定日志窗口、响应式/无障碍要求和验收矩阵。
4. [`docs/v1-plan.md`](docs/v1-plan.md)：v1.0 大改的目标、里程碑和暂缓功能。

## 当前仓库状态

- 上游仓库：<https://github.com/luo-5/nearby-transfer>
- 当前分支：`next/1.0`
- Draft PR：<https://github.com/luo-5/nearby-transfer/pull/9>
- 查看最新提交：`git log -1 --oneline --decorate`
- 提交必须包含：`Co-authored-by: Codex <codex@openai.com>`

## UI 工作路径

- 生产 Android 入口：
  [`android-app/src/main/java/io/github/nearbytransfer/android/MainActivity.java`](android-app/src/main/java/io/github/nearbytransfer/android/MainActivity.java)
- Android Java UI 组件与运行时类：
  [`android-app/src/main/java/io/github/nearbytransfer/android/`](android-app/src/main/java/io/github/nearbytransfer/android/)
- Compose 迁移说明：
  [`docs/android-compose-migration.md`](docs/android-compose-migration.md)
- Compose debug 入口：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/migration/ComposeMigrationActivity.kt`](android-app/src/main/kotlin/io/github/nearbytransfer/android/migration/ComposeMigrationActivity.kt)
- Compose 当前预览壳：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/feature/home/NearbyTransferMigrationApp.kt`](android-app/src/main/kotlin/io/github/nearbytransfer/android/feature/home/NearbyTransferMigrationApp.kt)
- Compose UI 状态起点：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/feature/devices/DevicesUiState.kt`](android-app/src/main/kotlin/io/github/nearbytransfer/android/feature/devices/DevicesUiState.kt)
- Android 字符串资源：
  [`android-app/src/main/res/values/strings.xml`](android-app/src/main/res/values/strings.xml)、
  [`android-app/src/main/res/values-zh-rCN/strings.xml`](android-app/src/main/res/values-zh-rCN/strings.xml)

UI Agent 应先阅读 `docs/ui-handoff.md`，再修改 UI。不要为了让按钮看起来可用而
提前启用 v2 生产传输；当前接收运行时仍在集成中。

## Android v1.0 实现路径

- Room 数据库和实体：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/core/data/local/`](android-app/src/main/kotlin/io/github/nearbytransfer/android/core/data/local/)
- v2 数据仓库：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/core/data/`](android-app/src/main/kotlin/io/github/nearbytransfer/android/core/data/)
- 恢复与启动清理：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/core/recovery/`](android-app/src/main/kotlin/io/github/nearbytransfer/android/core/recovery/)
- 发布、MediaStore、SAF：
  [`android-app/src/main/kotlin/io/github/nearbytransfer/android/core/publication/`](android-app/src/main/kotlin/io/github/nearbytransfer/android/core/publication/)
- Android 单元测试：
  [`android-app/src/test/`](android-app/src/test/)
- Room 导出 schema：
  [`android-app/schemas/`](android-app/schemas/)
- Android 构建文档：
  [`docs/android.md`](docs/android.md)、[`docs/build.md`](docs/build.md)

下一批 Android 运行时优先查看主交接文档中的推荐拆分：接收运行时、Room
checkpoint facade、publication runtime、coordinator handoff，最后才接入
`V2PairingController` 和 `MainActivity`。

## Desktop 与协议路径

- 桌面主进程和 IPC：[`src/main.js`](src/main.js)、[`src/preload.js`](src/preload.js)
- 桌面 renderer UI：[`src/renderer/`](src/renderer/)
- 旧版核心传输：[`src/core/`](src/core/)
- v2 pairing/trust/persistence/transfer：[`src/v2/`](src/v2/)
- v2 协议说明：[`docs/protocol/v2.md`](docs/protocol/v2.md)
- 协议文档入口：[`docs/protocol.md`](docs/protocol.md)
- Node smoke tests：[`test/`](test/)
- 共享协议 fixtures：[`test/fixtures/`](test/fixtures/)

协议、加密、信任、checkpoint 或跨平台 wire behavior 的修改，不要放进纯 UI
提交；必须同步更新协议说明、双方实现和对应测试。

## 新电脑快速开始

在仓库根目录执行：

```powershell
git status
git switch next/1.0
npm ci
npm run check
npm test
```

Android 需要 Java 17、Android SDK platform 35 和 build tools 35.0.0：

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --no-daemon
```

不要迁移 `node_modules/`、`.gradle/`、`.kotlin/`、`android-app/build/`、`.tmp/`、
APK、安装包和机器专属截图；这些目录会在新电脑重新生成。

## 推荐提交顺序

1. UI 状态模型和布局收敛。
2. UI 资源化、无障碍和小屏/横屏适配。
3. 接收运行时与 checkpoint 持久化。
4. publication/recovery 集成。
5. Windows 与 Android 真实设备互操作测试。
6. 通过测试后再关闭 Draft PR 并准备版本发布。

每个批次保持小范围、可回滚，并在提交信息中保留 Codex trailer。
