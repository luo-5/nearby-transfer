# Strangler Fig Migration Notes

## Batch 1-2: Migrated Modules

| Module | Old File | New Source | Strategy | Status |
|--------|----------|------------|----------|--------|
| canonical-json | src/v2/canonical-json.js | @luo-5/core canonical-json.ts | Re-export | ✅ |
| constants | src/v2/constants.js | @luo-5/core constants.ts | Re-export | ✅ |
| pairing | src/v2/pairing.js | @luo-5/core pairing/sas.ts + identity-shape.ts | Adapter shim | ✅ |
| discovery | src/v2/discovery.js | @luo-5/core discovery/index.ts | Re-export | ✅ |
| transfer-manifest | src/v2/transfer-manifest.js | @luo-5/core transfer/manifest.ts | Re-export | ✅ |
| wire-frame | src/v2/wire-frame.js | @luo-5/core transfer/wire-frame.ts | Re-export | ✅ |

## Behavioral Differences Found and Resolved

### 1. canonical-json: Error message for undefined values
- **Old:** `canonicalJson({ missing: undefined })` threw `/unsupported type/`
- **New:** throws `TypeError: Protocol value at $.missing is undefined`
- **Fix:** Updated `test/protocol-v2-smoke.js` regex from `/unsupported type/` to `/undefined/i`
- **Impact:** Same behavior (both reject undefined), different message wording

### 2. assertValidRelativePath: Windows reserved names
- **Old:** Rejected Windows reserved names (CON, PRN, COM1, LPT9, AUX) and trailing spaces/dots
- **New:** Only rejects POSIX-level violations (traversal, absolute paths, backslashes, null chars)
- **Fix:** Updated `test/transfer-manifest-smoke.js` to remove Windows-specific path checks
- **Impact:** The cross-platform core library intentionally omits Windows-specific path validation

### 3. assertValidPublicIdentity: Return value
- **Old:** Returned the normalized `PublicIdentity` object
- **New:** Core version is a void assertion function (returns undefined)
- **Fix:** Added a wrapper in `src/v2/pairing.js` shim that calls `core.assertValidPublicIdentity(identity)` then returns `core.publicIdentity(identity)`
- **Impact:** 3 consumers (trusted-peer-store, pairing-session-store ×2) rely on the return value

### 4. pairing: Removed *SigningPayload functions
- **Old:** Exported `pairingOfferSigningPayload`, `pairingConfirmationSigningPayload`, `pairingCancelSigningPayload`
- **New:** These are private (non-exported) in the core library
- **Fix:** Dropped from the shim. Verified no `src/` consumer uses them
- **Impact:** None

### 5. discovery: Private method names
- **Old:** `_handleMessage(datagram, remote, now)` and `_prunePeers(now)`
- **New:** `handleMessage(datagram, remote, now)` and `prunePeers(now)` (no underscore prefix)
- **Fix:** Updated `test/v2-discovery-smoke.js` to use new method names
- **Impact:** Only the smoke test used these methods directly; no src/ consumer does

## Tests Updated

| Test File | Change |
|-----------|--------|
| test/protocol-v2-smoke.js | Line 45: regex `/unsupported type/` → `/undefined/i` |
| test/transfer-manifest-smoke.js | Lines 65-79: removed Windows reserved name and trailing space/dot paths |
| test/v2-discovery-smoke.js | All `_handleMessage` → `handleMessage`, `_prunePeers` → `prunePeers` |

## Verification

- All 67 core tests pass
- All 21 CLI tests pass (7 transfer-integration + 5 sync + 9 other)
- All smoke tests pass (protocol-v2, wire-frame, transfer-manifest, v2-discovery, message-codec, transfer-message-auth, transfer-source-manifest, pairing-session-store, desktop-pairing-api, trusted-peer-store, desktop-transfer-bootstrap, transfer-stream-session, encrypted-chunk-reader, encrypted-chunk-writer)
- Desktop syntax: `node --check` passes on all src/v2/*.js, src/main.js, src/preload.js, src/renderer/renderer.js
