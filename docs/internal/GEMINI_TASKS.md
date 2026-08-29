# Gemini 任务清单（更新版）

**项目：** Nearby Transfer — Node.js/Electron 桌面 + Android LAN 加密文件传输 + NAS WebDAV
**仓库 HEAD：** 3c5c153（已 push 到 GitHub）
**测试基线：** 79 核心测试 + 21 CLI 测试 + 全部桌面 smoke 测试 = 全绿
**约束：** 零运行时 npm 依赖（core/cli 只用 node: 内置模块），TypeScript strict 模式，配对安全模型（Ed25519+SAS+X25519+AES-256-GCM）不改。

## 自上次以来的变更（你需要知道的）

上次给你的代码 HEAD 是 7a10b00。过去一天我完成了 6 个阶段：

1. **P1 修通 CLI 端到端传输**：bootstrap→stream session 的 leftoverData 交接方案。改了 bootstrap.ts（返回 leftoverData）、stream-session.ts（接受 initialBuffer、awaiting-ack 状态接受 progress）、executor.ts（无初始 checkpoint 时跳过 advance）、receiver.ts（receiveWireFrame 返回 leftover）。新增 2 个 e2e 集成测试。
2. **P2 版本 bump**：0.1.0 → 0.2.0（npm publish 因 auth 失败跳过）
3. **P3 文件夹同步**：新增 sync-state.ts（增量检测）、resume-store.ts（断点续传）、conflict-resolver.ts（冲突处理）、sync.ts（CLI 命令）、sync.test.ts（5 个测试）
4. **P4 Strangler Fig 迁移**：6 个 v2 JS 模块改为 @luo-5/core re-export 适配器（canonical-json, constants, pairing, discovery, transfer-manifest, wire-frame）。pairing.js 需要 assertValidPublicIdentity 返回值的兼容 shim。MIGRATION_NOTES.md 记录了所有差异。
5. **P5 安全加固**：新增 timing-safe-compare.ts（常量时间比较）、security.test.ts（12 个安全测试）。验证了 nonce 唯一性、DoS 限制、路径遍历防护、签名验证用 crypto.verify。
6. **P6 CHANGELOG + README**：更新了 CHANGELOG.md 和 README.md。

## 任务变更

### 删除（已完成）
- ~~A2 常量时间比较~~ → 已创建 timing-safe-compare.ts
- ~~D1 增量同步模块~~ → 已创建 sync-state.ts + resume-store.ts + conflict-resolver.ts

### 保留（仍然需要）
- A1 安全审计报告（8 维度逐文件审计）
- A3 DoS 防护加固（速率限制器、连接限制器、安全 JSON 解析器）
- A4 密钥卫生审计
- B1 Python 参考实现（7 个 .py + verify_vectors.py）
- B2 边界测试
- B3 模糊测试
- B4 属性测试
- C1 性能分析报告
- C2 热路径优化
- C3 基准脚本
- D2 WebDAV 客户端
- E1 CI/CD
- E2 文档套件 + README
- E3 架构与规划评审

### 新增（基于最近的工作）
- F1 P1 修复代码审查：审查 leftoverData 交接方案的正确性、竞态条件、边界情况
- F2 P3 同步实现代码审查：审查目录扫描、增量检测、冲突处理的正确性
- F3 P4 迁移适配器审查：审查 6 个 re-export 适配器是否有遗漏的行为差异
- F4 跨机测试方案：设计三对跨机传输测试（Ubuntu↔CentOS, Ubuntu↔Windows, CentOS↔Windows）
- F5 大文件压力测试：1GB+ 文件、10k 小文件、传输中断恢复
- F6 npm 发布脚本：pre-publish 检查 + 版本一致性验证

## 任务详情

### A1 安全审计报告
逐文件审计 packages/core/src/ 的全部源码，从 8 个维度：
1. 时序侧信道（timing side-channel）
2. Nonce 碰撞概率
3. 密钥卫生（key lifecycle: generation, usage, wiping, zeroing）
4. 路径遍历
5. DoS（资源耗尽、内存放大）
6. 规范 JSON 攻击（duplicate keys, BOM, integer overflow）
7. 重放保护（nonce reuse, checkpoint chain）
8. TLS 配置（cert-manager.js 如果在参考材料中）

产出：security-audit-report.md，每个发现标注严重性（Critical/High/Medium/Low/Info）。

### A3 DoS 防护加固
实现 3 个模块到 packages/core/src/security/（新建目录）：
- rate-limiter.ts：滑动窗口速率限制器，限制每 IP 每秒连接数
- connection-limiter.ts：并发连接限制器，限制同时活跃连接数
- safe-json-parse.ts：安全 JSON 解析器，限制深度、键长度、值长度

每个模块含单元测试。API 设计要能被 lan-service.ts 和 receiver.ts 使用。

### A4 密钥卫生审计
追踪 5 种密钥的生命周期：
1. Ed25519 签名私钥（设备身份）
2. X25519 加密私钥（设备身份）
3. X25519 临时密钥（每传输一次）
4. AES-256-GCM 会话密钥（ECDH 派生）
5. Nonce（每 chunk 一个）

检查：生成是否安全（crypto.randomBytes/createKeyPairSync）、使用后是否 fill(0)、是否有泄漏路径（日志、异常消息、JSON 序列化）。

### B1 Python 参考实现
用纯 Python（只用 hashlib, cryptography, json, struct, base64, os）实现：
- identity.py：Ed25519 密钥生成、deviceId 派生、fingerprint
- session.py：X25519 ECDH 会话密钥派生
- chunk.py：AES-256-GCM 加密/解密、AAD 构建
- canonical-json.py：规范 JSON 序列化/解析
- wire-frame.py：wire frame 编解码
- chunk-frame.py：chunk frame 编解码
- verify_vectors.py：读取 3 个 test vectors JSON 文件，验证全部 10 组向量

### B2 边界测试
6 个 .test.ts 文件，测试异常路径：
- canonical-json-edge.test.ts：超大数字、嵌套深、空输入、非 UTF-8
- manifest-edge.test.ts：空 manifest、超长路径、超大文件、重复条目
- crypto-edge.test.ts：空密钥、错误密钥类型、篡改密文
- wire-frame-edge.test.ts：截断帧、零长度、超大帧、重复帧
- discovery-edge.test.ts：过期公告、时钟偏移、篡改签名、重复 deviceId
- control-edge.test.ts：乱序控制消息、重复 hello、取消后发数据

### B3 模糊测试
4 个 fuzz-*.ts 文件，每个 1000 次随机输入：
- fuzz-canonical-json.ts：随机 JSON 值 round-trip
- fuzz-wire-frame.ts：随机帧编码→解码→比较
- fuzz-chunk-crypto.ts：随机明文加密→解密→比较
- fuzz-manifest.ts：随机 manifest 构建→序列化→解析→比较

### B4 属性测试
6 个不变式（每个 100 次随机输入）：
- canonical-json 幂等性：canonicalJson(canonicalJson(x)) === canonicalJson(x)
- wire-frame round-trip：decode(encode(f)) deepEqual f
- chunk crypto round-trip：decrypt(encrypt(p)) === p
- nonce 唯一性：n 次加密产生 n 个不同 nonce
- deviceId 确定性：相同公钥总是产生相同 deviceId
- manifest 序列化确定性：相同 manifest 总是产生相同字节

### C1 性能分析报告
分析 6 条热路径：
1. canonicalJson 序列化（每个控制消息都调）
2. encryptChunk / decryptChunk（每 4MB 调一次）
3. wire frame 编解码（每消息调）
4. MUX envelope 编解码（每 chunk 调）
5. SHA-256 哈希（manifest 构建 + 接收验证）
6. ECDH 密钥派生（每传输一次）

每条路径：分析瓶颈、建议优化方向、预估吞吐量影响。

### C2 热路径优化
基于 C1 报告实现优化（API 不变 + 测试通过才保留）：
- optimized-canonical-json.ts：预分配 Buffer、减少字符串拼接
- optimized-wire-frame.ts：避免重复 Buffer.alloc
- optimized-chunk-aad.ts：批量 AAD 构建
- buffer-pool.ts：Buffer 对象池减少 GC 压力

### C3 基准脚本
3 个基准脚本：
- benchmark-crypto.ts：加密吞吐量（MB/s）
- benchmark-transfer.ts：传输吞吐量（本地 loopback）
- benchmark-serialization.ts：序列化延迟（μs/op）

### D2 WebDAV 客户端
零依赖轻量 WebDAV 客户端（只用 node:http/https）：
- PROPFIND（Depth: 0/1/infinity）
- GET / PUT（带 Range 支持）
- DELETE / MKCOL / MOVE / COPY
- 基本认证 + Bearer token
- TLS 自签名证书支持

### E1 CI/CD
5 个 GitHub Actions workflow：
- ci.yml：push/PR 触发，tsc + tsx --test + node --check
- docker.yml：tag 触发，构建 Docker 镜像推送 GHCR
- release.yml：tag 触发，npm publish + GitHub Release
- codeql.yml：定期安全扫描
- stale.yml：自动关闭陈旧 issue/PR

### E2 文档套件 + README
- docs/architecture.md：模块边界、数据流、协议层次
- docs/security.md：威胁模型、密钥管理、安全边界
- docs/api-reference.md：@luo-5/core 全部公开 API
- CONTRIBUTING.md：开发流程、代码规范、提交规范
- README.md 大改版：中英双语、badge 行、对比表、3 种快速开始、架构图、路线图

### E3 架构与规划评审
6 维度深度评审：
1. 模块边界：core/cli/localsend-adapter/protocol-spec 的职责是否清晰
2. Strangler fig 迁移：6 个适配器是否正确，是否有遗漏
3. 协议设计：v2 wire frame + MUX frame 双层是否合理
4. 测试策略：79 核心测试覆盖是否充分，缺什么
5. 规划评审：PROJECT_PLAN.md 的 6 阶段是否合理，有无遗漏
6. 代码风格：TypeScript strict + 零依赖约束是否带来问题

**特别要求：** 对规划提意见，指出可能遗漏的问题或合理性存疑的决策。

### F1 P1 修复代码审查
审查以下文件的变更（对比 7a10b00 → 3c5c153）：
- packages/core/src/transfer/bootstrap.ts：leftoverData 返回逻辑
- packages/core/src/transfer/stream-session.ts：initialBuffer 喂给 decoder、awaiting-ack 接受 progress
- packages/core/src/transfer/executor.ts：无初始 checkpoint 时跳过 advance
- packages/core/src/transfer/receiver.ts：receiveWireFrame 返回 leftover

检查：竞态条件（initialBuffer 和 resume() 的时序）、边界情况（空 leftover、大 leftover）、错误路径（leftover 被丢弃时的影响）。

### F2 P3 同步实现代码审查
审查：
- packages/core/src/transfer/sync-state.ts：quickHash/fullHash/planIncrementalSync
- packages/core/src/transfer/resume-store.ts：JSON 持久化
- packages/core/src/transfer/conflict-resolver.ts：rename-new 逻辑
- packages/cli/src/commands/sync.ts：目录扫描、manifest 构建

检查：大目录扫描的内存占用、增量检测的准确性（mtimeMs 未使用是否是问题）、冲突命名的边界情况。

### F3 P4 迁移适配器审查
审查 src/v2/ 下 6 个适配器文件 + MIGRATION_NOTES.md：
- canonical-json.js, constants.js, pairing.js, discovery.js, transfer-manifest.js, wire-frame.js

检查：是否有遗漏的导出、pairing.js 的 assertValidPublicIdentity shim 是否正确、是否有其他 v2 文件依赖被删除的 *SigningPayload 函数。

### F4 跨机测试方案
设计三对跨机传输测试方案（Ubuntu↔CentOS, Ubuntu↔Windows, CentOS↔Windows）：
- 每对的测试步骤（发现→配对→传输→验证）
- 预期结果和验证方法
- 网络障碍排查清单（multicast 路由、防火墙）
- 回归测试脚本（自动化执行）

### F5 大文件压力测试
设计并实现压力测试脚本：
- 1GB 单文件传输（验证内存使用、SHA-256 正确性）
- 10k 小文件目录同步（验证 manifest 构建时间、传输顺序）
- 传输中断恢复（kill -9 后 resume）

### F6 npm 发布脚本
写一个 publish.sh 脚本：
- 检查 git 工作树干净
- 检查版本号一致性（core/cli/root）
- 构建 + 测试
- npm publish（core 然后 cli）
- npm view 验证
- git tag

## 优先级

A1 > F1 > B1 > F2 > E3 > A3 > C1 > B2 > F3 > E2 > B3 > A4 > C2 > B4 > C3 > E1 > D2 > F4 > F5 > F6
