# @luo-5/core

Protocol core for [Nearby Transfer](https://github.com/luo-5/nearby-transfer) — a pure TypeScript implementation of the v2 protocol with no Electron or DOM dependencies.

## Contents

- **crypto** — Ed25519 device identities, X25519 ECDH session key agreement, AES-256-GCM chunk encryption
- **discovery** — UDP multicast device announcement, listen, deduplication, TTL expiry
- **pairing** — 6-digit SAS pairing code derivation, signed confirmation, trust store
- **transfer** — manifest signing, resumable chunked transfer, encrypted chunk reader/writer, stream session state machine
- **protocol** — 7-protocol registry with hot-switching
- **canonical-json** — deterministic JSON serialization for signature canonicalization

## Status

`0.2.0` — under active development (M1 extraction). The desktop app consumes this package through strangler-fig adapters in `src/v2/`, and the packaged bundle vendors the built artifact (`scripts/build-vendor.js`).

## Install

```bash
npm install @luo-5/core
```

Requires Node.js >= 22. Ships dual ESM/CJS builds with TypeScript declarations.

## Example

```ts
import {
  createX25519KeyPair,
  deriveSessionKey,
  encryptChunk,
} from '@luo-5/core';

const sender = createX25519KeyPair();
const receiver = createX25519KeyPair();

const key = deriveSessionKey({
  localPrivateKeyPem: sender.privateKey,
  remotePublicKeyPem: receiver.publicKey,
  senderDeviceId: '0123456789abcdef',
  receiverDeviceId: 'fedcba9876543210',
  taskId: 'AQIDBAUGBwgJCgsMDQ4PEA', // 16-byte base64url task id
  manifestSha256: '64-hex-manifest-digest',
});

// The nonce is generated internally; the AAD binds the chunk to its position.
const { nonce, ciphertext, authTag } = encryptChunk({
  key,
  taskId: 'AQIDBAUGBwgJCgsMDQ4PEA',
  path: 'docs/report.pdf',
  offset: 0,
  sequence: 0,
  plaintext: new TextEncoder().encode('hello'),
});
```

Cross-language test vectors (TypeScript / Java / Python) live in the repository
under `test/fixtures/`.

## License

MIT
