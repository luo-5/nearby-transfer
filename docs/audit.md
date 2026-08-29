# Nearby Transfer — 代码审计与 M1 迁移映射 (M0)

> 审计范围：`src/v2/*.js`（31 模块）、`src/core/*.js`（7 模块）、`src/protocols/*.js`（2 模块）+ 7 个协议驱动。
> 目的：为 M1（抽取 `@luo-5/core` TypeScript 包）提供逐模块的职责、依赖、平台耦合分级，以及「旧路径 → core 目标路径」映射表。
>
> 基线：main `732b29b`，桌面端 `1.3.0`，42 项 smoke 测试。

## 1. 总览

| 层 | 模块数 | 说明 |
|---|---|---|
| `src/v2/` | 31 | v2 协议核心（加密/配对/传输/发现/库服务）+ 桌面 IPC 封装 |
| `src/core/` | 7 | v1 时代的底层原语（crypto/discovery/server/transfer/config/path） |
| `src/protocols/` | 2 + 7 驱动 | 7 协议注册表与驱动（turbo/quic/smb/webdav/v2-stream/v1/ftps） |

**关键事实（修正 M1 计划中的假设）：**
- 三个持久化存储（`trusted-peer-store` / `pairing-session-store` / `transfer-job-store`）使用的是 **`node:sqlite`（Node 22+ 内置）**，**不是** `better-sqlite3`。已是零原生依赖，但 `node:sqlite` 仅限 Node 运行时，不可在浏览器/打包器中使用。M1 改为 **JSON 文件存储** 以保证 core 包的可移植性。
- 唯一直接依赖 Electron 的模块是 **`cert-manager.js`**（用 `app.getPath` 定位证书目录）。它不迁入 core。
- 名为 `desktop-*` 的模块中，**`desktop-transfer-executor` / `desktop-transfer-bootstrap` / `desktop-transfer-scheduler` 实际不 require Electron**（仅 `crypto`/`net`/内部模块），是纯 Node 逻辑，只是被桌面端使用——它们可以迁入 core。真正留在 `src/` 的是 IPC API 表面（`desktop-*-api.js`）与依赖 `cert-manager` 的 `desktop-library-service`。
- Android 端 v2 协议以 **Java** 实现（`V2*.java`，约 20 个文件），与 JS 模块一一对应；Kotlin `core/` 目录是数据/持久化层（Room），不直接对应 JS 协议模块。

## 2. 平台耦合分级

- **A 纯逻辑**：零 Node 运行时依赖（最多 `util`），可直接迁移。
- **B Node crypto/util**：仅用 `node:crypto` / `util`，迁移后保持 Node `crypto`（不引入 tweetnacl）。
- **C Node fs/path**：文件 I/O，迁移时保留 `node:fs`/`node:path`（core 仍是 Node 库）。
- **D Node net/dgram/http**：网络/传输，迁入 core 的 transport/discovery 子目录。
- **E Node + 原生内置**：`node:sqlite`，M1 改 JSON 存储。
- **F Electron 耦合 / 桌面 IPC**：留在 `src/`，不迁入 core。

## 3. 逐模块审计

### 3.1 `src/v2/` — 协议核心与桌面封装

| 文件 | 职责 | 公开导出（要点） | 依赖 | 级别 | core 目标 | Android 对应 |
|---|---|---|---|---|---|---|
| `canonical-json.js` | 确定性 JSON 序列化（签名前规范化） | `canonicalize`, `canonicalizeForSignature` | — | A | `src/canonical-json.ts` | `JsonUtil` (内联) |
| `constants.js` | 协议常量（端口/魔数/版本/分块大小） | 常量对象 | — | A | `src/constants.ts` | `ProtocolV2` 常量 |
| `wire-frame.js` | 长度前缀帧编解码（TCP 流分帧） | `encodeFrame`, `decodeFrame`, `WireFrameDecoder` | util, canonical-json, constants | A | `src/transfer/wire-frame.ts` | `V2TransferChunkFrame` |
| `message-codec.js` | 配对/控制消息 JSON 编解码 | `encodeMessage`, `decodeMessage` | util, constants, canonical-json, pairing | A | `src/pairing/message-codec.ts` | `V2ControlMessage` |
| `pairing-router.js` | 配对会话路由（按 pairingId 分发） | `createPairingRouter` | constants, message-codec, pairing | A | `src/pairing/router.ts` | `V2PairingController` |
| `pairing.js` | SAS 6 位配对码派生/确认/签名验证 | `derivePairingCode`, `pairingCodeTranscript`, `createPairingConfirmation`, `signPairingConfirmation`, `verifyPairingConfirmation`, `assertValidPairingOffer` | crypto, constants, canonical-json, ../core/crypto | B | `src/pairing/sas.ts` | `V2Pairing` |
| `transfer-manifest.js` | 传输清单（文件条目/哈希/签名） | `createManifest`, `signManifest`, `verifyManifest`, `encodeManifest`, `decodeManifest` | crypto, constants, canonical-json | B | `src/transfer/manifest.ts` | `TransferManifestCodec` |
| `transfer-session-crypto.js` | 会话密钥派生（X25519 ECDH）+ 分块加解密（AES-256-GCM） | `deriveSessionKey`, `encryptChunk`, `decryptChunk` | crypto, transfer-manifest | B | `src/crypto/session.ts` | `CryptoUtil` + `V2EncryptedChunkWriter` |
| `transfer-message-codec.js` | 传输控制消息（manifest/progress/ack）编解码 | `encodeManifestFrame`, `decodeFrame`, `encodeProgress`, `encodeAck` 等 | util, constants, canonical-json, transfer-manifest, transfer-session-crypto | A | `src/transfer/message-codec.ts` | `V2TransferAcknowledgementCodec` |
| `transfer-message-auth.js` | 控制消息 Ed25519 签名/验证 | `signTransferMessage`, `verifyTransferMessage` | crypto, constants, transfer-message-codec | B | `src/transfer/message-auth.ts` | `V2SignedStreamControl` |
| `signed-stream-control.js` | 流式控制帧（带签名）状态机 | `createSignedStreamControlCodec`, `createStreamControlSession` | crypto, util, constants, canonical-json, transfer-manifest, transfer-message-codec | B | `src/transfer/control.ts` | `V2SignedStreamControl` |
| `transfer-chunk-frame.js` | 加密数据块帧编解码（序列号/偏移） | `encodeChunkFrame`, `decodeChunkFrame` | util, transfer-session-crypto, transfer-manifest | A | `src/transfer/chunk-frame.ts` | `V2TransferChunkFrame` |
| `transfer-stream-session.js` | 传输会话状态机（发送/接收/断点续传协调） | `createTransferStreamSession` | transfer-manifest, signed-stream-control, transfer-message-codec, transfer-chunk-frame | A | `src/transfer/stream-session.ts` | `V2IncomingTransferRuntime` |
| `discovery.js` | v2 UDP 组播发现（announce/listen/去重/TTL） | `createDiscoveryService`, `Peer` | crypto, dgram, events, util, constants, canonical-json, ../core/multicast-interfaces, pairing | D | `src/discovery/index.ts` | `V2DiscoveryService`, `V2DiscoveryAnnouncement` |
| `lan-service.js` | v2 TCP 传输服务端（接受连接/分发会话） | `createLanService` | net, events, constants, discovery, wire-frame, message-codec, pairing, pairing-router, pairing-session-store | D | `src/transport/lan-service.ts` | `V2LanService` |
| `encrypted-chunk-reader.js` | 发送端：读文件→加密→产出块帧 | `createEncryptedChunkReader` | crypto, fs, path, util, transfer-session-crypto, transfer-manifest | C | `src/transfer/encrypted-reader.ts` | `V2IncomingTransferRuntime`（接收侧） |
| `encrypted-chunk-writer.js` | 接收端：解密块帧→落盘→提交偏移 | `createEncryptedChunkWriter` | crypto, fs, path, util, receive-target-planner, transfer-manifest, transfer-session-crypto | C | `src/transfer/encrypted-writer.ts` | `V2EncryptedChunkWriter` |
| `receive-target-planner.js` | 接收目标规划（目录/冲突/断点 staging） | `createReceiveTargetPlanner` | crypto, fs, path, util, transfer-manifest | C | `src/transfer/receive-planner.ts` | `V2StagingLayout` |
| `transfer-source-manifest.js` | 发送端清单构建（扫描文件/计算大小） | `buildSourceManifest` | crypto, fs, path, transfer-manifest | C | `src/transfer/source-manifest.ts` | `V2TransferBootstrap` |
| `trusted-peer-store.js` | 信任库持久化（已配对设备） | `createTrustedPeerStore`, `loadOrCreateDevice` | fs, path, node:sqlite, pairing | E | `src/pairing/trust-store.ts` | `TrustedPeerRepository`/`TrustedPeerDao` |
| `pairing-session-store.js` | 配对会话状态持久化 | `createPairingSessionStore` | fs, path, node:sqlite, pairing, trusted-peer-store, canonical-json | E | `src/pairing/session-store.ts` | `V2PairingSessionStore` |
| `transfer-job-store.js` | 传输任务持久化（断点续传状态） | `createTransferJobStore` | fs, path, node:sqlite, transfer-manifest, trusted-peer-store | E | `src/transfer/job-store.ts` | `TransferJobDao`/`RoomTransferJobRepository` |
| `desktop-transfer-executor.js` | 传输执行器（编排发送全流程，net 客户端） | `createDesktopTransferExecutor` | crypto, net, transfer-job-store, transfer-manifest, transfer-message-codec, transfer-message-auth, desktop-transfer-bootstrap, encrypted-chunk-reader, signed-stream-control, transfer-session-crypto, transfer-stream-session | D | `src/transfer/executor.ts` | `TransferClient` |
| `desktop-transfer-bootstrap.js` | 接收端引导（建连→收 manifest→协商） | `createDesktopTransferBootstrap` | crypto, constants, transfer-manifest, transfer-message-codec, transfer-message-auth, wire-frame | B | `src/transfer/bootstrap.ts` | `V2TransferBootstrap` |
| `desktop-transfer-scheduler.js` | 传输任务调度（队列/并发/重试） | `createDesktopTransferScheduler` | transfer-job-store | A | `src/transfer/scheduler.ts` | `TransferForegroundService` |
| `cert-manager.js` | 自签名 TLS 证书生成/缓存（Electron 路径） | `CertManager` 单例 | fs, path, os, crypto, **electron** | F | **不迁移**（留 src/） | — |
| `desktop-library-service.js` | 共享库 HTTPS WebDAV 服务（PROPFIND/GET/PUT/DELETE/MKCOL + 鉴权） | `createDesktopLibraryService` | https, fs, path, crypto, cert-manager | F | **不迁移**（依赖 cert-manager） | `WebDavClient`（客户端） |
| `desktop-lan-api.js` | LAN 服务 IPC 封装 | `createDesktopLanApi` | desktop-pairing-api | F | **不迁移** | — |
| `desktop-library-api.js` | 库服务 IPC 封装（路径管理） | `createDesktopLibraryApi` | path, fs | F | **不迁移** | — |
| `desktop-pairing-api.js` | 配对 IPC 封装 | `createDesktopPairingApi` | pairing | F | **不迁移** | — |
| `desktop-transfer-job-api.js` | 任务 IPC 封装 | `createDesktopTransferJobApi` | — | F | **不迁移** | — |

### 3.2 `src/core/` — v1 底层原语

| 文件 | 职责 | 公开导出 | 依赖 | 级别 | core 目标 | 说明 |
|---|---|---|---|---|---|---|
| `crypto.js` | v1 加密原语：X25519 密钥对、传输密钥派生、流式加解密帧 | `createX25519KeyPair`, `deriveTransferKey`, `EncryptFrameStream`, `DecryptFrameStream`, `createKeyPair`, `fingerprintFor` | crypto, fs, stream | B/C | `src/crypto/identity.ts`（身份/指纹）+ `src/crypto/legacy-stream.ts`（v1 流） | v1 流式加密是旧协议，保留为 legacy；身份/指纹部分被 v2 复用 |
| `discovery.js` | v1 UDP 发现（旧协议） | `createDiscovery` | dgram, crypto, events, crypto, multicast-interfaces | D | `src/discovery/legacy.ts` | v1 发现，标记 legacy |
| `multicast-interfaces.js` | 枚举可用组播网卡 | `getMulticastInterfaces` | os | D | `src/discovery/multicast-interfaces.ts` | 被 v2/v1 discovery 共用 |
| `config.js` | 设备身份/配置加载（protocol_config.json） | `loadConfig`, `getDeviceIdentity` | fs, os, path, crypto, crypto | C | `src/config.ts`（仅纯逻辑部分）；fs 部分留桌面 | 桌面端配置加载 |
| `path-utils.js` | 路径工具（安全拼接/规范化） | 路径工具函数 | fs, path | C | `src/utils/path.ts` | 通用工具 |
| `server.js` | v1 HTTP 传输服务端（旧协议） | `TransferServer` | crypto, fs, http, path, stream, stream/promises, crypto, path-utils | F | **不迁移**（v1 旧协议，留 src/） | legacy |
| `transfer.js` | v1 HTTP 传输客户端（旧协议） | `createTransfer` | crypto, fs, http, path, stream, stream/promises, crypto | F | **不迁移**（v1 旧协议，留 src/） | legacy |

### 3.3 `src/protocols/` — 协议注册表

| 文件 | 职责 | 依赖 | 级别 | core 目标 |
|---|---|---|---|---|
| `protocol-types.js` | 协议元数据类型/分类常量 | — | A | `src/protocol/types.ts` |
| `protocol-engine.js` | 7 协议注册表 + 热切换 | protocol-types, 7 个 driver | A | `src/protocol/registry.ts` |
| `drivers/v2-stream-driver.js` | v2 流协议驱动 | v2 模块 | B | `src/protocol/v2-stream.ts` |
| `drivers/v1-classic-driver.js` | v1 旧协议驱动 | core v1 | F | 标记 experimental / 留 src/ |
| `drivers/turbo-parallel-driver.js` | 极速并行驱动 | — | A | `src/protocol/turbo-parallel.ts` |
| `drivers/quic-udp-driver.js` | QUIC/UDP 驱动 | — | A | 标记 experimental |
| `drivers/smb-share-driver.js` | SMB 驱动 | — | A | 标记 experimental |
| `drivers/webdav-sync-driver.js` | WebDAV 同步驱动 | — | A | 标记 experimental |
| `drivers/ftps-secure-driver.js` | FTPS 驱动 | — | A | 标记 experimental |

> M1.7 目标：`v2-stream` 完整实现迁入 core，其余驱动标记 `experimental`（接口占位）。

## 4. 旧路径 → core 目标路径 映射表（M1 迁移用）

| 旧路径 | core 目标 | M1 步骤 |
|---|---|---|
| `src/v2/canonical-json.js` | `packages/core/src/canonical-json.ts` | 1.8 |
| `src/v2/constants.js` | `packages/core/src/constants.ts` | 1.8 |
| `src/core/crypto.js`（身份/指纹） | `packages/core/src/crypto/identity.ts` | 1.3 |
| `src/v2/transfer-session-crypto.js` | `packages/core/src/crypto/session.ts` | 1.3 |
| `src/v2/transfer-manifest.js`（加密相关） | `packages/core/src/crypto/chunk.ts`（分块加密向量） | 1.3 |
| `src/v2/discovery.js` | `packages/core/src/discovery/index.ts` | 1.4 |
| `src/core/discovery.js` | `packages/core/src/discovery/legacy.ts` | 1.4 |
| `src/core/multicast-interfaces.js` | `packages/core/src/discovery/multicast-interfaces.ts` | 1.4 |
| `src/v2/pairing.js` | `packages/core/src/pairing/sas.ts` | 1.5 |
| `src/v2/pairing-session-store.js` | `packages/core/src/pairing/session-store.ts`（JSON） | 1.5 |
| `src/v2/trusted-peer-store.js` | `packages/core/src/pairing/trust-store.ts`（JSON） | 1.5 |
| `src/v2/message-codec.js` | `packages/core/src/pairing/message-codec.ts` | 1.5 |
| `src/v2/pairing-router.js` | `packages/core/src/pairing/router.ts` | 1.5 |
| `src/v2/transfer-manifest.js` | `packages/core/src/transfer/manifest.ts` | 1.6 |
| `src/v2/transfer-source-manifest.js` | `packages/core/src/transfer/source-manifest.ts` | 1.6 |
| `src/v2/transfer-chunk-frame.js` | `packages/core/src/transfer/chunk-frame.ts` | 1.6 |
| `src/v2/transfer-stream-session.js` | `packages/core/src/transfer/stream-session.ts` | 1.6 |
| `src/v2/encrypted-chunk-reader.js` | `packages/core/src/transfer/encrypted-reader.ts` | 1.6 |
| `src/v2/encrypted-chunk-writer.js` | `packages/core/src/transfer/encrypted-writer.ts` | 1.6 |
| `src/v2/receive-target-planner.js` | `packages/core/src/transfer/receive-planner.ts` | 1.6 |
| `src/v2/signed-stream-control.js` | `packages/core/src/transfer/control.ts` | 1.6 |
| `src/v2/transfer-message-codec.js` | `packages/core/src/transfer/message-codec.ts` | 1.6 |
| `src/v2/transfer-message-auth.js` | `packages/core/src/transfer/message-auth.ts` | 1.6 |
| `src/v2/wire-frame.js` | `packages/core/src/transfer/wire-frame.ts` | 1.6 |
| `src/v2/desktop-transfer-executor.js` | `packages/core/src/transfer/executor.ts` | 1.6 |
| `src/v2/desktop-transfer-bootstrap.js` | `packages/core/src/transfer/bootstrap.ts` | 1.6 |
| `src/v2/transfer-job-store.js` | `packages/core/src/transfer/job-store.ts`（JSON） | 1.6 |
| `src/v2/desktop-transfer-scheduler.js` | `packages/core/src/transfer/scheduler.ts` | 1.6 |
| `src/v2/lan-service.js` | `packages/core/src/transport/lan-service.ts` | 1.6（随 transport） |
| `src/protocols/protocol-engine.js` | `packages/core/src/protocol/registry.ts` | 1.7 |
| `src/protocols/protocol-types.js` | `packages/core/src/protocol/types.ts` | 1.7 |
| `src/protocols/drivers/v2-stream-driver.js` | `packages/core/src/protocol/v2-stream.ts` | 1.7 |

**留 `src/`（不迁移）：** `cert-manager.js`、`desktop-library-service.js`、`desktop-lan-api.js`、`desktop-library-api.js`、`desktop-pairing-api.js`、`desktop-transfer-job-api.js`、`src/core/server.js`、`src/core/transfer.js`、`src/core/config.js`（fs 部分）、`src/core/path-utils.js`。

## 5. 现有测试向量

| 测试文件 | 覆盖模块 | 向量形态 |
|---|---|---|
| `test/crypto-smoke.js` | `src/core/crypto.js`（X25519/deriveTransferKey/流式加解密） | 运行时随机密钥对（**非确定性向量**）— 验证 round-trip/tamper/wrong-key/truncate |
| `test/protocol-v2-smoke.js` | `pairing.js`（SAS 配对码） | **确定性向量**：`test/fixtures/protocol-v2-pairing.json` → `pairingCode.pairingId` + `expectedTranscript` + `expectedCode` |
| `test/transfer-session-crypto-smoke.js` | `transfer-session-crypto.js` | 运行时随机（非确定性） |
| `test/transfer-chunk-frame-smoke.js` | `transfer-chunk-frame.js` | 运行时随机 |
| `test/transfer-message-auth-smoke.js` | `transfer-message-auth.js` | 运行时随机 |

**M1.3 需新增确定性测试向量 JSON**（至少 3 组）：
1. 身份派生：固定 Ed25519 种子 → `deviceId` / `fingerprint`
2. 密钥协商：固定 Alice/Bob X25519 私钥 → `sessionKey`
3. 分块加密：固定 `sessionKey` + `plaintext` + `sequence` → `ciphertext`（AES-256-GCM，含 nonce/tag）

> 现有 `protocol-v2-pairing.json` 的 SAS 向量可直接复用到 core 测试。

## 6. M1 关键决策与风险

1. **存储后端**：三个 store 用 `node:sqlite`（内置、零原生依赖，但仅 Node 可用）。core 包改为 **JSON 文件存储**以保证可移植性；定义 `TrustStore`/`SessionStore`/`JobStore` 接口，JSON 为默认实现，`node:sqlite` 可作为可选后端。
2. **`desktop-transfer-*` 命名误导**：executor/bootstrap/scheduler 不依赖 Electron，是纯 Node 逻辑，迁入 core；真正留 `src/` 的是 `*-api.js`（IPC 表面）与 `desktop-library-service`（依赖 cert-manager）。
3. **crypto 双轨**：`src/core/crypto.js` 含 v1 流式加密（`EncryptFrameStream`）与 v2 身份原语（`createKeyPair`/`fingerprintFor`）。v2 身份部分迁 `crypto/identity.ts`；v1 流式迁 `crypto/legacy-stream.ts` 标记 legacy。
4. **传输层 `net`/`dgram`**：core 是 Node 库（非浏览器库），保留 `node:net`/`node:dgram`。transport/discovery 子目录承载网络 I/O。
5. **绞杀者迁移**：旧 `src/v2/*.js`、`src/core/*.js` 在 M1.9 切换后保留并标记 deprecated，等 CI 全绿后再删（不在本轮删）。
6. **零运行时依赖**：core 包尽量零运行时依赖，仅 `node:crypto`/`node:net` 等内置模块；不引入 tweetnacl（`node:crypto` 的 X25519/Ed25519/AES-256-GCM 已足够）。
7. **Android 不动**：M1 只抽桌面端 core 包；Android Java `V2*.java` 与 Kotlin `core/` 数据层是 M5 的事。
