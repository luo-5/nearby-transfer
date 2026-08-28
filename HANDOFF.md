# Nearby Transfer 项目交接文档

**交接日期：** 2026-08-26
**当前 HEAD：** `8c17297`
**GitHub：** https://github.com/luo-5/nearby-transfer.git
**分支：** main
**git 身份：** luo-5 / lluo77250@gmail.com

---

## 一、项目概览

Nearby Transfer 是一个局域网加密文件传输 + NAS WebDAV 应用，包含：
- **桌面端**：Electron app（Linux/Windows），旧 JS 实现在 `src/v2/*.js`（31 文件），正在逐步迁移到 TS 核心库
- **核心库** `@luo-5/core`：纯 TypeScript，零运行时 npm 依赖，46 个源文件，124 个测试
- **CLI 工具** `@luo-5/cli`：6 个命令（send/receive/sync/devices/pair/trust），21 个测试
- **LocalSend 适配器** `@luo-5/localsend-adapter`：LocalSend 协议桥接
- **协议规范** `packages/protocol-spec/v2-spec.md`：11 章 + 10 组测试向量
- **Python 参考实现** `packages/python-ref/`：10 个 .py，全部 10 组向量验证通过
- **Android 客户端**：`android-app/`，独立 Kotlin/Java 项目（本轮未改动）

### 技术栈
- v2 协议：Ed25519 签名 + X25519 ECDH + AES-256-GCM chunk 加密 + SAS 6 位配对码
- 传输：TCP + UDP multicast 发现（239.255.77.77:47777）
- 框架：Node 24+ / Electron 43 / TypeScript strict / tsup 构建
- 约束：core/cli 零运行时 npm 依赖（只用 node: 内置模块）

---

## 二、当前完成状态

### ✅ 已完成

| 模块 | 详情 |
|------|------|
| 核心库 @luo-5/core 0.2.0 | 46 TS 文件，124 测试全绿，零依赖 |
| CLI @luo-5/cli 0.2.0 | send/receive/sync/devices/pair/trust，21 测试全绿 |
| 端到端传输 | bootstrap→stream session leftoverData 交接修复，2 个 e2e 测试 |
| 文件夹同步 | sync-state（增量检测）、resume-store（断点续传）、conflict-resolver（冲突处理） |
| 安全加固 | timing-safe 比较、Windows 保留名校验、路径遍历防护、nonce 唯一性（1000 次验证）、DoS 限制、密钥异常擦除 |
| Strangler Fig 1-2 批 | 6 个 v2 JS 模块迁移为 @luo-5/core re-export 适配器 |
| 协议规范 | v2-spec.md 11 章 + 10 组确定性测试向量 |
| Python 参考实现 | 10 个 .py，10/10 向量验证通过 |
| Gemini 整合 | 安全审计修复 + 46 新测试 + 3 个安全模块 + 4 个优化模块 + CI/CD + 文档 |
| Docker 构建 | CentOS 上 Docker CE 29.7.2，镜像构建成功，`docker run --help` 正常 |
| 跨机测试 | 3/3 通过：Ubuntu→CentOS ✅、Windows→Ubuntu ✅、Windows→CentOS ✅ |
| CI/CD | 5 个 GitHub Actions workflow（ci/docker/release/codeql/stale） |
| 文档 | 架构、安全、API 参考、CONTRIBUTING、CHANGELOG、Gemini 审查报告 |

### 测试统计
- 核心：124 个测试（含 12 安全 + 35 边界 + 5 模糊 + 6 属性 + 10 安全模块）
- CLI：21 个测试（含 2 e2e + 5 sync + 5 unit + 9 其他）
- 桌面 smoke：30+ 项全绿
- Python 向量：10/10 通过
- TypeScript strict 编译：通过

### ⏳ 待处理

| 项目 | 状态 | 阻塞 |
|------|------|------|
| npm 0.2.0 发布 | 版本已 bump，代码已构建，publish.sh 就绪 | 需要有效 npm token |
| Gemini 优化模块接入 | 4 个优化文件已导出到 index.ts（实验性） | 未替换热路径，需基准对比后决定 |
| Strangler Fig 3 批 | 25 个 v2 JS 模块未迁移 | 分 3 层：3a(7 纯逻辑) → 3b(10 fs/net) → 3c(8 Electron) |

---

## 三、关键文件路径

```
packages/core/src/                    # 核心库源码（46 个 TS 文件）
packages/core/src/index.ts            # 核心库导出入口
packages/core/src/transfer/           # 传输模块（bootstrap/stream-session/executor/receiver/sync-state 等）
packages/core/src/crypto/             # 加密模块（identity/session/chunk/timing-safe-compare）
packages/core/src/security/           # DoS 防护（rate-limiter/connection-limiter/safe-json-parse）
packages/core/src/optimizations/      # 性能优化（buffer-pool/optimized-canonical-json 等，实验性）
packages/core/test/                   # 测试（20 个文件，124 个测试）
packages/core/test/vectors/            # 测试向量 JSON
packages/cli/src/                      # CLI 源码（8 个 TS 文件）
packages/cli/test/                     # CLI 测试
packages/cli/Dockerfile               # Docker 构建（已验证）
packages/python-ref/                  # Python 参考实现
packages/protocol-spec/v2-spec.md     # 协议规范
src/v2/*.js                           # 桌面端旧 JS（31 文件，6 个已迁移为 re-export）
scripts/cross-transfer.mjs            # 跨机传输测试脚本
publish.sh                            # npm 发布脚本
SKIPPED.md                            # 待处理项清单
MIGRATION_NOTES.md                    # 迁移差异记录
CHANGELOG.md                          # 变更日志
```

---

## 四、待完成工作详细规划

### 4.1 npm 0.2.0 发布（最高优先级）
```
npm login
npm publish --workspace @luo-5/core
npm publish --workspace @luo-5/cli
npm view @luo-5/core@0.2.0  # 验证
```
或用 `publish.sh`（会先检查 git 干净、版本一致、构建、测试）。

### 4.2 Strangler Fig 第 3 批迁移
src/v2/ 下 25 个文件仍是原始 JS。core 已有对应的 TS 实现，用 re-export 适配器替换。

**3a（低风险，纯逻辑，7 个）：**
- transfer-message-codec.js → core transfer/message-codec.ts
- transfer-message-auth.js → core transfer/message-auth.ts
- transfer-chunk-frame.js → core transfer/chunk-frame.ts
- transfer-session-crypto.js → core crypto/session.ts
- transfer-source-manifest.js → core transfer/source-manifest.ts
- signed-stream-control.js → core transfer/control.ts
- message-codec.js → core pairing/message-codec.ts

**3b（中风险，fs/net 依赖，10 个）：**
- encrypted-chunk-reader.js → core transfer/encrypted-reader.ts
- encrypted-chunk-writer.js → core transfer/encrypted-writer.ts
- receive-target-planner.js → core transfer/receive-planner.ts
- transfer-job-store.js → core transfer/job-store.ts
- pairing-session-store.js → core pairing/session-store.ts（SQLite→JSON）
- trusted-peer-store.js → core pairing/trust-store.ts（SQLite→JSON）
- transfer-stream-session.js → core transfer/stream-session.ts
- desktop-transfer-bootstrap.js → core transfer/bootstrap.ts
- desktop-transfer-executor.js → core transfer/executor.ts
- desktop-transfer-scheduler.js → core transfer/scheduler.ts

**3c（高风险，Electron 依赖，8 个）：**
- lan-service.js → core transport/lan-service.ts
- pairing-router.js → core pairing/router.ts
- desktop-pairing-api.js / desktop-lan-api.js / desktop-library-api.js / desktop-transfer-job-api.js → Electron IPC 适配层
- desktop-library-service.js（WebDAV）→ 保持原位
- cert-manager.js（TLS 证书）→ 保持原位

**每步验收：** `node --check src/v2/*.js` + `npm test` 全绿 + `npm start`（Electron）不报错。

**注意迁移历史教训：**
- pairing.js 的 `assertValidPublicIdentity` 在 core 里是 void，旧 JS 期望返回 normalized identity → 需要包装 shim
- pairing.js 的 3 个 `*SigningPayload` 函数在 core 里是 private → 需要在 shim 中重新实现
- discovery.js 的 `_handleMessage`/`_prunePeers` 在 core 里改名为 `handleMessage`/`prunePeers` → 测试需要更新
- `assertValidRelativePath` 在 core 里不检查 Windows 保留名 → 已在 manifest-validation.ts 中添加
- 桌面 smoke 测试可能因为错误消息变化而失败 → 需要更新 regex

### 4.3 Gemini 优化模块
`packages/core/src/optimizations/` 下 4 个文件已导出到 index.ts 但未接入热路径。需要：
1. 跑 `benchmarks/benchmark-*.ts` 获取基线性能数据
2. 逐个替换热路径：canonical-json → wire-frame → chunk-aad → buffer-pool
3. 每次替换后跑测试 + 基准对比，确认 API 不变 + 性能提升 + 测试通过

### 4.4 跨机测试（已完成但可重复运行）
```bash
# 在宿主机上
python run-cross-tests.py          # 自动跑三对
python manual-test.py              # 手动跑单对
python test-windows-sender.py      # Windows 做 sender
```
注意：Windows VM（NAT 模式）入站端口不可达，只能做出站 sender。

### 4.5 Docker
Docker 构建已在 CentOS (192.168.80.130) 上验证通过。重建：
```bash
ssh l@192.168.80.130
cd ~/nearby-transfer
sudo docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
sudo docker run --rm nearby-transfer-cli --help
```

---

## 五、三台测试机器信息

| 机器 | IP | SSH 用户/密码 | Node | 角色 |
|------|-----|-------------|------|------|
| Windows 宿主机 | 192.168.80.1 | 本机 | v24.19.0 | 开发 + 测试 |
| Ubuntu VM | 192.168.80.128 | l / 123 | v24.19.0 | 测试 |
| CentOS VM | 192.168.80.130 | l / 123 | v24.19.0 | 测试 + Docker |
| Windows VM | 192.168.80.129 | 31752 / 123 | v24.6.0 | 测试（NAT，只能出站） |

Windows VM 装了 portable OpenSSH（`C:\Program Files\OpenSSH`），防火墙已全关。仓库在 `C:\nearby-transfer`。

---

## 六、Gemini 已完成的任务（参考）

上一轮 Gemini 产出了 20 个任务，全部已整合：
- A1 安全审计（8 维度报告，发现 SEC-01~08）
- A3 DoS 防护模块（rate-limiter/connection-limiter/safe-json-parse）
- A4 密钥卫生审计
- B1 Python 参考实现（10 .py + verify_vectors.py）
- B2 边界测试（7 个 .test.ts，35 个 test）
- B3 模糊测试（4 个 fuzz-*.ts，每个 1000 次）
- B4 属性测试（6 个不变式，每个 100 次）
- C1 性能分析报告
- C2 热路径优化模块（4 个，已导出但未接入）
- C3 基准脚本（3 个 benchmark-*.ts）
- D2 WebDAV 客户端
- E1 CI/CD（5 个 GitHub Actions workflow）
- E2 文档套件（architecture/security/api-reference/CONTRIBUTING）
- E3 架构评审（6 维度 + 规划意见）
- F1 P1 修复审查（确认 leftoverData 方案正确）
- F2 P3 同步审查（发现 OOM + mtimeMs + 原子写入问题，已修复）
- F3 迁移适配器审查
- F4 跨机测试方案
- F5 压力测试脚本
- F6 npm 发布脚本

---

## 七、约束和规范

1. **零运行时 npm 依赖**：core/cli 只用 node: 内置模块，不引入新依赖
2. **TypeScript strict 模式**：与 packages/core/tsconfig.json 一致
3. **exactOptionalPropertyTypes: true**：不能直接传 undefined 给 optional 属性，用条件展开 `...(cond ? { prop: value } : {})`
4. **提交规范**：英文 conventional commits，身份 luo-5 / lluo77250@gmail.com
5. **安全模型不变**：Ed25519 签名 + SAS 双向比对码 + X25519 ECDH + AES-256-GCM
6. **测试用 npx tsx --test**（不用 vitest，vitest 不支持 node:test 风格）
7. **不要在 PROJECT_PLAN.md / SKIPPED.md 等文件中放 npm token**（GitHub push protection 会拦截）

---

## 八、给 Gemini 的建议

1. 先读 `SKIPPED.md` 了解待处理项
2. 先读 `MIGRATION_NOTES.md` 了解迁移差异（避免重蹈覆辙）
3. 做 Strangler Fig 3 批迁移时，每迁一个模块就跑 `node --check` + `npm test`
4. 如果 pairing.js 迁移有问题，参考已有的 shim（assertValidPublicIdentity 返回值 + *SigningPayload 重新实现）
5. 桌面 smoke 测试在 Linux 上可能因为 Windows 保留名校验的添加而失败 → 需要更新测试
6. Docker 构建需要在 Dockerfile 中加 `@types/node` 步骤（已修好）
7. 跨机测试时 Windows VM 只能做 sender（NAT 限制）
8. 优化模块接入热路径前先跑 `benchmarks/` 获取基线
