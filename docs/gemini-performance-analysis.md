# Nearby Transfer 6 大热路径性能分析报告 (C1)

> **历史分析 / 非权威资料：** 本文件保留早期审查思路，可能包含未复现的
> 假设、旧版本基线或过时结论。当前能力以 docs/capabilities.md、现行规范
> 和可重复运行的测试为准；其中的数值或完成度不得作为发布承诺。

**分析目标：** 对 Nearby Transfer v2 的 6 条核心热路径进行逐一瓶颈诊断、优化路径建模与吞吐量预估。

> 说明：这是探索性的性能假设清单，不是当前版本的基准测试报告。
> 下列方向必须在目标平台上用可复现基准验证后，才能形成性能承诺。

---

## 性能分析与评估总览

| 热路径 | 调用频率 | 可能瓶颈 | 候选优化方案 | 验证要求 |
| :--- | :--- | :--- | :--- | :--- |
| **1. canonicalJson 序列化** | 每个控制信令调用 | 对象键动态排序、多重小字符串拼接与 GC 压力 | 预分配 Buffer 流式写入、ASCII 快速路径、已知 Schema 静态排序 | 用 CPU profile、分配统计和端到端延迟对比验证 |
| **2. encrypt/decryptChunk** | 每 1~4 MiB Chunk 一次 | `buildChunkAad` 重复分配多个小 Buffer | AAD 静态模板就地重用、避免重复内存拷贝 | 在不同 CPU 与块大小上测量吞吐和内存分配 |
| **3. Wire Frame 编解码** | 握手与配置阶段每帧一次 | `Buffer.concat` 频繁重新分配内存 | 双指针滑动窗口环形缓冲（Ring Buffer） | 消除 O(N²) 重复拷贝开销 |
| **4. MUX Envelope 编解码** | 每个 Chunk / Progress 一次 | 头部与数据载荷的合并拷贝 | 向量化 I/O（`cork/uncork` + 分段写入） | 对比复制次数、CPU 与端到端吞吐，并验证背压行为 |
| **5. SHA-256 全量哈希** | Manifest 构建与完成校验 | 固定读取块大小可能未适配所有存储设备 | 测试不同读取块大小和流水线方案 | 在 HDD、SSD 与网络盘上分别基准测试，避免单平台结论 |
| **6. ECDH 密钥派生** | 每次传输会话一次 | PEM 解析与 Base64 解码 | 评估直接使用原始 KeyObject、减少中间表示 | 测量会话建立延迟，并优先保持密钥格式兼容性 |

---

## 1. 逐条热路径深度剖析

### 热路径 1：`canonicalJson` 规范化序列化
* **现状分析**：
  ```typescript
  return `{${Object.keys(record).sort().map((key) => ...).join(',')}}`;
  ```
  在每个配对信令、传输 Manifest、发现广播与流控制帧中均被调用。每次调用都会执行数组分配、键排序、递归调用、字符串拼接。
* **瓶颈诊断**：
  V8 引擎在大量短字符串拼接（String Concatenation）时会频繁触发 Scavenge GC。
* **优化方向**：
  1. 构建定长字节缓冲区预估模型，使用 `Buffer.write()` 直接写入；
  2. 对 ASCII 字符跳过繁重的 UTF-8 编码与代理对校验；
  3. 对于固定的协议信令（如 `stream-hello`, `stream-start`），采用常量模版。

---

### 热路径 2：`encryptChunk` / `decryptChunk` (AES-256-GCM)
* **现状分析**：
  ```typescript
  export function buildChunkAad(input: ChunkMetadata): Buffer {
    return Buffer.concat([
      encodeFields([CONTEXT, CHUNK_AAD_LABEL, metadata.taskId, metadata.path]),
      encodeSafeInteger(metadata.offset),
      encodeSafeInteger(metadata.sequence),
      encodeUint32(metadata.plainLength),
    ]);
  }
  ```
* **瓶颈诊断**：
  每传输一个 1 MiB 块，`buildChunkAad` 都会调用 `encodeFields`（为每个字段分配 4 字节长度 Buffer + 字符串 Buffer），再分配 8 字节 offset Buffer、8 字节 sequence Buffer、4 字节 plainLength Buffer，最后执行 `Buffer.concat`。对于 100 GB 文件，将无谓创建超过 60 万个临时 Buffer。
* **优化方向**：
  构建一个固定前缀模板 Buffer（包含 `CONTEXT`、`CHUNK_AAD_LABEL`、`taskId`、`path`），针对每个 Chunk 在末尾写入数字字段，以减少每块的临时 Buffer 分配；实际收益需要基准验证。

---

### 热路径 3：Wire Frame 编解码
* **现状分析**：
  `WireFrameDecoder` 在收到 TCP 片段时，使用 `this.pending = Buffer.concat([this.pending, chunk])`。
* **瓶颈诊断**：
  在慢速网络或高网络抖动时，每个分片都会触发整个未完成缓冲区的深拷贝，引发内存搬移放大。
* **优化方向**：
  使用预分配 64 KiB 的固定 RingBuffer，仅移动读写游标。

---

### 热路径 4：MUX Envelope 编解码
* **现状分析**：
  ```typescript
  export function encodeStreamEnvelope(kind: number, payload: Buffer): Buffer {
    const encoded = Buffer.allocUnsafe(MUX_PREFIX_BYTES + payload.length);
    MUX_MAGIC.copy(encoded, 0);
    // ... 写入头部 ...
    payload.copy(encoded, MUX_PREFIX_BYTES);
    return encoded;
  }
  ```
* **瓶颈诊断**：
  `payload.copy(encoded, 16)` 将 1 MiB 的加密数据块再次完整拷贝了一遍。
* **优化方向**：
  利用 Node.js `stream.cork()` 与两次轻量 `stream.write()`：
  1. `stream.write(header16Bytes)`
  2. `stream.write(payload)`
  实现完全零拷贝（Zero-Copy）封包发送。

---

### 热路径 5：SHA-256 全量哈希计算
* **现状分析**：
  `verifyCompletedFile` 采用 256 KiB 块循环读取并更新哈希。
* **优化方向**：
  1. 将读取块大小调整至 1 MiB（匹配传输 Chunk 大小及现代 NVMe 最佳 I/O 块）；
  2. 在 `writeChunk` 解密写入磁盘的同时利用流水线并行更新哈希，从而在最后一个 Chunk 写入完成时即刻完成哈希校验，消除文件写入后的二次全盘重读。

---

### 热路径 6：ECDH 密钥派生
* **现状分析**：
  PEM 字符串格式转换增加了数十行 base64 编解码与正则匹配开销。
* **优化方向**：
  在应用内部直接使用 `KeyObject` 或 Raw 32-byte 格式进行密钥传递，仅在持久化或向外部展示时转换为 PEM。
