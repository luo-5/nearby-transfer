/**
 * Create the runtime executor for one outgoing transfer job.
 * Ported from src/v2/desktop-transfer-executor.js.
 *
 * Setup is async: no executor is returned until the authenticated peer has
 * accepted the manifest and the stream session owns the connected socket.
 * The executor exposes a `done` promise, plus pause/resume/cancel methods
 * that the scheduler calls.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';
import { bootstrapOutgoingTransfer, type BootstrapCheckpoint, type BootstrapFileCheckpoint } from './bootstrap.js';
import { createEncryptedChunkReader, type EncryptedChunkReader } from './encrypted-reader.js';
import { createSignedStreamControlCodec } from './control.js';
import { MAX_SEQUENCE, deriveSessionKey } from '../crypto/session.js';
import { createTransferStreamSession, type TransferStreamSession } from './stream-session.js';
import { JOB_DIRECTION, JOB_STATUS, DIAGNOSTIC_CODE, type TransferJob, type OutgoingCheckpoint, type JobSource } from './job-store.js';
import { normalizeTransferManifest, serializeTransferManifest, type TransferManifest, type ManifestFileEntry } from './manifest.js';
import {
  TYPE_TRANSFER_PROGRESS,
  advanceTransferControlCheckpoint,
  decodeTransferMessage,
  type ControlCheckpoint,
} from './message-codec.js';
import { verifyTransferMessage } from './message-auth.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 10 * 1000,
  bootstrapMs: 90 * 1000,
  controlTtlMs: 30 * 1000,
  handshakeMs: 10 * 1000,
  idleMs: 30 * 1000,
  writeMs: 30 * 1000,
  operationMs: 30 * 1000,
  pauseMs: 2 * 60 * 1000,
  closingMs: 10 * 1000,
});
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_KEYS = Object.freeze(Object.keys(DEFAULT_TIMEOUTS));

export const ERROR_CODE = Object.freeze({
  CONNECT_FAILED: 'TRANSFER_CONNECT_FAILED',
  DISCOVERY_IDENTITY_MISMATCH: 'TRANSFER_DISCOVERY_IDENTITY_MISMATCH',
  JOB_INVALID: 'TRANSFER_JOB_INVALID',
  MANIFEST_REJECTED: 'TRANSFER_MANIFEST_REJECTED',
  PEER_OFFLINE: 'TRANSFER_PEER_OFFLINE',
  PEER_PERMISSION_DENIED: 'TRANSFER_PEER_PERMISSION_DENIED',
  PEER_REVOKED: 'TRANSFER_PEER_REVOKED',
});

export interface ExecutorTimeouts {
  connectMs?: number;
  bootstrapMs?: number;
  controlTtlMs?: number;
  handshakeMs?: number;
  idleMs?: number;
  writeMs?: number;
  operationMs?: number;
  pauseMs?: number;
  closingMs?: number;
}

export interface TrustedPeerIdentity {
  deviceId: string;
  deviceName?: string;
  fingerprint?: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

export interface TrustedPeer {
  identity: TrustedPeerIdentity;
  permissions?: { transfer?: boolean };
  revokedAt?: number | null;
}

export interface ExecutorDiscoveredPeer {
  deviceId: string;
  deviceName?: string;
  fingerprint?: string;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
  host: string;
  port: number;
}

export interface LocalDeviceInput {
  deviceId: string;
  signingPrivateKey: string;
  signingPublicKey?: string;
}

export interface ConnectorOptions {
  host: string;
  port: number;
  peer?: ExecutorDiscoveredPeer;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ExecutorInput {
  job: TransferJob;
  checkpoint: OutgoingCheckpoint | null;
  signal: AbortSignal;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint | BootstrapCheckpoint, now?: number) => Promise<unknown> | unknown;
  localDevice: LocalDeviceInput;
  trustedPeerStore: { getTrustedPeer: (deviceId: string, options?: { includeRevoked?: boolean }) => TrustedPeer | null };
  lanService: { listPeers: () => ExecutorDiscoveredPeer[] };
  connector?: (options: ConnectorOptions) => Promise<Duplex | any>;
  clock?: () => number;
  timeouts?: ExecutorTimeouts;
}

export interface DesktopTransferExecutor {
  done: Promise<unknown>;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  cancel(reason?: unknown): Promise<void>;
  close(): Promise<void>;
}

interface NormalizedExecutorConfig {
  job: TransferJob;
  checkpoint: OutgoingCheckpoint | null;
  signal: AbortSignal;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint | BootstrapCheckpoint, now?: number) => Promise<unknown> | unknown;
  localDevice: LocalDeviceInput;
  trustedPeerStore: ExecutorInput['trustedPeerStore'];
  lanService: ExecutorInput['lanService'];
  connector: (options: ConnectorOptions) => Promise<Duplex | any>;
  clock: () => number;
  timeouts: Record<string, number>;
}

export async function createDesktopTransferExecutor(input: ExecutorInput): Promise<DesktopTransferExecutor> {
  const config = normalizeInput(input);
  const job = normalizeOutgoingJob(config.job);
  const transferredBytes = (config.job as any).progress?.transferredBytes ?? 0;
  if (!config.checkpoint || typeof config.checkpoint !== 'object' ||
      config.checkpoint.totalTransferred !== transferredBytes) {
    throw diagnosticError(
      'Outgoing transfer checkpoint does not match the persisted job progress',
      ERROR_CODE.JOB_INVALID,
      DIAGNOSTIC_CODE.PROTOCOL_ERROR,
    );
  }
  throwIfAborted(config.signal);

  const trustedPeer = requireTrustedTransferPeer(config.trustedPeerStore, job.peerDeviceId);
  const endpoint = requireOnlineTrustedEndpoint(config.lanService, trustedPeer);
  throwIfAborted(config.signal);

  let stream: Duplex | any = null;
  let chunkReader: EncryptedChunkReader | null = null;
  let sessionKey: Buffer | null = null;
  let removeSetupAbort = (): void => {};
  const attemptController = new AbortController();
  const removeAbortRelay = relayAbort(config.signal, attemptController);

  try {
    stream = await connectBounded({
      connector: config.connector,
      endpoint,
      signal: attemptController.signal,
      timeoutMs: config.timeouts.connectMs!,
    });
    const onSetupAbort = (): void => safeDestroy(stream);
    attemptController.signal.addEventListener('abort', onSetupAbort, { once: true });
    removeSetupAbort = (): void => attemptController.signal.removeEventListener('abort', onSetupAbort);
    if (attemptController.signal.aborted) onSetupAbort();
    throwIfAborted(attemptController.signal);

    const sessionId = crypto.randomBytes(16).toString('base64url');
    const ephemeral = createEphemeralX25519KeyPair();
    const bootstrap = await bootstrapOutgoingTransfer({
      stream,
      localDevice: config.localDevice,
      remotePeer: trustedPeer,
      manifest: job.manifest,
      checkpoint: config.checkpoint as unknown as BootstrapCheckpoint,
      senderEphemeralPublicKey: ephemeral.publicKeyRaw,
      sessionId,
      clock: config.clock,
      ...(config.timeouts.controlTtlMs !== undefined ? { ttlMs: config.timeouts.controlTtlMs } : {}),
      ...(config.timeouts.bootstrapMs !== undefined ? { timeoutMs: config.timeouts.bootstrapMs } : {}),
    }).catch((error) => {
      throw decorateBootstrapError(error);
    });

    if (bootstrap.decision !== 'accepted') {
      throw createDecisionError(bootstrap.decision);
    }
    throwIfAborted(attemptController.signal);

    const manifestSha256 = crypto.createHash('sha256')
      .update(serializeTransferManifest(job.manifest), 'utf8')
      .digest('hex');
    sessionKey = deriveSessionKey({
      localPrivateKeyPem: ephemeral.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      remotePublicKeyPem: trustedPeer.identity.encryptionPublicKey,
      senderDeviceId: config.localDevice.deviceId,
      receiverDeviceId: trustedPeer.identity.deviceId,
      taskId: job.taskId,
      manifestSha256,
    });

    chunkReader = createEncryptedChunkReader({
      manifest: job.manifest,
      sourceFiles: job.sources as any,
      sessionKey,
      signal: attemptController.signal,
      resumeCheckpoint: bootstrap.checkpoint as any,
    });
    sessionKey.fill(0);
    sessionKey = null;

    const progress = createProgressCommitter({
      bootstrap,
      commitRemoteCheckpoint: config.commitRemoteCheckpoint,
      manifest: job.manifest,
      manifestSha256,
      sessionId,
      localDeviceId: config.localDevice.deviceId,
      remoteDeviceId: trustedPeer.identity.deviceId,
      remoteSigningPublicKey: trustedPeer.identity.signingPublicKey,
      clock: config.clock,
    });
    const control = createSignedStreamControlCodec({
      localDevice: config.localDevice,
      remotePeer: trustedPeer,
      taskId: job.taskId,
      sessionId,
      now: config.clock,
      ...(config.timeouts.controlTtlMs !== undefined ? { ttlMs: config.timeouts.controlTtlMs } : {}),
    });
    const session = createTransferStreamSession({
      stream,
      role: 'sender',
      taskId: job.taskId,
      localPeerId: config.localDevice.deviceId,
      remotePeerId: trustedPeer.identity.deviceId,
      chunkReader: chunkReader as any,
      encodeControl: (msg, _ctx) => control.encodeControl(msg),
      decodeControl: (bytes, _ctx) => control.decodeControl(bytes),
      verifyControl: (decoded, _ctx) => control.verifyControl(decoded),
      encodeProgress: () => { throw new Error('Desktop sender cannot encode receiver progress'); },
      decodeProgress: (payload) => progress.decode(payload),
      commitProgress: async (msg, chunk) => { await progress.commit(msg, chunk); },
      signal: attemptController.signal,
      ...(config.timeouts.handshakeMs !== undefined ? { handshakeTimeoutMs: config.timeouts.handshakeMs } : {}),
      ...(config.timeouts.idleMs !== undefined ? { idleTimeoutMs: config.timeouts.idleMs } : {}),
      ...(config.timeouts.writeMs !== undefined ? { writeTimeoutMs: config.timeouts.writeMs } : {}),
      ...(config.timeouts.operationMs !== undefined ? { operationTimeoutMs: config.timeouts.operationMs } : {}),
      ...(config.timeouts.pauseMs !== undefined ? { pauseTimeoutMs: config.timeouts.pauseMs } : {}),
      ...(config.timeouts.closingMs !== undefined ? { closingTimeoutMs: config.timeouts.closingMs } : {}),
    });
    removeSetupAbort();

    let closed = false;
    let settled = false;
    const done = Promise.resolve(session.start()).finally(() => {
      settled = true;
      removeAbortRelay();
      safeDestroy(stream);
    });

    return Object.freeze({
      done,
      pause: () => session.pause(),
      resume: () => session.resume(),
      async cancel(reason?: unknown): Promise<void> {
        if (!attemptController.signal.aborted) attemptController.abort(reason);
        try {
          await session.cancel(reason);
        } catch (error) {
          if (!isAbortError(error)) throw error;
        } finally {
          safeDestroy(stream);
        }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (!settled && !attemptController.signal.aborted) {
          attemptController.abort(new Error('Transfer executor closed'));
          try {
            await session.cancel((attemptController.signal as any).reason);
          } catch (error) {
            if (!isAbortError(error)) throw error;
          }
        }
        safeDestroy(stream);
        removeAbortRelay();
      },
    });
  } catch (error) {
    if (!attemptController.signal.aborted) attemptController.abort(error);
    if (chunkReader && typeof chunkReader.return === 'function') {
      try {
        await chunkReader.return();
      } catch (_) {
        // Preserve the setup failure while still releasing the reader key copy.
      }
    }
    safeDestroy(stream);
    removeSetupAbort();
    removeAbortRelay();
    throw normalizeExecutorError(error, config.signal);
  } finally {
    if (sessionKey) (sessionKey as Buffer).fill(0);
    if (!stream || stream.destroyed) removeAbortRelay();
  }
}

function normalizeOutgoingJob(value: TransferJob): { taskId: string; peerDeviceId: string; manifest: TransferManifest; sources: JobSource[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw diagnosticError('Desktop transfer job is invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  if (value.direction !== JOB_DIRECTION.OUTGOING || value.status !== JOB_STATUS.TRANSFERRING) {
    throw diagnosticError('Desktop transfer executor requires an active outgoing job', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  const manifest = normalizeTransferManifest(value.manifest);
  if (value.taskId !== manifest.taskId || typeof value.peerDeviceId !== 'string') {
    throw diagnosticError('Desktop transfer job does not match its manifest', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  const raw = value as any;
  if (raw.sourceMappingStatus !== 'available' || !Array.isArray(raw.sources)) {
    throw diagnosticError('Outgoing transfer source file mappings are unavailable', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
  }
  const files = (manifest.entries as ManifestFileEntry[]).filter((entry) => entry.kind === 'file');
  if (raw.sources.length !== files.length) {
    throw diagnosticError('Outgoing transfer sources must map every manifest file exactly once', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
  }
  const expected = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const sources = raw.sources.map((source: any) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || seen.has(source.path)) {
      throw diagnosticError('Outgoing transfer source mappings are invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
    }
    const file = expected.get(source.path);
    if (!file || typeof source.sourcePath !== 'string' || source.sourcePath.length === 0 ||
        source.size !== file.size || source.sha256 !== file.sha256) {
      throw diagnosticError('Outgoing transfer source metadata does not match the manifest', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
    }
    seen.add(source.path);
    return { path: source.path, sourcePath: source.sourcePath, size: source.size, sha256: source.sha256 };
  });
  if (!raw.progress || !Number.isSafeInteger(raw.progress.transferredBytes) || raw.progress.transferredBytes < 0) {
    throw diagnosticError('Outgoing transfer progress is invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  return { taskId: value.taskId, peerDeviceId: value.peerDeviceId, manifest, sources };
}

function requireTrustedTransferPeer(store: ExecutorInput['trustedPeerStore'], deviceId: string): TrustedPeer {
  let peer: TrustedPeer | null = null;
  try {
    peer = store.getTrustedPeer(deviceId, { includeRevoked: true });
  } catch (error) {
    throw diagnosticError('Unable to re-read the trusted transfer peer', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED, error);
  }
  if (!peer || peer.revokedAt !== null) {
    throw diagnosticError('The transfer peer is missing or revoked', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  if (!peer.permissions || peer.permissions.transfer !== true) {
    throw diagnosticError('The trusted peer does not have transfer permission', ERROR_CODE.PEER_PERMISSION_DENIED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  if (!peer.identity || peer.identity.deviceId !== deviceId ||
      typeof peer.identity.signingPublicKey !== 'string' || typeof peer.identity.encryptionPublicKey !== 'string') {
    throw diagnosticError('The trusted peer identity is invalid', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  return peer;
}

function requireOnlineTrustedEndpoint(lanService: ExecutorInput['lanService'], trustedPeer: TrustedPeer): { host: string; port: number; peer: ExecutorDiscoveredPeer } {
  const peers = lanService.listPeers();
  if (!Array.isArray(peers)) throw new TypeError('LAN discovery service returned an invalid peer list');
  const discovered = peers.find((peer) => peer && peer.deviceId === trustedPeer.identity.deviceId);
  if (!discovered) {
    throw diagnosticError('The trusted transfer peer is offline', ERROR_CODE.PEER_OFFLINE, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  }
  const identity = trustedPeer.identity;
  if (discovered.deviceId !== identity.deviceId || discovered.deviceName !== identity.deviceName ||
      discovered.fingerprint !== identity.fingerprint || discovered.signingPublicKey !== identity.signingPublicKey ||
      discovered.encryptionPublicKey !== identity.encryptionPublicKey) {
    throw diagnosticError(
      'The discovered peer identity does not match the trusted identity',
      ERROR_CODE.DISCOVERY_IDENTITY_MISMATCH,
      DIAGNOSTIC_CODE.PEER_REVOKED,
    );
  }
  if (typeof discovered.host !== 'string' || discovered.host.length === 0 || discovered.host.includes('\0') ||
      !Number.isSafeInteger(discovered.port) || discovered.port < 1 || discovered.port > 65535) {
    throw diagnosticError('The discovered transfer endpoint is invalid', ERROR_CODE.PEER_OFFLINE, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  }
  return Object.freeze({ host: discovered.host, port: discovered.port, peer: discovered });
}

function createEphemeralX25519KeyPair(): { publicKeyRaw: string; privateKey: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('x25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'X25519' || typeof publicJwk.x !== 'string' ||
      Buffer.from(publicJwk.x, 'base64url').length !== 32 || Buffer.from(publicJwk.x, 'base64url').toString('base64url') !== publicJwk.x) {
    throw new Error('Unable to export a canonical ephemeral X25519 public key');
  }
  return Object.freeze({
    publicKeyRaw: publicJwk.x,
    privateKey: pair.privateKey,
  });
}

async function connectBounded(options: { connector: (opts: ConnectorOptions) => Promise<Duplex | any>; endpoint: { host: string; port: number; peer: ExecutorDiscoveredPeer }; signal: AbortSignal; timeoutMs: number }): Promise<Duplex | any> {
  const { connector, endpoint, signal, timeoutMs } = options;
  throwIfAborted(signal);
  let settled = false;
  let resolvedStream: any = null;
  let timer: NodeJS.Timeout | null = null;
  let removeAbort = (): void => {};
  const operation = Promise.resolve().then(() => connector(Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    peer: endpoint.peer,
    signal,
    timeoutMs,
  })));

  const guarded = new Promise<Duplex | any>((resolve, reject) => {
    const finish = (callback: (val: any) => void, value: any): void => {
      if (settled) {
        if (callback === resolve) safeDestroy(value);
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      removeAbort();
      callback(value);
    };
    timer = setTimeout(() => {
      const error = diagnosticError(
        `Transfer connection timed out after ${timeoutMs} milliseconds`,
        ERROR_CODE.CONNECT_FAILED,
        DIAGNOSTIC_CODE.NETWORK_INTERRUPTED,
      );
      error.name = 'TimeoutError';
      finish(reject, error);
    }, timeoutMs);
    const onAbort = (): void => finish(reject, createAbortError((signal as any).reason));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = (): void => signal.removeEventListener('abort', onAbort);
    operation.then(
      (s) => {
        resolvedStream = s;
        try {
          assertDuplex(s);
          finish(resolve, s);
        } catch (error) {
          safeDestroy(s);
          finish(reject, error);
        }
      },
      (error) => finish(reject, diagnosticError(
        'Unable to connect to the transfer peer',
        ERROR_CODE.CONNECT_FAILED,
        DIAGNOSTIC_CODE.NETWORK_INTERRUPTED,
        error,
      )),
    );
  });

  try {
    return await guarded;
  } catch (error) {
    safeDestroy(resolvedStream);
    throw error;
  }
}

function defaultConnector(opts: ConnectorOptions): Promise<net.Socket> {
  const { host, port, signal, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (callback: (val: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      callback(value);
    };
    const onConnect = (): void => {
      socket.setNoDelay(true);
      finish(resolve, socket);
    };
    const onError = (error: unknown): void => {
      safeDestroy(socket);
      finish(reject, error);
    };
    const onAbort = (): void => {
      safeDestroy(socket);
      finish(reject, createAbortError((signal as any).reason));
    };
    timer = setTimeout(() => {
      const error = new Error(`Transfer TCP connection timed out after ${timeoutMs} milliseconds`);
      error.name = 'TimeoutError';
      safeDestroy(socket);
      finish(reject, error);
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createProgressCommitter(input: {
  bootstrap: any;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint | BootstrapCheckpoint, now?: number) => Promise<unknown> | unknown;
  manifest: TransferManifest;
  manifestSha256: string;
  sessionId: string;
  localDeviceId: string;
  remoteDeviceId: string;
  remoteSigningPublicKey: string;
  clock: () => number;
}): { decode: (encoded: Uint8Array) => Record<string, unknown>; commit: (message: any, sentChunk: any) => Promise<unknown> } {
  let checkpoint: BootstrapCheckpoint = input.bootstrap.checkpoint;
  let controlCheckpoint: ControlCheckpoint | null = input.bootstrap.controlCheckpoint;
  const manifestFiles = new Map(
    (input.manifest.entries as ManifestFileEntry[])
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [entry.path, entry]),
  );

  return Object.freeze({
    decode(encoded: Uint8Array): Record<string, unknown> {
      const now = readClock(input.clock);
      const normalized = decodeTransferMessage(TYPE_TRANSFER_PROGRESS, encoded, {
        now,
        checkpoint: controlCheckpoint,
      });
      if (!verifyTransferMessage(
        TYPE_TRANSFER_PROGRESS,
        normalized,
        input.remoteSigningPublicKey,
        { now, checkpoint: controlCheckpoint },
      )) {
        throw new Error('Transfer progress signature verification failed');
      }
      if (normalized.taskId !== input.manifest.taskId ||
          normalized.sessionId !== input.sessionId ||
          normalized.senderDeviceId !== input.remoteDeviceId ||
          normalized.receiverDeviceId !== input.localDeviceId ||
          normalized.manifestHash !== input.manifestSha256) {
        throw new Error('Transfer progress binding does not match the authenticated session');
      }
      return normalized;
    },

    async commit(message: any, sentChunk: any): Promise<unknown> {
      const relativePath = sentChunk.relativePath || sentChunk.path;
      const expectedFile = manifestFiles.get(relativePath);
      const currentFile = checkpoint.files.find((file) => file.path === relativePath);
      if (!expectedFile || !currentFile || sentChunk.sequence !== checkpoint.nextSequence ||
          sentChunk.offset !== currentFile.committedOffset) {
        throw new Error('Transfer progress does not acknowledge the outstanding encrypted chunk');
      }
      const committedOffset = sentChunk.offset + sentChunk.plainLength;
      const completed = committedOffset === expectedFile.size;
      const nextSequence = sentChunk.sequence === MAX_SEQUENCE
        ? MAX_SEQUENCE
        : sentChunk.sequence + 1;
      if (message.path !== relativePath || message.fileSize !== expectedFile.size ||
          message.committedOffset !== committedOffset || message.completed !== completed ||
          message.nextSequence !== nextSequence ||
          message.totalTransferred !== checkpoint.totalTransferred + sentChunk.plainLength) {
        throw new Error('Transfer progress acknowledgement does not match the outstanding encrypted chunk');
      }

      const candidate: BootstrapCheckpoint = Object.freeze({
        files: Object.freeze(checkpoint.files.map((file) => Object.freeze(
          file.path === message.path
            ? {
                path: file.path,
                size: file.size,
                committedOffset: message.committedOffset,
                completed: message.completed,
              }
            : { ...file },
        ))),
        totalTransferred: message.totalTransferred,
        nextSequence: message.nextSequence,
      });
      const now = readClock(input.clock);
      const committed = await input.commitRemoteCheckpoint(candidate, now);
      assertCommittedCheckpoint(committed, candidate);
      controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, message, {
        now,
        checkpoint: controlCheckpoint,
      });
      checkpoint = candidate;
      return committed;
    },
  });
}

function assertCommittedCheckpoint(actual: any, expected: BootstrapCheckpoint): void {
  if (!actual || typeof actual !== 'object' ||
      actual.totalTransferred !== expected.totalTransferred ||
      actual.nextSequence !== expected.nextSequence ||
      !Array.isArray(actual.files) || actual.files.length !== expected.files.length) {
    throw new Error('Persisted transfer checkpoint does not match the receiver acknowledgement');
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const left = actual.files[index];
    const right = expected.files[index]!;
    if (!left || left.path !== right.path || left.size !== right.size ||
        left.committedOffset !== right.committedOffset || left.completed !== right.completed) {
      throw new Error('Persisted transfer checkpoint does not match the receiver acknowledgement');
    }
  }
}

function createDecisionError(decision: string): Error & { code?: string; diagnosticCode?: string; decision?: string } {
  const diagnostic = decision === 'unauthorized'
    ? DIAGNOSTIC_CODE.PEER_REVOKED
    : decision === 'busy'
      ? DIAGNOSTIC_CODE.NETWORK_INTERRUPTED
      : decision === 'rejected'
        ? DIAGNOSTIC_CODE.USER_CANCELLED
        : DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  const error = diagnosticError(
    `Remote peer rejected the transfer manifest: ${decision}`,
    ERROR_CODE.MANIFEST_REJECTED,
    diagnostic,
  ) as Error & { code?: string; diagnosticCode?: string; decision?: string };
  error.decision = decision;
  return error;
}

export function decorateBootstrapError(error: unknown): Error & { code?: string; diagnosticCode?: string } {
  const message = String(error && (error as any).message ? (error as any).message : error);
  const diagnostic = /timed out|ended|closed|socket|connection/i.test(message)
    ? DIAGNOSTIC_CODE.NETWORK_INTERRUPTED
    : DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  return diagnosticError('Transfer manifest negotiation failed', ERROR_CODE.CONNECT_FAILED, diagnostic, error);
}

function normalizeExecutorError(error: unknown, upstreamSignal: AbortSignal): Error {
  if (upstreamSignal.aborted || isAbortError(error)) return createAbortError((upstreamSignal as any).reason || error);
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && ((error as any).name === 'AbortError' || (error as any).code === 'ABORT_ERR'));
}

function diagnosticError(message: string, code: string, diagnosticCode: string, cause?: unknown): Error & { code?: string; diagnosticCode?: string } {
  const error = (cause === undefined ? new Error(message) : new Error(message, { cause })) as Error & { code?: string; diagnosticCode?: string };
  error.code = code;
  error.diagnosticCode = diagnosticCode;
  return error;
}

function normalizeTimeouts(value?: ExecutorTimeouts): Record<string, number> {
  if (value === undefined) return { ...DEFAULT_TIMEOUTS };
  assertPlainObject(value, 'Desktop transfer timeouts');
  for (const key of Object.keys(value)) {
    if (!TIMEOUT_KEYS.includes(key)) throw new TypeError(`Desktop transfer timeouts contains unknown field ${key}`);
  }
  const result: Record<string, number> = {};
  for (const key of TIMEOUT_KEYS) {
    const val = (value as any)[key];
    const timeout = val === undefined ? (DEFAULT_TIMEOUTS as any)[key] : val;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      throw new RangeError(`Desktop transfer timeout ${key} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
    }
    result[key] = timeout;
  }
  return Object.freeze(result);
}

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const onAbort = (): void => {
    if (!target.signal.aborted) target.abort((source as any).reason);
  };
  source.addEventListener('abort', onAbort, { once: true });
  if (source.aborted) onAbort();
  return () => source.removeEventListener('abort', onAbort);
}

function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Desktop transfer clock must return a positive safe integer');
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError((signal as any).reason);
}

function createAbortError(reason?: unknown): Error & { code?: string; diagnosticCode?: string } {
  const error = new Error('Desktop outgoing transfer was aborted') as Error & { code?: string; diagnosticCode?: string };
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.diagnosticCode = DIAGNOSTIC_CODE.USER_CANCELLED;
  if (reason !== undefined) (error as any).cause = reason;
  return error;
}

function safeDestroy(stream: unknown): void {
  if (!stream || typeof stream !== 'object') return;
  const s = stream as { destroyed?: boolean; destroy?: () => void };
  if (!s.destroyed && typeof s.destroy === 'function') {
    try {
      s.destroy();
    } catch (_) {
      // Ignore destroy errors during cleanup
    }
  }
}

function assertDuplex(stream: unknown): void {
  if (!stream || typeof stream !== 'object' || typeof (stream as any).on !== 'function' ||
      typeof (stream as any).removeListener !== 'function' || typeof (stream as any).write !== 'function' ||
      typeof (stream as any).destroy !== 'function') {
    throw new TypeError('Transfer stream must be a Node Duplex or Socket-like object');
  }
}

function normalizeInput(input: ExecutorInput): NormalizedExecutorConfig {
  assertPlainObject(input, 'Desktop transfer executor input');
  for (const key of [
    'job', 'checkpoint', 'signal', 'commitRemoteCheckpoint',
    'localDevice', 'trustedPeerStore', 'lanService',
  ] as const) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`Desktop transfer executor input is missing ${key}`);
  }
  if (!input.signal || typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function') {
    throw new TypeError('Desktop transfer executor requires an AbortSignal');
  }
  if (typeof input.commitRemoteCheckpoint !== 'function') {
    throw new TypeError('Desktop transfer executor requires commitRemoteCheckpoint');
  }
  if (!input.localDevice || typeof input.localDevice !== 'object' ||
      typeof input.localDevice.deviceId !== 'string' || typeof input.localDevice.signingPrivateKey !== 'string') {
    throw new TypeError('Desktop transfer executor requires a signing-capable local device');
  }
  if (!input.trustedPeerStore || typeof input.trustedPeerStore.getTrustedPeer !== 'function') {
    throw new TypeError('Desktop transfer executor requires a trusted peer store');
  }
  if (!input.lanService || typeof input.lanService.listPeers !== 'function') {
    throw new TypeError('Desktop transfer executor requires a LAN discovery service');
  }
  const connector = input.connector === undefined ? defaultConnector : input.connector;
  if (typeof connector !== 'function') throw new TypeError('Desktop transfer connector must be a function');
  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') throw new TypeError('Desktop transfer clock must be a function');
  const timeouts = normalizeTimeouts(input.timeouts);

  return {
    job: input.job,
    checkpoint: input.checkpoint,
    signal: input.signal,
    commitRemoteCheckpoint: input.commitRemoteCheckpoint,
    localDevice: input.localDevice,
    trustedPeerStore: input.trustedPeerStore,
    lanService: input.lanService,
    connector,
    clock,
    timeouts,
  };
}

function assertPlainObject(value: unknown, subject: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}
