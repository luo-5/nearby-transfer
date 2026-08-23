/**
 * @nearby-transfer/core — protocol core for Nearby Transfer.
 *
 * Pure TypeScript implementation of the v2 protocol: device identities (Ed25519),
 * session key agreement (X25519 ECDH), AES-256-GCM chunk encryption, UDP multicast
 * discovery, 6-digit SAS pairing, resumable chunked transfer, and the protocol
 * registry. No Electron or DOM dependencies.
 *
 * This entry re-exports the public surface as the modules are migrated in M1.
 */

export * from './constants.js';
export * from './canonical-json.js';
export * from './types.js';
export * from './crypto/identity.js';
export * from './crypto/session.js';
export * from './crypto/chunk.js';
export * from './discovery/multicast-interfaces.js';
export * from './discovery/index.js';
export * from './pairing/identity-shape.js';
export * from './pairing/sas.js';
export * from './pairing/trust-store.js';
export * from './pairing/session-store.js';
export * from './pairing/message-codec.js';
export * from './pairing/router.js';
export * from './transfer/manifest.js';
export * from './transfer/manifest-validation.js';
export * from './transfer/wire-frame.js';
export * from './transfer/chunk-frame.js';
export * from './transfer/message-codec.js';
export * from './transfer/message-auth.js';
export * from './transfer/source-manifest.js';
export * from './transfer/encrypted-reader.js';
export * from './transfer/control.js';
export * from './transport/lan-service.js';
export * from './protocol/types.js';
export * from './protocol/registry.js';
