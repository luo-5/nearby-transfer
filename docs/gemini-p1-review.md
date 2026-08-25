# P1 修复代码审查报告 (F1)

**审查目标：** P1 阶段端到端传输修复方案（`bootstrap` → `stream-session` 的 `leftoverData` 交接方案）  
**涉及文件：**
* `packages/core/src/transfer/bootstrap.ts`
* `packages/core/src/transfer/stream-session.ts`
* `packages/core/src/transfer/executor.ts`
* `packages/core/src/transfer/receiver.ts`

---

## 1. 架构背景与问题根因

在 Nearby Transfer v2 协议中，连接生命周期分为两个阶段：
1. **Bootstrap 阶段**：使用 **Wire Frame**（4 字节大端总长度 + 2 字节头长度 + JSON Header + JSON Payload），交换 Transfer Manifest、Decision 与 Resume Checkpoint；
2. **Stream Session 阶段**：在同一条 TCP 套接字上切换到 **MUX Frame**（16 字节固定前缀 `NTV2MUX1` + 帧类型 + 载荷长度），用于传输控制信令（Control）、加密数据块（Chunk）与进度确认（Progress）。

**历史 Bug 根因（7a10b00）：**
当接收方收到 Manifest 并返回 Decision 后，立即启动 Stream Session 并发送 MUX `stream-hello` 帧。此时发送方的 Socket 数据监听器正从 `bootstrap.ts` 卸载、尚未挂载到 `stream-session.ts`。由于 TCP 是连续字节流，MUX 帧的数据可能与 Decision 的数据包合并（TCP Packet Coalescing）同时到达，或者在监听器交接空档期到达，导致数据丢失或挂起。

---

## 2. 修复方案逐文件审查与分析

### 2.1 `bootstrap.ts`：`leftoverData` 捕获与退出机制

#### 实现要点 (Line 156-187)
```typescript
while (buffer.length >= FRAME_LENGTH_BYTES) {
  const frameLength = buffer.readUInt32BE(0);

  // 如果 frameLength 异常，说明遭遇了 MUX 数据前缀（如 'NTV2' = 0x4E545632）
  if (!Number.isSafeInteger(frameLength) || frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
    if (decision !== null) { succeed(); return; }
    if (!settled) fail(new RangeError(`Wire frame length must be between ${HEADER_LENGTH_BYTES} and ${MAX_FRAME_SIZE} bytes`));
    return;
  }
  // ... 正常解析 WireFrame ...
}
```
* **正确性评估**：
  * MUX 帧的 Magic 头部为 `NTV2MUX1`（ASCII 码对应 16 进制为 `0x4E5456324D555831`），前 4 个字节解析为 32 位大端整数是 `1,314,149,938`（约 1.22 GiB），显著大于 `MAX_FRAME_SIZE`（16 MiB）。
  * 因此，代码能够 100% 可靠地区分 Wire Frame 与 MUX 帧的起始边界。
  * 当已经接收到 `decision` 时，一旦检测到长度超出边界即正确判定为 MUX 数据到达，立刻调用 `succeed()` 将剩余 `buffer` 作为 `leftoverData` 返回。

### 2.2 `stream-session.ts`：`initialBuffer` 注入与并发队列串行化

#### 实现要点 (Line 307-310, 157-168)
```typescript
// start() 初始化
if (config.initialBuffer && config.initialBuffer.length > 0) {
  void onData(Buffer.from(config.initialBuffer));
}
config.stream.resume();
```
```typescript
// onData 处理机制
function onData(chunk: Buffer): void {
  if (settled) return;
  config.stream.pause();
  incomingTail = incomingTail.then(async () => {
    if (settled) return;
    await decoder.push(chunk, async (kind, payload) => {
      // 依序分发帧
    });
  }).then(() => { if (!settled) config.stream.resume(); }).catch((error) => fail(error as Error, 'protocol-error'));
}
```
* **竞态条件（Race Condition）分析**：
  * **时序安全性**：`onData(initialBuffer)` 先将 `initialBuffer` 入队到 `incomingTail` Promise 链中，然后同步调用 `config.stream.resume()`。
  * **乱序风险核查**：即使套接字在新数据触发时迅速触发后续的 `data` 事件，后续的 `onData(chunk)` 也会链式追加到 `incomingTail.then(...)` 之后。由于 JavaScript 单线程事件循环与 Promise 队列的 FIFO 保证，`initialBuffer` 中的数据必定先于 Socket 新到达的数据被 Decoder 解析。
  * **暂停与恢复时机**：每次处理时执行 `stream.pause()` 并在处理完成后 `resume()`，配合 `incomingTail` 完美实现了背压（Backpressure）控制。

#### awaiting-ack 状态支持 Progress (Line 247)
```typescript
if (state !== 'sending' && state !== 'awaiting-ack') throw new Error(`Progress out of order for state ${state}`);
```
* 发送端在推送完所有 Chunk 后进入 `awaiting-ack` 状态并发送 `stream-complete`。在此期间，接收端之前发送的进度确认帧（Progress）可能仍在信道中传输。允许 `awaiting-ack` 接收 Progress 彻底避免了时序竞态导致的连接崩溃。

### 2.3 `executor.ts`：Checkpoint Advance 安全跳过

#### 实现要点 (Line 115-125)
```typescript
decodeProgress: (bytes, _ctx) => {
  const decOpts: { now: number; checkpoint?: ControlCheckpoint } = { now: Date.now() };
  if (controlCheckpoint) decOpts.checkpoint = controlCheckpoint;
  const decoded = decodeTransferMessage(TYPE_TRANSFER_PROGRESS, bytes, decOpts);
  if (controlCheckpoint) {
    const advOpts: { now: number; checkpoint: ControlCheckpoint } = { now: Date.now(), checkpoint: controlCheckpoint };
    controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, decoded as Record<string, unknown>, advOpts);
    config.commitRemoteCheckpoint(buildOutgoingCheckpoint(controlCheckpoint));
  }
  return decoded;
}
```
* **正确性评估**：
  * 在全新的传输任务中，`bootstrapResult.checkpoint` 为 `null`。
  * 过去代码无条件调用 `advanceTransferControlCheckpoint` 会抛出 `TypeError: Checkpoint is missing`。修改后只有在存在已有 Checkpoint 时才进行链式递进，设计严谨合理。

### 2.4 `receiver.ts`：`receiveWireFrame` 的 Leftover 承接

#### 实现要点 (Line 214-226)
```typescript
const frames = decoder.push(chunk);
if (frames.length > 0) {
  // ...
  resolve({
    frame: frames[0]!,
    leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined,
  });
}
```
* 接收端在解析第一个 Wire Frame 时，如果一次性收到了超出单帧长度的数据（例如后续帧的一部分），将未消费的 `decoder.buffer` 完整保存并通过 `leftover` 传递给下一阶段，避免数据截断。

---

## 3. 边界条件与异常路径检查清单

| 场景 | 行为表现 | 审计结果 |
| :--- | :--- | :--- |
| **空 Leftover** (`buffer.length === 0`) | `leftoverData` 为 `undefined`，`stream-session` 正常等待 socket 事件 | ✅ 正常通过 |
| **超大 Leftover** ($> 64\text{ KiB}$) | `initialBuffer` 一次性喂给 `StreamEnvelopeDecoder`，内部循环切片解码 | ✅ 正常通过 |
| **单字节/碎片化 MUX 数据到达** | 累积在 `StreamEnvelopeDecoder.pending` 中，直到凑齐 16 字节头部再解码 | ✅ 正常通过 |
| **Socket 异常关闭/报错** | 清除 Handshake 定时器，触发 `rejectDone` 并关闭流 | ✅ 正常通过 |
| **双向并发 Hello 竞争** | `remoteHello` 标志位保证仅接受一次 `stream-hello`，重复 hello 抛出明确协议错误 | ✅ 正常通过 |

---

## 4. 结论

P1 阶段通过 `leftoverData` / `initialBuffer` 的缓冲区交接设计是**优雅且充分完备的**，成功消除了双协议帧在同一 TCP 连接上的状态切换丢失问题。无需回退到复杂度更高的双连接模式（方案 B）。
