/**
 * Public TypeScript interfaces for @nearby-transfer/core.
 *
 * Fully populated in M1.2; this file defines the core identity and transfer
 * types so the package compiles during the scaffold step.
 */

/** Stable identifier for a device, derived from its Ed25519 signing public key. */
export type DeviceId = string;

/** A device's long-term identity keypair (Ed25519 for signing, X25519 for ECDH). */
export interface PeerIdentity {
  deviceId: DeviceId;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  /** X25519 keypair used for session key agreement; may be ephemeral per transfer. */
  ecdhPublicKey: Uint8Array;
  ecdhPrivateKey: Uint8Array;
}

/** A device announcement discovered on the LAN. */
export interface DiscoveredPeer {
  deviceId: DeviceId;
  name: string;
  address: string;
  port: number;
  protocolVersion: number;
  capabilities: string[];
  lastSeen: number;
}

/** A persisted trust record for a paired peer. */
export interface TrustRecord {
  deviceId: DeviceId;
  name: string;
  signingPublicKey: Uint8Array;
  trustedAt: number;
}

/** Specification of a file to transfer. */
export interface FileSpec {
  path: string;
  size: number;
}

/** Progress of an in-flight transfer. */
export interface TransferProgress {
  path: string;
  fileSize: number;
  committedOffset: number;
  completed: boolean;
  nextSequence: number;
  totalTransferred: number;
}
