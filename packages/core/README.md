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

`0.1.0` — under active development (M1 extraction). The desktop app will switch to consuming this package once migration is complete.

## License

MIT
