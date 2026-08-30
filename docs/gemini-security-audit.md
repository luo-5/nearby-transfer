# Nearby Transfer 核心库（@luo-5/core）全量安全审计报告 (A1)

> **历史分析 / 非权威资料：** 本文件保留早期审查思路，可能包含未复现的
> 假设、旧版本基线或过时结论。当前能力以 docs/capabilities.md、现行规范
> 和可重复运行的测试为准；其中的数值或完成度不得作为发布承诺。

**审计基线：** `@luo-5/core@0.2.0` (commit `3c5c153`)  
**审计范围：** `packages/core/src/` 全部源码（23 个 TypeScript 核心模块，覆盖 `crypto/`, `discovery/`, `pairing/`, `protocol/`, `transfer/`, `transport/`）  
**审计维度：** 8 大安全维度（时序侧信道、Nonce 碰撞、密钥卫生、路径遍历、DoS/资源耗尽、规范 JSON 攻击、重放保护、TLS 配置）

---

## 漏洞与风险汇总表

| 编号 | 严重级别 | 安全维度 | 涉及模块 / 文件 | 简要描述 |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **High** | 路径遍历 / 注入 | `manifest.ts`<br>`manifest-validation.ts` | `isWindowsReservedName` 未在核心校验中生效，Windows 保留设备名（`CON`, `NUL`, `AUX` 等）可能导致系统拒绝服务或文件系统异常 |
| **SEC-02** | **High** | 密钥卫生 | `session.ts`<br>`identity.ts`<br>`control.ts` | PEM 格式密钥及派生的会话密钥在部分异常路径和垃圾回收前未保证零化（zeroization），可能在堆内存转储中泄漏 |
| **SEC-03** | **Medium** | DoS / 资源耗尽 | `lan-service.ts`<br>`discovery/index.ts` | 缺少针对单 IP 的细粒度滑动窗口速率限制（Rate Limiter）及慢速连接攻击防护（Slowloris） |
| **SEC-04** | **Medium** | 重放保护 / 时钟偏移 | `discovery/index.ts`<br>`control.ts` | `DISCOVERY_MAX_CLOCK_SKEW_MS` (30s) 与 TTL 窗口内存在广播重放攻击窗口；未记录已消费的广播签名缓存 |
| **SEC-05** | **Medium** | 时序侧信道 | `crypto/timing-safe-compare.ts` | `timingSafeEqualStrings` 在字符串长度不同时直接短路返回 `false`，存在微小的长度探测侧信道 |
| **SEC-06** | **Low** | 规范 JSON 解析 | `canonical-json.ts` | JSON 反序列化后使用内置 `JSON.parse`，存在潜在的 `__proto__` 键原型污染边界以及高并发下的重序列化开销 |
| **SEC-07** | **Low** | Nonce 碰撞与重用 | `session.ts` | 采用纯随机 96-bit Nonce，虽然在单会话内碰撞概率极低，但在传输超大规模文件（如 $>10^6$ chunks）时推荐确定性计数器派生 Nonce 增强确定性界限 |
| **SEC-08** | **Info** | TLS 与网络层传输 | `transport/lan-service.ts`<br>`desktop-v2/cert-manager.js` | 核心协议层采用应用层加密（X25519+AES-GCM），未强制底层 TLS；若接入 WebDAV，需确保证书 SAN 扩展与自签名校验逻辑严格隔离 |

---

## 逐维度深度审计详情

---

### 维度 1：时序侧信道（Timing Side-Channel）

#### 1.1 现状与分析
* **正面发现**：
  * 项目在 P5 阶段引入了 `timing-safe-compare.ts`，并在 `control.ts` 的 `assertLocalPublicKeyMatches` 中使用了 `crypto.timingSafeEqual`。
  * Ed25519 签名验证统一使用 `crypto.verify(null, payload, key, signature)`，底层由 Node.js OpenSSL C++ 绑定实现常量时间验证。
  * SAS 配对码比对在 `pairing/sas.ts` 中通过哈希运算和格式化比较完成。
* **发现缺陷 (SEC-05)**：
  在 `packages/core/src/crypto/timing-safe-compare.ts` 中：
  ```typescript
  export function timingSafeEqualStrings(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
  ```
  `a.length !== b.length` 的快速返回在防御高精度远程或本地跨核时钟攻击时会泄露目标字符串长度。
* **修复建议**：
  对输入计算固定长度的 HMAC 或 SHA-256 哈希后再执行常量时间比对：
  ```typescript
  export function timingSafeEqualStrings(a: string, b: string): boolean {
    const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
    const match = crypto.timingSafeEqual(hashA, hashB);
    return match && a.length === b.length;
  }
  ```

---

### 维度 2：Nonce 碰撞概率与重用（Nonce Reuse & Collision）

#### 2.1 现状与分析
* **分析对象**：`packages/core/src/crypto/session.ts` (Line 136)
  ```typescript
  const nonce = crypto.randomBytes(NONCE_BYTES); // 12 bytes = 96 bits
  ```
* **碰撞概率建模**：
  根据生日悖论，在同一个 256-bit 会话密钥下，生成 $N$ 个 96-bit 随机 Nonce 的碰撞概率近似为：
  $$P(\text{collision}) \approx \frac{N^2}{2 \times 2^{96}} = \frac{N^2}{2^{97}}$$
  * 传输 1 TiB 文件（以 1 MiB chunk 计，$N = 10^6$）：
    $$P \approx \frac{10^{12}}{1.58 \times 10^{29}} \approx 6.3 \times 10^{-18}$$
    碰撞概率在数学上极其微小，且每个传输任务都有独立通过 X25519 临时密钥派生的 `sessionKey`，因此跨任务 Key-Nonce 重用被彻底杜绝。
* **AAD 绑定保护**：
  `buildChunkAad` 严格绑定了 `taskId`, `path`, `offset`, `sequence`, `plainLength`：
  ```typescript
  encodeFields([CONTEXT, CHUNK_AAD_LABEL, metadata.taskId, metadata.path]),
  encodeSafeInteger(metadata.offset),
  encodeSafeInteger(metadata.sequence),
  encodeUint32(metadata.plainLength)
  ```
  即使攻击者捕获了密文，也无法进行 Chunk 乱序插入、替换或跨文件重放攻击。
* **改进建议 (SEC-07)**：
  为了彻底消除随机数发生器潜在弱随机性导致的 Nonce 碰撞风险，建议采用 **Deterministic Nonce** 构造方案：
  $$\text{Nonce} = \text{HKDF-Expand}(\text{SessionKey}, \text{"nonce"} \parallel \text{sequence}, 12)$$
  或者使用 4-byte 随机前缀 + 8-byte 单调递增 `sequence`。

---

### 维度 3：密钥卫生（Key Lifecycle & Hygiene）

#### 3.1 现状与分析
* **5 类密钥生命周期**：
  1. `Ed25519` 设备身份私钥（持久化于本地存储，PEM 格式）；
  2. `X25519` 设备身份私钥（持久化，PEM 格式）；
  3. `X25519` 临时传输私钥（`executor.ts` 每任务动态生成）；
  4. `AES-256-GCM` 会话密钥（HKDF 派生，32 字节 Buffer）；
  5. `Nonce`（12 字节 Buffer）。
* **发现缺陷 (SEC-02)**：
  1. `deriveSessionKey` 实现了 `sharedSecret.fill(0)`，这是良好的实践。但在 `executor.ts` (Line 137) 与 `receiver.ts` (Line 168) 中：
     ```typescript
     const done = session.start().then(() => { sessionKey.fill(0); }).catch((error) => { sessionKey.fill(0); throw error; });
     ```
     如果 `createTransferStreamSession` 初始化同步抛出异常，`sessionKey` 不会触发 `fill(0)` 擦除。
  2. Node.js `crypto.generateKeyPairSync` 返回的 PEM 字符串属于 V8 引擎不可变字符串堆内存，无法通过 JavaScript 手动 zero-fill。
* **修复建议**：
  1. 在 `executor.ts` 和 `receiver.ts` 中使用 `try...finally` 块封装整个会话生命周期，保证密钥在任何同步/异步异常时均被 `fill(0)`。
  2. 针对 X25519 临时密钥，尽量使用 `KeyObject` 或 Raw Buffer 处理并在使用后显式释放。

---

### 维度 4：路径遍历防护（Path Traversal）

#### 4.1 现状与分析
* **分析对象**：`manifest-validation.ts`, `manifest.ts`, `receive-planner.ts`, `encrypted-writer.ts`
* **现有防护机制**：
  1. 必须为 POSIX 相对路径，禁止以 `/`、`\` 或盘符 `C:` 开头；
  2. 禁止 `.` 与 `..` 组件；
  3. 禁止包含 `\0` 与 Windows 非法字符（`< > : " / \ | ? *`）；
  4. `receive-planner.ts` 通过 `path.relative(root, target)` 强制执行 `assertContained`，杜绝溢出目标接收目录；
  5. 检查软链接：`staging` 目录各层级校验 `lstat`，拒绝符号链接与 Junction 挂载点。
* **发现缺陷 (SEC-01 - High)**：
  在 `manifest.ts` 中，`isWindowsReservedName`（检查 `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` 等）被定义但**从未在 `normalizeEntry` 中被调用**！
  ```typescript
  // manifest.ts Line 213: 未引用的孤立函数
  function isWindowsReservedName(component: string): boolean {
    const baseName = component.split('.')[0]!.replace(/[. ]+$/u, '');
    return WINDOWS_RESERVED_NAME_PATTERN.test(baseName);
  }
  ```
  **危害**：如果发送方（如 Linux 设备）发送一个名为 `con.txt` 或 `nul` 的文件，Windows 接收端在执行 `fsPromises.open()` 或 `mkdir()` 时，系统底层驱动会将 `CON`/`NUL` 视为特殊设备句柄，导致进程挂起、拒绝服务或写入被吞。
* **修复建议**：
  在 `manifest-validation.ts` 的 `assertValidRelativePath` 中强制集成 `isWindowsReservedName` 校验：
  ```typescript
  for (const component of components) {
    if (isWindowsReservedName(component)) {
      throw new TypeError(`Transfer path component contains a Windows reserved name: ${component}`);
    }
  }
  ```

---

### 维度 5：DoS 与资源耗尽防御（Denial of Service）

#### 5.1 现状与分析
* **分析对象**：`transport/lan-service.ts`, `transfer/wire-frame.ts`, `transfer/stream-session.ts`, `canonical-json.ts`
* **现有防护**：
  * TCP Server 限制 `maxConnections` (默认 16) 和 `maxConnectionsPerIp` (默认 4)；
  * `bootstrap` 阶段设置 10s 超时与 32 KiB 输入上限；
  * Wire Frame 头部包含 4 字节长度，限制最大帧大小不超过 `MAX_FRAME_SIZE` (16 MiB)。
* **发现缺陷 (SEC-03 - Medium)**：
  1. **慢速连接 DoS (Slowloris)**：虽然设置了 `socket.setTimeout(bootstrapTimeoutMs)`，但一旦收到单字节后计时器不会持续限制吞吐速率，恶意对端可以通过每 9 秒发送 1 字节数据长期占用连接槽位。
  2. **缺失 Rate Limiter**：未对 UDP Discovery 与 TCP 连接握手实现滑动窗口速率限制（Rate Limiting），易受到局域网广播泛洪攻击。
* **修复建议**：
  引入 `security/rate-limiter.ts` 与 `security/connection-limiter.ts`（将在任务 A3 中完整实现），对单位时间内的新建连接数及数据包处理速率进行滑动窗口限制。

---

### 维度 6：规范 JSON 攻击防御（Canonical JSON Security）

#### 6.1 现状与分析
* **分析对象**：`canonical-json.ts`
* **现有防护**：
  1. 严格检查 `Number.isSafeInteger`，拒绝浮点数及精度溢出整数；
  2. 强制 `isWellFormed()`，拒绝孤立代理对（Unpaired Surrogates）；
  3. 对象键严格字典序排序，禁止重复键与 `undefined`；
  4. 解析后比对 `canonicalJson(parsed) === serialized`，确保输入具有唯一确定性表征。
* **安全性评估 (SEC-06 - Low)**：
  * 防护体系非常严密，有效防御了哈希碰撞、JSON 反序列化多义性攻击。
  * 补充建议：在 `parseCanonicalJson` 中限制最大递归解析深度（建议 32 层）和最大键长度（建议 256 字符），防止畸形嵌套 JSON 导致调用栈溢出（Stack Overflow DoS）。

---

### 维度 7：重放保护（Replay Protection）

#### 7.1 现状与分析
* **分析对象**：`transfer/control.ts`, `transfer/message-codec.ts`, `discovery/index.ts`
* **现有机制**：
  1. 控制帧使用 `sequence`（从 0 开始严格递增，跳序或重序均报错终止）；
  2. 控制帧包含 `issuedAt` + `expiresAt` (TTL 30s)，并验证 `Math.abs(now - issuedAt) <= 30000`；
  3. 严格绑定 `taskId` + `sessionId` + `fromDeviceId` + `toDeviceId`。
* **发现缺陷 (SEC-04 - Medium)**：
  在 `discovery/index.ts` 中，UDP 发现广播在 30 秒的时钟偏移窗口期内，恶意攻击者可以重放旧的有效广播包。虽然接收方会根据 `lastSeen` 刷新，但如果受害者设备处于移动漫游状态，可能被旧广播诱导向错误的主机 IP 发起连接。
* **修复建议**：
  维护最近接收到的公告签名缓存 `recentAnnouncementSignatures: Map<string, number>`，30 秒内相同的广播包直接去重，不重复触发 `peer` 事件。

---

### 维度 8：TLS 配置与网络边界（TLS & Network Transport）

#### 8.1 现状与分析
* **分析对象**：`reference/desktop-v2/cert-manager.js`, `core-src/transport/lan-service.ts`
* **协议安全架构**：
  * Nearby Transfer v2 采用 **应用层零信任加密架构**（Ed25519 签名身份认证 + X25519 ECDH + AES-256-GCM 逐块认证加密），即使运行在明文 TCP 或被劫持的局域网信道上，数据机密性与完整性依然受到密码学保障。
  * WebDAV 服务若启用 TLS：
    * `cert-manager.js` 生成自签名证书时，必须包含完整的 `subjectAltName`（SAN: IP 与 localhost）以及 `keyUsage = digitalSignature, keyEncipherment`。
* **安全结论**：
  应用层双向认证与端到端加密模型设计完备，不依赖底层 TLS 传输即可抵御局域网嗅探与中间人攻击。

---

## 结论与修复优先级

1. **P0（紧急修复）**：激活 `manifest.ts` 中的 `isWindowsReservedName` 校验，防止 Windows 平台文件名注入崩溃。
2. **P1（高优先级）**：在任务 A3 中实现 `rate-limiter.ts`、`connection-limiter.ts`、`safe-json-parse.ts` 加固 DoS 防护。
3. **P2（中优先级）**：修复 `timingSafeEqualStrings` 长度泄漏，完善会话密钥异常擦除。
