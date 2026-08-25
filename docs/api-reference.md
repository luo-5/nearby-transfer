# @luo-5/core API Reference

Complete reference for the `@luo-5/core` public API.

---

## 1. Crypto (`@luo-5/core/crypto`)

### `createEd25519KeyPair(): KeyPair`
Generates a new Ed25519 signing keypair in PEM format (`publicKey`, `privateKey`).

### `createX25519KeyPair(): KeyPair`
Generates a new X25519 ECDH keypair in PEM format.

### `deriveDeviceId(signingPublicKeyPem: string): string`
Returns the 16-hex-character device identifier derived from `sha256(signingPublicKeyPem).slice(0, 16)`.

### `fingerprintFor(publicKeyPem: string): string`
Computes the formatted fingerprint string (`AAAA-BBBB-CCCC-DDDD-EEEE-FFFF`).

### `deriveSessionKey(input: SessionKeyInput): Buffer`
Performs X25519 ECDH exchange and HKDF-SHA256 derivation to produce a 32-byte session key.

### `encryptChunk(input: ChunkEncryptInput): EncryptedChunk`
Encrypts a single plaintext buffer using AES-256-GCM and position-bound AAD. Returns `{ nonce, ciphertext, authTag }`.

### `decryptChunk(input: ChunkDecryptInput): Buffer`
Decrypts and authenticates an encrypted chunk. Throws `Error` if the tag fails to verify.

---

## 2. Discovery (`@luo-5/core/discovery`)

### `class V2Discovery extends EventEmitter`
Manages UDP multicast discovery announcements and peer tracking.
* `new V2Discovery(options: V2DiscoveryOptions)`
* `start(): void`
* `stop(): void`
* `listPeers(): DiscoveredPeerEntry[]`
* `getPeer(deviceId: string): DiscoveredPeerEntry | null`
* *Events*: `'peer'`, `'peers'`, `'error'`

---

## 3. Pairing (`@luo-5/core/pairing`)

### `derivePairingCode(context: PairingCodeContext): string`
Computes the 6-digit SAS code from the canonical JSON transcript of initiator and responder identities.

### `createPairingOffer(options): PairingOffer`
Creates a signed pairing offer envelope.

### `createPairingConfirmation(options): PairingConfirmation`
Creates a signed pairing confirmation payload carrying the 6-digit code.

---

## 4. Transfer Manifest (`@luo-5/core/transfer`)

### `createTransferManifest(input: CreateManifestInput): TransferManifest`
Creates and normalizes a transfer manifest containing file and directory entries.

### `serializeTransferManifest(manifest: TransferManifest): string`
Serializes a manifest into byte-for-byte canonical JSON for hashing and signing.

### `parsePersistedTransferManifest(serialized: string): TransferManifest`
Parses and validates a stored manifest string.

---

## 5. Transfer Execution (`@luo-5/core/transfer`)

### `createDesktopTransferExecutor(input: ExecutorInput): Promise<DesktopTransferExecutor>`
Initiates an outgoing transfer job to a connected peer.
* `done: Promise<void>`
* `pause(): Promise<void>`
* `resume(): Promise<void>`
* `cancel(reason?: unknown): Promise<void>`

### `createTransferReceiver(input: TransferReceiverInput): Promise<TransferReceiver>`
Accepts an incoming transfer stream on a TCP socket, receives manifest, and handles chunk writes.
* `done: Promise<void>`
* `pause(): Promise<void>`
* `resume(): Promise<void>`
* `cancel(reason?: unknown): Promise<void>`
