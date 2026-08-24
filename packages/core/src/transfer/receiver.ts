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
import { encodeWireFrame, decodeWireFrame, WireFrameDecoder, type WireFrame } from './wire-frame.js';
import {
  TYPE_TRANSFER_DECISION, TYPE_TRANSFER_MANIFEST, TYPE_TRANSFER_PROGRESS,
  decodeTransferMessage, encodeTransferMessage, type ControlCheckpoint,
} from './message-codec.js';
import { signTransferMessage, verifyTransferMessage } from './message-auth.js';
import { serializeTransferManifest, normalizeTransferManifest, type TransferManifest } from './manifest.js';
import { deriveSessionKey } from '../crypto/session.js';
import { createEncryptedChunkWriter, type EncryptedChunkWriter, type WriterProgress, type ChunkWriterInput } from './encrypted-writer.js';
import { planReceiveTargets } from './receive-planner.js';
import { createSignedStreamControlCodec } from './control.js';
import { createTransferStreamSession, type ChunkWriterLike } from './stream-session.js';
import { decodeFrame as decodeChunkFrame, type ChunkFrameInput } from './chunk-frame.js';

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

  // Phase 1: receive the manifest envelope wire frame
  const manifestResult = await receiveWireFrame(config.socket, DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  const envelope = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, manifestResult.frame.payload, { now: Date.now() }) as Record<string, unknown>;

  // Look up the sender's trusted peer to get the signing public key
  const senderDeviceId = envelope.senderDeviceId as string;
  const peer = config.lookupPeer(senderDeviceId);
  if (!peer) {
    config.socket.destroy();
    throw new Error(`Sender ${senderDeviceId} is not a trusted peer`);
  }

  // Verify the manifest signature against the remote signing key
  if (!verifyTransferMessage(TYPE_TRANSFER_MANIFEST, envelope, peer.signingPublicKey, { now: Date.now() })) {
    config.socket.destroy();
    throw new Error('Transfer manifest signature verification failed');
  }

  const manifest = normalizeTransferManifest(envelope.manifest);
  const senderEphemeralPublicKey = envelope.senderEphemeralPublicKey as string;
  const sessionId = envelope.sessionId as string;

  // Phase 2: send the accepted decision
  const now = Date.now();
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
  await writeBuffer(config.socket, decisionFrame);

  // Phase 3: derive the session key
  const manifestHash = crypto.createHash('sha256').update(serializeTransferManifest(manifest)).digest('hex');
  const remoteEphemeralPem = rawX25519ToPem(senderEphemeralPublicKey);
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: config.localEncryptionPrivateKey,
    remotePublicKeyPem: remoteEphemeralPem,
    senderDeviceId,
    receiverDeviceId: config.localDeviceId,
    taskId: manifest.taskId,
    manifestSha256: manifestHash,
  });

  // Phase 4: plan receive targets and create the chunk writer
  const plan = await planReceiveTargets({
    manifest, receiveRoot: config.receiveDir,
  });
  const writerPlan = { taskId: plan.taskId, receiveRoot: plan.receiveRoot, stagingDirectory: plan.stagingDirectory, targets: plan.targets.map((t) => ({ path: t.path, kind: t.kind, stagingPath: t.stagingPath, finalPath: t.finalPath })) };
  const chunkWriter = await createEncryptedChunkWriter({
    manifest, plan: writerPlan, sessionKey, signal: config.signal,
  });

  // Phase 5: create the signed stream control codec
  const codec = createSignedStreamControlCodec({
    localDevice: { deviceId: config.localDeviceId, signingPrivateKey: config.localSigningPrivateKey },
    remotePeer: { deviceId: senderDeviceId, signingPublicKey: peer.signingPublicKey },
    taskId: manifest.taskId, sessionId,
    ttlMs: DEFAULT_TTL_MS,
  });

  // Phase 6: create the stream session (receiver role)
  let controlCheckpoint: ControlCheckpoint | null = null;
  const fileSizes = new Map<string, number>();
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') fileSizes.set(entry.path, entry.size);
  }

  const session = createTransferStreamSession({
    stream: config.socket as never,
    role: 'receiver',
    taskId: manifest.taskId,
    localPeerId: config.localDeviceId,
    remotePeerId: senderDeviceId,
    ...(manifestResult.leftover ? { initialBuffer: manifestResult.leftover } : {}),
    encodeControl: (message, _ctx) => codec.encodeControl(message),
    decodeControl: (bytes, _ctx) => codec.decodeControl(bytes),
    verifyControl: (decoded, _ctx) => codec.verifyControl(decoded),
    encodeProgress: (progress: unknown, ctx: unknown) => {
      const wp = progress as WriterProgress;
      const chunkCtx = ctx as { chunk?: ChunkFrameInput };
      const path = chunkCtx?.chunk?.relativePath ?? wp.files[0]?.path ?? '';
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
      } as Record<string, unknown>, config.localSigningPrivateKey, { now: ts });
      return Buffer.from(encodeTransferMessage(TYPE_TRANSFER_PROGRESS, signed, { now: ts }));
    },
    decodeProgress: (_bytes: Buffer, _ctx: unknown) => { throw new Error('Receiver does not decode progress'); },
    commitProgress: async (_decoded: unknown, _chunk: unknown) => {},
    chunkWriter: chunkWriter as unknown as ChunkWriterLike,
    signal: config.signal,
  });

  const done = session.start().then(() => { sessionKey.fill(0); }).catch((error) => { sessionKey.fill(0); throw error; });

  return {
    done,
    pause: async () => { await session.pause(); },
    resume: async () => { await session.resume(); },
    cancel: async (reason?: unknown) => { await session.cancel(reason); },
  };
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

async function receiveWireFrame(socket: import('node:net').Socket, timeoutMs: number): Promise<{ frame: WireFrame; leftover: Buffer | undefined }> {
  return new Promise((resolve, reject) => {
    const decoder = new WireFrameDecoder();
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      reject(new Error(`Transfer bootstrap timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(chunk: Buffer): void {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          socket.removeListener('close', onClose);
          resolve({
            frame: frames[0]!,
            leftover: decoder.buffer.length > 0 ? Buffer.from(decoder.buffer) : undefined,
          });
        }
      } catch (error) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        reject(error as Error);
      }
    }
    function onError(error: Error): void { clearTimeout(timer); reject(error); }
    function onClose(): void { clearTimeout(timer); reject(new Error('Transfer stream closed during bootstrap')); }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function writeBuffer(socket: import('node:net').Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { socket.removeListener('error', onError); reject(error); };
    socket.once('error', onError);
    socket.write(data, () => { socket.removeListener('error', onError); resolve(); });
  });
}
