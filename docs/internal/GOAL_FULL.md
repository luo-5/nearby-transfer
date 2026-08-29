# Nearby Transfer — 完整 /goal 提示词

以下是一个整块提示词，直接全部复制粘贴即可。Agent 会连续工作，完成所有阶段。

---

```
你在 Nearby Transfer 项目（Node.js/Electron 桌面 + Android LAN 加密文件传输 + NAS WebDAV）工作。仓库在 D:\github项目\pr\pr\nearby-transfer-next-version。这是一个 npm workspaces monorepo：packages/core（TS 核心库，零运行时依赖，只用 node: 内置模块）、packages/cli（CLI 工具）、packages/localsend-adapter、packages/protocol-spec。桌面端 Electron app 用旧 src/v2/*.js（约 30 个文件），TS 核心库独立。GitHub: https://github.com/luo-5/nearby-transfer.git，git 身份 luo-5 / lluo77250@gmail.com。TypeScript strict 模式。测试一律用 npx tsx --test（不要用 vitest，vitest 不支持 node:test 风格测试）。零运行时 npm 依赖原则（core/cli 不引入新 npm 依赖，只用 node:crypto, node:net, node:fs, node:http, node:dgram 等）。提交用英文 conventional commits。配对安全模型（Ed25519 签名 + SAS 双向比对码 + X25519 ECDH + AES-256-GCM）永远不改。每改完一组就 git commit + git push。如果 git push 或 npm publish 失败（网络），重试最多 5 次每次间隔 15 秒。

当前 HEAD 7a10b00。工作树有未跟踪文件 PROJECT_PLAN.md, GOAL_24H_PLAN.md, GOAL_PROMPTS.md（这些是规划文件，不要删，但也不需要提交，除非你想提交）。

你的任务分 6 个阶段，连续完成。每阶段完成后提交并推送，然后继续下一阶段。不要停下来问我。如果某阶段卡住超过 3 次尝试，跳到下一阶段并记录跳过原因到 D:\github项目\pr\pr\nearby-transfer-next-version\SKIPPED.md。全部完成后做最终全量测试。

═══════════════════════════════════════════════
阶段 1：修通 CLI 端到端传输（关键阻塞）
═══════════════════════════════════════════════

问题：bootstrap（wire frame 协议）和 stream session（MUX frame 协议）共用一条 TCP 连接。发送方 bootstrap 读完 decision wire frame 后移除 data 监听器，接收方的 MUX stream-hello 帧到达时发送方 stream session 还没挂上监听器，数据丢失。之前 socket.unshift() 不工作。

方案：leftoverData 显式传递。改 4 个文件 + 写 1 个集成测试。

1) packages/core/src/transfer/bootstrap.ts：
   - BootstrapResult 接口加 leftoverData?: Buffer 字段
   - 删除 unshiftRemaining() 函数，删除 cleanup 里对它的调用
   - succeed() 改为返回 leftoverData：resolve({ decision: decision!, resume, checkpoint: controlCheckpoint, leftoverData: buffer.length > 0 ? Buffer.from(buffer) : undefined })
   - onData 里当检测到无效 frame length（MUX 数据）且 decision !== null 时调 succeed()（已有，确认 succeed 带上 leftoverData）

2) packages/core/src/transfer/stream-session.ts：
   - TransferStreamSessionInput 接口加 initialBuffer?: Buffer
   - start() 函数里在 config.stream.resume() 之前加：
     if (config.initialBuffer && config.initialBuffer.length > 0) { void onData(Buffer.from(config.initialBuffer)); }
   理解：onData 先 pause()（no-op 因为 stream 还没流动）再通过 incomingTail 队列异步处理 initialBuffer 再 resume()。之后 config.stream.resume() 触发新数据，onData 再次触发排到 incomingTail 后面，顺序正确。

3) packages/core/src/transfer/executor.ts：
   - createTransferStreamSession 调用里加 initialBuffer: bootstrapResult.leftoverData

4) packages/core/src/transfer/receiver.ts：
   - receiveWireFrame 返回类型改为 Promise<{ frame: WireFrame; leftover: Buffer | undefined }>
   - resolve 时带 leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined
   - createTransferReceiver 中用 manifestResult.frame.payload 替换 manifestFrame.payload
   - createTransferStreamSession 调用里加 initialBuffer: manifestResult.leftover

5) packages/cli/test/transfer-integration.test.ts：重写为真正的端到端测试。
   创建 sender/receiver 各一对 Ed25519+X25519 密钥，deriveDeviceId。创建 256KB 随机文件。buildTransferSourceManifest 构建 manifest。预加载 trustedPeers Map 双向。net.createServer 启动接收端 → createTransferReceiver。createDesktopTransferExecutor 发送 → executor.done。readFileSync 接收文件 → createHash('sha256') → assert.equal 与原始 hash。要 import crypto 做 randomFillSync。
   注意：TransferJob 需要这些字段：direction:'outgoing', status:'transferring', manifest, sources[{path,kind:'file',size,filePath}], peerDeviceId, peer:{host,port}, localDeviceId, signingPrivateKey, remoteSigningPublicKey, remoteEncryptionPublicKey。用 as any 绕过 TS 类型检查如果字段不完全匹配。

每改一个文件跑 npx tsc --noEmit -p packages/core/tsconfig.json 确认编译。全部改完后：
npx tsx --test packages/core/test/（核心测试全绿）
npx tsx --test packages/cli/test/transfer-integration.test.ts（集成测试通过）
npx tsx --test packages/cli/test/（全部 CLI 测试全绿）
node --check src/v2/*.js

如果方案 A 不通（集成测试超时或 SHA-256 不匹配），切方案 B 双连接：bootstrap 用连接 1，stream session 用连接 2。executor.ts bootstrap 后新建 socket 连到 receiver 新端口；receiver.ts 在 decision 里附下个端口号，TCP server 监听两个端口。但先试方案 A。

通过后提交：
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

═══════════════════════════════════════════════
阶段 2：npm 0.2.0 发布
═══════════════════════════════════════════════

1) 版本号：packages/core/package.json version 0.1.0→0.2.0；packages/cli/package.json version 0.1.0→0.2.0 且 dependencies @luo-5/core ^0.1.0→^0.2.0；根 package.json 如有 devDependencies @luo-5/core 也改 ^0.2.0。

2) 构建+测试：
npm run build:core && npm run build --workspace @luo-5/cli
npx tsx --test packages/core/test/ && npx tsx --test packages/cli/test/
全部通过。

3) 发布：npm publish --workspace @luo-5/core && npm publish --workspace @luo-5/cli

4) 验证：npm view @luo-5/core@0.2.0 && npm view @luo-5/cli@0.2.0

5) Docker（如果 daemon 运行）：docker build -t nearby-transfer-cli -f packages/cli/Dockerfile . && docker run --rm nearby-transfer-cli --help。daemon 没运行就跳过。

提交：git add -A && git commit -m "chore: publish @luo-5/core@0.2.0 and @luo-5/cli@0.2.0" && git push origin main

═══════════════════════════════════════════════
阶段 3：M6 文件夹同步
═══════════════════════════════════════════════

创建以下文件（全部只用 node: 内置模块）：

1) packages/core/src/transfer/sync-state.ts：
   FileSyncState { path, size, mtimeMs, quickHash, fullHash }
   SyncState { deviceId, lastSyncAt, files: Map<string, FileSyncState> }
   computeQuickHash(filePath, maxBytes=1MiB)：createReadStream(filePath,{start:0,end:maxBytes-1}) for await 喂 sha256
   computeFullHash(filePath)：createReadStream 全文件 for await 喂 sha256
   planIncrementalSync(files, lastState)：返回 {toSend, unchanged}。size 变→传；size 不变比 quickHash→不同传→相同跳过。

2) packages/core/src/transfer/resume-store.ts：
   ResumeState { taskId, files[{path,committedOffset,completed}], nextSequence, totalTransferred, updatedAt }
   saveResumeState(stateDir, state)：writeFileSync JSON
   loadResumeState(stateDir, taskId)：readFileSync，不存在 null
   deleteResumeState(stateDir, taskId)：unlinkSync

3) packages/core/src/transfer/conflict-resolver.ts：
   ConflictStrategy = 'overwrite'|'rename-new'|'skip'
   resolveConflict(targetPath, strategy)：不存在→原路径；overwrite→原路径；skip→空串；rename-new→.new1/.new2 后缀

4) packages/cli/src/commands/sync.ts：
   scanDirectory(root)：递归 readdirSync，返回 [{relativePath, absolutePath, size}]
   syncPush(opts)：扫描→buildTransferSourceManifest→createDesktopTransferExecutor→传输。支持 --strategy。

5) packages/cli/src/index.ts：注册 sync 命令（requiredOption --dir/--to，option --host/--port/--strategy）

6) packages/cli/test/sync.test.ts：3 个测试（10 文件同步、冲突 rename-new、增量检测只传变化文件）

每步 npx tsc --noEmit -p packages/core/tsconfig.json && npx tsc --noEmit -p packages/cli/tsconfig.json。全部完成后 npx tsx --test packages/core/test/ && npx tsx --test packages/cli/test/ && node --check src/v2/*.js。

提交：git add -A && git commit -m "feat(sync): implement directory sync with incremental detection and resume

- cli/commands/sync.ts: recursive directory scan + transfer
- core/transfer/sync-state.ts: quick hash (1 MiB) + full hash incremental detection
- core/transfer/resume-store.ts: JSON-based resume state persistence
- core/transfer/conflict-resolver.ts: overwrite/rename-new/skip strategies
- cli/test/sync.test.ts: 10-file sync, conflict, incremental" && git push origin main

═══════════════════════════════════════════════
【检查点 1】到这里阶段 1-3 完成。确认 git log --oneline -10 有 3 个新提交。继续阶段 4。
═══════════════════════════════════════════════

═══════════════════════════════════════════════
阶段 4：Strangler Fig 迁移（第 1-2 批）
═══════════════════════════════════════════════

把旧 src/v2/*.js 逐步迁移到用 @luo-5/core 的 TS 实现。用适配器模式：旧文件改为 re-export core 导出 + 必要的 API 适配。逐模块迁移，每迁一个测试，行为不一致就回退。

先读两边 API 对比差异：
- src/v2/canonical-json.js vs packages/core/src/canonical-json.ts
- src/v2/constants.js vs packages/core/src/constants.ts
- src/v2/pairing.js vs packages/core/src/pairing/ 目录
- src/v2/discovery.js vs packages/core/src/discovery/ 目录
- src/v2/transfer-manifest.js vs packages/core/src/transfer/manifest.ts
- src/v2/wire-frame.js vs packages/core/src/transfer/wire-frame.ts

第 1 批（纯逻辑）：
1. src/v2/canonical-json.js → re-export @luo-5/core canonicalJson/parseCanonicalJson
2. src/v2/constants.js → re-export APP_ID/PROTOCOL_VERSION/MESSAGE_TYPES 等
3. src/v2/pairing.js → re-export 配对函数，API 差异大就写适配层

第 2 批（有 fs/net 依赖）：
4. src/v2/discovery.js → 用 @luo-5/core discovery，Electron 特有功能在适配层补
5. src/v2/transfer-manifest.js → re-export manifest 函数
6. src/v2/wire-frame.js → re-export wire-frame 函数

每个模块迁移后跑：node --check src/v2/<module>.js && npx tsx --test packages/core/test/ && npx tsx --test packages/cli/test/

如果迁移后测试失败或行为不一致：git checkout -- src/v2/<module>.js 回退，记录差异到 MIGRATION_NOTES.md，继续下一个。

最终验收：npx tsc --noEmit -p packages/core/tsconfig.json && npx tsx --test packages/core/test/ && npx tsx --test packages/cli/test/ && node --check src/v2/*.js && node --check src/renderer/*.js && node --check src/preload.js && node --check src/main.js

提交：git add -A && git commit -m "refactor: migrate v2 JS modules to core TS adapters (batch 1-2)

Batch 1 (pure logic): canonical-json, constants, pairing
Batch 2 (fs/net deps): discovery, transfer-manifest, wire-frame

Each module replaced with an adapter that re-exports from @luo-5/core.
Behavioral differences documented in MIGRATION_NOTES.md." && git push origin main

═══════════════════════════════════════════════
阶段 5：安全加固
═══════════════════════════════════════════════

1) Timing-safe 比较：
   grep -rn "===" packages/core/src/ | grep -iE "key|token|signature|mac|hash|secret"
   对比较密钥/签名/mac 的地方，用 crypto.timingSafeEqual 替换。
   创建 packages/core/src/crypto/timing-safe-compare.ts：
   export function timingSafeEqualString(a: string, b: string): boolean { const ba = Buffer.from(a); const bb = Buffer.from(b); if (ba.length !== bb.length) return false; return crypto.timingSafeEqual(ba, bb); }

2) 路径遍历：检查 packages/core/src/transfer/receive-planner.ts，确保所有写入路径 resolve 后 startsWith(receiveDir)。有漏洞就修。

3) Nonce 唯一性：检查 packages/core/src/transfer/encrypted-reader.ts，nonce 必须递增或随机不重复。固定值就改递增计数器。

4) DoS 限制：确认 wire-frame.ts 有 MAX_FRAME_SIZE、chunk-frame.ts 有 MAX_FRAME_BYTES、message-codec.ts 有 MAX_TRANSFER_MESSAGE_BYTES。缺就补。

5) 写 packages/core/test/security.test.ts：测试 timing-safe-compare 正确性、路径遍历被拒绝（../和绝对路径）、超大 frame 被拒绝、nonce 不重复。

如果 D:\github项目\gemini-package.tar.gz 已解压或有 expected-output/ 目录（Gemini 返回的产出），整合：
- B2/B3/B4 测试 → packages/core/test/，跑 npx tsx --test 确认通过才保留
- A2 timing-safe-compare → packages/core/src/crypto/
- A3 DoS 防护 → packages/core/src/security/（新建）
- C2 性能优化：逐个替换，每次替换后跑测试 + 确认 API 不变
- E3 架构评审报告，合理建议记录到 ARCHITECTURE_DECISIONS.md
Gemini 产出的代码必须测试通过才整合。测试失败先判断是测试 bug 还是代码 bug。

每步 npx tsc --noEmit -p packages/core/tsconfig.json。全部后 npx tsx --test packages/core/test/ 全绿。

提交：git add -A && git commit -m "security: timing-safe comparison, path traversal prevention, nonce uniqueness, DoS limits

- crypto/timing-safe-compare.ts: constant-time comparison utility
- receive-planner.ts: enforce path resolution within receive directory
- encrypted-reader.ts: verify nonce uniqueness
- security.test.ts: tests for all hardening measures" && git push origin main

═══════════════════════════════════════════════
阶段 6：最终测试 + 发布准备
═══════════════════════════════════════════════

1) 全量测试（全部必须通过，有失败就修）：
npx tsc --noEmit -p packages/core/tsconfig.json
npx tsc --noEmit -p packages/cli/tsconfig.json
npx tsx --test packages/core/test/
npx tsx --test packages/cli/test/
node --check src/v2/*.js
node --check src/renderer/*.js
node --check src/preload.js
node --check src/main.js

2) 创建 CHANGELOG.md（根目录）：
   ## [0.2.0] - 2026-08-25
   ### Added: sync 命令、createTransferReceiver、增量检测、断点续传、冲突处理、端到端集成测试、安全加固（timing-safe/路径遍历/nonce/DoS）
   ### Fixed: bootstrap→stream session 交接、Ed25519 OID、ephemeral key 格式
   ### Changed: v2 模块迁移到 core TS 适配器、npm 0.1.0→0.2.0

3) 更新 README.md：添加 sync 命令文档、0.2.0 版本信息、安全特性说明。

4) 提交：git add -A && git commit -m "chore: 0.2.0 release preparation — full test suite green, CHANGELOG, README

- All tests pass (core + CLI)
- CHANGELOG for 0.2.0
- Security hardening verified
- README updated with sync command and security features" && git push origin main

═══════════════════════════════════════════════
【检查点 2】全部 6 阶段完成。输出最终报告：
- git log --oneline -15
- 测试结果汇总（多少通过）
- 跳过了什么（如果有，看 SKIPPED.md）
- npm 0.2.0 发布状态
- 安全加固清单
═══════════════════════════════════════════════

记住：连续工作不要停。每阶段完成后立即提交推送并继续下一阶段。只有全部完成后才输出最终报告。如果某阶段卡住超 3 次，记录到 SKIPPED.md 跳到下一阶段。测试用 npx tsx --test。零 npm 依赖。TypeScript strict。英文 conventional commits。安全模型不改。网络失败重试 5 次。
```
