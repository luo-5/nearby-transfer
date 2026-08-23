/**
 * Public TypeScript interfaces for @nearby-transfer/core.
 *
 * These define the stable API surface that the desktop app, future CLI, and
 * other consumers program against. Implementation modules (crypto, discovery,
 * pairing, transfer, protocol) are migrated in M1.3-M1.7 and re-exported from
 * index.ts; the interfaces here are contract-only.
 */

import type { CanonicalValue } from './canonical-json.js';
import type { MessageType } from './constants.js';

// ---------------------------------------------------------------------------
// Identity & crypto
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/** Specification of a file to transfer. */
export interface FileSpec {
  path: string;
  size: number;
}

/** A single entry in a transfer manifest. */
export interface ManifestEntry {
  path: string;
  size: number;
  sha256?: string;
}

/** A signed transfer manifest. */
export interface TransferManifest {
  transferId: string;
  entries: ManifestEntry[];
  senderDeviceId: DeviceId;
  signature: Uint8Array;
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

/** Options for serving an incoming transfer. */
export interface ServeOptions {
  receiveDirectory: string;
  /** Called as each file completes or progress advances. */
  onProgress?: (progress: TransferProgress) => void;
  /** Called when the manifest arrives, before any chunk. Return false to reject. */
  onManifest?: (manifest: TransferManifest) => boolean | Promise<boolean>;
  /** Chunk size in bytes; defaults to 4 MiB. */
  chunkSize?: number;
}

/** Result of a completed transfer. */
export interface TransferResult {
  transferId: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Discovery service
// ---------------------------------------------------------------------------

/** Emitted when a peer appears, updates, or expires from the LAN. */
export type DiscoveryEvent =
  | { type: 'peer-found'; peer: DiscoveredPeer }
  | { type: 'peer-updated'; peer: DiscoveredPeer }
  | { type: 'peer-lost'; deviceId: DeviceId };

/** A listener for discovery events. */
export type DiscoveryListener = (event: DiscoveryEvent) => void;

/** Multicast discovery of nearby devices on the LAN. */
export interface DiscoveryService {
  /** Begin broadcasting this device's announcement and listening for peers. */
  start(identity: PeerIdentity, options?: DiscoveryOptions): Promise<void>;
  /** Stop broadcasting and listening. */
  stop(): Promise<void>;
  /** Snapshot of currently-visible peers. */
  getPeers(): DiscoveredPeer[];
  /** Subscribe to peer found/updated/lost events. Returns an unsubscribe fn. */
  on(listener: DiscoveryListener): () => void;
}

export interface DiscoveryOptions {
  /** Multicast address; defaults to the protocol's standard group. */
  multicastAddress?: string;
  /** Multicast port. */
  port?: number;
  /** Human-readable device name advertised to peers. */
  name?: string;
  /** Capability tags advertised to peers. */
  capabilities?: string[];
  /** Announce interval in ms; defaults to 2000. */
  announceIntervalMs?: number;
  /** Peer expiry timeout in ms; defaults to 10000. */
  peerTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Trust store
// ---------------------------------------------------------------------------

/** Persistence for paired/trusted peers. Implementations: JSON file (default). */
export interface TrustStore {
  load(): Promise<TrustRecord[]>;
  get(deviceId: DeviceId): Promise<TrustRecord | null>;
  save(record: TrustRecord): Promise<void>;
  remove(deviceId: DeviceId): Promise<void>;
  clear(): Promise<void>;
}

/** Persistence for in-flight pairing sessions. */
export interface SessionStore {
  get(pairingId: string): Promise<unknown>;
  save(pairingId: string, session: unknown): Promise<void>;
  remove(pairingId: string): Promise<void>;
  clear(): Promise<void>;
}

/** Persistence for resumable transfer jobs. */
export interface JobStore {
  load(): Promise<unknown[]>;
  save(job: unknown): Promise<void>;
  remove(transferId: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Protocol registry
// ---------------------------------------------------------------------------

export type ProtocolId =
  | 'v2-stream'
  | 'turbo-parallel'
  | 'quic-udp'
  | 'smb-share'
  | 'webdav-sync'
  | 'v1-classic'
  | 'ftps-secure';

export type ProtocolCategory = 'fast' | 'system' | 'standard';

export type ProtocolState = 'idle' | 'ready' | 'active' | 'stopped' | 'error';

/** Status snapshot of a registered protocol driver. */
export interface ProtocolStatus {
  id: ProtocolId;
  name: string;
  category: ProtocolCategory;
  defaultPort: number;
  active: boolean;
  state: ProtocolState;
}

/** A protocol driver adapter. v2-stream is fully implemented; others are experimental. */
export interface ProtocolAdapter {
  id: ProtocolId;
  name: string;
  category: ProtocolCategory;
  defaultPort: number;
  init(config?: Record<string, unknown>): Promise<{ ok: boolean; id: ProtocolId }>;
  sendFile(peer: DiscoveredPeer, filePath: string, options?: Record<string, unknown>): Promise<TransferResult>;
  receiveFile(session: unknown, targetDir: string, options?: Record<string, unknown>): Promise<TransferResult>;
  pause(transferId: string): Promise<{ ok: boolean; paused: boolean }>;
  resume(transferId: string): Promise<{ ok: boolean; resumed: boolean }>;
  cancel(transferId: string): Promise<{ ok: boolean; cancelled: boolean }>;
  shutdown(): Promise<{ ok: boolean }>;
  getStatus(): ProtocolStatus;
}

/** Registry of available protocol drivers with hot-switching. */
export interface ProtocolRegistry {
  register(adapter: ProtocolAdapter): void;
  unregister(id: ProtocolId): void;
  get(id: ProtocolId): ProtocolAdapter | null;
  list(): ProtocolStatus[];
  /** Switch the active protocol; the previously-active one is shut down. */
  select(id: ProtocolId): Promise<void>;
  active(): ProtocolAdapter | null;
}

// ---------------------------------------------------------------------------
// Library server (shared WebDAV)
// ---------------------------------------------------------------------------

/** A shared library exposed over WebDAV. */
export interface LibraryShare {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
}

/** A device exposing one or more shared libraries. */
export interface LibraryServer {
  deviceId: DeviceId;
  shares: LibraryShare[];
  /** HTTPS endpoint base URL (self-signed TLS). */
  endpoint: string;
}

// ---------------------------------------------------------------------------
// Core configuration & entry point
// ---------------------------------------------------------------------------

/** Configuration for a NearbyTransferCore instance. */
export interface CoreConfig {
  /** Directory for trust store, session store, and job store data files. */
  dataDirectory: string;
  /** Default chunk size for transfers in bytes; defaults to 4 MiB. */
  defaultChunkSize?: number;
  /** Discovery options; defaults to standard multicast. */
  discovery?: DiscoveryOptions;
  /** Override the default JSON-file trust store. */
  trustStore?: TrustStore;
  /** Override the default JSON-file session store. */
  sessionStore?: SessionStore;
  /** Override the default JSON-file job store. */
  jobStore?: JobStore;
}

/**
 * The top-level Nearby Transfer core facade. Combines discovery, pairing,
 * transfer, and the protocol registry into a single coordinated instance.
 */
export interface NearbyTransferCore {
  readonly identity: PeerIdentity;
  readonly discovery: DiscoveryService;
  readonly trustStore: TrustStore;
  readonly protocols: ProtocolRegistry;

  /** Send files to a discovered peer using the active protocol. */
  send(peer: DiscoveredPeer, files: FileSpec[], options?: ServeOptions): Promise<TransferResult>;

  /** Begin serving incoming transfers into a directory. */
  serve(options: ServeOptions): Promise<void>;

  /** Initiate a pairing exchange with a peer; returns the 6-digit SAS code. */
  pair(peer: DiscoveredPeer): Promise<string>;

  /** Gracefully stop all subsystems. */
  shutdown(): Promise<void>;
}

/** Factory for a core instance. Implemented once all layers are migrated. */
export type CreateCore = (config: CoreConfig) => Promise<NearbyTransferCore>;

// ---------------------------------------------------------------------------
// Wire-level message shapes (re-exported for low-level consumers)
// ---------------------------------------------------------------------------

/** A decoded wire-frame message envelope. */
export interface WireMessage<T = CanonicalValue> {
  type: MessageType;
  payload: T;
}
