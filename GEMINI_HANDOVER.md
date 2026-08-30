# Nearby Transfer — Gemini 接手文档

> 交接日期：2026-08-30（Asia/Shanghai）
> 文档状态：本轮工作的权威交接记录
> 项目目录：`D:\github项目\pr\pr\nearby-transfer-next-version`
> 远程仓库：`https://github.com/luo-5/nearby-transfer.git`

## 0. 先读这一节

这是一个**尚未提交的大型工作树**。接手后不要执行会丢失本地修改的命令，
尤其不要执行 `git reset --hard`、`git checkout -- .`、`git clean -fd`，也不要
先切换分支或覆盖文件。

本轮最后阶段因为 OpenAI 侧多次误判相关请求，工作已主动停止。接手范围应限定为：

- 本地代码审查、修复、构建、测试与文档整理；
- 不连接当前已关机的 Ubuntu 虚拟机；
- 不修改宿主机 VPN、网卡、路由、DNS、代理、防火墙、端口转发、电源或登录状态；
- 不做局域网探测、外部主机探测或任何与本项目收尾无关的网络操作；
- 未经用户再次确认，不推送 GitHub、不更新 PR、不发布 npm、不创建 Release/tag。

不要把聊天中出现过的虚拟机密码、地址或账户信息写入代码、测试、日志、提交或文档。

## 1. 当前 Git 状态

```text
branch: fix/codex-oss-readiness-baseline
HEAD:   1167ef1 ci(release): publish npm packages with OIDC
PR:     既有 PR #21（本地本轮修改尚未推送）
status: 111 modified + 83 deleted + 13 untracked = 207 entries
diff:   194 tracked files, about +5784 / -9473 lines
```

重要结论：

1. 本轮修改全部仍在工作树中，没有为这些修改创建新提交。
2. 没有把本轮修改推到 PR #21。
3. 不要另开重复 PR；若以后决定继续，应先确认 PR #21 的远端状态。
4. `git diff --check` 当前通过；输出里的 CRLF/LF 信息是换行规范化提示，不是
   whitespace error。

建议接手后的第一个只读检查：

```powershell
Set-Location -LiteralPath 'D:\github项目\pr\pr\nearby-transfer-next-version'
git status --short
git branch --show-current
git rev-parse --short HEAD
git diff --check
```

## 2. 当前版本号

```text
nearby-transfer                   1.3.1
@luo-5/core                       0.2.2
@luo-5/cli                        0.2.2
@luo-5/localsend-adapter          0.1.2
```

本轮此前已经处理过 npm 发布。不要仅因本地版本号存在就再次发布；如果用户以后授权
继续发布，先只读核对 registry 现状与 tag，再决定动作，避免覆盖或重复发布。

本地最终 pack 产物曾放在：

```text
<本轮 Codex 工作目录>\work\packs-final
```

这些 tarball 不在仓库内，不应提交。

## 3. 必须优先阅读的文件

按以下顺序阅读，旧报告只作历史参考：

1. `AGENTS.md` — 仓库级开发、验证、恢复与提交约束。
2. `docs/capabilities.md` — 当前实际能力的公开事实来源。
3. `docs/releasing.md` — npm、应用与容器发布规则。
4. `CHANGELOG.md` — 本轮 Unreleased 变化。
5. `docs/internal/publication-recovery-design.md` — **仅为设计，尚未实现**。
6. `AGENT_HANDOVER.md`、`docs/internal/HANDOFF.md` — 历史文档，不能用其中的旧
   测试数量或“全部完成”表述替代当前事实。

## 4. 本轮已经完成的主要修改

### 4.1 Core、CLI 与传输生命周期

- 修复 Core receiver bootstrap 的取消、超时、listener 和 socket 所有权清理。
- 调整 stream session，使失败完成态在资源清理结束后才对外结算。
- 修复 scheduler、job store、LAN service 的 start/stop/restart、并发调用和失败重试。
- CLI receive/send/sync 增加一致的退出处理、活动连接跟踪和清理等待。
- CLI send/sync 在发现身份与持久信任记录不一致时 fail closed。
- 新增 `packages/cli/src/transfer-context.ts`，统一传输上下文与信任查找。

重点文件：

```text
packages/core/src/transfer/receiver.ts
packages/core/src/transfer/stream-session.ts
packages/core/src/transfer/scheduler.ts
packages/core/src/transfer/job-store.ts
packages/core/src/transport/lan-service.ts
packages/cli/src/commands/receive.ts
packages/cli/src/commands/send.ts
packages/cli/src/commands/sync.ts
packages/cli/src/transfer-context.ts
```

### 4.2 Core 接收文件发布

- 顶层普通文件只允许通过同文件系统 hard link 发布；不支持时失败关闭，不再把
  staging 内容直接复制进可见最终路径。
- 发布后重新核验文件身份、大小与摘要。
- 清理失败不再把已完成发布错误地报告为传输失败。
- cancel 与 publish 交错增加了确定性回归测试。

重点文件：

```text
packages/core/src/transfer/encrypted-writer.ts
packages/core/test/encrypted-writer-publication.test.ts
packages/core/README.md
```

### 4.3 LocalSend adapter

- sender 成功条件同时等待请求体上传和响应完成，提前响应不会再虚报成功。
- receiver 增加 session permit、全局/per-IP 上限、请求超时、start/stop 屏障和
  临时文件清理。
- discovery 修复 stop-before-bind 后 timer 复活的问题。
- WebDAV client 增加响应大小限制、超时、TLS pin 检查与源流生命周期处理。

重点文件：

```text
packages/localsend-adapter/src/sender.ts
packages/localsend-adapter/src/receiver.ts
packages/localsend-adapter/src/discovery.ts
packages/localsend-adapter/src/webdav/webdav-client.ts
packages/localsend-adapter/test/localsend.test.ts
packages/localsend-adapter/test/webdav-client.test.ts
```

### 4.4 Classic desktop、发现与关闭流程

- Classic desktop 与 Android discovery announcement 改为签名版本，加入新鲜度、
  身份与公钥绑定检查；旧的 unsigned announcement 会被拒绝。
- Classic sender/receiver 关闭时会等待活动请求、流和临时文件处理完成。
- Desktop LAN service 修复监听失败后的重试和并发生命周期。
- Electron incoming dialog timer 正常清除。

签名 discovery 是兼容性变化：两端应一起升级。Classic transfer request 的主体格式
没有随之改成 v2 data plane。

### 4.5 Desktop HTTPS shared-library / WebDAV

- GET 流错误通过受控 pipeline 结算，避免主进程出现未处理流错误。
- PUT/COPY 使用操作自有 staging 目录；最终文件使用 no-overwrite hard link 发布。
- hard link 不可用时失败关闭，不再退回到直接写最终路径。
- MOVE 使用操作自有 tombstone/recovery 路径；异常时保留完整来源、目标或恢复材料，
  不盲目删除最终文件。
- 目录 COPY/MOVE 当前明确返回 `409`；这里只支持普通文件，文档已同步。
- malformed `Destination` percent encoding 返回 `400`。
- SSE 与 stop/close 生命周期合并并增加有界清理。

重点文件：

```text
src/v2/desktop-library-service.js
test/desktop-library-service-smoke.js
docs/interop/webdav-interop.md
```

### 4.6 Android

- Android discovery 同步签名格式与生命周期测试。
- 非 ASCII 项目路径下的 Gradle 输出根做了兼容处理。
- release build 不再错误复用 debug signing。
- ABI 文档改为实际状态：当前没有 ABI restriction。

本轮没有使用虚拟机。Android 验证只在本机使用离线 Gradle 缓存完成。

### 4.7 发布流程

- npm 包使用独立 namespaced tag 与全局串行组。
- 发布依赖包前，检查 registry 中已发布的 core 版本满足依赖范围。
- stable tag 必须是该命名空间中的最高 stable 版本，且 registry 版本不能倒退。
- npm provenance、包内容、license、checksum 与 tarball 检查已加入流程。
- GitHub Release 先创建 draft，比较已有资产；不同内容或额外资产会拒绝，只有缺失
  资产允许上传，最终集合完全匹配后才发布 draft。
- 应用 checksum 使用 release-assets 内的裸文件名生成。
- Docker 版本发布同样串行，并在构建前重新 fetch/tag 校验。

重点文件：

```text
.github/workflows/release.yml
.github/workflows/release-app.yml
.github/workflows/docker.yml
docs/releasing.md
scripts/verify-packed-package.js
```

### 4.8 能力声明、UI 与仓库清理

- UI 和文档区分：当前可用 classic 路径、实验性 v2 组件、roadmap-only protocol
  entries，以及独立的 HTTPS shared-library 认证模型。
- 不再因存在七项协议 registry 就宣称七条 data path 都已交付。
- 历史审查文档加入“非当前事实来源”提示。
- 删除 `scripts/dev/` 下 78 个机器专用、发布或跨机器操作脚本，目录仅保留说明文件。
- 删除不适合作为默认本地套件的跨机器/VM 测试和旧 `publish.sh`。
- 新增 `.gitattributes` 与通用 `run_tests.ps1`。

这些删除是本轮有意的仓库卫生变更，不要在没有逐项判断的情况下恢复。

## 5. 当前未跟踪文件

以下文件是本轮有意新增，提交时不要漏掉：

```text
.gitattributes
GEMINI_HANDOVER.md
docs/internal/README.md
docs/internal/publication-recovery-design.md
packages/cli/src/transfer-context.ts
packages/core/test/encrypted-writer-publication.test.ts
packages/core/test/job-store-composition.test.ts
packages/core/test/lan-service-lifecycle.test.ts
packages/core/test/receiver-lifecycle.test.ts
packages/core/test/scheduler-lifecycle.test.ts
packages/localsend-adapter/test/webdav-client.test.ts
scripts/dev/README.md
scripts/verify-packed-package.js
```

中断前曾短暂生成过 `packages/core/test/publication-retry-receiver.test.ts`，但它引用
尚未实现的 API，已在收尾时删除。当前也不存在
`packages/core/src/transfer/publication-journal.ts`。如果看到这两个文件重新出现，先确认
它们是否是完整实现，不能直接加入提交。

## 6. 已完成的验证

### 6.1 Node / desktop

曾完整通过：

```text
npm run ci:verify
```

当时结果包括：

```text
Core tests:       142 / 142
CLI tests:         25 / 25
LocalSend tests:   34 / 34
Root desktop/WebDAV integration suites: passed
TypeScript typecheck and JS syntax checks: passed
```

注意时间边界：完整 `ci:verify` 在最后两项 publication 收尾调整之前执行。最后两项调整
之后又分别执行并通过：

```text
npm run test:core                     # 142 / 142
npm run typecheck --workspace @luo-5/core
node test/desktop-library-service-smoke.js
```

因此接手后的最终合并门禁仍应重新跑一次完整 `npm run ci:verify`。

### 6.2 Android（本机离线）

执行并通过：

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --offline --no-daemon
```

结果：48 Gradle tasks，`BUILD SUCCESSFUL`。此前详细统计为 307 项，其中 301 passed、
6 skipped。最后一次运行多数 task 为 UP-TO-DATE，因此没有重新打印完整测试计数。

输出根曾位于：

```text
D:\.nearby-transfer-gradle\3a3ccad0
```

该构建产物不应提交。

### 6.3 Workflows、脚本与包内容

- 10 个 workflow YAML 使用本地解析器成功解析。
- 28 个 Bash `run:` block 通过 `bash -n`。
- 相关 `.sh` / Bash 脚本语法检查通过。
- 7 个 JSON 文件解析通过。
- 三个 npm workspace 的实际 tarball 均成功 pack 并人工核对内容：
  - core：9 files，包含 CJS / ESM / declarations；
  - CLI：5 files，bin 指向 `./dist/index.js`；
  - LocalSend adapter：9 files，包含 CJS / ESM / declarations。
- `git diff --check` 当前通过。
- 最后一次敏感本机标记扫描没有发现用户名、虚拟机地址、项目绝对路径、邮箱或密码
  被写入拟提交内容。

## 7. 仍未完成的关键事项

### 7.1 v2 多根发布的进程退出恢复

这是目前最重要、且**没有实现**的技术缺口。

现有 Core writer 能保证单个普通文件 root 使用 hard link no-overwrite 发布，并在进程
内处理失败；但一个 task 包含多个 top-level roots 时，进程可能在 roots 之间退出，
留下已验证的可见子集。当前没有 durable publication journal、startup recovery 和
committed receipt 去重机制。

详细方案已写入：

```text
docs/internal/publication-recovery-design.md
```

该文档只是设计，不是完成证据。不要把它写入公开能力表述为“已支持”。建议把完整
实现单独放入后续 PR，而不是在当前已经很大的工作树里临时拼接。实现至少需要：

- durable monotonic journal；
- intent → side effect → verified receipt 顺序；
- COMMITTED 后才清 staging；
- sender/receiver/task/manifest 绑定的长期 receipt，避免 ACK 前退出导致重复 `(1)`；
- CLI listener 启动前 recovery；
- 同 task retry 在 planner 前查 receipt；
- directory no-replace 的明确平台后端或诚实的逐项可见 fallback；
- 每个 crash window 的确定性测试。

### 7.2 产品能力边界

- desktop 默认数据路径仍是 `v1-classic`；v2 data plane 组件尚未连接成默认桌面收发。
- CLI pair 仍是 preview，并未完成双方持久化配对闭环。
- Android release signing 的公开可验证自动化尚未完成。
- Desktop shared-library 不是完整 RFC 4918 WebDAV server，也不是普通密码挂载服务。
- Directory COPY/MOVE 当前明确不支持。

这些边界已经写入 `docs/capabilities.md`，后续实现前不要放宽表述。

## 8. 建议的接手顺序

### 阶段 A：只读确认

1. 阅读第 3 节列出的文件。
2. 查看完整 `git status --short` 与 `git diff --stat`。
3. 确认没有未完成的 publication journal 源文件或引用不存在 API 的测试。
4. 按目录审查 diff，不要依赖历史交接文档里的旧统计。

### 阶段 B：本地验证

1. 运行 `npm run ci:verify`。
2. 若仍使用当前本机 Gradle 缓存，运行 Android 的 offline unit + assemble 命令。
3. 再运行 `git diff --check`。
4. 不把真实设备、局域网、外部服务或发布账户作为默认测试依赖。

### 阶段 C：整理提交

当前变更很大，建议仅用 `git add <明确路径>` 分批暂存，不使用 reset/clean。可按以下
逻辑提交拆分：

1. `fix(core): make transfer lifecycle and publication fail closed`
2. `fix(adapters): bound LocalSend and shared-library lifecycles`
3. `fix(app): align classic discovery and Android compatibility`
4. `ci(release): make package and app publication monotonic`
5. `docs: align public capability and release claims`
6. `chore(repo): remove machine-specific development helpers`

实际拆分前要查看文件间依赖；如果拆分后的中间提交无法构建，应合并相邻提交。

### 阶段 D：用户确认后再更新 PR

1. 输出提交列表、完整测试结果和剩余风险。
2. 让用户确认是否推送到现有 PR #21。
3. 只有确认后才 push；不要 force push。
4. 本轮不要顺带发布 npm、创建 tag 或 GitHub Release。

## 9. 明确禁止事项

- 不使用或唤醒当前已关机的 Ubuntu 虚拟机。
- 不修改 VPN、网卡、路由、DNS、代理、防火墙或端口转发。
- 不运行机器发现、端口探测或与本地代码验证无关的网络命令。
- 不在日志、文档、commit 或 PR 中加入账户凭据、虚拟机密码、私钥或本机身份信息。
- 不重置、清理、覆盖或自动格式化整个工作树。
- 不恢复已删除的机器专用脚本，除非逐文件确认它们确实属于公开产品。
- 不手改构建生成的 `src/vendor/luo5-core/index.cjs`；修改 Core 后运行
  `npm run build:vendor`。
- 不根据 registry、protocol selector、旧报告或测试文件的存在推断产品已交付。
- 不再次发布已经存在的 npm 版本。
- 不在用户确认前 push、merge、tag 或 release。

## 10. 推荐给 Gemini 的首条提示词

```text
请接手 D:\github项目\pr\pr\nearby-transfer-next-version。

先完整阅读仓库根目录 AGENTS.md 和 GEMINI_HANDOVER.md，再阅读
docs/capabilities.md、docs/releasing.md、CHANGELOG.md。当前分支是
fix/codex-oss-readiness-baseline，HEAD 为 1167ef1，工作树有 207 项尚未提交的
既有修改。严格保留这些修改，不要 reset、clean、checkout 覆盖或恢复已删除脚本。

本阶段只做本地代码审查、构建、测试和提交规划；不要连接虚拟机，不要修改 VPN、
网卡、路由、DNS、代理、防火墙或端口转发，不要做任何网络探测，也不要 push、发布
npm、创建 tag/Release。先按交接文档核对状态与未跟踪文件，然后运行本地门禁并报告
真实结果。特别注意 docs/internal/publication-recovery-design.md 只是未实现方案，不能
宣称 v2 多根 publication 已具备完整进程退出恢复。完成审查后给出分提交清单，等我
确认再更新现有 PR #21。
```

## 11. 最终交接结论

当前工作树包含大量已经实现并有本地验证覆盖的可靠性、兼容性、发布流程和文档修正，
但还不是一个可以直接声称“全部完成”的最终状态。最安全的接手策略是：先保存并审查
现有 diff，重新跑完整本地门禁，按依赖关系分批提交；把 durable multi-root
publication recovery 留作独立后续工作。未经用户确认，不进行任何远端写操作。
