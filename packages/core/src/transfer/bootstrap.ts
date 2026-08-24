/**
 * Bootstrap an outgoing transfer: send the authenticated manifest frame and
 * await the receiver's authenticated decision and resume checkpoint.
 * Ported from src/v2/desktop-transfer-bootstrap.js (549 lines).
 *
 * On success the stream is returned to paused mode with this module's
 * listeners removed, ready for TransferStreamSession to take ownership.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } from '../constants.js';
import { normalizeTransferManifest, serializeTransferManifest, type TransferManifest } from './manifest.js';
import {
  MAX_MESSAGE_TTL_MS, MAX_TRANSFER_MESSAGE_BYTES, assertValidSessionId, assertValidEphemeralKey,
  TYPE_TRANSFER_DECISION, TYPE_TRANSFER_MANIFEST, TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint, decodeTransferMessage, encodeTransferMessage,
  type ControlCheckpoint,
} from './message-codec.js';
import { signTransferMessage, verifyTransferMessage } from './message-auth.js';
import { FRAME_LENGTH_BYTES, HEADER_LENGTH_BYTES, MAX_FRAME_SIZE, MAX_HEADER_SIZE, decodeWireFrame, encodeWireFrame } from './wire-frame.js';

export const DEFAULT_TTL_MS = 30 * 1000;
export const DEFAULT_TIMEOUT_MS = 90 * 1000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_BOOTSTRAP_FRAME_BODY_BYTES = HEADER_LENGTH_BYTES + MAX_HEADER_SIZE + MAX_TRANSFER_MESSAGE_BYTES;

interface TransferStream {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  write(data: Buffer, cb?: (err?: Error | null) => void): boolean;
  pause(): this;
  resume(): this;
  destroy(error?: Error): this;
  destroyed: boolean;
}

export interface BootstrapInput {
  stream: TransferStream;
  manifest: TransferManifest;
  localDeviceId: string;
  remoteDeviceId: string;
  signingPrivateKey: string;
  remoteSigningPublicKey: string;
  senderEphemeralPublicKey: string;
  sessionId: string;
  ttlMs?: number;
  timeoutMs?: number;
  clock?: () => number;
}

export interface BootstrapResult {
  decision: string;
  resume: unknown;
  checkpoint: ControlCheckpoint | null;
}

export function bootstrapOutgoingTransfer(input: BootstrapInput): Promise<BootstrapResult> {
  const config = normalizeInput(input);
  const requestFrame = createRequestFrame(config);
  return exchangeBootstrapFrames(config, requestFrame);
}

interface BootstrapConfig {
  stream: TransferStream;
  manifest: TransferManifest;
  localDeviceId: string;
  remoteDeviceId: string;
  signingPrivateKey: string;
  remoteSigningPublicKey: string;
  senderEphemeralPublicKey: string;
  sessionId: string;
  ttlMs: number;
  timeoutMs: number;
  clock: () => number;
}

function normalizeInput(input: BootstrapInput): BootstrapConfig {
  if (!input || typeof input !== 'object') throw new TypeError('Bootstrap input must be an object');
  if (!input.stream || typeof input.stream.write !== 'function') throw new TypeError('A transfer stream is required');
  const manifest = normalizeTransferManifest(input.manifest);
  if (!DEVICE_ID_PATTERN.test(input.localDeviceId || '')) throw new TypeError('Local device ID must be 16 hex chars');
  if (!DEVICE_ID_PATTERN.test(input.remoteDeviceId || '')) throw new TypeError('Remote device ID must be 16 hex chars');
  if (input.localDeviceId === input.remoteDeviceId) throw new TypeError('Device IDs must differ');
  if (typeof input.signingPrivateKey !== 'string') throw new TypeError('Signing private key is required');
  if (typeof input.remoteSigningPublicKey !== 'string') throw new TypeError('Remote signing public key is required');
  assertValidEphemeralKey(input.senderEphemeralPublicKey);
  assertValidSessionId(input.sessionId);
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_MESSAGE_TTL_MS) throw new RangeError('TTL is out of range');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new RangeError('Timeout is out of range');
  const clock = input.clock ?? (() => Date.now());
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function');
  return { stream: input.stream, manifest, localDeviceId: input.localDeviceId, remoteDeviceId: input.remoteDeviceId, signingPrivateKey: input.signingPrivateKey, remoteSigningPublicKey: input.remoteSigningPublicKey, senderEphemeralPublicKey: input.senderEphemeralPublicKey, sessionId: input.sessionId, ttlMs, timeoutMs, clock };
}

function createRequestFrame(config: BootstrapConfig): Buffer {
  const issuedAt = config.clock();
  if (issuedAt > Number.MAX_SAFE_INTEGER - config.ttlMs) throw new RangeError('Bootstrap expiration exceeds safe integer');
  const signed = signTransferMessage(TYPE_TRANSFER_MANIFEST, {
    app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_MANIFEST,
    manifest: config.manifest, senderDeviceId: config.localDeviceId, receiverDeviceId: config.remoteDeviceId,
    senderEphemeralPublicKey: config.senderEphemeralPublicKey, sessionId: config.sessionId,
    issuedAt, expiresAt: issuedAt + config.ttlMs,
  } as Record<string, unknown>, config.signingPrivateKey, { now: issuedAt });
  return encodeWireFrame({
    header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_MANIFEST },
    payload: encodeTransferMessage(TYPE_TRANSFER_MANIFEST, signed, { now: issuedAt }),
  });
}

function exchangeBootstrapFrames(config: BootstrapConfig, requestFrame: Buffer): Promise<BootstrapResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeComplete = false;
    let decision: string | null = null;
    let resume: unknown = null;
    let checkpoint: ControlCheckpoint | null = null;
    let controlCheckpoint: ControlCheckpoint | null = null;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => fail(new Error(`Transfer bootstrap timed out after ${config.timeoutMs} milliseconds`)), config.timeoutMs);

    function unshiftRemaining(): void {
      // Push any buffered data (e.g. MUX frames) back to the socket so the
      // stream session can receive it after the bootstrap hands off.
      const stream = config.stream as unknown as { unshift?: (data: Buffer) => void };
      if (buffer.length > 0 && typeof stream.unshift === 'function') {
        stream.unshift(buffer);
        buffer = Buffer.alloc(0);
      }
    }

    function cleanup(): void {
      clearTimeout(timer);
      config.stream.removeListener('data', onData);
      config.stream.removeListener('error', onError);
      config.stream.removeListener('close', onClose);
      // Do NOT pause — let Node.js auto-pause when the 'data' listener is
      // removed. The stream session will resume() when it takes ownership.
    }

    function succeed(): void {
      if (settled) return;
      settled = true;
      cleanup();
      unshiftRemaining();
      resolve({ decision: decision!, resume, checkpoint: controlCheckpoint });
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (!config.stream.destroyed) config.stream.destroy(error);
      reject(error);
    }

    function onData(chunk: Buffer): void {
      if (settled) return;
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BOOTSTRAP_FRAME_BODY_BYTES * 2) { fail(new Error('Bootstrap input exceeds the accepted limit')); return; }

      // Try to decode wire frames from the accumulated buffer
      while (buffer.length >= FRAME_LENGTH_BYTES) {
        const frameLength = buffer.readUInt32BE(0);

        // If the frame length is invalid, this is likely trailing MUX data
        if (!Number.isSafeInteger(frameLength) || frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
          if (decision !== null) { succeed(); return; }
          if (!settled) fail(new RangeError(`Wire frame length must be between ${HEADER_LENGTH_BYTES} and ${MAX_FRAME_SIZE} bytes`));
          return;
        }

        const totalLength = FRAME_LENGTH_BYTES + frameLength;
        if (buffer.length < totalLength) break; // wait for more data

        try {
          const frame = decodeWireFrame(buffer.subarray(0, totalLength));
          buffer = Buffer.from(buffer.subarray(totalLength));
          processFrame(frame.header.type, frame.payload);
        } catch (error) {
          if (!settled) fail(error as Error);
          return;
        }

        // After processing a frame, if we've settled (succeeded), push remaining data back
        if (settled) { succeed(); return; }
      }
    }

    function processFrame(type: string, payload: Buffer): void {
      const now = config.clock();
      if (type === TYPE_TRANSFER_DECISION) {
        const decoded = decodeTransferMessage(type, payload, { now }) as Record<string, unknown>;
        if (!verifyTransferMessage(type, decoded, config.remoteSigningPublicKey, { now })) throw new Error('Transfer decision signature is invalid');
        if (decoded.senderDeviceId !== config.remoteDeviceId || decoded.receiverDeviceId !== config.localDeviceId) throw new Error('Transfer decision route is invalid');
        decision = decoded.decision as string;
        if (decision !== 'accepted') { succeed(); return; }
      } else if (type === TYPE_TRANSFER_RESUME) {
        const opts: { now: number; checkpoint?: ControlCheckpoint } = { now };
        if (checkpoint) opts.checkpoint = checkpoint;
        const decoded = decodeTransferMessage(type, payload, opts) as Record<string, unknown>;
        if (!verifyTransferMessage(type, decoded, config.remoteSigningPublicKey, { now })) throw new Error('Transfer resume signature is invalid');
        if (decoded.senderDeviceId !== config.remoteDeviceId || decoded.receiverDeviceId !== config.localDeviceId) throw new Error('Transfer resume route is invalid');
        resume = decoded;
        const advOpts: { now: number; checkpoint?: ControlCheckpoint } = { now };
        if (checkpoint) advOpts.checkpoint = checkpoint;
        controlCheckpoint = advanceTransferControlCheckpoint(type, decoded, advOpts);
        succeed();
      } else {
        throw new Error(`Unexpected bootstrap frame type: ${type}`);
      }
    }

    function onError(error: Error): void { fail(error); }
    function onClose(): void { if (!settled) fail(new Error('Transfer stream closed during bootstrap')); }

    config.stream.on('data', onData);
    config.stream.once('error', onError);
    config.stream.once('close', onClose);
    config.stream.resume();

    writeComplete = config.stream.write(requestFrame, (err) => {
      if (err && !settled) fail(err);
    });
    if (!writeComplete && !settled) {
      config.stream.once('drain', () => { /* write already buffered */ });
    }
  });
}
