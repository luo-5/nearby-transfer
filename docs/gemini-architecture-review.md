# Nearby Transfer 架构与规划深度评审报告 (E3)

> **历史分析 / 非权威资料：** 本文件保留早期审查思路，可能包含未复现的
> 假设、旧版本基线或过时结论。当前能力以 docs/capabilities.md、现行规范
> 和可重复运行的测试为准；其中的数值或完成度不得作为发布承诺。

**评审对象：** Nearby Transfer 整体架构、协议设计、Strangler Fig 迁移现状及 `PROJECT_PLAN.md` 规划方案  
**评审维度：** 6 维度深度分析 + 规划改进与建设性意见

---

## 1. 架构与设计六维度深度评审

### 1.1 模块边界与职责划分
* **现有架构**：
  * `@luo-5/core`：纯粹的协议与安全核心库，**零运行时 npm 依赖**，仅依赖 `node:` 内置模块；
  * `@luo-5/cli`：命令行工具，封装核心库暴露 `send`, `receive`, `sync`, `pair`, `devices`, `trust` 等命令；
  * `@luo-5/localsend-adapter`：LocalSend 协议桥接层，处理第三方协议适配与互操作；
  * `protocol-spec`：协议权威规范（`v2-spec.md`）与确定性测试向量集。
* **评审结论**：
  模块分层边界极为清晰。Core 库与具体的 UI、CLI 彻底解耦，依赖关系为严格的单向依赖网（`cli` $\to$ `core`, `localsend-adapter` $\to$ `core`），无循环依赖。

---

### 1.2 Strangler Fig（绞杀者模式）迁移评估
* **现状**：
  旧版 Electron 桌面应用拥有 30+ 个 `.js` 模块，首批 6 个核心模块（`canonical-json`, `constants`, `pairing`, `discovery`, `transfer-manifest`, `wire-frame`）已成功替换为 `@luo-5/core` 的 re-export 适配器。
* **适配器审计**：
  * `pairing.js` 针对 `assertValidPublicIdentity` 的返回值差异增加了适配 Shim（返回 `PublicIdentity` 对象而非 void），确保了旧有 `trusted-peer-store.js` 等 3 处消费者的平滑兼容；
  * `discovery.js` 删除了非标准的下划线私有前缀（`_handleMessage` $\to$ `handleMessage`），规范了 API 命名。
* **评审结论**：
  迁移过渡策略稳健，所有既有 Smoke 测试与 CLI 测试均保持全绿。

---

### 1.3 协议层次与双层帧设计（Wire Frame + MUX Frame）
* **协议分层**：
  * **第一层（Bootstrap Wire Frame）**：用于传输前的握手、Manifest 协商与 Checkpoint 对齐。采用可读性高、自描述性强的 JSON Header + JSON Payload；
  * **第二层（Stream MUX Frame）**：用于数据流传输阶段。采用 16 字节超轻量固定前缀（`NTV2MUX1` + 帧类型 + 载荷长度），承载 Control、Chunk、Progress 帧。
* **评审结论**：
  * 双层设计兼顾了**元数据交换的灵活性**与**数据传输的高吞吐、低开销**。
  * 相比于全量 JSON 帧每块附加数十字节的 base64 编解码开销，MUX 帧直接传输二进制密文，网络开销降低 $\sim 33\%$，GC 压力显著减少。

---

### 1.4 测试策略与覆盖度评估
* **现状基线**：79 核心测试 + 21 CLI 测试 + 42 桌面 smoke 测试 + 62 互操作断言。
* **盲区与缺口分析**：
  1. **异常与边界输入**：缺乏超大嵌套 JSON、非 UTF-8 畸形字节、截断帧、乱序帧的异常拒绝测试（将在任务 B2 补齐）；
  2. **随机化与鲁棒性**：缺乏 1000+ 次随机输入的模糊测试（Fuzzing，任务 B3）；
  3. **代数不变量（Invariants）**：缺乏序列化/反序列化幂等性、确定性哈希的属性测试（Property-based Testing，任务 B4）。

---

### 1.5 代码风格与工程约束
* **TypeScript `strict: true`**：代码中几乎杜绝了 `any` 滥用（少数在 EventEmitter 回调中），类型守卫（Type Guards）如 `assertPlainObject`, `assertValidTaskId` 使用严谨；
* **零运行时依赖约束**：避免了庞大的 `node_modules` 供应链攻击风险与版本漂移，发布体积轻量，冷启动速度极快。

---

## 2. 对 `PROJECT_PLAN.md` 的建设性意见与潜在问题预警

> [!IMPORTANT]
> 以下为针对原规划中可能遗漏的技术盲区、合理性存疑决策及优化建议：

### 意见 1：Windows 跨平台文件名兼容性决策需重新审视
* **现状**：在 M1.6 核心库迁移中，为了“跨平台统一性”移除了对 Windows 保留名称（`CON`, `PRN`, `AUX`, `NUL` 等）和尾部空格/句点的检查（`MIGRATION_NOTES.md` 第 2 点）。
* **风险预警**：Nearby Transfer 的目标场景包含 Android $\to$ Windows、Linux $\to$ Windows。如果 Linux 发送方包含 `con.log`，Windows 接收端在执行 `open` 或 `mkdir` 时会被 Windows 驱动直接劫持或抛出异常。
* **建议**：在核心库 Manifest 校验中重新启用跨平台最严文件名约束（即默认采用所有平台约束的交集），并在规划中将此作为基线要求。

### 意见 2：增量同步中大文件原地修改的“漏检”风险
* **现状**：Phase 4 增量同步规划依赖快速哈希（前 1 MiB `quickHash`）与 `file.size`。
* **风险预警**：虚拟磁盘、大型日志文件、SQLite 数据库的原地修改常常只变动后半部分而保持总大小和前 1 MiB 不变，导致增量同步漏判。
* **建议**：在 `PROJECT_PLAN.md` 4.2 节将增量检测升级为 **“大小 + mtime 粗筛 $\to$ quickHash 快速过滤 $\to$ 异常回退 fullHash”** 的多级判定策略。

### 意见 3：WebDAV 模块的包组织定位
* **现状**：原规划将 WebDAV 客户端置于 `core` 或 `localsend-adapter`。
* **建议**：WebDAV 属于可选的扩展存储传输协议，建议保持 `@luo-5/core` 专注于局域网点对点核心协议，将 WebDAV 作为独立子模块或 `@luo-5/webdav` 发布，避免核心库 API 膨胀。

### 意见 4：自动化发布流水线与 Token 隔离
* **现状**：P2 发布因 npm token IP 限制失败。
* **建议**：在 Phase 6 发布流程中，将发布操作固化为 GitHub Actions `release.yml`（通过 GitHub Secret 注入颗粒度 npm Access Token），避免开发者个人 IP 变动导致发布阻塞。

---

## 3. 总体结论

Nearby Transfer 核心库在密码学协议、状态机控制与代码架构上表现优异。采纳上述关于 Windows 文件名过滤、增量判定三级阶梯以及自动化流水线的优化建议后，系统将具备极高的工业级健壮性。
