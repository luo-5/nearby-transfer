# Nearby Transfer 24 小时自主执行计划

> 历史计划，不应直接执行；所有路径、提交号和测试数量均可能过期。

**创建日期：** 2026-08-24
**仓库：** `<repository-root>`
**GitHub：** `https://github.com/luo-5/nearby-transfer.git`
**当前 HEAD：** `7a10b00`
**测试基线：** 核心 67 + CLI 14 + 桌面 42 文件 + 互操作 62 断言 = 全绿

---

## 使用方法

1. 每个阶段是一个独立的 `/goal` 提示词，按顺序复制执行
2. 每阶段结束后检查结果（看终端输出 + `git log --oneline -5` + 测试是否全绿）
3. 确认无问题后继续下一阶段
4. 晚间检查点停下来，你人工 review，第二天继续

## 阶段总览

| 阶段 | 预估时间 | 内容 | 成功标准 |
|------|----------|------|----------|
| P1 | 3-4h | 修通 CLI 端到端传输 | 集成测试通过，`send`+`receive` 能传文件 |
| P2 | 1h | npm 0.2.0 发布 + Docker 构建 | `npm view` 成功 + Docker run 成功 |
| P3 | 4-5h | M6 文件夹同步 | `sync push` 可用 + 增量检测 + 断点续传 |
| — | **晚间检查点 1** | **Review P1-P3** | |
| P4 | 5-6h | Strangler Fig 迁移（第 1-2 批） | 全部测试通过 + Electron 启动无错 |
| P5 | 3-4h | Gemini 产出整合 + 安全加固 | 全部测试通过 |
| P6 | 2-3h | 最终测试 + 发布准备 | 全绿 + CHANGELOG |
| — | **晚间检查点 2** | **Review P4-P6** | |

**总时间：** 约 22-24 小时（含检查和调整）

---

## Day 1

---

### P1：修通 CLI 端到端传输

这是整个项目的关键阻塞。问题：bootstrap（wire frame）和 stream session（MUX frame）共用同一条 TCP 连接，bootstrap 读取完 decision wire frame 后，接收方发来的 MUX `stream-hello` 帧到达时，stream session 还没挂上 data 监听器，数据丢失。

**方案：leftoverData 交接缓冲区**（不用 unshift，用显式传递）

#### 改动 1：bootstrap.ts — 返回 leftoverData

文件：`packages/core/src/transfer/bootstrap.ts`

1. `BootstrapResult` 接口加 `leftoverData?: Buffer`：
```typescript
export interface BootstrapResult {
  decision: string;
  resume: unknown;
  checkpoint: ControlCheckpoint | null;
  leftoverData?: Buffer;
}
```

2. 删除 `unshiftRemaining()` 函数（不工作，删掉）

3. `succeed()` 改为把剩余 buffer 作为 leftoverData 返回：
```typescript
function succeed(): void {
  if (settled) return;
  settled = true;
  cleanup();
  resolve({
    decision: decision!,
    resume,
    checkpoint: controlCheckpoint,
    leftoverData: buffer.length > 0 ? Buffer.from(buffer) : undefined,
  });
}
```

4. `onData` 中，当检测到无效 frame length（MUX 数据）且 `decision !== null` 时，调 `succeed()` 而不是 fail：
```typescript
if (!Number.isSafeInteger(frameLength) || frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
  if (decision !== null) { succeed(); return; }
  if (!settled) fail(new RangeError(`Wire frame length must be between ${HEADER_LENGTH_BYTES} and ${MAX_FRAME_SIZE} bytes`));
  return;
}
```
（这段已经有了，确认 `succeed()` 会带上 leftoverData 即可）

5. 同样在 `processFrame` 里 `succeed()` 调用后（TYPE_TRANSFER_RESUME 分支），buffer 里可能有剩余数据，确认走 `succeed()` 路径

#### 改动 2：stream-session.ts — 接受 initialBuffer

文件：`packages/core/src/transfer/stream-session.ts`

1. `TransferStreamSessionInput` 加 `initialBuffer?: Buffer`：
```typescript
export interface TransferStreamSessionInput {
  // ... 现有字段 ...
  initialBuffer?: Buffer;
  // ... 现有 timeout 字段 ...
}
```

2. `start()` 函数，在 `config.stream.resume()` 之前，喂初始缓冲区给 decoder：
```typescript
function start(): Promise<TransferSessionState> {
  if (started) return done;
  started = true;
  state = 'handshaking';
  config.stream.on('data', onData);
  config.stream.once('error', onError);
  config.stream.once('close', onClose);
  config.stream.once('end', onEnd);
  armTimeout('handshake', config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  // Feed leftover bootstrap data (MUX frames) to the decoder before resuming.
  // onData will pause() -> queue via incomingTail -> resume(), so the initial
  // buffer is processed before any new data from resume() arrives.
  if (config.initialBuffer && config.initialBuffer.length > 0) {
    void onData(Buffer.from(config.initialBuffer));
  }
  config.stream.resume();
  void sendControl(CONTROL_TYPES.HELLO).catch((error) => fail(error as Error, 'transfer-error'));
  return done;
}
```

**关键理解：** `onData` 会先 `pause()` 再异步处理再 `resume()`。在 `resume()` 之前调 `onData(initialBuffer)`：
- `pause()` 是 no-op（stream 还没开始流动）
- `incomingTail` 队列先处理 initialBuffer
- 之后 `config.stream.resume()` 触发新数据，`onData` 再次触发，排到 incomingTail 后面
- 顺序正确：initialBuffer 先处理，新数据后处理

#### 改动 3：executor.ts — 传递 leftoverData

文件：`packages/core/src/transfer/executor.ts`

在 `createTransferStreamSession` 调用里加 `initialBuffer`：
```typescript
const session = createTransferStreamSession({
  stream: socket as unknown as Parameters<typeof createTransferStreamSession>[0]['stream'],
  role: 'sender',
  taskId: config.job.manifest.taskId,
  localPeerId: config.localDeviceId,
  remotePeerId: config.job.peerDeviceId,
  initialBuffer: bootstrapResult.leftoverData,  // ← 新增
  encodeControl: (message, _ctx) => codec.encodeControl(message),
  // ... 其余不变 ...
});
```

#### 改动 4：receiver.ts — receiveWireFrame 返回 leftover

文件：`packages/core/src/transfer/receiver.ts`

`receiveWireFrame` 当前只返回第一个 `WireFrame`，丢弃 decoder 里剩余字节。需要也返回 leftover。

1. 修改返回类型：
```typescript
async function receiveWireFrame(socket: import('node:net').Socket, timeoutMs: number): Promise<{ frame: WireFrame; leftover: Buffer | undefined }> {
```

2. resolve 时带上 decoder 的剩余 buffer：
```typescript
resolve({ frame: frames[0]!, leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined });
```

3. `createTransferReceiver` 中，接收 manifestFrame 后取 leftover，传给 stream session：
```typescript
const manifestResult = await receiveWireFrame(config.socket, DEFAULT_BOOTSTRAP_TIMEOUT_MS);
const envelope = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, manifestResult.frame.payload, { now: Date.now() }) as Record<string, unknown>;
// ... 后续逻辑不变，manifestResult.leftover 用于 stream session ...
```

4. 在 `createTransferStreamSession` 调用里加 `initialBuffer`：
```typescript
const session = createTransferStreamSession({
  stream: config.socket as never,
  role: 'receiver',
  taskId: manifest.taskId,
  localPeerId: config.localDeviceId,
  remotePeerId: senderDeviceId,
  initialBuffer: manifestResult.leftover,  // ← 新增
  // ... 其余不变 ...
});
```

#### 改动 5：端到端集成测试

文件：`packages/cli/test/transfer-integration.test.ts`

重写为真正的端到端测试（替换现有的 5 个 unit test 中的部分，或新增一个 `test('end-to-end transfer'`）：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import net from 'node:net';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  buildTransferSourceManifest,
  normalizeTransferManifest,
} from '@luo-5/core';
import { createDesktopTransferExecutor } from '@luo-5/core';
import { createTransferReceiver } from '@luo-5/core';

test('end-to-end: sender → receiver transfers a file with correct SHA-256', async () => {
  const senderKeys = createEd25519KeyPair();
  const senderEncKeys = createX25519KeyPair();
  const receiverKeys = createEd25519KeyPair();
  const receiverEncKeys = createX25519KeyPair();

  const senderDeviceId = deriveDeviceId(senderKeys.publicKey);
  const receiverDeviceId = deriveDeviceId(receiverKeys.publicKey);

  // Create test file
  const tmpDir = join(tmpdir(), `nt-test-${Date.now()}`);
  const sendDir = join(tmpDir, 'send');
  const recvDir = join(tmpDir, 'recv');
  mkdirSync(sendDir, { recursive: true });
  mkdirSync(recvDir, { recursive: true });
  const filePath = join(sendDir, 'test.bin');
  const content = Buffer.alloc(256 * 1024, 0xAB); // 256 KB
  crypto.randomFillSync(content); // random data
  writeFileSync(filePath, content);
  const expectedHash = createHash('sha256').update(content).digest('hex');

  // Build manifest
  const manifest = buildTransferSourceManifest({
    entries: [{ path: 'test.bin', kind: 'file' as const, size: content.length, filePath }],
    senderDeviceId,
    receiverDeviceId,
  });
  const normalized = normalizeTransferManifest(manifest);

  // Trusted peers (pre-loaded for synchronous lookup)
  const trustedPeers = new Map();
  trustedPeers.set(senderDeviceId, {
    signingPublicKey: senderKeys.publicKey,
    deviceName: 'Sender',
    encryptionPublicKey: senderEncKeys.publicKey,
  });
  trustedPeers.set(receiverDeviceId, {
    signingPublicKey: receiverKeys.publicKey,
    deviceName: 'Receiver',
    encryptionPublicKey: receiverEncKeys.publicKey,
  });

  // Start TCP server (receiver)
  const server = net.createServer(async (socket) => {
    socket.setNoDelay(true);
    const receiver = await createTransferReceiver({
      socket,
      receiveDir: recvDir,
      localDeviceId: receiverDeviceId,
      localSigningPrivateKey: receiverKeys.privateKey,
      localEncryptionPrivateKey: receiverEncKeys.privateKey,
      lookupPeer: (deviceId) => {
        const peer = trustedPeers.get(deviceId);
        if (!peer) return null;
        return { signingPublicKey: peer.signingPublicKey, deviceName: peer.deviceName };
      },
    });
    await receiver.done;
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  // Start sender
  const controller = new AbortController();
  const executor = await createDesktopTransferExecutor({
    job: {
      direction: 'outgoing' as const,
      status: 'transferring' as const,
      manifest: normalized,
      sources: [{ path: 'test.bin', kind: 'file' as const, size: content.length, filePath }],
      peerDeviceId: receiverDeviceId,
      peer: { host: '127.0.0.1', port },
      localDeviceId: senderDeviceId,
      signingPrivateKey: senderKeys.privateKey,
      remoteSigningPublicKey: receiverKeys.publicKey,
      remoteEncryptionPublicKey: receiverEncKeys.publicKey,
    } as any,
    checkpoint: null,
    signal: controller.signal,
    commitRemoteCheckpoint: () => ({}) as any,
  });

  await executor.done;

  // Verify received file
  const receivedPath = join(recvDir, 'test.bin');
  const receivedContent = readFileSync(receivedPath);
  const receivedHash = createHash('sha256').update(receivedContent).digest('hex');
  assert.equal(receivedHash, expectedHash, 'SHA-256 mismatch');

  // Cleanup
  server.close();
  rmSync(tmpDir, { recursive: true, true });
});
```

#### 验收标准

```bash
# 1. TypeScript 编译
cd packages/core && npx tsc --noEmit -p tsconfig.json

# 2. 核心测试
npx tsx --test packages/core/test/

# 3. 集成测试
npx tsx --test packages/cli/test/transfer-integration.test.ts

# 4. 全部 CLI 测试
npx tsx --test packages/cli/test/

# 5. 桌面 smoke
node --check src/v2/*.js && node --check src/renderer/*.js && node --check src/preload.js
```

全部通过后提交：
```
git add -A
git commit -m "fix(transfer): resolve bootstrap-to-stream-session handoff via leftoverData buffer

The bootstrap (wire frame) and stream session (MUX frame) share one TCP
connection. Previously, the receiver's MUX stream-hello arrived while the
sender's bootstrap data listener was still attached but the stream session
hadn't taken ownership yet, causing data loss.

Fix: bootstrap.ts returns leftoverData in BootstrapResult; stream-session.ts
accepts initialBuffer and feeds it to the decoder before resume(); executor.ts
and receiver.ts wire the leftover data through.

Adds end-to-end integration test verifying SHA-256 file integrity."
```

#### 备选方案 B（如果方案 A 不通）

如果方案 A 仍然不通（集成测试超时或数据不匹配），切换到双连接模式：
- bootstrap 用连接 1（TCP 连接 → manifest/decision 交换 → 关闭）
- stream session 用连接 2（新的 TCP 连接 → MUX 帧交换）

改动点：
- `executor.ts`：bootstrap 后不关闭 socket 1，而是新建 socket 2 传给 stream session
- `receiver.ts`：在 TCP server 的 connection handler 里，receiveWireFrame 后发送 decision，然后新建到 sender 的连接给 stream session
- 或更简单：receiver 在 decision 里附上下一个连接的端口号，sender 连新端口

但先试方案 A。

---

### P2：npm 0.2.0 发布 + Docker 构建验证

P1 修通后执行。

#### 步骤

```bash
cd <repository-root>

# 1. 版本号
# packages/core/package.json: "version": "0.1.0" → "0.2.0"
# packages/cli/package.json: "version": "0.1.0" → "0.2.0"
# packages/cli/package.json dependencies: "@luo-5/core": "^0.1.0" → "^0.2.0"
# 根 package.json devDependencies: "@luo-5/core": "^0.1.0" → "^0.2.0" (如果有)

# 2. 构建
npm run build:core
npm run build --workspace @luo-5/cli

# 3. 全部测试
npx tsx --test packages/core/test/
npx tsx --test packages/cli/test/
node --check src/v2/*.js

# 4. 发布
npm publish --workspace @luo-5/core
npm publish --workspace @luo-5/cli

# 5. 验证
npm view @luo-5/core@0.2.0
npm view @luo-5/cli@0.2.0

# 6. Docker 构建（如果 daemon 在运行）
docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
docker run --rm nearby-transfer-cli --help
docker run --rm nearby-transfer-cli devices
```

提交：
```bash
git add -A
git commit -m "chore: publish @luo-5/core@0.2.0 and @luo-5/cli@0.2.0

- Version bump 0.1.0 → 0.2.0
- CLI dependency updated to @luo-5/core@^0.2.0
- Includes bootstrap-to-stream-session handoff fix
- Includes createTransferReceiver (receive-side executor)"
git push origin main
```

---

### P3：M6 文件夹同步

依赖 P1 修通。

#### 3.1 sync 命令

文件：`packages/cli/src/commands/sync.ts`（新建）

```typescript
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { buildTransferSourceManifest, createDesktopTransferExecutor } from '@luo-5/core';

// sync push --dir <directory> --to <deviceId>
// - Recursively scan directory
// - Build manifest with all files
// - Create executor and transfer all files
// - Report progress per file

export async function syncPush(opts: {
  dir: string;
  to: string;
  host: string;
  port: number;
  localDeviceId: string;
  signingPrivateKey: string;
  remoteSigningPublicKey: string;
  remoteEncryptionPublicKey: string;
}) {
  const entries = scanDirectory(opts.dir);
  const manifest = buildTransferSourceManifest({
    entries: entries.map(e => ({ path: e.relativePath, kind: 'file' as const, size: e.size, filePath: e.absolutePath })),
    senderDeviceId: opts.localDeviceId,
    receiverDeviceId: opts.to,
  });
  // ... create executor and run ...
}

interface ScanResult { relativePath: string; absolutePath: string; size: number; }

function scanDirectory(root: string): ScanResult[] {
  const results: ScanResult[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) {
        const stat = statSync(fullPath);
        results.push({
          relativePath: relative(root, fullPath).split(sep).join('/'),
          absolutePath: fullPath,
          size: stat.size,
        });
      }
    }
  }
  walk(root);
  return results;
}
```

#### 3.2 增量检测

文件：`packages/core/src/transfer/sync-state.ts`（新建）

```typescript
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Buffer } from 'node:buffer';

export interface FileSyncState {
  path: string;
  size: number;
  mtimeMs: number;
  quickHash: string;  // SHA-256 of first 1 MiB
  fullHash: string;   // SHA-256 of entire file
}

export interface SyncState {
  deviceId: string;
  lastSyncAt: number;
  files: Map<string, FileSyncState>;
}

// 快速哈希：前 1 MiB（检测大小+mtime 变化的文件）
export async function computeQuickHash(filePath: string, maxBytes = 1024 * 1024): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// 全文件哈希（仅对快速哈希匹配但需要确认的文件）
export async function computeFullHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// 比对上次同步状态，找出需要传输的文件
export async function planIncrementalSync(
  files: ScanResult[],
  lastState: SyncState | null
): Promise<{ toSend: ScanResult[]; unchanged: string[] }> {
  if (!lastState) return { toSend: files, unchanged: [] };
  const toSend: ScanResult[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const prev = lastState.files.get(file.relativePath);
    if (!prev || prev.size !== file.size) {
      toSend.push(file);
      continue;
    }
    const quick = await computeQuickHash(file.absolutePath);
    if (quick !== prev.quickHash) {
      toSend.push(file);
    } else {
      unchanged.push(file.relativePath);
    }
  }
  return { toSend, unchanged };
}
```

#### 3.3 断点续传持久化

文件：`packages/core/src/transfer/resume-store.ts`（新建）

```typescript
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ResumeState {
  taskId: string;
  files: Array<{
    path: string;
    committedOffset: number;
    completed: boolean;
  }>;
  nextSequence: number;
  totalTransferred: number;
  updatedAt: number;
}

export function saveResumeState(stateDir: string, state: ResumeState): void {
  const filePath = join(stateDir, `resume-${state.taskId}.json`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function loadResumeState(stateDir: string, taskId: string): ResumeState | null {
  const filePath = join(stateDir, `resume-${taskId}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as ResumeState;
}

export function deleteResumeState(stateDir: string, taskId: string): void {
  const filePath = join(stateDir, `resume-${taskId}.json`);
  if (existsSync(filePath)) {
    const { unlinkSync } = require('node:fs');
    unlinkSync(filePath);
  }
}
```

#### 3.4 冲突处理

文件：`packages/core/src/transfer/conflict-resolver.ts`（新建）

```typescript
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';

export type ConflictStrategy = 'overwrite' | 'rename-new' | 'skip';

export function resolveConflict(
  targetPath: string,
  strategy: ConflictStrategy
): string {
  if (!existsSync(targetPath)) return targetPath;

  switch (strategy) {
    case 'overwrite':
      return targetPath;
    case 'skip':
      return ''; // empty = skip this file
    case 'rename-new': {
      const dir = dirname(targetPath);
      const ext = extname(targetPath);
      const name = basename(targetPath, ext);
      let counter = 1;
      let candidate = join(dir, `${name}.new${counter}${ext}`);
      while (existsSync(candidate)) {
        counter++;
        candidate = join(dir, `${name}.new${counter}${ext}`);
      }
      mkdirSync(dir, { recursive: true });
      return candidate;
    }
    default:
      return targetPath;
  }
}
```

#### 3.5 CLI sync 命令注册

文件：`packages/cli/src/index.ts`（修改）

在现有命令列表中注册 `sync`：
```typescript
program.command('sync')
  .description('Sync a directory to a peer device')
  .requiredOption('--dir <path>', 'Directory to sync')
  .requiredOption('--to <deviceId>', 'Target device ID')
  .option('--host <host>', 'Peer host', '127.0.0.1')
  .option('--port <port>', 'Peer port', '53118')
  .option('--strategy <strategy>', 'Conflict strategy: overwrite|rename-new|skip', 'rename-new')
  .action(async (opts) => {
    const { syncPush } = await import('./commands/sync.js');
    await syncPush(opts);
  });
```

#### 3.6 测试

文件：`packages/cli/test/sync.test.ts`（新建）

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createTransferReceiver } from '@luo-5/core';
import { createEd25519KeyPair, createX25519KeyPair, deriveDeviceId } from '@luo-5/core';

test('sync: 10 small files transfer correctly', async () => {
  // Create 10 small files
  // Sync to receiver
  // Verify all 10 files exist with correct content
});

test('sync: conflict rename-new does not overwrite existing', async () => {
  // Create file on both sides
  // Sync with rename-new strategy
  // Verify original file unchanged, new file has .new1 suffix
});

test('sync: incremental detects only changed files', async () => {
  // First sync: all files transferred
  // Modify one file
  // Second sync: only changed file transferred
});
```

#### 验收标准

```bash
# 1. 编译
npx tsc --noEmit -p packages/core/tsconfig.json
npx tsc --noEmit -p packages/cli/tsconfig.json

# 2. 核心测试
npx tsx --test packages/core/test/

# 3. CLI 测试（含 sync）
npx tsx --test packages/cli/test/

# 4. 手动验证
# 终端 1: npx @luo-5/cli receive --dir /tmp/recv
# 终端 2: npx @luo-5/cli sync --dir /tmp/senddir --to <deviceId> --host 127.0.0.1 --port <port>
```

提交：
```
git commit -m "feat(sync): implement directory sync with incremental detection and resume

- packages/cli/src/commands/sync.ts: recursive directory scan + transfer
- packages/core/src/transfer/sync-state.ts: quick hash (1 MiB) + full hash
  incremental detection against last sync state
- packages/core/src/transfer/resume-store.ts: JSON-based resume state
  persistence, resume by taskId
- packages/core/src/transfer/conflict-resolver.ts: overwrite/rename-new/skip
  strategies for name collisions
- packages/cli/test/sync.test.ts: 10-file sync, conflict, incremental"
```

---

## ⏸ 晚间检查点 1

**检查项：**
1. `git log --oneline -10` — 确认 P1-P3 的提交
2. `npx tsx --test packages/core/test/` — 核心测试全绿
3. `npx tsx --test packages/cli/test/` — CLI 测试全绿
4. `npm view @luo-5/core@0.2.0` — npm 发布成功
5. 手动跑一次 `send` + `receive` — 确认文件传输正常
6. 手动跑一次 `sync` — 确认目录同步正常

**如果有问题：** 记录问题，第二天先修问题再继续 P4。

---

## Day 2

---

### P4：Strangler Fig 迁移（第 1-2 批）

目标：把旧 `src/v2/*.js` 里的纯逻辑模块迁移到 `@luo-5/core` TS 实现，让桌面端直接用核心库。

**核心原则：** 逐模块迁移，每迁一个就测试，不兼容就回退。

#### 第 1 批：纯逻辑模块（低风险）

##### 4.1 canonical-json.js → core canonical-json.ts

1. 对比 `src/v2/canonical-json.js` 和 `packages/core/src/canonical-json.ts` 的 API
2. 如果 API 兼容，在 `src/v2/canonical-json.js` 改为 re-export：
   ```javascript
   module.exports = require('@luo-5/core').canonicalJson;
   // 或如果 API 不完全一致，做适配层
   ```
3. `node --check src/v2/canonical-json.js`
4. `npm test`

##### 4.2 constants.js → core constants.ts

同上模式。检查 `APP_ID`、`PROTOCOL_VERSION`、`MESSAGE_TYPES` 是否一致。

##### 4.3 pairing.js → core pairing modules

`src/v2/pairing.js` 对应 core 的 `pairing/sas.ts` + `identity-shape.ts`。这个可能 API 差异较大，需要适配层。

#### 第 2 批：有 fs/net 依赖（中风险）

##### 4.4 discovery.js → core discovery/index.ts

1. 对比 API：`src/v2/discovery.js` 导出的 `V2Discovery` 类 vs core 的 discovery 模块
2. 如果 core 缺少某些功能（如 Electron 集成的网络接口枚举），在适配层补
3. 创建 `src/v2/discovery-adapter.js`：
   ```javascript
   const { V2Discovery: CoreDiscovery } = require('@luo-5/core');
   class V2Discovery extends CoreDiscovery {
     // Electron-specific overrides if needed
   }
   module.exports = { V2Discovery };
   ```
4. 测试：`node --check src/v2/discovery-adapter.js` + Electron 启动

##### 4.5 transfer-manifest.js → core transfer/manifest.ts

同上。检查 `buildTransferSourceManifest`、`normalizeTransferManifest`、`serializeTransferManifest` 是否一致。

##### 4.6 wire-frame.js → core transfer/wire-frame.ts

同上。检查 `encodeWireFrame`、`decodeWireFrame`、`WireFrameDecoder` 是否一致。

#### 每批验收

```bash
# 每迁一个模块：
node --check src/v2/<module>.js          # 语法检查
npm run test:core                         # 核心测试
npx tsx --test packages/cli/test/         # CLI 测试
# Electron 启动（如果能启动的话）：
npx electron . 2>&1 | head -20           # 看有没有报错
```

如果某个模块迁移后行为不一致：
1. 回退改动（`git checkout -- src/v2/<module>.js`）
2. 记录差异到 `MIGRATION_NOTES.md`
3. 继续下一个模块

#### 最终验收

```bash
# 全部测试
npx tsx --test packages/core/test/
npx tsx --test packages/cli/test/
node --check src/v2/*.js
node --check src/renderer/*.js
node --check src/preload.js
node --check src/main.js
# 互操作测试（如果 webdav server 能启动）
node test/webdav-interop-smoke.js
```

提交：
```
git commit -m "refactor: migrate v2 JS modules to core TS (batch 1-2)

Batch 1 (pure logic): canonical-json, constants, pairing
Batch 2 (fs/net deps): discovery, transfer-manifest, wire-frame

Each module replaced with an adapter that re-exports from @luo-5/core.
Behavioral differences documented in MIGRATION_NOTES.md.
All tests pass, Electron starts without errors."
```

---

### P5：Gemini 产出整合 + 安全加固

**前提：** Gemini 任务包已发给 Gemini，收到 `expected-output/` 目录。

如果没有收到 Gemini 产出，跳到 P5 备选方案（自主安全加固）。

#### 5.1 安全审计修复（A1-A4）

1. 阅读 `expected-output/A1-security-audit-report.md`
2. 逐条核对审计发现
3. 高优先级立即修：
   - 如果发现 timing attack 风险 → 用 `crypto.timingSafeEqual` 替换 `===` 比较
   - 如果发现 nonce 重用风险 → 检查 `encrypted-reader.ts` 的 nonce 生成
   - 如果发现路径遍历 → 检查 `receive-planner.ts` 的路径清洗
4. 整合 `expected-output/A2-timing-safe-compare.ts` → `packages/core/src/crypto/timing-safe-compare.ts`
5. 整合 `expected-output/A3-dos-protection/` → `packages/core/src/security/`
6. 测试：`npx tsx --test packages/core/test/`

#### 5.2 测试整合（B1-B4）

1. `expected-output/B1-python-ref/` → `packages/python-ref/`
   ```bash
   cd packages/python-ref
   python verify_vectors.py
   ```
2. `expected-output/B2-edge-cases/` → `packages/core/test/`
   ```bash
   npx tsx --test packages/core/test/edge-*.test.ts
   ```
3. `expected-output/B3-fuzz/` → `packages/core/test/`
4. `expected-output/B4-property/` → `packages/core/test/`

全部必须通过。如果有失败的，先修测试（可能是 Gemini 的测试有 bug），再确认代码没问题。

#### 5.3 性能优化（C1-C3）

1. 阅读 `expected-output/C1-performance-report.md`
2. 整合 `expected-output/C2-optimized/` 中的优化模块
3. **关键：** 逐个替换，每次替换后跑测试，确认 API 不变 + 测试通过
4. 基准对比：`expected-output/C3-benchmark/` 跑 `node benchmark.js` 对比优化前后
5. 只有在 API 不变 + 测试通过 + 性能有提升时才保留优化

#### 5.4 架构评审意见整合（E3）

1. 阅读 `expected-output/E3-architecture-review.md`
2. 逐条评估建议
3. 合理的记录到 `ARCHITECTURE_DECISIONS.md`
4. 如果建议调整规划，更新 `PROJECT_PLAN.md`

#### P5 备选方案（如果没收到 Gemini 产出）

自主做安全加固：

1. **Timing-safe 比较**：搜索所有 `===` 比较密钥/token 的地方，替换为 `crypto.timingSafeEqual`
   ```bash
   grep -rn "===.*key\|===.*token\|===.*signature" packages/core/src/ | grep -v test
   ```

2. **Nonce 唯一性**：检查 `encrypted-reader.ts` 的 nonce 生成，确保每次递增或随机
   ```bash
   grep -n "nonce" packages/core/src/transfer/encrypted-reader.ts
   ```

3. **路径遍历**：检查 `receive-planner.ts` 的路径清洗
   ```bash
   grep -n "\.\." packages/core/src/transfer/receive-planner.ts
   ```

4. **DoS 防护**：检查 wire-frame、chunk-frame 的大小限制
   ```bash
   grep -n "MAX_" packages/core/src/transfer/wire-frame.ts
   grep -n "MAX_" packages/core/src/transfer/chunk-frame.ts
   ```

5. 写测试验证以上安全措施

---

### P6：最终测试 + 发布准备

#### 6.1 全量测试

```bash
cd <repository-root>

# TypeScript 编译
npx tsc --noEmit -p packages/core/tsconfig.json
npx tsc --noEmit -p packages/cli/tsconfig.json

# 核心测试
npx tsx --test packages/core/test/

# CLI 测试
npx tsx --test packages/cli/test/

# 桌面端语法检查
node --check src/v2/*.js
node --check src/renderer/*.js
node --check src/preload.js
node --check src/main.js

# 互操作（如果能启动 server）
node scripts/webdav-test-server.js &
sleep 2
bash scripts/interop-webdav.sh
kill %1

# Python 向量验证（如果有 python-ref）
cd packages/python-ref && python verify_vectors.py && cd ../..
```

全部必须通过。有失败就修。

#### 6.2 CHANGELOG

文件：`CHANGELOG.md`（新建或更新）

```markdown
# Changelog

## [0.2.0] - 2026-08-25

### Added
- CLI `sync` command: recursive directory sync with incremental detection
- `createTransferReceiver`: receive-side transfer executor (mirror of sender)
- `sync-state.ts`: quick hash (1 MiB) + full hash incremental detection
- `resume-store.ts`: JSON-based resume state persistence
- `conflict-resolver.ts`: overwrite/rename-new/skip conflict strategies
- End-to-end integration test (SHA-256 file integrity verification)
- Timing-safe comparison utility
- DoS protection: rate limiter + connection limiter + safe JSON parser
- Edge case tests (canonical-json, manifest, crypto, wire-frame, discovery, control)
- Fuzz tests (1000 random round-trips)
- Property tests (100 random invariants)

### Fixed
- Bootstrap-to-stream-session handoff on same TCP connection (leftoverData buffer)
- Ed25519 key OID prefix (2b6570 instead of X25519's 2b656e)
- Ephemeral key export format (raw base64url instead of PEM)
- Wire frame trailing MUX data handling

### Changed
- Migrated v2 JS modules to core TS adapters (canonical-json, constants, pairing, discovery, manifest, wire-frame)
- npm package version 0.1.0 → 0.2.0

### Security
- Timing-safe comparison for all key/token comparisons
- Path traversal prevention in receive planner
- Nonce uniqueness verification in encrypted reader
- Size limits enforced on all frame types
```

#### 6.3 提交 + 推送

```bash
git add -A
git commit -m "chore: 0.2.0 release preparation

- Full test suite green (core + CLI + interop + python vectors)
- CHANGELOG for 0.2.0
- All Gemini integrations tested and verified"
git push origin main
```

#### 6.4 README 更新（如果 Gemini 产出了 E2）

如果 `expected-output/E2-readme/` 存在，整合到根 `README.md`。

否则手动更新 README：
- 添加 `sync` 命令文档
- 添加 0.2.0 版本信息
- 添加架构图链接

---

## ⏸ 晚间检查点 2

**检查项：**
1. `git log --oneline -15` — 确认 P4-P6 的提交
2. 全量测试全绿
3. `npm view @luo-5/core@0.2.0` — 确认发布
4. 手动跑 `send` + `receive` + `sync` — 功能正常
5. 如果有 Gemini 产出，检查安全审计报告的修复情况
6. 确认没有遗留的 TypeScript 编译错误

---

## 关键约束（全阶段适用）

1. **零运行时 npm 依赖**：`packages/core` 和 `packages/cli` 不引入新的 npm 依赖（只用 node: 内置模块）
2. **TypeScript strict 模式**：与 `packages/core/tsconfig.json` 一致
3. **提交规范**：遵循当前 `CONTRIBUTING.md`，提交身份由维护者本地配置
4. **安全模型不变**：Ed25519 签名 + SAS 双向比对码 + X25519 ECDH + AES-256-GCM
5. **Gemini 产出必须测试**：不盲目信任，整合后跑全部测试
6. **方案 A 不通切方案 B**：不要死磕一个方案
7. **每步都提交**：小步快跑，方便回退

## 关键文件路径速查

```
packages/core/src/transfer/bootstrap.ts       # P1 改动
packages/core/src/transfer/stream-session.ts   # P1 改动
packages/core/src/transfer/executor.ts         # P1 改动
packages/core/src/transfer/receiver.ts          # P1 改动
packages/core/src/transfer/sync-state.ts        # P3 新建
packages/core/src/transfer/resume-store.ts      # P3 新建
packages/core/src/transfer/conflict-resolver.ts # P3 新建
packages/cli/src/commands/sync.ts               # P3 新建
packages/cli/test/transfer-integration.test.ts  # P1 测试
packages/cli/test/sync.test.ts                  # P3 测试
src/v2/*.js                                      # P4 迁移目标
PROJECT_PLAN.md                                  # 原始规划
GOAL_24H_PLAN.md                                 # 本文件
```

## 故障恢复

如果某阶段卡住：
1. 检查 TypeScript 编译错误：`npx tsc --noEmit -p packages/core/tsconfig.json`
2. 检查测试失败：`npx tsx --test packages/core/test/ 2>&1 | grep -A5 "fail"`
3. 回退最近改动：`git diff HEAD~1` → 确认 → `git checkout -- .`
4. 跳过当前阶段，继续下一个（记录跳过原因）
5. 如果是网络问题（npm publish / git push）：等待重试，最多 5 次，每次间隔 15 秒
