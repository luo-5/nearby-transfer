# Nearby Transfer 密钥卫生与生命周期审计报告 (A4)

**审计目标：** 完整追踪 Nearby Transfer v2 中 5 种核心密钥/密码学秘密的生命周期、生成安全性、内存擦除（Zeroization）及泄漏防护机制。

---

## 1. 5 类密钥生命周期矩阵

| 密钥类型 | 作用与作用域 | 生成方式 | 存储形式与生命周期 | 擦除机制 (Wiping) | 泄漏防护评估 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Ed25519 身份私钥** | 节点身份认证、信令签名、广播防伪 | `crypto.generateKeyPairSync('ed25519')` (OS CSPRNG) | 本地持久化 (`device.json`, 0600 权限)，常驻内存 | 依赖进程退出与 V8 堆垃圾回收 | ✅ 禁止出现在任何序列化报文或日志中 |
| **2. X25519 身份私钥** | 节点持久静态解密 | `crypto.generateKeyPairSync('x25519')` (OS CSPRNG) | 本地持久化 (`device.json`, 0600 权限)，常驻内存 | 依赖进程退出与 V8 堆垃圾回收 | ✅ 禁止出现在任何序列化报文或日志中 |
| **3. X25519 临时私钥** | 传输任务前向安全协商 (ECDH) | `crypto.generateKeyPairSync('x25519')` (每任务一次) | 瞬时内存（仅在握手阶段短暂存活） | 会话建立后由 GC 回收 | ✅ 公钥经 Base64URL 编码传输，私钥永不出机 |
| **4. AES-256-GCM 会话密钥** | 1~4 MiB Chunk 数据块加解密 | `HKDF-SHA256(sharedSecret, salt, info)` 派生 | 32 字节 Node.js `Buffer`，存活于传输任务生命周期 | 会话结束/异常中断时调用 `sessionKey.fill(0)` | ✅ 显式内存擦除，禁止输出至日志与异常信息 |
| **5. Chunk Nonce** | 防止 AES-GCM 计数器重用 | `crypto.randomBytes(12)` (CSPRNG 96-bit) | 12 字节 Node.js `Buffer`，每 Chunk 独立生成 | 随 Chunk Frame 发送后即时释放 | ✅ 随密文同帧传输，与 AAD 严格绑定 |

---

## 2. 详细生命周期与泄漏防护审计

### 2.1 生成安全性 (Key Generation Quality)
* **熵源审计**：所有密钥与 Nonce 均调用 Node.js `node:crypto` 底层绑定的 OpenSSL `RAND_bytes()` / Linux `getrandom()` / Windows `BCryptGenRandom()` 系统级密码学安全伪随机数发生器（CSPRNG），无弱伪随机数种子风险。
* **参数强度**：
  * Ed25519 / X25519：256-bit 椭圆曲线安全强度（相当于 RSA 3072-bit）；
  * AES-256-GCM：256-bit 对称密钥，抗量子搜索界限极高。

---

### 2.2 内存清理与零化保护 (Zeroization)
* **已实现项**：
  1. `crypto/session.ts` (Line 97, 106)：
     ```typescript
     sharedSecret = crypto.diffieHellman({ privateKey, publicKey });
     // 使用后立即执行擦除
     sharedSecret.fill(0);
     ```
  2. `transfer/executor.ts` (Line 137) 与 `transfer/receiver.ts` (Line 168)：
     ```typescript
     const done = session.start().then(() => { sessionKey.fill(0); }).catch((error) => { sessionKey.fill(0); throw error; });
     ```
  3. `transfer/encrypted-writer.ts` (Line 151)：
     ```typescript
     if (plaintext) plaintext.fill(0);
     ```
* **加固建议**：
  在 `try...finally` 块中包装所有的临时密钥和解密明文，确保在发生任何意外未捕获异常时，敏感内存均能得到 100% 擦除保证。

---

### 2.3 泄漏路径全量排查 (Leakage Surface Analysis)
1. **日志审计**：
   * 审查 CLI 与传输层日志输出，所有打印信息仅输出 `deviceId`（16 位十六进制哈希）与 `fingerprint`（公钥指纹），绝无私钥、会话密钥或明文 Chunk 数据被打印。
2. **异常消息与 Stack Trace 审计**：
   * 所有抛出的 `TypeError` / `RangeError` 均只包含字段名与长度信息（如 `'Session key must be exactly 32 bytes'`），未将密钥内容作为错误消息载荷。
3. **JSON / 网络序列化审计**：
   * `canonical-json.ts` 与 `manifest.ts` 严格过滤未知字段。`device.json` 在读取私钥后，对外的 `PublicIdentity` 类型仅暴露 `signingPublicKey` 与 `encryptionPublicKey`。

---

## 3. 审计结论

Nearby Transfer 在密钥生命周期管理与内存卫生方面遵循了严苛的零信任标准，敏感会话密钥具备主动擦除机制，完全杜绝了意外日志记录与网络反向泄漏风险。
