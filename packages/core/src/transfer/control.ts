/**
 * Signed stream control codec: encode/decode/verify Ed25519-signed control
 * frames for the v2 transfer stream session.
 * Ported from src/v2/signed-stream-control.js.
 *
 * Each control frame carries a command (hello/start/pause/paused/resume/
 * resumed/complete/complete-ack/cancel) bound to a task id, session id, and
 * both device ids, with a monotonic sequence number and TTL. The codec is
 * created per-session with the local device's private key and the remote
 * peer's public key.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } from '../constants.js';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../canonical-json.js';
import { assertValidTaskId } from './manifest.js';
import { assertValidSessionId } from './message-codec.js';

export const MAX_ENCODED_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const CONTROL_PROTOCOL = 1;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const CONTROL_COMMANDS: Set<string> = new Set([
  'stream-hello', 'stream-start', 'stream-pause', 'stream-paused',
  'stream-resume', 'stream-resumed', 'stream-complete', 'stream-complete-ack', 'stream-cancel',
]);
export const CANCEL_CODES: Set<string> = new Set(['cancelled', 'timeout', 'protocol-error', 'transfer-error']);

const CORE_FIELDS = ['type', 'protocol', 'taskId', 'fromPeerId', 'toPeerId', 'direction'];
const SIGNED_FIELDS = ['app', 'protocolVersion', 'type', 'command', 'controlProtocol', 'taskId', 'sessionId', 'fromDeviceId', 'toDeviceId', 'direction', 'sequence', 'issuedAt', 'expiresAt'];

export interface StreamControlCodecOptions {
  localDevice: { deviceId: string; signingPrivateKey: string; signingPublicKey?: string };
  remotePeer: { deviceId: string; signingPublicKey: string } | { identity: { deviceId: string; signingPublicKey: string } };
  taskId: string;
  sessionId: string;
  now?: () => number;
  ttlMs?: number;
}

export interface CoreControlMessage {
  type: string;
  protocol: number;
  taskId: string;
  fromPeerId: string;
  toPeerId: string;
  direction: string;
  code?: string;
}

export interface StreamControlCodec {
  encodeControl(message: CoreControlMessage): Buffer;
  decodeControl(bytes: Uint8Array): CoreControlMessage;
  verifyControl(decoded: CoreControlMessage): boolean;
}

export function createSignedStreamControlCodec(options: StreamControlCodecOptions): StreamControlCodec {
  const localDeviceId = readDeviceId(options.localDevice, 'Local device');
  const remoteIdentity = (options.remotePeer as { identity?: { deviceId: string; signingPublicKey: string } }).identity ?? (options.remotePeer as { deviceId: string; signingPublicKey: string });
  const remoteDeviceId = readDeviceId(remoteIdentity, 'Remote peer');
  if (localDeviceId === remoteDeviceId) throw new TypeError('Local and remote device IDs must differ');
  assertValidTaskId(options.taskId);
  assertValidSessionId(options.sessionId);
  const now = options.now ?? (() => Date.now());
  if (typeof now !== 'function') throw new TypeError('Stream control clock must be a function');
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  assertTtl(ttlMs);

  const signingPrivateKey = readEd25519PrivateKey(options.localDevice.signingPrivateKey);
  const remoteSigningPublicKey = readEd25519PublicKey(remoteIdentity.signingPublicKey);
  assertLocalPublicKeyMatches(options.localDevice, signingPrivateKey);

  let nextLocalSequence = 0;
  let nextRemoteSequence = 0;
  let localDirection: string | null = null;
  const authenticatedValues = new WeakMap<object, Readonly<{ sequence: number; direction: string; issuedAt: number; expiresAt: number }>>();

  function encodeControl(message: CoreControlMessage): Buffer {
    const core = inspectCoreMessage(message);
    assertCoreBinding(core, localDeviceId, remoteDeviceId, options.taskId);
    assertLocalDirection(core.direction, localDirection);
    if (!Number.isSafeInteger(nextLocalSequence)) throw new RangeError('Stream control local sequence is exhausted');

    const issuedAt = readClock(now);
    if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) throw new RangeError('Stream control expiration exceeds safe integer precision');
    const unsigned: Record<string, unknown> = {
      app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_STREAM_CONTROL,
      command: core.type, controlProtocol: CONTROL_PROTOCOL, taskId: options.taskId, sessionId: options.sessionId,
      fromDeviceId: localDeviceId, toDeviceId: remoteDeviceId, direction: core.direction,
      sequence: nextLocalSequence, issuedAt, expiresAt: issuedAt + ttlMs,
    };
    if (core.type === 'stream-cancel') unsigned.code = core.code;

    const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned as unknown as CanonicalValue), 'utf8'), signingPrivateKey).toString('base64url');
    assertCanonicalSignature(signature);
    const encoded = Buffer.from(canonicalJson({ ...unsigned, signature } as unknown as CanonicalValue), 'utf8');
    if (encoded.length === 0 || encoded.length > MAX_ENCODED_BYTES) throw new RangeError('Encoded stream control exceeds 16 KiB');

    localDirection = core.direction;
    nextLocalSequence += 1;
    return encoded;
  }

  function decodeControl(bytes: Uint8Array): CoreControlMessage {
    const input = requireBytes(bytes);
    if (input.length === 0 || input.length > MAX_ENCODED_BYTES) throw new RangeError('Encoded stream control must be between 1 byte and 16 KiB');

    let serialized: string;
    try { serialized = UTF8_DECODER.decode(input); } catch { throw new SyntaxError('Stream control is not valid UTF-8'); }
    if (!Buffer.from(serialized, 'utf8').equals(input)) throw new SyntaxError('Stream control is not canonical UTF-8');

    const signed = parseCanonicalJson(serialized, 'Stream control') as Record<string, unknown>;
    inspectSignedMessage(signed);
    assertSignedBinding(signed, remoteDeviceId, localDeviceId, options.taskId, options.sessionId);
    assertFreshTimestamp(signed, readClock(now));
    if (!Number.isSafeInteger(nextRemoteSequence)) throw new RangeError('Stream control remote sequence is exhausted');
    if (signed.sequence !== nextRemoteSequence) throw new Error(`Stream control sequence must be exactly ${nextRemoteSequence}`);

    const signature = Buffer.from(signed.signature as string, 'base64url');
    const unsigned = copyUnsignedMessage(signed);
    if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned as unknown as CanonicalValue), 'utf8'), remoteSigningPublicKey, signature)) {
      throw new Error('Stream control signature verification failed');
    }

    const decoded: CoreControlMessage = {
      type: signed.command as string, protocol: signed.controlProtocol as number,
      taskId: signed.taskId as string, fromPeerId: signed.fromDeviceId as string,
      toPeerId: signed.toDeviceId as string, direction: signed.direction as string,
    };
    if (signed.command === 'stream-cancel') decoded.code = signed.code as string;
    const result = Object.freeze(decoded) as CoreControlMessage;
    authenticatedValues.set(result as unknown as object, Object.freeze({ sequence: signed.sequence as number, direction: signed.direction as string, issuedAt: signed.issuedAt as number, expiresAt: signed.expiresAt as number }));
    return result;
  }

  function verifyControl(decoded: CoreControlMessage): boolean {
    if (!decoded || typeof decoded !== 'object') return false;
    const metadata = authenticatedValues.get(decoded as unknown as object);
    if (!metadata) return false;
    authenticatedValues.delete(decoded as unknown as object);

    try {
      if (metadata.sequence !== nextRemoteSequence) return false;
      assertFreshTimeRange(metadata.issuedAt, metadata.expiresAt, readClock(now));
      const expectedRemoteDirection = localDirection === null ? null : oppositeDirection(localDirection);
      if (expectedRemoteDirection !== null && metadata.direction !== expectedRemoteDirection) return false;
      if (localDirection === null) localDirection = oppositeDirection(metadata.direction);
      nextRemoteSequence += 1;
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ encodeControl, decodeControl, verifyControl });
}

function inspectCoreMessage(value: CoreControlMessage): CoreControlMessage {
  assertPlainDataObject(value, 'Transfer stream control');
  const command = value.type;
  if (!CONTROL_COMMANDS.has(command)) throw new TypeError('Transfer stream control command is unsupported');
  if (value.protocol !== CONTROL_PROTOCOL) throw new TypeError('Transfer stream control protocol is unsupported');
  assertValidTaskId(value.taskId);
  assertDeviceId(value.fromPeerId, 'Transfer stream control sender');
  assertDeviceId(value.toPeerId, 'Transfer stream control receiver');
  assertDirection(value.direction);
  if (command === 'stream-cancel' && (!value.code || !CANCEL_CODES.has(value.code))) throw new TypeError('Transfer stream cancellation code is invalid');
  return value;
}

function inspectSignedMessage(value: Record<string, unknown>): void {
  assertPlainDataObject(value, 'Signed stream control');
  const command = value.command as string;
  if (value.app !== APP_ID || value.protocolVersion !== PROTOCOL_VERSION || value.type !== MESSAGE_TYPES.TRANSFER_STREAM_CONTROL || value.controlProtocol !== CONTROL_PROTOCOL) {
    throw new TypeError('Signed stream control has an unsupported protocol envelope');
  }
  if (!CONTROL_COMMANDS.has(command)) throw new TypeError('Signed stream control command is unsupported');
  assertValidTaskId(value.taskId as string);
  assertValidSessionId(value.sessionId);
  assertDeviceId(value.fromDeviceId as string, 'Signed stream control sender');
  assertDeviceId(value.toDeviceId as string, 'Signed stream control receiver');
  if (value.fromDeviceId === value.toDeviceId) throw new TypeError('Stream control device IDs must differ');
  assertDirection(value.direction as string);
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new TypeError('Stream control sequence must be a nonnegative safe integer');
  assertPositiveSafeInteger(value.issuedAt as number, 'Stream control issue time');
  assertPositiveSafeInteger(value.expiresAt as number, 'Stream control expiration time');
  if (command === 'stream-cancel' && (!value.code || !CANCEL_CODES.has(value.code as string))) throw new TypeError('Stream control cancellation code is invalid');
  assertCanonicalSignature(value.signature as string);
}

function copyUnsignedMessage(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) unsigned[field] = value[field];
  if (value.command === 'stream-cancel') unsigned.code = value.code;
  return unsigned;
}

function assertCoreBinding(value: CoreControlMessage, localDeviceId: string, remoteDeviceId: string, taskId: string): void {
  if (value.taskId !== taskId) throw new Error('Transfer stream control task does not match this codec');
  if (value.fromPeerId !== localDeviceId || value.toPeerId !== remoteDeviceId) throw new Error('Transfer stream control identities do not match this codec');
}

function assertSignedBinding(value: Record<string, unknown>, remoteDeviceId: string, localDeviceId: string, taskId: string, sessionId: string): void {
  if (value.taskId !== taskId) throw new Error('Signed stream control task does not match this codec');
  if (value.sessionId !== sessionId) throw new Error('Signed stream control session does not match this codec');
  if (value.fromDeviceId !== remoteDeviceId || value.toDeviceId !== localDeviceId) throw new Error('Signed stream control identities do not match this codec');
}

function assertLocalDirection(direction: string, boundDirection: string | null): void {
  if (boundDirection !== null && direction !== boundDirection) throw new Error('Transfer stream control direction conflicts with this codec');
}

function assertFreshTimestamp(value: Record<string, unknown>, currentTime: number): void {
  assertFreshTimeRange(value.issuedAt as number, value.expiresAt as number, currentTime);
}

function assertFreshTimeRange(issuedAt: number, expiresAt: number, currentTime: number): void {
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) throw new Error('Stream control validity period is invalid');
  if (issuedAt > currentTime && issuedAt - currentTime > CLOCK_SKEW_MS) throw new Error('Stream control issue time is too far in the future');
  if (currentTime > expiresAt && currentTime - expiresAt > CLOCK_SKEW_MS) throw new Error('Stream control has expired');
}

function readClock(now: () => number): number {
  const value = now();
  assertPositiveSafeInteger(value, 'Stream control clock value');
  return value;
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_MS) throw new RangeError(`Stream control TTL must be between 1 and ${MAX_TTL_MS} milliseconds`);
}

function readDeviceId(value: { deviceId: string }, subject: string): string {
  if (!value || typeof value !== 'object') throw new TypeError(`${subject} is required`);
  assertDeviceId(value.deviceId, subject);
  return value.deviceId;
}

function assertDeviceId(value: string, subject: string): void {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) throw new TypeError(`${subject} device ID must be 16 lowercase hexadecimal characters`);
}

function assertDirection(value: string): void {
  if (value !== 'send' && value !== 'receive') throw new TypeError('Stream control direction is invalid');
}

function assertPositiveSafeInteger(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${subject} must be a positive safe integer`);
}

function assertCanonicalSignature(value: string): void {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) throw new TypeError('Stream control signature must be an unpadded base64url Ed25519 signature');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) throw new TypeError('Stream control signature must be exactly 64 canonical bytes');
}

function readEd25519PrivateKey(value: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(value); } catch { throw new TypeError('Local device signing private key is unreadable'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Local device signing key must be Ed25519');
  return key;
}

function readEd25519PublicKey(value: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(value); } catch { throw new TypeError('Remote peer signing public key is unreadable'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Remote peer signing key must be Ed25519');
  return key;
}

function assertLocalPublicKeyMatches(localDevice: { signingPublicKey?: string }, privateKey: crypto.KeyObject): void {
  if (!localDevice || localDevice.signingPublicKey === undefined) return;
  const supplied = readEd25519PublicKey(localDevice.signingPublicKey);
  const derived = crypto.createPublicKey(privateKey);
  const suppliedDer = supplied.export({ type: 'spki', format: 'der' });
  const derivedDer = derived.export({ type: 'spki', format: 'der' });
  if (!crypto.timingSafeEqual(suppliedDer, derivedDer)) throw new TypeError('Local device signing key pair does not match');
}

function requireBytes(value: Uint8Array): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Encoded stream control must be a Buffer or Uint8Array');
}

function assertPlainDataObject(value: unknown, subject: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${subject} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${subject} must be a plain object`);
}

function oppositeDirection(direction: string): string {
  return direction === 'send' ? 'receive' : 'send';
}
