# Strangler Fig Migration Notes

## Overview

The Strangler Fig pattern was used to migrate desktop v2 JavaScript modules from `src/v2/*.js` to TypeScript in `@luo-5/core`. All legacy modules in `src/v2/` now either re-export directly from `@luo-5/core` or serve as thin compatibility adapters.

## Batch Migration Status

### Batch 1-2: Foundation & Crypto
| Module | Old File | New Source | Strategy | Status |
|--------|----------|------------|----------|--------|
| canonical-json | src/v2/canonical-json.js | @luo-5/core canonical-json.ts | Re-export | ✅ |
| constants | src/v2/constants.js | @luo-5/core constants.ts | Re-export | ✅ |
| pairing | src/v2/pairing.js | @luo-5/core pairing/sas.ts + identity-shape.ts | Adapter shim | ✅ |
| discovery | src/v2/discovery.js | @luo-5/core discovery/index.ts | Re-export | ✅ |
| transfer-manifest | src/v2/transfer-manifest.js | @luo-5/core transfer/manifest.ts | Re-export | ✅ |
| wire-frame | src/v2/wire-frame.js | @luo-5/core transfer/wire-frame.ts | Re-export | ✅ |

### Batch 3a: Pure Logic Modules (7/7)
| Module | Old File | New Source | Strategy | Status |
|--------|----------|------------|----------|--------|
| transfer-message-codec | src/v2/transfer-message-codec.js | @luo-5/core transfer/message-codec.ts | Re-export | ✅ |
| transfer-message-auth | src/v2/transfer-message-auth.js | @luo-5/core transfer/message-auth.ts | Re-export | ✅ |
| transfer-chunk-frame | src/v2/transfer-chunk-frame.js | @luo-5/core transfer/chunk-frame.ts | Re-export | ✅ |
| transfer-session-crypto | src/v2/transfer-session-crypto.js | @luo-5/core crypto/session.ts | Re-export | ✅ |
| transfer-source-manifest | src/v2/transfer-source-manifest.js | @luo-5/core transfer/source-manifest.ts | Re-export | ✅ |
| signed-stream-control | src/v2/signed-stream-control.js | @luo-5/core transfer/control.ts | Re-export | ✅ |
| message-codec | src/v2/message-codec.js | @luo-5/core pairing/message-codec.ts | Re-export | ✅ |

### Batch 3b: FS, Net & Scheduler Modules (10/10)
| Module | Old File | New Source | Strategy | Status |
|--------|----------|------------|----------|--------|
| encrypted-chunk-reader | src/v2/encrypted-chunk-reader.js | @luo-5/core transfer/encrypted-reader.ts | Re-export | ✅ |
| encrypted-chunk-writer | src/v2/encrypted-chunk-writer.js | @luo-5/core transfer/encrypted-writer.ts | Re-export | ✅ |
| receive-target-planner | src/v2/receive-target-planner.js | @luo-5/core transfer/receive-planner.ts | Re-export | ✅ |
| transfer-job-store | src/v2/transfer-job-store.js | @luo-5/core transfer/job-store.ts | Re-export | ✅ |
| pairing-session-store | src/v2/pairing-session-store.js | @luo-5/core pairing/session-store.ts | Adapter (JSON-backed) | ✅ |
| trusted-peer-store | src/v2/trusted-peer-store.js | @luo-5/core pairing/trust-store.ts | Adapter (JSON-backed) | ✅ |
| transfer-stream-session | src/v2/transfer-stream-session.js | @luo-5/core transfer/stream-session.ts | Re-export | ✅ |
| desktop-transfer-bootstrap | src/v2/desktop-transfer-bootstrap.js | @luo-5/core transfer/bootstrap.ts | Re-export | ✅ |
| desktop-transfer-executor | src/v2/desktop-transfer-executor.js | @luo-5/core transfer/executor.ts | Re-export | ✅ |
| desktop-transfer-scheduler | src/v2/desktop-transfer-scheduler.js | @luo-5/core transfer/scheduler.ts | Re-export | ✅ |

### Batch 3c: Electron & IPC Adapters (8/8)
| Module | Old File | Strategy | Status |
|--------|----------|----------|--------|
| desktop-lan-api | src/v2/desktop-lan-api.js | Electron IPC handler over core lan-service | ✅ |
| desktop-library-api | src/v2/desktop-library-api.js | Electron IPC handler over WebDAV service | ✅ |
| desktop-pairing-api | src/v2/desktop-pairing-api.js | Electron IPC handler over pairing router | ✅ |
| desktop-transfer-job-api | src/v2/desktop-transfer-job-api.js | Electron IPC handler over job store & scheduler | ✅ |
| lan-service | src/v2/lan-service.js | Bridge adapter to core transport/lan-service | ✅ |
| pairing-router | src/v2/pairing-router.js | Bridge adapter to core pairing/router | ✅ |
| preload | src/preload.js | Context bridge IPC exposing v2 API surface | ✅ |
| renderer | src/renderer/renderer.js | Frontend UI state machine | ✅ |

---

## Behavioral Differences Found and Resolved

### 1. Transfer Stream Leftover & Socket Pause Lifecycle
- **Issue:** Node.js streams emit chunks immediately in flowing mode when listener attached; removing listener without calling `socket.pause()` caused early `stream-hello` frame dropped before consumer attached.
- **Fix:** Added `socket.pause()` upon completing bootstrap frame detection and `socket.unshift(manifestResult.leftover)` when leftover bytes are present.
- **Impact:** Reliable handshake transitions on persistent TCP connections.

### 2. Multi-File Transfer Progress Path Resolution
- **Issue:** `_progressContext` exposed `chunk.path`, whereas receiver's `encodeProgress` checked `chunk.relativePath`, falling back to file 0.
- **Fix:** Handled both `chunk.path` and `chunk.relativePath`, ensuring accurate monotonic progress calculations across multi-file transfers.

### 3. Checkpoint Tracking Monotonicity
- **Issue:** `advanceTransferControlCheckpoint` required incremental progression from `TYPE_TRANSFER_RESUME` through each `TYPE_TRANSFER_PROGRESS` frame.
- **Fix:** Both sender progress committer and receiver progress encoder advance monotonic control checkpoints synchronously.

---

## Full Test Verification

- **Core Suite**: 124 unit, property, and fuzz tests passing (100%).
- **CLI Suite**: 21 integration, sync, unit, and E2E transfer tests passing (100%).
- **Desktop Smoke**: 41 smoke, stress, multi-round, and interop suites passing (100%).
- **Python Reference**: 10/10 test vector groups verified successfully.
- **Typecheck & Syntax**: Zero TypeScript errors (`strict`, `exactOptionalPropertyTypes`) and zero JavaScript syntax errors.
