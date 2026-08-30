# `@luo-5/core` selected API overview

This page highlights commonly used exports. It is not an exhaustive API reference.
The published package currently exposes its public API from the package root only:

```ts
import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  V2Discovery,
  createTransferManifest,
  createDesktopTransferExecutor
} from '@luo-5/core';
```

Imports such as `@luo-5/core/crypto` or `@luo-5/core/transfer` are not public
package entry points.

## Identity and session primitives

- `createEd25519KeyPair()` creates a signing key pair in PEM form.
- `createX25519KeyPair()` creates a key-agreement key pair in PEM form.
- `deriveDeviceId(signingPublicKeyPem)` derives the 16-character device ID.
- `fingerprintFor(publicKeyPem)` returns a human-readable key fingerprint.
- `deriveSessionKey(input)` derives a 32-byte session key with X25519 and HKDF-SHA256.
- `encryptChunk(input)` and `decryptChunk(input)` use AES-256-GCM with position-bound authenticated metadata.

## Discovery and pairing

- `V2Discovery` manages signed v2 discovery announcements and peer expiry.
- `createDiscoveryAnnouncement`, `signDiscoveryAnnouncement`, and `verifyDiscoveryAnnouncement` create and verify discovery messages.
- `derivePairingCode(context)` derives the six-digit SAS value.
- `createPairingOffer` and `createPairingConfirmation` build pairing messages.

## Transfer manifests and execution

- `createTransferManifest(input)` normalizes file and directory entries.
- `serializeTransferManifest(manifest)` produces canonical persisted JSON.
- `parsePersistedTransferManifest(serialized)` validates stored manifests.
- `createDesktopTransferExecutor(input)` creates an outgoing v2 transfer executor.
- `createTransferReceiver(input)` creates a v2 receive-side executor.

Executors expose a `done` promise and asynchronous `pause`, `resume`, and `cancel` operations. Protocol-v2 executors are library components; they are not yet connected to the default Electron desktop send/receive data path. See [`capabilities.md`](capabilities.md) before presenting a component as shipped.

For the exact current public surface and TypeScript types, use the declarations published with the installed package or inspect `packages/core/src/index.ts` in the matching source tag.
