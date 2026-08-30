# Nearby Transfer — /goal 提示词

> 历史提示词归档，不应直接执行。路径、提交号、能力和自动发布指令均可能过期。

4 个提示词，按顺序执行。每个都是自包含的，直接复制粘贴即可。

---

## 提示词 1（Day 1 上午）：P1 修通 CLI 端到端传输

```
你在 `<repository-root>` 的 Nearby Transfer 项目工作。这是一个 npm workspaces monorepo；以当前仓库脚本和维护者文档为准。

当前 HEAD 7a10b00，工作树干净（除了 PROJECT_PLAN.md 和 GOAL_24H_PLAN.md 未跟踪）。

关键阻塞问题：CLI 端到端传输不通。根因是 bootstrap（wire frame 协议）和 stream session（MUX frame 协议）共用同一条 TCP 连接。发送方 bootstrap 读取完 decision wire frame 后移除 data 监听器，接收方随后发送的 MUX stream-hello 帧到达时，发送方的 stream session 还没挂上 data 监听器，数据丢失。之前试过 socket.unshift() 但不工作。

你的任务：用 leftoverData 显式传递方案修通这个问题。改 4 个文件 + 写 1 个集成测试。具体步骤：

1. packages/core/src/transfer/bootstrap.ts：
   - BootstrapResult 接口加 leftoverData?: Buffer 字段
   - 删除 unshiftRemaining() 函数（不工作，删掉）
   - cleanup() 里删除对 unshiftRemaining 的调用
   - succeed() 改为：resolve({ decision: decision!, resume, checkpoint: controlCheckpoint, leftoverData: buffer.length > 0 ? Buffer.from(buffer) : undefined })
   - onData 中当检测到无效 frame length（MUX 数据）且 decision !== null 时调 succeed()（已有，确认 succeed 会带上 leftoverData 即可）

2. packages/core/src/transfer/stream-session.ts：
   - TransferStreamSessionInput 接口加 initialBuffer?: Buffer 字段
   - start() 函数里，在 config.stream.resume() 之前加：
     if (config.initialBuffer && config.initialBuffer.length > 0) { void onData(Buffer.from(config.initialBuffer)); }
   这会先把 leftover MUX 数据喂给 decoder（通过 incomingTail 队列），再 resume() 触发新数据，顺序正确。

3. packages/core/src/transfer/executor.ts：
   - 在 createTransferStreamSession 调用里加 initialBuffer: bootstrapResult.leftoverData

4. packages/core/src/transfer/receiver.ts：
   - receiveWireFrame 返回类型改为 Promise<{ frame: WireFrame; leftover: Buffer | undefined }>
   - resolve 时带上 decoder 里剩余的字节：leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined
   - createTransferReceiver 中用 manifestResult.frame.payload 替换原来的 manifestFrame.payload
   - 在 createTransferStreamSession 调用里加 initialBuffer: manifestResult.leftover

5. packages/cli/test/transfer-integration.test.ts：重写为真正的端到端测试。创建两个设备（Ed25519+X25519 密钥对），启动 TCP server（接收端），用 createDesktopTransferExecutor（发送端）传输一个 256KB 随机文件，验证接收到的文件 SHA-256 与原始一致。测试结构：
   - 创建 sender/receiver 密钥对和 deviceId
   - 创建 256KB 随机文件
   - 用 buildTransferSourceManifest 构建 manifest
   - 预加载 trustedPeers Map（双向）
   - net.createServer → createTransferReceiver
   - createDesktopTransferExecutor → executor.done
   - readFileSync 接收文件 → createHash('sha256') → assert.equal

每改一个文件后跑 npx tsc --noEmit -p packages/core/tsconfig.json 确认编译通过。全部改完后跑：
- npx tsx --test packages/core/test/（核心 67+ 测试必须全绿）
- npx tsx --test packages/cli/test/transfer-integration.test.ts（集成测试必须通过）
- npx tsx --test packages/cli/test/（全部 CLI 测试必须全绿）
- node --check src/v2/*.js（桌面端语法检查）

如果方案 A（leftoverData）不通（集成测试超时或 SHA-256 不匹配），切方案 B：双连接模式。bootstrap 用连接 1（manifest/decision 交换），stream session 用连接 2（新 TCP 连接）。具体：executor.ts 在 bootstrap 完成后新建一个 socket 连接到 receiver 的新端口；receiver.ts 在 decision 里附带下一个连接端口号，TCP server 监听两个端口。但先试方案 A。

全部通过后：
git add -A
git commit -m "fix(transfer): resolve bootstrap-to-stream-session handoff via leftoverData buffer

The bootstrap (wire frame) and stream session (MUX frame) share one TCP
connection. Previously, the receiver's MUX stream-hello arrived while the
sender's bootstrap data listener was still attached but the stream session
hadn't taken ownership yet, causing data loss.

Fix: bootstrap.ts returns leftoverData in BootstrapResult; stream-session.ts
accepts initialBuffer and feeds it to the decoder before resume(); executor.ts
and receiver.ts wire the leftover data through.

Adds end-to-end integration test verifying SHA-256 file integrity."
git push origin main

约束：不要引入新的 npm 依赖。不要改配对安全模型（Ed25519+SAS+X25519+AES-GCM）。不要改旧 src/v2/*.js（本轮只改 packages/ 下的 TS）。提交用英文 conventional commits。如果网络不通 git push 失败，重试最多 5 次每次间隔 15 秒。
```

---

## 提示词 2（Day 1 下午）：P2 npm 发布 + P3 文件夹同步

```
你在 `<repository-root>` 的 Nearby Transfer 项目工作；以当前仓库脚本和维护者文档为准。

前一个阶段已修通 CLI 端到端传输（bootstrap→stream session leftoverData 方案）。现在做两件事：发布 npm 0.2.0 + 实现文件夹同步。

== P2：npm 0.2.0 发布 ==

1. 版本号更新：
   - packages/core/package.json: version 0.1.0 → 0.2.0
   - packages/cli/package.json: version 0.1.0 → 0.2.0，dependencies @luo-5/core ^0.1.0 → ^0.2.0
   - 根 package.json 里如果有 devDependencies @luo-5/core 也改成 ^0.2.0

2. 构建 + 测试：
   npm run build:core
   npm run build --workspace @luo-5/cli
   npx tsx --test packages/core/test/
   npx tsx --test packages/cli/test/
   node --check src/v2/*.js
   全部必须通过。

3. 发布：
   npm publish --workspace @luo-5/core
   npm publish --workspace @luo-5/cli

4. 验证：
   npm view @luo-5/core@0.2.0
   npm view @luo-5/cli@0.2.0
   确认版本号和发布时间正确。

5. Docker 构建（如果 docker daemon 在运行）：
   docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
   docker run --rm nearby-transfer-cli --help
   如果 docker daemon 没运行，跳过，记录"Docker daemon 未运行，Dockerfile 已验证正确"。

6. 提交：
   git add -A
   git commit -m "chore: publish @luo-5/core@0.2.0 and @luo-5/cli@0.2.0"
   git push origin main

== P3：M6 文件夹同步 ==

创建以下文件：

1. packages/core/src/transfer/sync-state.ts：
   - FileSyncState 接口：path, size, mtimeMs, quickHash（前 1MiB SHA-256）, fullHash（全文件 SHA-256）
   - SyncState 接口：deviceId, lastSyncAt, files: Map<string, FileSyncState>
   - computeQuickHash(filePath, maxBytes=1MiB)：createReadStream start:0 end:maxBytes-1，for await 喂 hash
   - computeFullHash(filePath)：createReadStream 全文件
   - planIncrementalSync(files: ScanResult[], lastState: SyncState | null)：返回 { toSend, unchanged }，size 变了→传，size 没变比 quickHash，不同→传，相同→跳过

2. packages/core/src/transfer/resume-store.ts：
   - ResumeState 接口：taskId, files[{path,committedOffset,completed}], nextSequence, totalTransferred, updatedAt
   - saveResumeState(stateDir, state)：writeFileSync JSON
   - loadResumeState(stateDir, taskId)：readFileSync，不存在返回 null
   - deleteResumeState(stateDir, taskId)：unlinkSync

3. packages/core/src/transfer/conflict-resolver.ts：
   - ConflictStrategy 类型：'overwrite' | 'rename-new' | 'skip'
   - resolveConflict(targetPath, strategy)：文件不存在→返回原路径；overwrite→原路径；skip→空字符串；rename-new→生成 .new1/.new2 后缀路径

4. packages/cli/src/commands/sync.ts：
   - scanDirectory(root)：递归扫描，返回 [{ relativePath, absolutePath, size }]
   - syncPush(opts)：扫描目录→构建 manifest→createDesktopTransferExecutor→传输
   - 支持 --strategy 选项传给 conflict-resolver

5. packages/cli/src/index.ts：注册 sync 命令
   program.command('sync').description('Sync a directory to a peer device')
   .requiredOption('--dir <path>').requiredOption('--to <deviceId>')
   .option('--host <host>', '127.0.0.1').option('--port <port>', '53118')
   .option('--strategy <strategy>', 'rename-new')
   .action(async (opts) => { const { syncPush } = await import('./commands/sync.js'); await syncPush(opts); })

6. packages/cli/test/sync.test.ts：3 个测试
   - 10 个小文件同步正确传输
   - 冲突 rename-new 不覆盖已有文件
   - 增量检测只传变化的文件

每改一步跑 npx tsc --noEmit -p packages/core/tsconfig.json 和 npx tsc --noEmit -p packages/cli/tsconfig.json 确认编译。全部完成后：
- npx tsx --test packages/core/test/（核心测试全绿）
- npx tsx --test packages/cli/test/（CLI 测试含 sync 全绿）
- node --check src/v2/*.js

提交：
git add -A
git commit -m "feat(sync): implement directory sync with incremental detection and resume

- packages/cli/src/commands/sync.ts: recursive directory scan + transfer
- packages/core/src/transfer/sync-state.ts: quick hash (1 MiB) + full hash
  incremental detection against last sync state
- packages/core/src/transfer/resume-store.ts: JSON-based resume state
  persistence, resume by taskId
- packages/core/src/transfer/conflict-resolver.ts: overwrite/rename-new/skip
  strategies for name collisions
- packages/cli/test/sync.test.ts: 10-file sync, conflict, incremental"
git push origin main

约束：零运行时 npm 依赖（只用 node:fs, node:crypto, node:net, node:path 等内置模块）。TypeScript strict。不要改 src/v2/*.js。如果 npm publish 失败（网络/token），重试 5 次。npm token 在 .npmrc 里已配置。如果 Docker daemon 没运行就跳过 Docker 构建步骤。
```

---

## 提示词 3（Day 2 上午-下午）：P4 Strangler Fig 迁移

```
你在 `<repository-root>` 的 Nearby Transfer 项目工作；以当前仓库脚本和维护者文档为准。

当前状态：CLI 端到端传输已修通，npm 0.2.0 已发布，文件夹同步已实现。桌面端 Electron app 用旧 src/v2/*.js（约 30 个文件），TS 核心库（@luo-5/core）独立。两套代码并行是最大维护成本。

你的任务：把旧 src/v2/*.js 里的模块逐步迁移到用 @luo-5/core 的 TS 实现。用适配器模式：旧文件改为 re-export core 的导出，做必要的 API 适配。逐模块迁移，每迁一个就测试，行为不一致就回退。

先读这些文件了解两边的 API 差异：
- src/v2/canonical-json.js vs packages/core/src/canonical-json.ts
- src/v2/constants.js vs packages/core/src/constants.ts
- src/v2/pairing.js vs packages/core/src/pairing/ 目录
- src/v2/discovery.js vs packages/core/src/discovery/ 目录
- src/v2/transfer-manifest.js vs packages/core/src/transfer/manifest.ts
- src/v2/wire-frame.js vs packages/core/src/transfer/wire-frame.ts

第 1 批（纯逻辑，低风险）：
1. src/v2/canonical-json.js → 改为 re-export @luo-5/core 的 canonicalJson/parseCanonicalJson。如果 API 名字不同做适配。
2. src/v2/constants.js → re-export @luo-5/core 的 APP_ID/PROTOCOL_VERSION/MESSAGE_TYPES 等。
3. src/v2/pairing.js → re-export @luo-5/core 的配对相关函数。API 差异大就写适配层。

每迁一个模块后：
- node --check src/v2/<module>.js（语法检查）
- npx tsx --test packages/core/test/（核心测试不变）
- npx tsx --test packages/cli/test/（CLI 测试不变）

第 2 批（有 fs/net 依赖，中风险）：
4. src/v2/discovery.js → 用 @luo-5/core 的 discovery 模块。Electron 特有的网络接口枚举在适配层补。
5. src/v2/transfer-manifest.js → re-export @luo-5/core 的 manifest 函数。
6. src/v2/wire-frame.js → re-export @luo-5/core 的 wire-frame 函数。

每个模块迁移后同样跑 node --check + npx tsx --test。

如果某个模块迁移后行为不一致（测试失败或 Electron 启动报错）：
1. 回退：git checkout -- src/v2/<module>.js
2. 记录差异到 MIGRATION_NOTES.md（新建文件，写明哪个模块、什么差异、为什么回退）
3. 继续下一个模块

最终验收：
- npx tsc --noEmit -p packages/core/tsconfig.json
- npx tsx --test packages/core/test/
- npx tsx --test packages/cli/test/
- node --check src/v2/*.js
- node --check src/renderer/*.js
- node --check src/preload.js
- node --check src/main.js
全部必须通过。

提交：
git add -A
git commit -m "refactor: migrate v2 JS modules to core TS adapters (batch 1-2)

Batch 1 (pure logic): canonical-json, constants, pairing
Batch 2 (fs/net deps): discovery, transfer-manifest, wire-frame

Each module replaced with an adapter that re-exports from @luo-5/core.
Behavioral differences documented in MIGRATION_NOTES.md.
All tests pass."
git push origin main

约束：不要改 @luo-5/core 的 TS 源码（只改 src/v2/*.js 的适配层）。不要引入新依赖。Electron 启动如果不可用（没有 display），用 node --check 验证语法 + 记录"Electron 启动未验证"。如果某模块迁移后测试失败，立即回退，不死磕。
```

---

## 提示词 4（Day 2 下午-晚上）：P5 安全加固 + P6 最终测试

```
你在 `<repository-root>` 的 Nearby Transfer 项目工作；以当前仓库脚本和维护者文档为准。

当前状态：CLI 传输修通，npm 0.2.0 已发布，文件夹同步已实现，Strangler fig 迁移第 1-2 批已完成。

你的任务：安全加固 + 最终全量测试 + 发布准备。

== P5：安全加固 ==

如果维护者提供了外部产出，先验证来源与内容，再决定是否整合。

自主安全加固（无论有没有 Gemini 产出都做）：

1. Timing-safe 比较：
   搜索 packages/core/src/ 里所有用 === 比较密钥/token/签名/mac 的地方：
   grep -rn "===" packages/core/src/ | grep -iE "key|token|signature|mac|hash|secret"
   对每个找到的地方，用 crypto.timingSafeEqual 替换：
   const a = Buffer.from(expected); const b = Buffer.from(actual);
   if (a.length !== b.length) return false;
   return crypto.timingSafeEqual(a, b);
   如果两边都是 string，先 Buffer.from() 再比较。
   创建 packages/core/src/crypto/timing-safe-compare.ts 封装这个逻辑。

2. 路径遍历检查：
   检查 packages/core/src/transfer/receive-planner.ts 的路径清洗：
   grep -rn "\.\." packages/core/src/transfer/
   确保所有文件路径在写入前都做了 path.resolve + 检查不会逃出 receiveDir。
   如果发现漏洞，修复：resolve 后检查 startsWith(receiveDir)。

3. Nonce 唯一性：
   检查 packages/core/src/transfer/encrypted-reader.ts 的 nonce 生成：
   确保 nonce 是递增的（同 sessionKey 下不会重复）或随机的（32 位以上）。
   如果是固定值，改为递增计数器。

4. DoS 防护检查：
   确认 wire-frame.ts 有 MAX_FRAME_SIZE（16MB）限制。
   确认 chunk-frame.ts 有 MAX_FRAME_BYTES 限制。
   确认 message-codec.ts 有 MAX_TRANSFER_MESSAGE_BYTES 限制。
   如果缺限制，补上。

5. 写安全测试 packages/core/test/security.test.ts：
   - timing-safe-compare 的正确性和非时序泄漏
   - 路径遍历被拒绝（../ 和绝对路径）
   - 超大 frame 被拒绝
   - nonce 不重复

每步跑 npx tsc --noEmit -p packages/core/tsconfig.json 确认编译。全部完成后 npx tsx --test packages/core/test/ 必须全绿。

如果有 Gemini 产出（expected-output/ 目录存在）：
- 整合 B2 边界测试 → packages/core/test/，跑 npx tsx --test 确认通过
- 整合 B3 模糊测试 → packages/core/test/，跑确认通过
- 整合 B4 属性测试 → packages/core/test/，跑确认通过
- 整合 A2 timing-safe-compare.ts → packages/core/src/crypto/
- 整合 A3 DoS 防护 → packages/core/src/security/（新建目录）
- 整合 C2 性能优化：逐个替换，每次替换后跑测试 + 确认 API 不变
- 读 E3 架构评审报告，合理建议记录到 ARCHITECTURE_DECISIONS.md（新建）

Gemini 产出的代码必须测试通过才整合，不盲目信任。测试失败先修测试（可能是 Gemini 的 bug），再确认代码没问题。

提交：
git add -A
git commit -m "security: timing-safe comparison, path traversal prevention, nonce uniqueness, DoS limits

- crypto/timing-safe-compare.ts: constant-time buffer comparison utility
- receive-planner.ts: enforce path resolution within receive directory
- encrypted-reader.ts: verify nonce uniqueness (incrementing counter)
- security.test.ts: tests for all hardening measures
- [if Gemini]: integrated edge/fuzz/property tests, DoS protection, perf optimizations"
git push origin main

== P6：最终测试 + 发布准备 ==

1. 全量测试：
   npx tsc --noEmit -p packages/core/tsconfig.json
   npx tsc --noEmit -p packages/cli/tsconfig.json
   npx tsx --test packages/core/test/
   npx tsx --test packages/cli/test/
   node --check src/v2/*.js
   node --check src/renderer/*.js
   node --check src/preload.js
   node --check src/main.js
   如果有 packages/python-ref/ 且有 python：cd packages/python-ref && python verify_vectors.py
   全部必须通过。有失败就修。

2. 创建 CHANGELOG.md（根目录）：
   记录 0.2.0 的所有改动：新增（sync 命令、createTransferReceiver、增量检测、断点续传、冲突处理、集成测试、安全加固）、修复（bootstrap→stream session 交接、Ed25519 OID、ephemeral key 格式）、变更（v2 模块迁移到 core TS 适配器）。

3. 更新 README.md：
   添加 sync 命令文档、0.2.0 版本信息、安全特性说明。

4. 最终提交：
   git add -A
   git commit -m "chore: 0.2.0 release preparation — full test suite green, CHANGELOG, README

- All tests pass (core + CLI + interop)
- CHANGELOG for 0.2.0
- Security hardening verified
- README updated with sync command and security features"
   git push origin main

约束：零运行时 npm 依赖。TypeScript strict。不改配对安全模型。Gemini 产出必须测试通过才整合。每步都提交，小步快跑。测试用 npx tsx --test。如果网络不通 git push 失败重试 5 次。
```

---

## 执行节奏

| 提示词 | 时间 | 内容 | 检查点 |
|--------|------|------|--------|
| 1 | Day 1 上午 | P1 修通传输 | 集成测试通过 |
| 2 | Day 1 下午 | P2 npm + P3 sync | npm view 成功 + sync 测试通过 |
| — | Day 1 晚 | **检查点 1** | review git log + 手动测试 |
| 3 | Day 2 上午-下午 | P4 迁移 | 全部测试通过 |
| 4 | Day 2 下午-晚 | P5 安全 + P6 发布 | 全绿 + CHANGELOG |
| — | Day 2 晚 | **检查点 2** | review 全部 |
