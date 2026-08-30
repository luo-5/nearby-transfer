/**
 * Receive-side transfer executor: accepts an incoming TCP connection, receives
 * the authenticated manifest, sends an accepted decision, derives the session
 * key, and runs the encrypted chunk writer + stream session as the receiver.
 *
 * This is the mirror of createDesktopTransferExecutor (the sender side).
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } from '../constants.js';
import { encodeWireFrame, WireFrameDecoder, type WireFrame } from './wire-frame.js';
import {
  TYPE_TRANSFER_DECISION, TYPE_TRANSFER_MANIFEST, TYPE_TRANSFER_PROGRESS, TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint, decodeTransferMessage, encodeTransferMessage, type ControlCheckpoint,
} from './message-codec.js';
import { signTransferMessage, verifyTransferMessage } from './message-auth.js';
import { serializeTransferManifest, normalizeTransferManifest } from './manifest.js';
import { deriveSessionKey } from '../crypto/session.js';
import { createEncryptedChunkWriter, type EncryptedChunkWriter, type WriterProgress } from './encrypted-writer.js';
import { cleanupReceiveStaging, planReceiveTargets } from './receive-planner.js';
import { createSignedStreamControlCodec } from './control.js';
import { createTransferStreamSession, type ChunkWriterLike } from './stream-session.js';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 90_000;

export interface TransferReceiverInput {
  socket: import('node:net').Socket;
  receiveDir: string;
  localDeviceId: string;
  localSigningPrivateKey: string;
  localEncryptionPrivateKey: string;
  lookupPeer: (deviceId: string) => { signingPublicKey: string; deviceName?: string } | null;
  signal?: AbortSignal;
}

export interface TransferReceiver {
  done: Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

interface ReceiverConfig {
  socket: import('node:net').Socket;
  receiveDir: string;
  localDeviceId: string;
  localSigningPrivateKey: string;
  localEncryptionPrivateKey: string;
  lookupPeer: (deviceId: string) => { signingPublicKey: string; deviceName?: string } | null;
  signal: AbortSignal;
}

export async function createTransferReceiver(input: TransferReceiverInput): Promise<TransferReceiver> {
  const config = normalizeReceiverInput(input);
  let cleanupPlan: (() => Promise<unknown>) | null = null;
  let cleanupPromise: Promise<unknown> | null = null;
  let bootstrapWriter: EncryptedChunkWriter | null = null;
  let sessionKey: Buffer | null = null;

  const cleanupOnce = (): Promise<unknown> => {
    if (!cleanupPlan) return Promise.resolve();
    if (!cleanupPromise) cleanupPromise = cleanupPlan();
    return cleanupPromise;
  };

  try {
    throwIfReceiverAborted(config.signal);

    // Phase 1: receive and authenticate the manifest envelope. Everything
    // after input normalization is inside this ownership boundary so a bad
    // first frame cannot leave the transport open.
    const manifestResult = await receiveWireFrame(config.socket, DEFAULT_BOOTSTRAP_TIMEOUT_MS, config.signal);
    if (manifestResult.frame.header.type !== MESSAGE_TYPES.TRANSFER_MANIFEST) {
      throw new TypeError('Transfer receiver expected a transfer-manifest frame');
    }
    const envelope = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, manifestResult.frame.payload, { now: Date.now() }) as Record<string, unknown>;

    // Look up the sender's trusted peer to get the signing public key.
    const senderDeviceId = envelope.senderDeviceId as string;
    const peer = config.lookupPeer(senderDeviceId);
    if (!peer) throw new Error(`Sender ${senderDeviceId} is not a trusted peer`);

    // Verify the manifest signature against the remote signing key.
    if (!verifyTransferMessage(TYPE_TRANSFER_MANIFEST, envelope, peer.signingPublicKey, { now: Date.now() })) {
      throw new Error('Transfer manifest signature verification failed');
    }

    const manifest = normalizeTransferManifest(envelope.manifest);
    if (envelope.receiverDeviceId !== config.localDeviceId) {
      throw new Error('Transfer manifest receiver identity does not match this receiver');
    }
    const senderEphemeralPublicKey = envelope.senderEphemeralPublicKey as string;
    const sessionId = envelope.sessionId as string;

    // Prepare storage before telling the sender that the transfer is accepted.
    // The planner cleans its own partial failures. Once it succeeds, all later
    // paths share the same memoized cleanup operation.
    const plan = await planReceiveTargets({ manifest, receiveRoot: config.receiveDir });
    cleanupPlan = () => cleanupReceiveStaging({
      receiveRoot: plan.receiveRoot,
      taskId: plan.taskId,
    });

    // Phase 2: send the accepted decision and resume checkpoint frame.
    const now = Date.now();
    const manifestHash = crypto.createHash('sha256').update(serializeTransferManifest(manifest)).digest('hex');
    const decision = signTransferMessage(TYPE_TRANSFER_DECISION, {
      app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_DECISION,
      taskId: manifest.taskId, sessionId,
      senderDeviceId: config.localDeviceId, receiverDeviceId: senderDeviceId,
      decision: 'accepted', issuedAt: now, expiresAt: now + DEFAULT_TTL_MS,
    } as Record<string, unknown>, config.localSigningPrivateKey, { now });
    const decisionFrame = encodeWireFrame({
      header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_DECISION },
      payload: encodeTransferMessage(TYPE_TRANSFER_DECISION, decision, { now }),
    });

    const resume = signTransferMessage(TYPE_TRANSFER_RESUME, {
      app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_RESUME,
      taskId: manifest.taskId, sessionId,
      senderDeviceId: config.localDeviceId, receiverDeviceId: senderDeviceId,
      manifestHash,
      files: manifest.entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => ({
          path: entry.path,
          size: entry.size,
          committedOffset: 0,
          completed: false,
        })),
      nextSequence: 0,
      totalTransferred: 0,
      issuedAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    } as Record<string, unknown>, config.localSigningPrivateKey, { now });
    const resumeFrame = encodeWireFrame({
      header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_RESUME },
      payload: encodeTransferMessage(TYPE_TRANSFER_RESUME, resume, { now }),
    });

    await writeBuffer(config.socket, Buffer.concat([decisionFrame, resumeFrame]), config.signal, DEFAULT_BOOTSTRAP_TIMEOUT_MS);

    // Phase 3: derive the session key.
    const remoteEphemeralPem = rawX25519ToPem(senderEphemeralPublicKey);
    sessionKey = deriveSessionKey({
      localPrivateKeyPem: config.localEncryptionPrivateKey,
      remotePublicKeyPem: remoteEphemeralPem,
      senderDeviceId,
      receiverDeviceId: config.localDeviceId,
      taskId: manifest.taskId,
      manifestSha256: manifestHash,
    });

    // Phase 4: create the chunk writer. Until stream-session construction
    // succeeds, bootstrap retains responsibility for cancelling this writer.
    const writerPlan = { taskId: plan.taskId, receiveRoot: plan.receiveRoot, stagingDirectory: plan.stagingDirectory, targets: plan.targets.map((t) => ({ path: t.path, kind: t.kind, stagingPath: t.stagingPath, finalPath: t.finalPath })) };
    bootstrapWriter = await createEncryptedChunkWriter({
      manifest, plan: writerPlan, sessionKey, signal: config.signal,
    });
    sessionKey.fill(0);
    sessionKey = null;

    // Phase 5: create the signed stream control codec.
    const codec = createSignedStreamControlCodec({
      localDevice: { deviceId: config.localDeviceId, signingPrivateKey: config.localSigningPrivateKey },
      remotePeer: { deviceId: senderDeviceId, signingPublicKey: peer.signingPublicKey },
      taskId: manifest.taskId, sessionId,
      ttlMs: DEFAULT_TTL_MS,
    });

    // Phase 6: create the stream session (receiver role).
    let controlCheckpoint: ControlCheckpoint | null = advanceTransferControlCheckpoint(TYPE_TRANSFER_RESUME, resume, { now, checkpoint: null });
    const fileSizes = new Map<string, number>();
    for (const entry of manifest.entries) {
      if (entry.kind === 'file') fileSizes.set(entry.path, entry.size);
    }

    if (manifestResult.leftover && manifestResult.leftover.length > 0) {
      config.socket.unshift(manifestResult.leftover);
    }

    const session = createTransferStreamSession({
      stream: config.socket as never,
      role: 'receiver',
      taskId: manifest.taskId,
      localPeerId: config.localDeviceId,
      remotePeerId: senderDeviceId,
      encodeControl: (message, _ctx) => codec.encodeControl(message),
      decodeControl: (bytes, _ctx) => codec.decodeControl(bytes),
      verifyControl: (decoded, _ctx) => codec.verifyControl(decoded),
      encodeProgress: (progress: unknown, ctx: unknown) => {
        const wp = progress as WriterProgress;
        const chunkCtx = ctx as { chunk?: { path?: string; relativePath?: string } };
        const path = chunkCtx?.chunk?.path ?? chunkCtx?.chunk?.relativePath ?? wp.files[0]?.path ?? '';
        const fileSize = fileSizes.get(path) ?? 0;
        const fileProgress = wp.files.find((f) => f.path === path);
        const totalTransferred = wp.files.reduce((sum, f) => sum + f.committedOffset, 0);
        const ts = Date.now();
        const signed = signTransferMessage(TYPE_TRANSFER_PROGRESS, {
          app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_PROGRESS,
          taskId: manifest.taskId, sessionId,
          senderDeviceId: config.localDeviceId, receiverDeviceId: senderDeviceId,
          manifestHash, path, fileSize,
          committedOffset: fileProgress?.committedOffset ?? 0,
          completed: fileProgress?.completed ?? false,
          nextSequence: wp.nextSequence, totalTransferred,
          issuedAt: ts, expiresAt: ts + DEFAULT_TTL_MS,
        } as Record<string, unknown>, config.localSigningPrivateKey, { now: ts, checkpoint: controlCheckpoint });
        controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, signed, { now: ts, checkpoint: controlCheckpoint });
        return Buffer.from(encodeTransferMessage(TYPE_TRANSFER_PROGRESS, signed, { now: ts }));
      },
      decodeProgress: (_bytes: Buffer, _ctx: unknown) => { throw new Error('Receiver does not decode progress'); },
      commitProgress: async (_decoded: unknown, _chunk: unknown) => {},
      chunkWriter: bootstrapWriter as unknown as ChunkWriterLike,
      signal: config.signal,
    });

    const done = session.start()
      .then(() => {})
      .catch(async (error) => {
        await cleanupOnce().catch(() => {});
        throw error;
      });
    bootstrapWriter = null;

    return {
      done,
      pause: async () => { await session.pause(); },
      resume: async () => { await session.resume(); },
      cancel: async (reason?: unknown) => {
        try { await session.cancel(reason); } finally { await cleanupOnce().catch(() => {}); }
      },
    };
  } catch (error) {
    if (sessionKey) sessionKey.fill(0);
    config.socket.destroy();
    if (bootstrapWriter) await bootstrapWriter.cancel().catch(() => {});
    await cleanupOnce().catch(() => {});
    throw error;
  }
}

function normalizeReceiverInput(input: TransferReceiverInput): ReceiverConfig {
  if (!input || typeof input !== 'object') throw new TypeError('Receiver input must be an object');
  if (!input.socket || typeof input.socket.write !== 'function') throw new TypeError('A connected TCP socket is required');
  if (typeof input.receiveDir !== 'string' || input.receiveDir.length === 0) throw new TypeError('A receive directory is required');
  if (typeof input.localDeviceId !== 'string' || !/^[a-f0-9]{16}$/.test(input.localDeviceId)) throw new TypeError('Local device ID must be 16 hex chars');
  if (typeof input.localSigningPrivateKey !== 'string') throw new TypeError('Local signing private key is required');
  if (typeof input.localEncryptionPrivateKey !== 'string') throw new TypeError('Local encryption private key is required');
  if (typeof input.lookupPeer !== 'function') throw new TypeError('A lookupPeer callback is required');
  const signal = input.signal ?? new AbortController().signal;
  if (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new TypeError('Receiver signal must be an AbortSignal');
  }
  return {
    socket: input.socket, receiveDir: input.receiveDir,
    localDeviceId: input.localDeviceId, localSigningPrivateKey: input.localSigningPrivateKey,
    localEncryptionPrivateKey: input.localEncryptionPrivateKey,
    lookupPeer: input.lookupPeer,
    signal,
  };
}

function rawX25519ToPem(rawBase64Url: string): string {
  const raw = Buffer.from(rawBase64Url, 'base64url');
  if (raw.length !== 32) throw new Error('Sender ephemeral public key must be 32 bytes');
  const der = Buffer.concat([X25519_SPKI_PREFIX, raw]);
  const b64 = der.toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

async function receiveWireFrame(socket: import('node:net').Socket, timeoutMs: number, signal: AbortSignal): Promise<{ frame: WireFrame; leftover: Buffer | undefined }> {
  return new Promise((resolve, reject) => {
    const decoder = new WireFrameDecoder();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const finish = (callback: (value: any) => void, value: any, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      if (destroy) socket.destroy();
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Transfer bootstrap timed out after ${timeoutMs}ms`), true);
    }, timeoutMs);

    function onData(chunk: Buffer): void {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          finish(resolve, {
            frame: frames[0]!,
            leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined,
          });
        }
      } catch (error) {
        finish(reject, error as Error, true);
      }
    }
    function onError(error: Error): void { finish(reject, error); }
    function onClose(): void { finish(reject, new Error('Transfer stream closed during bootstrap')); }
    function onAbort(): void { finish(reject, receiverAbortError(signal), true); }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function writeBuffer(socket: import('node:net').Socket, data: Buffer, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error(`Transfer bootstrap write timed out after ${timeoutMs}ms`), true), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: (value?: any) => void, value?: any, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) socket.destroy();
      callback(value);
    };
    const onError = (error: Error) => finish(reject, error);
    const onAbort = () => finish(reject, receiverAbortError(signal), true);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    socket.write(data, () => finish(resolve));
  });
}

function throwIfReceiverAborted(signal: AbortSignal): void {
  if (signal.aborted) throw receiverAbortError(signal);
}

function receiverAbortError(signal: AbortSignal): Error {
  const error = new Error('Transfer receiver was cancelled');
  error.name = 'AbortError';
  if ('reason' in signal) error.cause = signal.reason;
  return error;
}
