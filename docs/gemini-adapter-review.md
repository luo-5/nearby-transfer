# P4 迁移适配器审查报告 (F3)

> **历史分析 / 非权威资料：** 本文件保留早期审查思路，可能包含未复现的
> 假设、旧版本基线或过时结论。当前能力以 docs/capabilities.md、现行规范
> 和可重复运行的测试为准；其中的数值或完成度不得作为发布承诺。

**审查目标：** `src/v2/` 下 6 个 Strangler Fig（绞杀者模式）适配器文件及 `MIGRATION_NOTES.md`  
**涉及文件：**
1. `src/v2/canonical-json.js`
2. `src/v2/constants.js`
3. `src/v2/pairing.js`
4. `src/v2/discovery.js`
5. `src/v2/transfer-manifest.js`
6. `src/v2/wire-frame.js`

---

## 1. 适配器导出与行为差异逐一审查

### 1.1 `canonical-json.js`
* **导出检查**：导出 `canonicalJson`, `parseCanonicalJson`。
* **行为差异**：
  * 旧版在遇到 `undefined` 时抛出包含 `/unsupported type/` 的异常；
  * 新核心库抛出更精准的 `TypeError: Protocol value at $.key is undefined`。
  * 差异已在 Smoke 测试中同步适配（使用 `/undefined/i` 正则），不影响生产逻辑。

### 1.2 `constants.js`
* **导出检查**：完整导出 `APP_ID`, `PROTOCOL_VERSION`, `MESSAGE_TYPES`, `PAIRING_CODE_DIGITS` 等所有协议常量。无遗漏。

### 1.3 `pairing.js`
* **Shim 兼容性核验**：
  ```javascript
  function assertValidPublicIdentity(identity) {
    core.assertValidPublicIdentity(identity);
    return core.publicIdentity(identity);
  }
  ```
  * **分析**：TypeScript 核心库中 `assertValidPublicIdentity` 被重构为 TypeScript 标准的 `asserts identity is PublicIdentity`（返回 `void`）。
  * 旧版桌面调用方（`trusted-peer-store.js`, `pairing-session-store.js`）依赖其返回规范化后的身份对象。
  * 适配器增加 Shim 包装层，调用断言后返回 `core.publicIdentity(identity)`，**完美保障了向后兼容性**。
* **私有函数裁剪核验**：
  * 原模块导出了 `pairingOfferSigningPayload`, `pairingConfirmationSigningPayload`, `pairingCancelSigningPayload`。
  * 全库 Grep 扫描证实：`src/` 目录下除旧单元测试外，无任何业务代码直接依赖这三个私有构造函数，裁剪安全无副作用。

### 1.4 `discovery.js`
* **导出检查**：导出 `V2Discovery`, `DISCOVERY_PORT`, `createDiscoveryAnnouncement`, `discoveryAnnouncementSigningPayload`, `signDiscoveryAnnouncement`, `verifyDiscoveryAnnouncement`, `parseDiscoveryDatagram`, `assertValidDiscoveryAnnouncement`, `assertFreshDiscoveryAnnouncement`。
* **方法更名**：去除了私有下划线前缀（`_handleMessage` $\to$ `handleMessage`, `_prunePeers` $\to$ `prunePeers`），Smoke 测试已对齐。

### 1.5 `transfer-manifest.js` 与 `wire-frame.js`
* **导出检查**：所有 Manifest 创建、规范化、持久化解析以及 WireFrame 编解码、`WireFrameDecoder` 类均完整 re-export，无遗漏导出。

---

## 2. 结论

6 个 Strangler Fig 适配器结构精简、Shim 设计严谨，遗留差异均已在 `MIGRATION_NOTES.md` 中详尽记录，无破坏性变更或悬挂调用。
