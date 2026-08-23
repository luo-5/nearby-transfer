/**
 * Create the runtime executor for one outgoing transfer job.
 * Ported from src/v2/desktop-transfer-executor.js (684 lines).
 *
 * Setup is async: no executor is returned until the authenticated peer has
 * accepted the manifest and the stream session owns the connected socket.
 * The executor exposes a `done` promise, plus pause/resume/cancel methods
 * that the scheduler calls.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { bootstrapOutgoingTransfer } from './bootstrap.js';
import { createEncryptedChunkReader } from './encrypted-reader.js';
import { createSignedStreamControlCodec } from './control.js';
import { MAX_SEQUENCE, deriveSessionKey } from '../crypto/session.js';
import { createTransferStreamSession } from './stream-session.js';
import { JOB_DIRECTION, JOB_STATUS, DIAGNOSTIC_CODE, type TransferJob, type OutgoingCheckpoint, type JobSource } from './job-store.js';
import { normalizeTransferManifest, serializeTransferManifest, type TransferManifest } from './manifest.js';
import { TYPE_TRANSFER_PROGRESS, advanceTransferControlCheckpoint, decodeTransferMessage, type ControlCheckpoint } from './message-codec.js';
import { verifyTransferMessage } from './message-auth.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 10_000, bootstrapMs: 90_000, controlTtlMs: 30_000,
  handshakeMs: 10_000, idleMs: 30_000, writeMs: 30_000,
  operationMs: 30_000, pauseMs: 120_000, closingMs: 10_000,
});

export interface ExecutorTimeouts {
  connectMs?: number; bootstrapMs?: number; controlTtlMs?: number;
  handshakeMs?: number; idleMs?: number; writeMs?: number;
  operationMs?: number; pauseMs?: number; closingMs?: number;
}

export interface ExecutorInput {
  job: TransferJob;
  checkpoint: OutgoingCheckpoint | null;
  signal: AbortSignal;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint, now?: number) => TransferJob;
  timeouts?: ExecutorTimeouts;
  createSocket?: (host: string, port: number) => net.Socket;
}

export interface DesktopTransferExecutor {
  done: Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

export async function createDesktopTransferExecutor(input: ExecutorInput): Promise<DesktopTransferExecutor> {
  const config = normalizeInput(input);
  const socket = await connectToPeer(config);
  const ephemeralKey = crypto.generateKeyPairSync('x25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

  const bootstrapResult = await bootstrapOutgoingTransfer({
    stream: socket as unknown as Parameters<typeof bootstrapOutgoingTransfer>[0]['stream'],
    manifest: config.job.manifest,
    localDeviceId: config.localDeviceId,
    remoteDeviceId: config.job.peerDeviceId,
    signingPrivateKey: config.signingPrivateKey,
    remoteSigningPublicKey: config.remoteSigningPublicKey,
    senderEphemeralPublicKey: ephemeralKey.publicKey,
    sessionId: config.sessionId,
    ttlMs: config.timeouts.controlTtlMs,
    timeoutMs: config.timeouts.bootstrapMs,
  });

  if (bootstrapResult.decision !== 'accepted') {
    socket.destroy();
    throw new Error(`Transfer manifest was rejected: ${bootstrapResult.decision}`);
  }

  const manifestHash = crypto.createHash('sha256').update(serializeTransferManifest(config.job.manifest)).digest('hex');
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: ephemeralKey.privateKey,
    remotePublicKeyPem: config.remoteEncryptionPublicKey,
    senderDeviceId: config.localDeviceId,
    receiverDeviceId: config.job.peerDeviceId,
    taskId: config.job.manifest.taskId,
    manifestSha256: manifestHash,
  });

  const codec = createSignedStreamControlCodec({
    localDevice: { deviceId: config.localDeviceId, signingPrivateKey: config.signingPrivateKey },
    remotePeer: { deviceId: config.job.peerDeviceId, signingPublicKey: config.remoteSigningPublicKey },
    taskId: config.job.manifest.taskId,
    sessionId: config.sessionId,
    ttlMs: config.timeouts.controlTtlMs,
  });

  const chunkReader = createEncryptedChunkReader({
    manifest: config.job.manifest,
    sourceFiles: config.job.sources,
    sessionKey,
    resumeCheckpoint: config.checkpoint ? { files: config.checkpoint.files, nextSequence: config.checkpoint.nextSequence, totalTransferred: config.checkpoint.totalTransferred } : undefined,
    signal: config.signal,
  });

  let controlCheckpoint: ControlCheckpoint | null = bootstrapResult.checkpoint;

  const session = createTransferStreamSession({
    stream: socket as unknown as Parameters<typeof createTransferStreamSession>[0]['stream'],
    role: 'sender',
    taskId: config.job.manifest.taskId,
    localPeerId: config.localDeviceId,
    remotePeerId: config.job.peerDeviceId,
    encodeControl: (message, _ctx) => codec.encodeControl(message),
    decodeControl: (bytes, _ctx) => codec.decodeControl(bytes),
    verifyControl: (decoded, _ctx) => codec.verifyControl(decoded),
    encodeProgress: (progress, _ctx) => Buffer.from(JSON.stringify(progress)),
    decodeProgress: (bytes, _ctx) => {
      const decOpts: { now: number; checkpoint?: ControlCheckpoint } = { now: Date.now() };
      if (controlCheckpoint) decOpts.checkpoint = controlCheckpoint;
      const decoded = decodeTransferMessage(TYPE_TRANSFER_PROGRESS, bytes, decOpts);
      const advOpts: { now: number; checkpoint?: ControlCheckpoint } = { now: Date.now() };
      if (controlCheckpoint) advOpts.checkpoint = controlCheckpoint;
      controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, decoded as Record<string, unknown>, advOpts);
      config.commitRemoteCheckpoint(buildOutgoingCheckpoint(controlCheckpoint!));
      return decoded;
    },
    commitProgress: async (_decoded, _chunk) => {},
    chunkReader,
    signal: config.signal,
    handshakeTimeoutMs: config.timeouts.handshakeMs,
    idleTimeoutMs: config.timeouts.idleMs,
    writeTimeoutMs: config.timeouts.writeMs,
    operationTimeoutMs: config.timeouts.operationMs,
    pauseTimeoutMs: config.timeouts.pauseMs,
    closingTimeoutMs: config.timeouts.closingMs,
  });

  const done = session.start().then(() => { sessionKey.fill(0); }).catch((error) => { sessionKey.fill(0); throw error; });

  return {
    done,
    pause: async () => { await session.pause(); },
    resume: async () => { await session.resume(); },
    cancel: async (reason?: unknown) => { await session.cancel(reason); },
  };
}

function buildOutgoingCheckpoint(cp: ControlCheckpoint): OutgoingCheckpoint {
  return { taskId: cp.taskId, senderDeviceId: cp.senderDeviceId, receiverDeviceId: cp.receiverDeviceId, manifestHash: cp.manifestHash, files: cp.files, nextSequence: cp.nextSequence, totalTransferred: cp.totalTransferred, issuedAt: cp.issuedAt };
}

interface ExecutorConfig {
  job: TransferJob;
  checkpoint: OutgoingCheckpoint | null;
  signal: AbortSignal;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint, now?: number) => TransferJob;
  timeouts: Required<ExecutorTimeouts>;
  createSocket: (host: string, port: number) => net.Socket;
  localDeviceId: string;
  signingPrivateKey: string;
  remoteSigningPublicKey: string;
  remoteEncryptionPublicKey: string;
  sessionId: string;
}

function normalizeInput(input: ExecutorInput): ExecutorConfig {
  if (!input || typeof input !== 'object') throw new TypeError('Executor input must be an object');
  if (!input.job) throw new TypeError('A transfer job is required');
  if (input.job.direction !== JOB_DIRECTION.OUTGOING) throw new Error('Executor only supports outgoing jobs');
  if (input.job.status !== JOB_STATUS.TRANSFERRING) throw new Error('Job must be in transferring state');
  normalizeTransferManifest(input.job.manifest);
  if (!input.signal) throw new TypeError('An abort signal is required');
  if (typeof input.commitRemoteCheckpoint !== 'function') throw new TypeError('A checkpoint commit callback is required');
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts } as Required<ExecutorTimeouts>;
  // These would come from the trusted peer store in the full implementation
  const localDeviceId = (input.job as TransferJob & { localDeviceId?: string }).localDeviceId ?? '';
  const signingPrivateKey = (input.job as TransferJob & { signingPrivateKey?: string }).signingPrivateKey ?? '';
  const remoteSigningPublicKey = (input.job as TransferJob & { remoteSigningPublicKey?: string }).remoteSigningPublicKey ?? '';
  const remoteEncryptionPublicKey = (input.job as TransferJob & { remoteEncryptionPublicKey?: string }).remoteEncryptionPublicKey ?? '';
  const sessionId = crypto.randomBytes(16).toString('base64url');
  const createSocket = input.createSocket ?? ((host: string, port: number) => net.createConnection({ host, port }));
  return { job: input.job, checkpoint: input.checkpoint, signal: input.signal, commitRemoteCheckpoint: input.commitRemoteCheckpoint, timeouts, createSocket, localDeviceId, signingPrivateKey, remoteSigningPublicKey, remoteEncryptionPublicKey, sessionId };
}

async function connectToPeer(config: ExecutorConfig): Promise<net.Socket> {
  const peer = (config.job as TransferJob & { peer?: { host: string; port: number } }).peer;
  if (!peer) throw new Error('Job does not have a peer endpoint');
  return new Promise((resolve, reject) => {
    const socket = config.createSocket(peer.host, peer.port);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Transfer connect timed out')); }, config.timeouts.connectMs);
    socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
