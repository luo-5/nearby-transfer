# Nearby Transfer — 详细后续计划

> 制定日期：2026-08-30（Asia/Shanghai）
> 配套交接：`GEMINI_HANDOVER.md`
> 项目目录：`D:\github项目\pr\pr\nearby-transfer-next-version`
> 当前分支：`fix/codex-oss-readiness-baseline`
> 当前基线：`1167ef1`
> 文档性质：执行计划，不代表计划中的功能已经完成

## 0. 执行原则

后续工作分为两个明确边界：

1. **当前 PR 收尾**：保存、审查、验证、分批提交现有工作树，更新既有 PR #21。
2. **后续独立功能**：持久化多根 publication recovery。它不应临时塞入当前已经很大的
   工作树，建议作为单独 PR 实施。

整个过程遵守以下规则：

- 先保护现有 200 多项工作树变化，再做任何整理。
- 只运行本地、确定性、与项目直接相关的构建和测试。
- 当前 Ubuntu 虚拟机已关机，不连接、不启动、不依赖它。
- 不修改 VPN、网卡、路由、DNS、代理、防火墙、端口转发或系统电源状态。
- 不把真实设备、局域网或外部服务变成默认验证条件。
- 未经用户明确确认，不 push、不更新 PR、不创建 tag/Release、不发布 npm。
- 不使用 `git reset --hard`、`git checkout -- .`、`git clean -fd` 或其他会丢失
  现有工作的命令。
- 不根据旧报告、注册表条目或测试文件的存在扩大产品能力声明。

## 1. 总体目标和优先级

### P0：保护与确认现有成果

- 确认当前分支、HEAD、工作树和未跟踪文件完整。
- 确认没有中断时留下的引用不存在 API 的半成品。
- 重新执行当前 PR 的完整本地门禁。

### P1：把当前工作树整理成可审查提交

- 按功能依赖拆成 5～7 个 Conventional Commits。
- 每个提交不遗漏测试、文档和 package metadata。
- 每次提交后保持工作树中剩余修改可解释，不覆盖用户已有内容。

### P2：更新既有 PR #21

- 在用户确认后推送当前分支。
- PR 描述如实列出行为变化、测试结果、兼容性变化和已知缺口。
- 等待公开 CI 结果后再决定是否合并。

### P3：独立实现 durable publication recovery

- 以 `docs/internal/publication-recovery-design.md` 为设计起点。
- 单独分支、单独 PR、单独状态迁移和故障点测试矩阵。
- 完成前继续保持公开能力声明为“未完整实现”。

## 2. 阶段 0：接手预检与工作树保护

### 2.1 只读确认

执行：

```powershell
Set-Location -LiteralPath 'D:\github项目\pr\pr\nearby-transfer-next-version'
git branch --show-current
git rev-parse --short HEAD
git status --short
git diff --stat
git diff --check
```

预期基线：

```text
branch: fix/codex-oss-readiness-baseline
HEAD:   1167ef1
```

写入本计划后，工作树预计为：

```text
111 modified + 83 deleted + 14 untracked = 208 entries
```

若计数不同，先查明是用户新改了文件、工具生成了产物，还是已有修改丢失。不要直接
恢复或删除差异。

### 2.2 确认重要新增文件

必须存在：

```text
.gitattributes
GEMINI_HANDOVER.md
GEMINI_NEXT_STEPS.md
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

必须确认**当前不存在**：

```text
packages/core/src/transfer/publication-journal.ts
packages/core/test/publication-retry-receiver.test.ts
```

这两个文件在上轮收尾时没有形成完整实现；后者曾短暂生成后已删除。不要把旧缓存或
未完成草稿误加到提交中。

### 2.3 检查生成物和本机信息

使用 `git status --short` 与仓库已有忽略规则确认以下内容没有进入拟提交列表：

- `node_modules/`、`dist/`、`src/vendor/` 构建输出；
- `.gradle/`、APK、安装包、tarball、日志与临时目录；
- IDE 配置、SDK 本地路径、用户目录；
- 密码、token、私钥、测试机地址和账户信息。

如发现未知文件，先记录来源和用途；只有确定是生成物时才移出仓库范围。

### 阶段 0 完成标准

- 分支和 HEAD 与交接一致，或差异已解释。
- 现有修改没有被覆盖。
- 新增文件清单完整。
- 没有半成品 API、凭据或生成产物准备进入提交。
- `git diff --check` 没有真正的 whitespace error。

## 3. 阶段 1：按模块审查现有 diff

目标不是重新设计全部代码，而是确认本轮实际修改完整、测试与文档匹配。

### 3.1 Core transfer 与生命周期

审查范围：

```text
packages/core/src/transfer/encrypted-writer.ts
packages/core/src/transfer/executor.ts
packages/core/src/transfer/job-store.ts
packages/core/src/transfer/receiver.ts
packages/core/src/transfer/scheduler.ts
packages/core/src/transfer/stream-session.ts
packages/core/src/transport/lan-service.ts
packages/core/src/discovery/index.ts
packages/core/src/index.ts
packages/core/test/*.test.ts（本轮新增和修改部分）
```

检查清单：

- `done` 或 terminal promise 是否只在资源静止后结算。
- cancel/timeout/stop 是否幂等，并等待已有操作退出。
- start → failure → retry 和 start/stop/start 是否能恢复。
- listener、timer、stream、socket、密钥副本与 staging 的所有权是否唯一明确。
- fail-closed publication 是否保留唯一 durable staging。
- hard-link 不可用时是否不会把数据直接复制到最终可见路径。
- cleanup failure 是否只标记 cleanup pending，不否定已完成 publication。
- 新增 public export 是否进入 ESM、CJS 和 declaration 构建。

暂时不要尝试在这里补 durable multi-root journal；它属于阶段 8 的独立功能。

### 3.2 CLI

审查范围：

```text
packages/cli/src/commands/devices.ts
packages/cli/src/commands/pair.ts
packages/cli/src/commands/receive.ts
packages/cli/src/commands/send.ts
packages/cli/src/commands/sync.ts
packages/cli/src/device.ts
packages/cli/src/transfer-context.ts
packages/cli/test/cli.test.ts
packages/cli/test/transfer-integration.test.ts
```

检查清单：

- SIGINT/SIGTERM 是否只启动一次 shutdown，并最终自然返回。
- server listen error 是否会 reject，而不是永久等待。
- active receiver/socket 是否在 shutdown 中清空。
- send/sync 是否重新读取最新 trust record，并绑定 discovery signing key。
- pair preview 是否仍明确是 preview，不能输出“配对完成”。
- `--data-dir`、receive directory 和环境默认路径是否跨平台一致。

### 3.3 LocalSend adapter

审查范围：

```text
packages/localsend-adapter/src/discovery.ts
packages/localsend-adapter/src/receiver.ts
packages/localsend-adapter/src/sender.ts
packages/localsend-adapter/src/webdav/webdav-client.ts
packages/localsend-adapter/test/localsend.test.ts
packages/localsend-adapter/test/webdav-client.test.ts
```

检查清单：

- sender 的成功是否同时依赖 request body 与 response 完成。
- 提前响应、超时、abort、非 2xx 是否销毁并等待源流。
- prepare approval 并发是否先占用 permit，所有失败路径是否释放。
- stop 返回后是否可能再创建 session、timer 或 scratch directory。
- request body、response body、连接数、session 数与临时总量是否有明确上限。
- discovery stop-before-bind 是否不会在 stop 后启动 timer。
- WebDAV client TLS identity/pin 与响应上限是否 fail closed。

### 3.4 Desktop classic 与 shared-library

审查范围：

```text
src/core/crypto.js
src/core/discovery.js
src/core/server.js
src/core/transfer.js
src/main.js
src/v2/desktop-library-api.js
src/v2/desktop-library-service.js
src/v2/lan-service.js
test/desktop-library-api-smoke.js
test/desktop-library-service-smoke.js
test/discovery-smoke.js
test/local-transfer-smoke.js
test/transfer-stream-session-smoke.js
test/webdav-interop-smoke.js
```

检查清单：

- classic discovery 的签名字段与验证输入是否与 Android 完全一致。
- stop/close 是否等待 active uploads、pending approval、SSE 与 socket。
- 旧 pending token/key 是否在 stop 后清除。
- GET stat/open race 的 stream error 是否被 pipeline 捕获。
- PUT/COPY/MOVE 是否始终先写操作自有 staging。
- 所有最终 publication 是否 no-overwrite；hard link 不支持时应明确失败。
- MOVE 异常是否保留至少一个完整来源或恢复材料。
- directory COPY/MOVE 是否稳定返回 `409`，测试和文档一致。
- malformed Destination 是否返回 `400`。

### 3.5 Android

审查范围：

```text
android-app/build.gradle
android-app/src/main/java/io/github/nearbytransfer/android/DeviceConfig.java
android-app/src/main/java/io/github/nearbytransfer/android/DiscoveryAnnouncement.java
android-app/src/main/java/io/github/nearbytransfer/android/JsonUtil.java
android-app/src/test/java/io/github/nearbytransfer/android/DiscoveryAnnouncementTest.java
android-app/src/test/java/io/github/nearbytransfer/android/DiscoveryServiceLifecycleTest.java
build.gradle
gradle.properties
```

检查清单：

- signed discovery canonicalization 与 desktop 完全一致。
- timestamp/freshness、deviceId、公钥和 signature 验证顺序一致。
- release variant 没有使用 debug signing。
- 非 ASCII 项目路径 workaround 只改变构建输出位置，不改变应用逻辑。
- Gradle 变更没有写入本机 SDK 绝对路径。

### 3.6 Workflows、package metadata 与文档

审查范围：

```text
.github/workflows/*.yml（本轮六个修改文件）
package.json
package-lock.json
packages/*/package.json
scripts/verify-packed-package.js
docs/releasing.md
docs/capabilities.md
CHANGELOG.md
README.md
```

检查清单：

- npm tag namespace、版本解析与 stable 最高版本校验一致。
- dependent package 在 publish 前验证已发布 core 满足声明 range。
- workflow concurrency group 不会让相互依赖的 npm 发布交错。
- GitHub Release asset 比对不会覆盖不同内容，也不会忽略额外资产。
- draft release 只有在完整资产集合验证后才 publish。
- checksum 文件内使用裸资产名。
- package `files`、exports、bin、license、repository metadata 与 tarball 一致。
- README/能力矩阵只描述真实用户路径，不把 registry 或 roadmap 当成已交付。

### 阶段 1 完成标准

- 每个改动模块都有“实现 + 测试 + 文档”对应关系。
- 没有明显的悬空 import、重复实现或未使用 API。
- 所有兼容性变化都有明确说明。
- 未发现必须在提交前修复的阻断问题，或阻断问题已形成最小修复清单。

## 4. 阶段 2：完整本地验证

### 4.1 工具链预检

```powershell
node --version
npm --version
java -version
.\gradlew.bat --version
```

预期：

- Node.js 24 或更新；
- Java 17；
- 使用仓库 Gradle Wrapper；
- 不依赖系统全局 Gradle。

如果依赖已经安装，不要为了“更干净”主动运行需要下载依赖的命令。只有确实缺少依赖，
并得到用户许可后，才重新安装。

### 4.2 Node、TypeScript 与 desktop 全量门禁

```powershell
npm run ci:verify
```

该命令应覆盖：

- Core、CLI、LocalSend 构建；
- 三个 workspace 类型检查；
- JS syntax check；
- 三个 workspace 测试；
- desktop smoke/integration 套件；
- vendored Core 生成与 desktop 使用路径。

若失败：

1. 记录第一个失败命令和完整错误摘要。
2. 单独重跑最小相关 suite 确认可复现。
3. 只修改负责该失败的文件。
4. 先通过 focused test，再重新执行完整 `npm run ci:verify`。
5. 不通过放宽 assertion、跳过测试或删除覆盖来制造通过。

### 4.3 Android 离线验证

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --offline --no-daemon
```

若离线缓存不完整，记录“缺少缓存，未运行”，不要自动连接外部源。等用户明确允许后再
决定是否补依赖。

### 4.4 Pack 内容验证

在本地临时目录运行三个 workspace 的 pack/dry-run，并确认：

- tarball 不包含源码外的本机文件、日志、缓存或凭据；
- `main`、`module`、`types`、`exports` 和 CLI `bin` 都指向包内真实文件；
- core、CLI、adapter 的依赖范围与发布顺序匹配；
- `scripts/verify-packed-package.js` 能在没有网络的情况下验证实际内容。

不要执行 `npm publish`。

### 4.5 Workflow 与格式验证

- 使用已安装的本地 YAML parser 解析全部 workflows。
- 对 workflow 中所有 Bash `run:` block 执行语法检查。
- 解析修改过的 JSON 文件。
- 执行 `git diff --check`。
- 再次确认没有仓库内 `.tgz`、APK、installer 或临时测试目录。

### 阶段 2 完成标准

- `npm run ci:verify` 全绿。
- Android offline unit + debug assemble 全绿，或有明确的环境原因记录。
- pack 内容与 metadata 一致。
- workflows、shell blocks、JSON 和 diff whitespace 检查通过。
- 没有生成物或本机信息进入工作树。

## 5. 阶段 3：仅处理验证发现的阻断问题

本阶段不是再次进行无限扩展的深审。只处理满足下列任一条件的问题：

- 当前测试失败；
- 编译或类型检查失败；
- 明确存在数据覆盖、资源未释放、版本发布倒退或文档虚假声明；
- 新增测试本身不稳定或依赖外部环境；
- 拆分提交后产生依赖断裂。

处理方式：

1. 写出最小复现或指出现有失败测试。
2. 说明修复不变量。
3. 使用 `apply_patch` 做最小改动。
4. 跑 focused test。
5. 跑所属 workspace test/typecheck。
6. 最后回到完整门禁。

停止扩展的条件：

- 问题属于 durable multi-root recovery；移入阶段 8。
- 修复需要新的产品行为选择；请求用户决定。
- 修复需要虚拟机、真实设备、外部服务或发布凭据；只记录，不擅自扩大范围。
- 会改变公开协议格式但无法同步 Android/desktop/fixtures；不得单边提交。

## 6. 阶段 4：提交拆分计划

当前工作树很大，禁止 `git add -A` 后一次性提交。使用明确路径或交互暂存，提交前
始终检查：

```powershell
git diff --cached --stat
git diff --cached --check
git diff --cached
```

以下是建议顺序。实际执行时以依赖可构建为准。

### Commit 1 — Core transfer lifecycle

建议主题：

```text
fix(core): make transfer lifecycle cleanup deterministic
```

候选范围：

```text
packages/core/src/transfer/executor.ts
packages/core/src/transfer/job-store.ts
packages/core/src/transfer/receiver.ts
packages/core/src/transfer/scheduler.ts
packages/core/src/transfer/stream-session.ts
packages/core/src/transport/lan-service.ts
packages/core/test/job-store-composition.test.ts
packages/core/test/lan-service-lifecycle.test.ts
packages/core/test/receiver-lifecycle.test.ts
packages/core/test/scheduler-lifecycle.test.ts
```

验收：Core typecheck/test 通过。

### Commit 2 — Core publication and discovery

建议主题：

```text
fix(core): fail closed during receive publication
```

候选范围：

```text
packages/core/src/transfer/encrypted-writer.ts
packages/core/src/discovery/index.ts
packages/core/src/index.ts
packages/core/test/encrypted-writer-publication.test.ts
packages/core/test/discovery.test.ts
packages/core/README.md
```

如 discovery 与 publication 没有必要放在一起，可拆成两个提交。验收：Core build、
typecheck、test 通过。

### Commit 3 — CLI lifecycle and trust binding

建议主题：

```text
fix(cli): bind transfers to current trusted peer state
```

候选范围：

```text
packages/cli/src/**
packages/cli/test/**
packages/cli/README.md
packages/cli/DOCKER_BUILD.md
packages/cli/Dockerfile
packages/cli/docker-entrypoint.sh
```

验收：CLI build、typecheck、test 通过。

### Commit 4 — LocalSend adapter

建议主题：

```text
fix(localsend): bound request and session lifecycles
```

候选范围：

```text
packages/localsend-adapter/src/**
packages/localsend-adapter/test/**
packages/localsend-adapter/README.md
```

验收：LocalSend build、typecheck、test 通过。

### Commit 5 — Desktop and Android compatibility

可按依赖拆成两个提交：

```text
fix(desktop): make shared-library publication recoverable
fix(discovery): require signed classic announcements
```

候选范围：

```text
src/core/**
src/v2/**
src/main.js
test/**（相应 focused tests）
android-app/**（本轮修改部分）
build.gradle
gradle.properties
```

签名 discovery 的 desktop/Android 实现和测试必须处于同一提交或同一不可拆分提交组，
避免中间状态互不兼容。

验收：desktop suite、Android offline tests/assemble 通过。

### Commit 6 — Release and package workflow

建议主题：

```text
ci(release): make artifact publication monotonic
```

候选范围：

```text
.github/workflows/build-linux.yml
.github/workflows/build-windows.yml
.github/workflows/ci.yml
.github/workflows/docker.yml
.github/workflows/release-app.yml
.github/workflows/release.yml
package.json
package-lock.json
packages/*/package.json
scripts/verify-packed-package.js
scripts/interop-webdav.sh
run_tests.ps1
```

验收：YAML、Bash、JSON、本地 pack 和 `ci:verify` 通过。

### Commit 7 — UI、公开文档和仓库整理

建议拆成：

```text
docs: align capability and release claims
chore(repo): remove machine-specific development helpers
```

候选范围：

```text
README.md
CHANGELOG.md
CONTRIBUTING.md
docs/**
src/renderer/**
.gitattributes
scripts/dev/**
publish.sh（删除）
已删除的跨机器测试
GEMINI_HANDOVER.md
GEMINI_NEXT_STEPS.md
```

注意：`src/renderer/styles.css` 改动较大，提交前单独审查是否包含无关格式重写。若只是
机械重排且没有必要，应该在不覆盖真实 UI 修改的前提下缩小 diff；不能直接恢复整个
文件。

### 提交拆分完成标准

- 每个提交主题明确并符合 Conventional Commits。
- 每个提交包含对应测试；文档与行为在同一提交或紧邻提交。
- 不包含生成物、凭据或本机路径。
- 最终工作树干净，或只剩明确暂缓的用户修改。
- `git log --oneline 1167ef1..HEAD` 可以清楚讲述变更顺序。

## 7. 阶段 5：提交后的最终验证

所有本地提交完成后，从最新 HEAD 重新执行：

```powershell
npm run ci:verify
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --offline --no-daemon
git diff --check 1167ef1..HEAD
git status --short
```

同时检查：

- package tarball 内容；
- workflow YAML 与 Bash block；
- `docs/capabilities.md`、`README.md`、`CHANGELOG.md` 之间没有冲突；
- npm 包版本和 lockfile 一致；
- 当前分支没有意外 merge commit；
- 删除文件清单确实只包含有意删除内容。

生成一份验证摘要，至少包含：

```text
command
result
test counts（若输出可得）
platform/runtime
skipped checks and reason
known limitations
```

## 8. 阶段 6：更新现有 PR #21

本阶段属于远端写操作，必须先向用户展示：

- 新提交列表；
- 最终测试结果；
- 文件变更规模；
- signed discovery 兼容性变化；
- WebDAV directory COPY/MOVE 不支持；
- durable multi-root recovery 尚未完成；
- Android release signing 尚未完成。

得到用户明确确认后：

1. 只推送 `fix/codex-oss-readiness-baseline`。
2. 不 force push。
3. 更新既有 PR #21，不创建重复 PR。
4. PR 描述应使用以下结构。

### 建议 PR 描述结构

```markdown
## Summary
- lifecycle and cleanup corrections across Core, CLI, LocalSend, and desktop
- fail-closed receive/shared-library publication
- signed classic discovery alignment for desktop and Android
- truthful capability/UI/documentation updates
- monotonic npm/app/container release workflows

## Compatibility changes
- unsigned classic discovery announcements are rejected
- desktop and Android endpoints should be updated together
- directory COPY/MOVE in the limited shared-library service returns 409

## Verification
- npm run ci:verify: PASS (...counts...)
- Android offline unit + assemble: PASS (...counts/tasks...)
- package contents/workflow syntax/diff checks: PASS

## Known limitations
- desktop default transfer remains v1-classic
- CLI pairing is still preview-only
- durable multi-root publication recovery is designed but not implemented
- Android public release signing is not automated

## Release note
- this PR does not publish npm packages or create application releases
```

### 公开 CI 处理规则

- CI 失败先判断是否由本 PR 引入，再本地复现。
- 不通过直接重跑掩盖确定性失败。
- 平台专属失败若本机无法复现，记录 job、step、环境与最小日志，做最小修复。
- 不把某个平台未运行写成“全平台通过”。
- 全部 required checks 通过后再请求用户决定 merge。

## 9. 阶段 7：合并后发布边界

合并当前 PR 与发布是两个独立决策。即使 PR 合并，也不要自动执行以下动作：

- bump version；
- npm publish；
- push package tag；
- push `app-v*` tag；
- 创建 GitHub Release；
- 推送容器镜像。

如果用户以后明确要求发布：

1. 以 `docs/releasing.md` 为唯一流程来源。
2. 核对 registry 中目标版本是否已存在；存在则禁止重复发布。
3. 核对 namespaced tag 与 stable 最高版本。
4. 在干净提交上重新执行完整门禁与 pack 内容验证。
5. npm、application、container 分开授权和执行。
6. 不使用旧 `publish.sh`；它已被有意删除。

## 10. 阶段 8：独立实现 durable multi-root publication recovery

该阶段建议在当前 PR 合并后另开分支。设计来源：

```text
docs/internal/publication-recovery-design.md
```

### 10.1 先冻结不变量

- final path 永不覆盖已有内容。
- 每个可见副作用之前必须有 durable intent。
- 每个副作用之后必须有经内容与身份绑定的 durable receipt。
- staging 在 aggregate COMMITTED 落盘前不能成为可删除的唯一来源。
- 一旦 publication 开始，自动恢复默认 roll forward，不删除可能已被用户看到或修改的
  final root。
- 不可证明的路径身份、损坏 journal 或冲突 receipt 一律进入
  `RECONCILE_REQUIRED`，不得猜测或自动删除。
- `writer.complete()` 只能在 COMMITTED durable 后返回。
- COMPLETE_ACK 前退出后，同 task retry 必须复用 receipt，不能生成 `(1)` 副本。

### 10.2 Phase A — 数据模型和纯状态机

新增并测试：

- publication plan；
- aggregate/root states；
- deterministic operation IDs；
- monotonic transitions；
- receipt conflict detection；
- in-memory store；
- failpoint backend。

这一阶段不接真实 receiver，不改变现有行为。先用纯单元测试覆盖所有状态转移。

### 10.3 Phase B — 文件型 durable journal

用于 CLI 的第一版 store：

- journal 位于 receive root 下的受控隐藏目录，或由明确传入的 data directory 管理；
- 只保存严格验证的相对路径；
- immutable generation records 或具有明确 durable semantics 的替换方案；
- 文件先 sync，再提交 record；目录 sync 能力作为平台 capability 记录；
- unknown version、truncated record、hash-chain fork 和额外文件 fail closed；
- receipt 具有 TTL、数量与总字节上限，但不能在 ACK 去重窗口前删除。

### 10.4 Phase C — publication backend

普通文件：

- hard link no-overwrite；
- final 与 staging identity 一致；
- aggregate COMMITTED 前保留 staging link。

目录：

- 不得用“exists check + 普通 rename”冒充 no-overwrite atomic rename；
- 可先实现 exclusively-created final directory + owned marker + 逐项 hard link 的
  recoverable fallback，并明确它可能部分可见；
- 若以后增加 native backend，Linux/macOS/Windows 分别验证真正 no-replace primitive；
- backend capability 不足时 fail closed 或使用已文档化 fallback。

### 10.5 Phase D — writer integration

把当前 `publishAllRoots()` 替换为 coordinator：

```text
PREPARED
  -> COMMITTING
  -> root publishing/published/verified ...
  -> COMMITTED
  -> CLEANUP_PENDING
  -> DONE
```

关键点：

- COMMITTING 前允许取消且 final 全部不存在。
- COMMITTING 后取消只记录请求，不回滚 final。
- publication/recovery pending 时普通 receiver cleanup 不得删除 staging。
- cleanup 失败只影响 cleanupPending，不改变 published success。

### 10.6 Phase E — receiver 与 CLI 接入

Core receiver：

- manifest 认证后、`planReceiveTargets()` 前查询同 task receipt/journal；
- 相同 taskId + 不同 manifest 拒绝；
- committed receipt 生成完整 resume checkpoint；
- 使用只读 receipt writer 完成协议握手，不接收重复 chunks；
- publication pending 的错误路径交给 recovery，不执行普通 staging cleanup。

CLI：

- 在 `server.listen()` 前完成 receive root 的全量 recovery；
- recovery 失败或出现 reconcile 项时明确报告，不悄悄监听；
- 单 task bootstrap 仍需再次定向查询，避免启动扫描与新连接交错。

Desktop：

- 当前 desktop v2 socket 只路由控制组件，不要把 recovery 错挂到 pairing socket；
- 等真正的 v2 incoming data path 接入时，再在 listener 启动前复用同一 coordinator；
- classic server 保持独立，不宣称被 v2 journal 覆盖。

### 10.7 Phase F — 确定性 crash-window 测试

至少覆盖：

1. PREPARED 前后退出；
2. COMMITTING 落盘后、首 root 前退出；
3. file link 后、receipt 前退出；
4. directory root 创建或逐项发布中退出；
5. 每两个 roots 之间退出；
6. 全 roots verified 后、COMMITTED 前退出；
7. COMMITTED 后每个 cleanup 操作之间退出；
8. cleanup 权限错误后再次恢复；
9. recovery 连续运行两次仍幂等；
10. final/staging 被替换、symlink/junction、journal 截断或冲突时零自动删除；
11. COMPLETE_ACK 前退出后同 task 重连不生成副本；
12. concurrent recovery 只有一个 coordinator 推进状态。

这些测试使用 fake/deferred filesystem 和本地临时目录，不需要虚拟机、外部服务或真实
网络设备。

### 10.8 Phase G — 声明门槛

只有以下条件全部满足后，才能把 `docs/capabilities.md` 中的限制改成“已支持”：

- Core 默认 v2 receive path 使用 durable coordinator；
- CLI 启动 recovery 默认启用；
- receipt retry 和 manifest mismatch 有端到端测试；
- supported platforms 的 backend 行为有真实 CI 覆盖；
- staging retention、cleanup、corruption 和所有 crash windows 通过；
- partial visibility 与 unsupported backend 行为在文档中如实说明；
- desktop 只在真正接入 v2 receiver 后声明覆盖。

## 11. 风险登记表

| 风险 | 当前状态 | 当前 PR 处理 | 后续动作 |
| --- | --- | --- | --- |
| 大型工作树误丢失 | 高影响 | 尚未提交 | 禁用 reset/clean，先审查并分批提交 |
| signed discovery 兼容性 | 已知变化 | desktop/Android 同步修改 | PR 明确 breaking behavior，两端一起升级 |
| multi-root 进程退出恢复 | 未完整实现 | 文档诚实标注 | 独立阶段 8 实现 |
| hard link filesystem 限制 | fail closed | 已在 Core/README 说明 | 后续 backend capability/fallback |
| WebDAV directory COPY/MOVE | 不支持 | 返回 409 | 保持文档一致，另行设计 |
| Android release signing | 未自动化 | 不发布 release APK | 单独建立签名与 provenance 流程 |
| npm 重复发布 | 版本不可覆盖 | workflow 加版本门禁 | 发布前再次查 registry，独立授权 |
| Release 资产覆盖 | 高影响 | draft + exact asset set | 保持不可覆盖策略 |
| 历史文档夸大完成度 | 已收敛 | 加历史提示与能力矩阵 | 以 capabilities 为权威 |
| CSS 大 diff 难审 | 中等 | 尚未单独复核 | 提交前检查是否混入无关格式变化 |
| Linux/macOS 本轮未重跑 | 环境限制 | 不作全平台声明 | 依赖公开 CI，真实记录结果 |

## 12. 当前 PR 的 Definition of Done

只有全部满足时才建议请求合并：

- [ ] 现有 208 项工作树变化全部分类并解释。
- [ ] 无生成物、凭据、本机身份信息或未知文件进入提交。
- [ ] `npm run ci:verify` 从最终 HEAD 通过。
- [ ] Android offline unit + assemble 通过，或环境阻断被明确记录。
- [ ] package tarball 内容、exports/bin/types/license 正确。
- [ ] workflows/YAML/Bash/JSON/diff checks 通过。
- [ ] signed discovery 的 desktop/Android 格式与测试一致。
- [ ] WebDAV directory COPY/MOVE 409 行为与文档一致。
- [ ] `docs/capabilities.md` 不宣称 durable multi-root recovery 已完成。
- [ ] 所有本地修改拆成可审查 Conventional Commits。
- [ ] 用户确认后才 push 到既有 PR #21。
- [ ] required CI checks 通过。
- [ ] PR 明确列出兼容性变化、验证结果和剩余限制。
- [ ] 当前 PR 没有执行 npm/application/container 发布。

## 13. 每次工作回合的记录模板

建议 Gemini 每次完成一批工作后追加简短记录，不修改历史结果：

```markdown
### YYYY-MM-DD HH:mm — <scope>

- Files reviewed/changed:
- Behavior changed:
- Focused verification:
- Full verification:
- Remaining blocker:
- Remote actions: none / explicitly authorized action
- VM or system-network changes: none
```

这能防止长任务压缩上下文后重复工作，也方便用户随时接手。

## 14. 推荐给 Gemini 的执行提示词

```text
请在 D:\github项目\pr\pr\nearby-transfer-next-version 接着完成当前 PR 收尾。
先完整阅读 AGENTS.md、GEMINI_HANDOVER.md、GEMINI_NEXT_STEPS.md、
docs/capabilities.md 和 docs/releasing.md。

当前分支应为 fix/codex-oss-readiness-baseline，基线 HEAD 为 1167ef1。写入两份
Gemini 文档后，工作树预计有 208 项既有未提交变化。严格保留这些修改，不要执行
reset、clean、checkout 覆盖，不要恢复已删除的机器专用脚本。

本阶段只完成计划中的阶段 0～2：只读核对、按模块审查、本地完整验证。不要连接或
启动虚拟机，不要修改 VPN、网卡、路由、DNS、代理、防火墙或端口转发，不要运行
外部/局域网探测，也不要 push、更新 PR、发布 npm、创建 tag 或 Release。

发现问题时只处理能由本地测试证明的当前 PR 阻断项。durable multi-root publication
recovery 属于独立后续 PR，目前只保留设计和真实能力限制。完成阶段 0～2 后，先向我
报告：工作树核对结果、测试结果、失败项、建议提交拆分和剩余风险，等我确认下一步。
```

## 15. 计划结束条件

本计划不是要求持续无限扩展。满足以下任一条件时应停止并向用户报告：

- 当前 PR 的本地门禁全部通过，已形成可审查提交清单，等待用户授权提交/推送；
- 遇到需要用户产品选择的行为变化；
- 缺少本地依赖且继续需要外部下载；
- 验证必须依赖当前关闭的虚拟机、真实设备或外部账户；
- 发现工作树与交接基线不一致且无法证明差异来源；
- 后续动作涉及 push、PR、merge、tag、release 或 package publication；
- 问题属于独立 durable publication recovery 项目。

结束报告应始终区分：已经实现、已经本地验证、等待公开 CI、设计但未实现、需要用户
授权五种状态，不能把它们混写为“全部完成”。
