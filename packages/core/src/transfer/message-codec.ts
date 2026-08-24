/**
 * Transfer control message encode/decode/validate (manifest, decision, complete,
 * resume, progress). Ported from src/v2/transfer-message-codec.js (749 lines).
 *
 * Each message type is validated against strict schema rules, canonical-JSON
 * encoded for wire transport, and signed via the message-auth module. Progress
 * and resume messages carry monotonic control checkpoints that prevent
 * replay and rollback of committed offsets.
 */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } from '../constants.js';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../canonical-json.js';
import { MAX_FILE_SIZE_BYTES, MAX_TOTAL_SIZE_BYTES, MAX_TRANSFER_FILES, assertValidRelativePath, assertValidTaskId, normalizeTransferManifest, type TransferManifest } from './manifest.js';
import { MAX_SEQUENCE } from '../crypto/session.js';

export const TYPE_TRANSFER_MANIFEST = MESSAGE_TYPES.TRANSFER_MANIFEST;
export const TYPE_TRANSFER_DECISION = MESSAGE_TYPES.TRANSFER_DECISION;
export const TYPE_TRANSFER_COMPLETE = MESSAGE_TYPES.TRANSFER_COMPLETE;
export const TYPE_TRANSFER_RESUME = MESSAGE_TYPES.TRANSFER_RESUME;
export const TYPE_TRANSFER_PROGRESS = MESSAGE_TYPES.TRANSFER_PROGRESS;

export const MAX_TRANSFER_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 30 * 1000;
export const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_RESUME_ENTRIES = MAX_TRANSFER_FILES;
export const SESSION_ID_BYTES = 16;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PLACEHOLDER = Buffer.alloc(64).toString('base64url');

export const DECISIONS: Set<string> = new Set(['accepted', 'rejected', 'busy', 'unauthorized', 'invalid-manifest', 'expired', 'unsupported']);
export const COMPLETION_DIAGNOSTICS: Set<string> = new Set(['success', 'hash-mismatch', 'size-mismatch', 'sequence-mismatch', 'cancelled', 'io-error', 'protocol-error']);
const TRANSFER_TYPES: Set<string> = new Set([TYPE_TRANSFER_MANIFEST, TYPE_TRANSFER_DECISION, TYPE_TRANSFER_COMPLETE, TYPE_TRANSFER_RESUME, TYPE_TRANSFER_PROGRESS]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type TransferMessageType = typeof TYPE_TRANSFER_MANIFEST | typeof TYPE_TRANSFER_DECISION | typeof TYPE_TRANSFER_COMPLETE | typeof TYPE_TRANSFER_RESUME | typeof TYPE_TRANSFER_PROGRESS;

export interface TransferMessageOptions {
  now?: number;
  checkpoint?: ControlCheckpoint | null;
}

export interface ResumeFile {
  path: string;
  size: number;
  committedOffset: number;
  completed: boolean;
}

export interface ControlCheckpoint {
  taskId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  manifestHash: string;
  files: ResumeFile[];
  nextSequence: number;
  totalTransferred: number;
  issuedAt: number;
}

export function encodeTransferMessage(type: string, message: Record<string, unknown>, options: TransferMessageOptions = {}): Buffer {
  assertTransferType(type);
  const normalized = validateTransferMessage(type, message, options);
  const encoded = Buffer.from(canonicalJson(normalized as unknown as CanonicalValue), 'utf8');
  assertPayloadBounds(type, encoded.length);
  return encoded;
}

export function decodeTransferMessage(type: string, payload: Uint8Array, options: TransferMessageOptions = {}): Record<string, unknown> {
  assertTransferType(type);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) throw new TypeError('Transfer message payload must be bytes');
  const bytes = Buffer.from(payload);
  assertPayloadBounds(type, bytes.length);
  const text = utf8Decoder.decode(bytes);
  const parsed = parseCanonicalJson(text, 'Transfer message payload');
  const normalized = validateTransferMessage(type, parsed as Record<string, unknown>, options);
  if (canonicalJson(normalized as unknown as CanonicalValue) !== text) {
    throw new SyntaxError('Transfer message payload is not in normalized canonical form');
  }
  return normalized;
}

export function transferMessageSigningPayload(type: string, message: Record<string, unknown>): string {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');
  const candidate: Record<string, unknown> = { ...message };
  if (!Object.hasOwn(candidate, 'signature')) candidate.signature = SIGNATURE_PLACEHOLDER;
  const normalized = validateTransferMessage(type, candidate, { now: (candidate.issuedAt as number) ?? Date.now() });
  const unsigned: Record<string, unknown> = { ...normalized };
  delete unsigned.signature;
  return canonicalJson(unsigned as unknown as CanonicalValue);
}

export function validateTransferMessage(type: string, message: Record<string, unknown>, options: TransferMessageOptions = {}): Record<string, unknown> {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');
  if (Object.hasOwn(options, 'previous' as never)) throw new TypeError('Transfer control validation requires a complete checkpoint, not options.previous');
  const now = normalizeNow(options.now);

  switch (type) {
    case TYPE_TRANSFER_MANIFEST:
      return validateManifestEnvelope(message, now);
    case TYPE_TRANSFER_DECISION:
      return validateDecision(message, now);
    case TYPE_TRANSFER_COMPLETE:
      return validateComplete(message, now);
    case TYPE_TRANSFER_RESUME:
      return validateResume(message, now, options.checkpoint ?? undefined);
    case TYPE_TRANSFER_PROGRESS:
      return validateProgress(message, now, options.checkpoint ?? undefined);
    default:
      throw new TypeError('Unsupported transfer message type');
  }
}

export function assertValidSessionId(value: unknown): void {
  assertCanonicalBase64Url(value, SESSION_ID_BYTES, 'Transfer session ID');
}

export function assertValidEphemeralKey(value: unknown): void {
  assertCanonicalBase64Url(value, 32, 'Sender ephemeral public key');
}

export function advanceTransferControlCheckpoint(type: string, message: Record<string, unknown>, options: TransferMessageOptions = {}): ControlCheckpoint {
  if (type !== TYPE_TRANSFER_RESUME && type !== TYPE_TRANSFER_PROGRESS) {
    throw new TypeError('Only transfer resume and progress messages can advance a control checkpoint');
  }
  const previous = options.checkpoint === undefined || options.checkpoint === null ? null : normalizeControlCheckpoint(options.checkpoint);
  if (previous === null && type !== TYPE_TRANSFER_RESUME) {
    throw new TypeError('The first transfer control checkpoint must be created from a transfer resume message');
  }
  const opts: TransferMessageOptions = {};
  if (options.now !== undefined) opts.now = options.now;
  if (previous !== null) opts.checkpoint = previous;
  const normalized = validateTransferMessage(type, message, opts) as Record<string, unknown>;
  const files: ResumeFile[] = previous === null
    ? (normalized.files as ResumeFile[])
    : normalized.type === TYPE_TRANSFER_RESUME
      ? (normalized.files as ResumeFile[])
      : previous.files.map((file) => (file.path === (normalized.path as string) ? { path: file.path, size: file.size, committedOffset: normalized.committedOffset as number, completed: normalized.completed as boolean } : file));
  return normalizeControlCheckpoint({
    taskId: normalized.taskId as string,
    senderDeviceId: normalized.senderDeviceId as string,
    receiverDeviceId: normalized.receiverDeviceId as string,
    manifestHash: normalized.manifestHash as string,
    files,
    nextSequence: normalized.nextSequence as number,
    totalTransferred: normalized.totalTransferred as number,
    issuedAt: normalized.issuedAt as number,
  });
}

function validateManifestEnvelope(message: Record<string, unknown>, now: number): Record<string, unknown> {
  assertExactKeys(message, ['app', 'protocolVersion', 'type', 'manifest', 'senderDeviceId', 'receiverDeviceId', 'senderEphemeralPublicKey', 'sessionId', 'issuedAt', 'expiresAt', 'signature'], 'Transfer manifest envelope');
  assertProtocolEnvelope(message, TYPE_TRANSFER_MANIFEST, 'Transfer manifest envelope');
  const manifest = normalizeTransferManifest(message.manifest);
  assertRoute(message.senderDeviceId as string, message.receiverDeviceId as string);
  assertCanonicalBase64Url(message.senderEphemeralPublicKey, 32, 'Sender ephemeral public key');
  assertValidSessionId(message.sessionId);
  assertTimeWindow(message.issuedAt as number, message.expiresAt as number, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');
  return { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_MANIFEST, manifest, senderDeviceId: message.senderDeviceId, receiverDeviceId: message.receiverDeviceId, senderEphemeralPublicKey: message.senderEphemeralPublicKey, sessionId: message.sessionId, issuedAt: message.issuedAt, expiresAt: message.expiresAt, signature: message.signature };
}

function validateDecision(message: Record<string, unknown>, now: number): Record<string, unknown> {
  assertExactKeys(message, ['app', 'protocolVersion', 'type', 'taskId', 'sessionId', 'senderDeviceId', 'receiverDeviceId', 'decision', 'issuedAt', 'expiresAt', 'signature'], 'Transfer decision');
  assertProtocolEnvelope(message, TYPE_TRANSFER_DECISION, 'Transfer decision');
  assertValidTaskId(message.taskId as string);
  assertRoute(message.senderDeviceId as string, message.receiverDeviceId as string);
  assertValidSessionId(message.sessionId);
  if (typeof message.decision !== 'string' || !DECISIONS.has(message.decision)) throw new TypeError('Transfer decision diagnostic is unsupported');
  assertTimeWindow(message.issuedAt as number, message.expiresAt as number, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');
  return { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_DECISION, taskId: message.taskId, senderDeviceId: message.senderDeviceId, receiverDeviceId: message.receiverDeviceId, decision: message.decision, sessionId: message.sessionId, issuedAt: message.issuedAt, expiresAt: message.expiresAt, signature: message.signature };
}

function validateComplete(message: Record<string, unknown>, now: number): Record<string, unknown> {
  assertExactKeys(message, ['app', 'protocolVersion', 'type', 'taskId', 'senderDeviceId', 'receiverDeviceId', 'status', 'diagnostic', 'sha256', 'bytes', 'sequence', 'issuedAt', 'expiresAt', 'signature'], 'Transfer completion');
  assertProtocolEnvelope(message, TYPE_TRANSFER_COMPLETE, 'Transfer completion');
  assertValidTaskId(message.taskId as string);
  assertRoute(message.senderDeviceId as string, message.receiverDeviceId as string);
  if (message.status !== 'success' && message.status !== 'failed') throw new TypeError('Transfer completion status must be success or failed');
  if (typeof message.diagnostic !== 'string' || !COMPLETION_DIAGNOSTICS.has(message.diagnostic)) throw new TypeError('Transfer completion diagnostic is unsupported');
  if (message.status === 'success') {
    if (message.diagnostic !== 'success') throw new TypeError('Successful transfer completion must use the success diagnostic');
    assertSha256(message.sha256);
  } else {
    if (message.diagnostic === 'success') throw new TypeError('Failed transfer completion must use a failure diagnostic');
    if (message.sha256 !== null) throw new TypeError('Failed transfer completion must not claim a verified SHA-256');
  }
  assertNonNegativeSafeInteger(message.bytes, 'Transfer completion byte count');
  assertNonNegativeSafeInteger(message.sequence, 'Transfer completion sequence');
  assertTimeWindow(message.issuedAt as number, message.expiresAt as number, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');
  return { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_COMPLETE, taskId: message.taskId, senderDeviceId: message.senderDeviceId, receiverDeviceId: message.receiverDeviceId, status: message.status, diagnostic: message.diagnostic, sha256: message.sha256, bytes: message.bytes, sequence: message.sequence, issuedAt: message.issuedAt, expiresAt: message.expiresAt, signature: message.signature };
}

function validateResume(message: Record<string, unknown>, now: number, checkpoint?: ControlCheckpoint): Record<string, unknown> {
  assertExactKeys(message, ['app', 'protocolVersion', 'type', 'taskId', 'sessionId', 'senderDeviceId', 'receiverDeviceId', 'manifestHash', 'files', 'nextSequence', 'totalTransferred', 'issuedAt', 'expiresAt', 'signature'], 'Transfer resume');
  assertProtocolEnvelope(message, TYPE_TRANSFER_RESUME, 'Transfer resume');
  assertValidTaskId(message.taskId as string);
  assertValidSessionId(message.sessionId);
  assertRoute(message.senderDeviceId as string, message.receiverDeviceId as string);
  assertManifestHash(message.manifestHash);
  const files = normalizeResumeFiles(message.files);
  assertSequence(message.nextSequence as number, 'Transfer resume next sequence');
  assertNonNegativeSafeInteger(message.totalTransferred, 'Transfer resume total transferred');
  if ((message.totalTransferred as number) > MAX_TOTAL_SIZE_BYTES) throw new RangeError('Transfer resume total transferred exceeds the maximum transfer size');
  const committedTotal = files.reduce((total, file) => checkedAdd(total, file.committedOffset, 'Transfer resume committed total'), 0);
  if (message.totalTransferred !== committedTotal) throw new TypeError('Transfer resume total transferred must equal the sum of committed offsets');
  assertTimeWindow(message.issuedAt as number, message.expiresAt as number, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');
  const normalized = { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_RESUME, taskId: message.taskId, sessionId: message.sessionId, senderDeviceId: message.senderDeviceId, receiverDeviceId: message.receiverDeviceId, manifestHash: message.manifestHash, files, nextSequence: message.nextSequence, totalTransferred: message.totalTransferred, issuedAt: message.issuedAt, expiresAt: message.expiresAt, signature: message.signature };
  assertMonotonicControl(checkpoint, normalized);
  return normalized;
}

function validateProgress(message: Record<string, unknown>, now: number, checkpoint?: ControlCheckpoint): Record<string, unknown> {
  assertExactKeys(message, ['app', 'protocolVersion', 'type', 'taskId', 'sessionId', 'senderDeviceId', 'receiverDeviceId', 'manifestHash', 'path', 'fileSize', 'committedOffset', 'completed', 'nextSequence', 'totalTransferred', 'issuedAt', 'expiresAt', 'signature'], 'Transfer progress acknowledgement');
  assertProtocolEnvelope(message, TYPE_TRANSFER_PROGRESS, 'Transfer progress acknowledgement');
  assertValidTaskId(message.taskId as string);
  assertValidSessionId(message.sessionId);
  assertRoute(message.senderDeviceId as string, message.receiverDeviceId as string);
  assertManifestHash(message.manifestHash);
  assertValidRelativePath(message.path as string);
  assertBoundedFileSize(message.fileSize as number, 'Transfer progress file size');
  assertNonNegativeSafeInteger(message.committedOffset, 'Transfer progress committed offset');
  if ((message.committedOffset as number) > (message.fileSize as number)) throw new RangeError('Transfer progress committed offset exceeds the file size');
  assertBoolean(message.completed, 'Transfer progress completed');
  if (message.completed && message.committedOffset !== message.fileSize) throw new TypeError('Completed transfer progress must commit the entire file');
  if (!message.completed && (message.fileSize as number) > 0 && message.committedOffset === message.fileSize) throw new TypeError('Fully committed non-empty transfer progress must be completed');
  assertSequence(message.nextSequence as number, 'Transfer progress next sequence');
  assertNonNegativeSafeInteger(message.totalTransferred, 'Transfer progress total transferred');
  if ((message.totalTransferred as number) < (message.committedOffset as number) || (message.totalTransferred as number) > MAX_TOTAL_SIZE_BYTES) throw new RangeError('Transfer progress total transferred is outside the accepted bounds');
  assertTimeWindow(message.issuedAt as number, message.expiresAt as number, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');
  const normalized = { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_PROGRESS, taskId: message.taskId, sessionId: message.sessionId, senderDeviceId: message.senderDeviceId, receiverDeviceId: message.receiverDeviceId, manifestHash: message.manifestHash, path: message.path, fileSize: message.fileSize, committedOffset: message.committedOffset, completed: message.completed, nextSequence: message.nextSequence, totalTransferred: message.totalTransferred, issuedAt: message.issuedAt, expiresAt: message.expiresAt, signature: message.signature };
  assertMonotonicControl(checkpoint, normalized);
  return normalized;
}

function normalizeResumeFiles(files: unknown): ResumeFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_RESUME_ENTRIES) throw new RangeError('Transfer resume files must be a bounded array');
  const seenPaths = new Set<string>();
  const seenWindowsPaths = new Set<string>();
  const normalized = (files as Record<string, unknown>[]).map((file) => {
    assertPlainObject(file, 'Transfer resume file');
    assertExactKeys(file, ['path', 'size', 'committedOffset', 'completed'], 'Transfer resume file');
    assertValidRelativePath(file.path as string);
    const windowsPath = (file.path as string).split('/').map((c) => c.toUpperCase()).join('/');
    if (seenPaths.has(file.path as string) || seenWindowsPaths.has(windowsPath)) throw new TypeError(`Transfer resume contains a duplicate path: ${file.path}`);
    seenPaths.add(file.path as string);
    seenWindowsPaths.add(windowsPath);
    assertBoundedFileSize(file.size as number, 'Transfer resume file size');
    assertNonNegativeSafeInteger(file.committedOffset, 'Transfer resume committed offset');
    if ((file.committedOffset as number) > (file.size as number)) throw new RangeError('Transfer resume committed offset exceeds the file size');
    assertBoolean(file.completed, 'Transfer resume file completed');
    if (file.completed && file.committedOffset !== file.size) throw new TypeError('Completed transfer resume file must commit its entire size');
    if (!file.completed && (file.size as number) > 0 && file.committedOffset === file.size) throw new TypeError('Fully committed non-empty transfer resume file must be completed');
    return { path: file.path as string, size: file.size as number, committedOffset: file.committedOffset as number, completed: file.completed as boolean };
  });
  normalized.sort((left, right) => compareCodeUnits(left.path, right.path));
  return normalized;
}

function assertMonotonicControl(checkpoint: ControlCheckpoint | undefined, next: Record<string, unknown>): void {
  if (checkpoint === undefined || checkpoint === null) return;
  const normalizedPrevious = normalizeControlCheckpoint(checkpoint);
  for (const key of ['taskId', 'senderDeviceId', 'receiverDeviceId', 'manifestHash']) {
    if ((normalizedPrevious as unknown as Record<string, unknown>)[key] !== next[key]) throw new TypeError(`Transfer control message changed bound field ${key}`);
  }
  if ((next.nextSequence as number) < normalizedPrevious.nextSequence) throw new RangeError('Transfer control next sequence must not move backwards');
  if ((next.totalTransferred as number) < normalizedPrevious.totalTransferred) throw new RangeError('Transfer control total transferred must not move backwards');
  if ((next.issuedAt as number) < normalizedPrevious.issuedAt) throw new RangeError('Transfer control issue time must not move backwards');
  const previousOffsets = new Map(normalizedPrevious.files.map((file) => [file.path, file]));
  const nextType = next.type as string;
  const nextOffsets = controlOffsets(next);
  if (nextType === TYPE_TRANSFER_PROGRESS && !previousOffsets.has(next.path as string)) throw new TypeError(`Transfer progress references a file outside the resume set: ${next.path}`);
  let committedDelta = 0;
  let changedFiles = 0;
  for (const [path, prior] of previousOffsets) {
    const current = nextOffsets.get(path);
    if (!current) {
      if (nextType === TYPE_TRANSFER_RESUME) throw new TypeError(`Transfer resume dropped a previously tracked file: ${path}`);
      continue;
    }
    if (current.size !== prior.size) throw new TypeError(`Transfer control file size changed for ${path}`);
    if (current.committedOffset < prior.committedOffset) throw new RangeError(`Transfer control committed offset moved backwards for ${path}`);
    if (prior.completed && !current.completed) throw new RangeError(`Transfer control completion moved backwards for ${path}`);
    const delta = current.committedOffset - prior.committedOffset;
    committedDelta = checkedAdd(committedDelta, delta, 'Transfer control committed delta');
    if (delta > 0 || current.completed !== prior.completed) changedFiles += 1;
  }
  if (nextType === TYPE_TRANSFER_RESUME && previousOffsets.size !== nextOffsets.size) throw new TypeError('Transfer resume file set must remain stable');
  const expectedTotal = checkedAdd(normalizedPrevious.totalTransferred, committedDelta, 'Transfer control total transferred');
  if (next.totalTransferred !== expectedTotal) throw new TypeError('Transfer control total transferred must equal the checkpoint plus committed offset delta');
  const sequenceDelta = (next.nextSequence as number) - normalizedPrevious.nextSequence;
  if (sequenceDelta < changedFiles) throw new RangeError('Transfer control next sequence delta is too small for the changed files');
}

function normalizeControlCheckpoint(checkpoint: ControlCheckpoint | Record<string, unknown>): ControlCheckpoint {
  if ((checkpoint as ControlCheckpoint).taskId !== undefined && typeof (checkpoint as ControlCheckpoint).taskId === 'string') return checkpoint as ControlCheckpoint;
  const cp = checkpoint as Record<string, unknown>;
  assertPlainObject(cp, 'Transfer control checkpoint');
  assertExactKeys(cp, ['taskId', 'senderDeviceId', 'receiverDeviceId', 'manifestHash', 'files', 'nextSequence', 'totalTransferred', 'issuedAt'], 'Transfer control checkpoint');
  assertValidTaskId(cp.taskId as string);
  assertRoute(cp.senderDeviceId as string, cp.receiverDeviceId as string);
  assertManifestHash(cp.manifestHash);
  const files = normalizeResumeFiles(cp.files);
  assertSequence(cp.nextSequence as number, 'Transfer control checkpoint next sequence');
  assertNonNegativeSafeInteger(cp.totalTransferred, 'Transfer control checkpoint total transferred');
  const committedTotal = files.reduce((total, file) => checkedAdd(total, file.committedOffset, 'Transfer control checkpoint committed total'), 0);
  if (cp.totalTransferred !== committedTotal) throw new TypeError('Transfer control checkpoint total transferred must equal the sum of committed offsets');
  assertPositiveSafeInteger(cp.issuedAt as number, 'Transfer control checkpoint issuedAt');
  return { taskId: cp.taskId as string, senderDeviceId: cp.senderDeviceId as string, receiverDeviceId: cp.receiverDeviceId as string, manifestHash: cp.manifestHash as string, files, nextSequence: cp.nextSequence as number, totalTransferred: cp.totalTransferred as number, issuedAt: cp.issuedAt as number };
}

function controlOffsets(message: Record<string, unknown>): Map<string, ResumeFile> {
  if (message.type === TYPE_TRANSFER_RESUME) return new Map((message.files as ResumeFile[]).map((file) => [file.path, file]));
  return new Map([[message.path as string, { path: message.path as string, size: message.fileSize as number, committedOffset: message.committedOffset as number, completed: message.completed as boolean }]]);
}

function assertManifestHash(value: unknown): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TypeError('Transfer manifest hash must be 64 lowercase hexadecimal characters');
}

function assertBoundedFileSize(value: number, label: string): void {
  assertNonNegativeSafeInteger(value, label);
  if (value > MAX_FILE_SIZE_BYTES) throw new RangeError(`${label} exceeds the maximum file size`);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function checkedAdd(left: number, right: number, label: string): number {
  if (left > MAX_SAFE_INTEGER - right) throw new RangeError(`${label} exceeds safe integer precision`);
  return left + right;
}

function assertProtocolEnvelope(message: Record<string, unknown>, expectedType: string, label: string): void {
  if (message.app !== APP_ID || message.protocolVersion !== PROTOCOL_VERSION || message.type !== expectedType) throw new TypeError(`${label} protocol envelope is invalid`);
}

function assertRoute(senderDeviceId: string, receiverDeviceId: string): void {
  assertDeviceId(senderDeviceId, 'Sender device ID');
  assertDeviceId(receiverDeviceId, 'Receiver device ID');
  if (senderDeviceId === receiverDeviceId) throw new TypeError('Transfer message sender and receiver must differ');
}

function assertDeviceId(value: string, label: string): void {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) throw new TypeError(`${label} must be 16 lowercase hexadecimal characters`);
}

function assertSha256(value: unknown): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TypeError('Transfer completion SHA-256 must be 64 lowercase hexadecimal characters');
}

function assertCanonicalBase64Url(value: unknown, expectedBytes: number, label: string): void {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) throw new TypeError(`${label} must use unpadded base64url`);
  let decoded: Buffer;
  try { decoded = Buffer.from(value, 'base64url'); } catch { throw new TypeError(`${label} must be valid base64url`); }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) throw new TypeError(`${label} must be canonical base64url for ${expectedBytes} bytes`);
}

function assertTimeWindow(issuedAt: number, expiresAt: number, now: number): void {
  assertPositiveSafeInteger(issuedAt, 'Transfer message issuedAt');
  assertPositiveSafeInteger(expiresAt, 'Transfer message expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_MS) throw new RangeError('Transfer message expiration window is invalid');
  if (issuedAt > now && issuedAt - now > MAX_CLOCK_SKEW_MS) throw new RangeError('Transfer message issue time is too far in the future');
  if (expiresAt < now) throw new RangeError('Transfer message has expired');
}

function normalizeNow(value: number | undefined): number {
  const now = value === undefined ? Date.now() : value;
  assertPositiveSafeInteger(now, 'Transfer message validation time');
  return now;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_INTEGER) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEQUENCE) throw new TypeError(`${label} must be between 0 and the transfer crypto maximum sequence`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_INTEGER) throw new TypeError(`${label} must be a non-negative safe integer`);
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} must be a plain object`);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const expectedSet = new Set(expected);
  for (const key of expected) if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!expectedSet.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
}

function assertPayloadBounds(type: string, length: number): void {
  const maximum = type === TYPE_TRANSFER_RESUME || type === TYPE_TRANSFER_PROGRESS ? MAX_CONTROL_MESSAGE_BYTES : MAX_TRANSFER_MESSAGE_BYTES;
  if (!Number.isSafeInteger(length) || length <= 0 || length > maximum) throw new RangeError('Transfer message payload exceeds the accepted bounds');
}

function assertTransferType(type: string): void {
  if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) throw new TypeError('Unsupported transfer message type');
}
