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
