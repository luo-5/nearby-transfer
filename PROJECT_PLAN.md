# Nearby Transfer 全流程规划

**最后更新：** 2026-08-24
**当前 HEAD：** `7a10b00`
**npm 包：** `@luo-5/core@0.1.0`、`@luo-5/cli@0.1.0`、`@luo-5/localsend-adapter@0.1.0`
**测试：** 核心 67 + CLI 14 + 桌面 42 文件 + 互操作 62 断言 = 全绿

---

## 已完成的里程碑

| 里程碑 | 产出 | 状态 |
|--------|------|------|
| M0 审计 | 40 模块映射表、平台耦合分级 | ✅ |
| M1 核心库 | `@luo-5/core@0.1.0`，35 个 TS 模块，67 测试 | ✅ 已发布 |
| M2 CLI | `@luo-5/cli@0.1.0`，5 命令，14 测试 | ✅ 已发布 |
| M3 WebDAV 加固 | PROPFIND/COPY/MOVE/Depth、TLS 证书 SAN+keyUsage、62 互操作断言 | ✅ |
| M4 LocalSend | `@luo-5/localsend-adapter@0.1.0`，11 测试 | ✅ 已发布 |
| M5 协议规范 | v2-spec.md（11 章）、10 组确定性测试向量 | ✅ |
| UI A1-A7 | 配对自动完成、列表过滤、设备持久化、协议折叠、日志去重 | ✅ 均已实现 |
| CLI 传输 | `createTransferReceiver` + send/receive 重写 | ⚠️ 见下 |
| Docker | Dockerfile + SMB sidecar | ⚠️ 未实际构建 |

---

## 关键技术问题：CLI 端到端传输不通

**根因：** bootstrap（wire frame）→ stream session（MUX frame）的交接在同一条 TCP 连接上。发送方 bootstrap 解码完 decision wire frame 后移除 data 监听器，接收方随后发送的 MUX `stream-hello` 帧到达时，发送方的 stream session 还没挂上 data 监听器。Node.js 的 socket pause/resume 没有可靠缓冲这段数据。

**已做的 bug 修复（已提交）：**
- `bootstrap.ts`：手动 frame-length 检查替代 one-shot `decodeWireFrame`，处理 trailing MUX 数据
- `executor.ts`：ephemeral X25519 公钥导出为 raw 32-byte base64url 而非 PEM
- `message-codec.ts`：新增 `assertValidEphemeralKey`（32 字节验证）
- `receiver.ts`：新增 `createTransferReceiver`（接收端完整流程）
- 但 `unshift` 机制和 delay 方案都未能让 stream session 收到 MUX 数据

---

## 细分规划

### Phase 1：修通 CLI 端到端传输（我做，风险：中）

**方案 A（首选）：leftoverData 交接缓冲区**

改动 3 个文件：

1. `packages/core/src/transfer/bootstrap.ts` — 在 `BootstrapResult` 接口加 `leftoverData?: Buffer`。在 `succeed()` 中，把 `buffer`（剩余的 MUX 数据）作为 `leftoverData` 返回：
   ```typescript
   resolve({ decision: decision!, resume, checkpoint: controlCheckpoint,
     leftoverData: buffer.length > 0 ? Buffer.from(buffer) : undefined });
   ```

2. `packages/core/src/transfer/stream-session.ts` — 在 `TransferStreamSessionInput` 加 `initialBuffer?: Buffer`。在 `start()` 中，`resume()` 之前手动喂初始缓冲区给 decoder：
   ```typescript
   if (input.initialBuffer && input.initialBuffer.length > 0) {
     onData(Buffer.from(input.initialBuffer));
   }
   config.stream.resume();
   ```
   `onData` 会 `pause()` → 队列化处理 → 处理完后 `resume()`，`incomingTail` 链保证串行化。

3. `packages/core/src/transfer/executor.ts` — 传递 leftoverData：
   ```typescript
   const session = createTransferStreamSession({
     // ... 现有参数 ...
     initialBuffer: bootstrapResult.leftoverData,
   });
   ```

4. `packages/cli/test/transfer-integration.test.ts` — 写真正的端到端测试：创建两个设备 → TCP server → executor → 验证 SHA-256。

**方案 B（备选）：双连接模式。** bootstrap 用连接 1，stream session 用连接 2。回避 wire-frame 和 MUX 帧在同一条连接上混用。改动更大，先试方案 A。

**验收：** 集成测试通过，`send` + `receive` 能在两个进程间传输文件。

### Phase 2：发布 npm 0.2.0（我做，风险：低）

P1 修通后：
- `packages/core/package.json`: 0.1.0 → 0.2.0
- `packages/cli/package.json`: 0.1.0 → 0.2.0，dependencies `@luo-5/core` → `^0.2.0`
- 根 `package.json` devDependencies `@luo-5/core` → `^0.2.0`
- `npm run build:core` + `npm run build --workspace @luo-5/cli` + 全部测试全绿
- `npm publish --workspace @luo-5/core` + `npm publish --workspace @luo-5/cli`
- 验证：`npm view @luo-5/core@0.2.0`

### Phase 3：Docker 构建验证（我做，30 分钟）

```bash
docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
docker run --rm nearby-transfer-cli --help
docker run --rm nearby-transfer-cli devices
```
Dockerfile 已验证正确，只需启动 Docker daemon 实际构建。

### Phase 4：M6 文件夹同步（我做 + Gemini 模块，风险：中高，2-3 夜）

依赖 P1 修通。

- **4.1 sync 命令**（我做）：`packages/cli/src/commands/sync.ts`，`sync push --dir --to`，基于 send 的传输能力 + 目录递归扫描
- **4.2 增量检测**（Gemini 已产出）：`sync-state.ts` + `incremental-planner.ts`（快速哈希前 1 MiB + 全文件哈希，对比上次同步状态）
- **4.3 断点续传持久化**：会话元数据 + chunk 位图持久化到 JSON，`resume --session <taskId>` 恢复
- **4.4 冲突处理**（Gemini 已产出）：`conflict-resolver.ts`（rename-new 策略）
- **4.5 测试**：1 GB 文件中断续传、10k 小文件同步、冲突命名

**验收：** `sync push` 能同步目录、中断后 `resume` 能续传、冲突不覆盖。

### Phase 5：Strangler Fig 迁移（我做，持续进行，风险：中）

桌面端 Electron app 用旧 `src/v2/*.js`（30 文件），TS 核心库独立。两套代码并行是最大维护成本。

**迁移顺序（从低风险到高风险）：**

第一批（纯逻辑）：
- `src/v2/canonical-json.js` → `@luo-5/core` canonical-json.ts
- `src/v2/constants.js` → constants.ts
- `src/v2/pairing.js` → pairing/sas.ts + identity-shape.ts

第二批（有 fs/net 依赖）：
- `src/v2/discovery.js` → discovery/index.ts
- `src/v2/transfer-manifest.js` → transfer/manifest.ts
- `src/v2/wire-frame.js` → transfer/wire-frame.ts

第三批（有 Electron/state 依赖）：
- `src/v2/trusted-peer-store.js`（SQLite → JSON trust-store.ts）
- `src/v2/lan-service.js` → transport/lan-service.ts
- `src/v2/desktop-library-service.js` → 保持原位（WebDAV 不在核心库）

**每批验收：** `node --check` + `npm test` 全绿 + Electron 启动不报错。
**调整原则：** 某模块迁移后行为不一致就回退，记录差异，下轮处理。

### Phase 6：M7 发布与推广（我做 + Gemini 产出，1 夜 + 手动）

- **6.1 README 大改版**（Gemini 已产出）：中英双语、badge 行、对比表、3 种快速开始、架构图、路线图
- **6.2 CI/CD**（Gemini 已产出）：GitHub Actions（ci/docker/release/codeql/stale）
- **6.3 文档套件**（Gemini 已产出）：architecture/security/api-reference/CONTRIBUTING/CHANGELOG
- **6.4 发布渠道**：npm（已有）、GHCR Docker、winget（可选）、F-Droid（可选）
- **6.5 社区发布**（手动）：V2EX、少数派、r/selfhosted、Hacker News

---

## Gemini 任务包（已打包）

**文件：** `D:\github项目\gemini-package.tar.gz`（219 KB，131 个文件）

### 包含的参考材料

| 目录 | 内容 |
|------|------|
| `reference/v2-spec.md` | 协议规范全文 |
| `reference/*-vectors.json` | 3 个测试向量文件（10 组） |
| `reference/core-src/` | TS 核心库全部源码（33 文件） |
| `reference/cli-src/` | CLI 工具源码（7 文件） |
| `reference/localsend-src/` | LocalSend 适配器源码（5 文件） |
| `reference/tests/` | 全部现有测试（9 文件） |
| `reference/desktop-v2/` | 桌面端旧 JS 实现（32 文件） |
| `reference/old-core/` | v1 核心模块（7 文件） |
| `reference/protocols/` | 协议引擎和驱动（10 文件） |
| `reference/*-package.json` | 构建配置 |

### 15 个任务

**A 安全（4 个）：**
- A1 安全审计报告 — 8 维度逐文件审计（时序侧信道、nonce 碰撞、密钥卫生、路径遍历、DoS、规范 JSON 攻击、重放保护、TLS）
- A2 常量时间比较修复 — timing-safe-compare.ts 工具
- A3 DoS 防护加固 — 速率限制器、连接限制器、安全 JSON 解析器
- A4 密钥卫生审计 — 5 种密钥生命周期追踪

**B 测试（4 个）：**
- B1 Python 参考实现 — 7 个 .py + verify_vectors.py，验证所有 10 组向量
- B2 边界测试 — 6 个 .test.ts（canonical-json/manifest/crypto/wire-frame/discovery/control 异常路径）
- B3 模糊测试 — 4 个 fuzz-*.ts（1000 次随机输入 round-trip + 幂等性）
- B4 属性测试 — 6 个不变式（100 次随机输入）

**C 性能（3 个）：**
- C1 性能分析报告 — 6 条热路径瓶颈分析 + 优化建议
- C2 热路径优化 — optimized-canonical-json/wire-frame/chunk-aad/buffer-pool
- C3 基准脚本 — 加密吞吐量、传输吞吐量、序列化性能

**D 模块（2 个）：**
- D1 增量同步模块 — sync-state + incremental-planner + conflict-resolver（含测试）
- D2 WebDAV 客户端 — 零依赖轻量客户端（PROPFIND/GET/PUT/DELETE/MKCOL/MOVE）

**E 工程（3 个）：**
- E1 CI/CD — 5 个 GitHub Actions workflow（ci/docker/release/codeql/stale）
- E2 文档套件 + README — architecture/security/api-reference/CONTRIBUTING/CHANGELOG + README 大改版
- E3 架构与规划评审 — 6 维度深度评审（模块边界、strangler fig、协议设计、测试策略、规划本身、代码风格）+ **对规划提意见**

### 优先级

A1 > B1 > D1 > E3 > A3 > C1 > B2 > E2 > B3 > A2 > A4 > C2 > B4 > C3 > E1 > D2

### 我整合 Gemini 产出的流程

1. Python 参考实现 → `packages/python-ref/`，跑 `python verify_vectors.py` 验证
2. 安全审计报告 → 逐条核对，高优先级立即修
3. 边界/模糊/属性测试 → `packages/core/test/`，跑 `npm run test:core` 验证全绿
4. 性能优化模块 → 对比基准，确认 API 不变 + 测试通过后替换
5. 增量同步模块 → `packages/core/src/transfer/`，P1 修通后接入 sync 命令
6. WebDAV 客户端 → `packages/localsend-adapter/src/` 或独立包
7. CI/CD → `.github/workflows/`
8. 文档 → 对应位置
9. 架构评审 → 逐条评估，采纳合理建议调整规划
10. **最后全部测试一遍**：`npm test` + `npm run test:core` + `npm run test:interop` + Python 向量验证

---

## 执行节奏

| 阶段 | 预估 | 方式 | 依赖 |
|------|------|------|------|
| P1 修通传输 | 1 夜 | /goal 自主 | 无 |
| P2 发布 0.2.0 | 1 小时 | 手动（npm token） | P1 |
| P3 Docker 验证 | 30 分钟 | 手动 | 无 |
| P4 M6 同步 | 2-3 夜 | /goal + Gemini 模块 | P1 + Gemini D1 |
| P5 Strangler fig | 持续 | 逐模块手动 + 测试 | P2 |
| P6 M7 发布 | 1 夜 + 手动 | /goal + Gemini 产出 | P2-P4 |

**并行：** Gemini 任务包可以和 P1 同时进行——Gemini 不依赖 CLI 传输修通。

---

## 关键文件路径速查

```
packages/core/src/transfer/bootstrap.ts      # Phase 1 改动
packages/core/src/transfer/stream-session.ts  # Phase 1 改动
packages/core/src/transfer/executor.ts        # Phase 1 改动
packages/core/src/transfer/receiver.ts         # 接收端（已实现）
packages/cli/src/commands/send.ts              # 发送命令（已实现）
packages/cli/src/commands/receive.ts           # 接收命令（已实现）
packages/cli/test/transfer-integration.test.ts # 集成测试（需重写为端到端）
packages/protocol-spec/v2-spec.md              # 协议规范
packages/core/test/vectors/*.json              # 测试向量
packages/core/scripts/generate-all-vectors.ts   # 向量生成器
D:\github项目\gemini-package.tar.gz            # Gemini 任务包
```

---

## 注意事项

1. **P1 是关键阻塞**：所有后续功能（M6 sync、npm 0.2.0）都依赖 CLI 传输修通
2. **方案 A 不通就切方案 B**（双连接），不要死磕
3. **Gemini 产出必须测试**：所有代码我都会跑一遍验证，不盲目信任
4. **E3 架构评审特别重要**：让 Gemini 对规划提意见，可能发现我遗漏的问题
5. **npm 发布需要 token**：需要有效的 npm access token（IP 限制为服务器 IP）
6. **零运行时依赖原则不变**：core/cli 不引入新 npm 依赖
7. **TypeScript strict 模式不变**：与 packages/core/tsconfig.json 一致
8. **提交规范**：英文 conventional commits，身份 luo-5 / lluo77250@gmail.com
