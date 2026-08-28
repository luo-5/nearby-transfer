# Nearby Transfer 项目交接文档

**交接日期：** 2026-08-28
**当前 HEAD：** 自动提交中
**GitHub：** https://github.com/luo-5/nearby-transfer.git
**分支：** main
**git 身份：** luo-5 / lluo77250@gmail.com

---

## 一、项目概览

Nearby Transfer 是一个局域网加密文件传输 + NAS WebDAV 应用，包含：
- **桌面端**：Electron app（Linux/Windows），所有 `src/v2/*.js` 模块已通过 Strangler Fig 模式全部迁移至 TS 核心库及薄适配层
- **核心库** `@luo-5/core`：纯 TypeScript，零运行时 npm 依赖，46 个源文件，124 个单元/模糊/属性测试 100% 通过
- **CLI 工具** `@luo-5/cli`：6 个命令（send/receive/sync/devices/pair/trust），21 个测试（含 2 个 e2e 及 5 个 sync 增量测试）100% 通过
- **LocalSend 适配器** `@luo-5/localsend-adapter`：LocalSend 协议桥接
- **协议规范** `packages/protocol-spec/v2-spec.md`：11 章 + 10 组测试向量
- **Python 参考实现** `packages/python-ref/`：10 个 .py，全部 10 组向量验证 100% 通过
- **性能基准与优化** `benchmarks/`：Crypto throughput (~700 MB/s), TCP loopback (~250 MB/s)
- **Android 客户端**：`android-app/`，独立 Kotlin/Java 项目

### 技术栈
- v2 协议：Ed25519 签名 + X25519 ECDH + AES-256-GCM chunk 加密 + SAS 6 位配对码
- 传输：TCP + UDP multicast 发现（239.255.77.77:47777）
- 框架：Node 24+ / Electron 43 / TypeScript strict / tsup 构建
- 约束：core/cli 零运行时 npm 依赖（只用 node: 内置模块）

---

## 二、当前完成状态

### ✅ 已完成

| 模块 | 详情 | 状态 |
|------|------|------|
| 核心库 @luo-5/core 0.2.0 | 46 TS 文件，124 测试全绿，零运行时依赖 | ✅ 100% |
| CLI @luo-5/cli 0.2.0 | send/receive/sync/devices/pair/trust，21 测试全绿 | ✅ 100% |
| 端到端传输 | bootstrap→stream session leftoverData 交接与 pause 生命周期修复，e2e 测试全绿 | ✅ 100% |
| 文件夹增量同步 | sync-state（增量检测）、resume-store（断点续传）、conflict-resolver（冲突处理） | ✅ 100% |
| 安全加固 | timing-safe 比较、Windows 保留名校验、路径遍历防护、nonce 唯一性、DoS 限制、密钥擦除 | ✅ 100% |
| Strangler Fig 第 1-2 批 | 6 个基础及加密模块迁移为 @luo-5/core re-export 适配器 | ✅ 100% |
| Strangler Fig 第 3 批 (3a/3b/3c) | 全部 25 个 v2 JS 模块完成 TS 迁移与适配，41 套桌面 smoke/stress 测试全绿 | ✅ 100% |
| 协议规范 | v2-spec.md 11 章 + 10 组确定性测试向量 | ✅ 100% |
| Python 参考实现 | 10 个 .py，10/10 向量验证全部通过 | ✅ 100% |
| Gemini 性能基准 | Crypto (~700 MB/s), TCP loopback (~250 MB/s), 序列化基准验证 | ✅ 100% |
| Docker 构建 | CentOS 上 Docker CE 29.7.2，镜像构建成功，`docker run --help` 正常 | ✅ 100% |
| 跨机测试 | 3/3 通过：Ubuntu→CentOS ✅、Windows→Ubuntu ✅、Windows→CentOS ✅ | ✅ 100% |
| CI/CD | 5 个 GitHub Actions workflow（ci/docker/release/codeql/stale） | ✅ 100% |

### 测试统计
- 核心：124 个测试（含 12 安全 + 35 边界 + 5 模糊 + 6 属性 + 10 安全模块）
- CLI：21 个测试（含 2 e2e + 5 sync + 5 unit + 9 其他）
- 桌面 smoke：41 套 smoke / stress / interop 全部通过
- Python 向量：10/10 通过
- TypeScript strict 编译 (`exactOptionalPropertyTypes: true`)：零错误

---

## 三、待处理项

| 项目 | 状态 | 阻塞 |
|------|------|------|
| npm 0.2.0 发布 | 版本已 bump，代码已构建，publish.sh 就绪 | 需要有效 npm token |

---

## 四、验证命令

```bash
# 1. 核心与 CLI 构建
npm run build:core

# 2. TypeScript 严格类型检查与语法检查
npm run typecheck:core
npm run check

# 3. 核心单元、模糊与属性测试
npm run test:core

# 4. 桌面端全量 Smoke & Stress 测试
npm test

# 5. CLI 与 端到端传输/同步测试
npx tsx --test packages/cli/test/cli.test.ts packages/cli/test/sync.test.ts packages/cli/test/transfer-integration.test.ts

# 6. Python 参考实现与 10 组测试向量验证
python packages/python-ref/verify_vectors.py

# 7. 性能基准测试
npx tsx benchmarks/benchmark-serialization.ts
npx tsx benchmarks/benchmark-crypto.ts
npx tsx benchmarks/benchmark-transfer.ts
```
