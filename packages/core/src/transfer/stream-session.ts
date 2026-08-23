/**
 * Run one authenticated transfer over a Node Duplex/Socket.
 * Ported from src/v2/transfer-stream-session.js (1204 lines).
 *
 * The session takes injected codec functions (encodeControl, decodeControl,
 * verifyControl, encodeProgress, decodeProgress, commitProgress) so the
 * transport can evolve independently from the signed control codec.
 * One session carries exactly one task in exactly one negotiated direction.
 */

import { Buffer } from 'node:buffer';
import { MAX_ENCODED_BYTES, type StreamControlCodec, type CoreControlMessage } from './control.js';
import { MAX_CONTROL_MESSAGE_BYTES, type ControlCheckpoint } from './message-codec.js';
import { MAX_FRAME_BYTES, decodeFrame as decodeChunkFrame, encodeFrame as encodeChunkFrame, type ChunkFrameInput } from './chunk-frame.js';
import { assertValidTaskId } from './manifest.js';

export const MUX_MAGIC = Buffer.from('NTV2MUX1', 'ascii');
export const MUX_VERSION = 1;
export const MUX_PREFIX_BYTES = 16;
export const FRAME_KIND_CONTROL = 1;
export const FRAME_KIND_CHUNK = 2;
export const FRAME_KIND_PROGRESS = 3;

export const CONTROL_TYPES = Object.freeze({
  HELLO: 'stream-hello', START: 'stream-start', PAUSE: 'stream-pause', PAUSED: 'stream-paused',
  RESUME: 'stream-resume', RESUMED: 'stream-resumed', COMPLETE: 'stream-complete',
  COMPLETE_ACK: 'stream-complete-ack', CANCEL: 'stream-cancel',
});

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed']);
const CANCEL_CODES = new Set(['cancelled', 'timeout', 'protocol-error', 'transfer-error']);
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_PAUSE_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSING_TIMEOUT_MS = 10_000;

interface TransferStream {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  write(data: Buffer, cb?: (err?: Error | null) => void): boolean;
  end(): void;
  destroy(error?: Error): this;
  pause(): this;
  resume(): this;
  destroyed: boolean;
  writableEnded: boolean;
  writable: boolean;
}

export interface ChunkWriterLike {
  writeChunk(chunk: ChunkFrameInput): Promise<unknown>;
  complete(): Promise<{ published: boolean }>;
  cancel(): Promise<unknown>;
  getCommittedProgress(): unknown;
}

export interface ChunkReaderLike {
  [Symbol.asyncIterator](): AsyncIterator<ChunkFrameInput>;
}

export interface TransferStreamSessionInput {
  stream: TransferStream;
  role: 'sender' | 'receiver';
  taskId: string;
  localPeerId: string;
  remotePeerId: string;
  encodeControl: (message: CoreControlMessage, context: unknown) => Buffer | Promise<Buffer>;
  decodeControl: (bytes: Buffer, context: unknown) => CoreControlMessage | Promise<CoreControlMessage>;
  verifyControl: (decoded: CoreControlMessage, context: unknown) => boolean | Promise<boolean>;
  encodeProgress: (progress: unknown, context: unknown) => Buffer | Promise<Buffer>;
  decodeProgress: (bytes: Buffer, context: unknown) => unknown | Promise<unknown>;
  commitProgress: (decoded: unknown, chunk: unknown) => void | Promise<void>;
  chunkReader?: ChunkReaderLike;
  chunkWriter?: ChunkWriterLike;
  signal?: AbortSignal | null;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  writeTimeoutMs?: number;
  operationTimeoutMs?: number;
  pauseTimeoutMs?: number;
  closingTimeoutMs?: number;
}

export interface TransferSessionState {
  state: string;
  role: string;
  taskId: string;
  peerId: string;
  chunks: number;
  ciphertextBytes: number;
  paused: boolean;
  localPauseState: string;
  remotePaused: boolean;
}

export function createTransferStreamSession(input: TransferStreamSessionInput): { start: () => Promise<TransferSessionState>; pause: () => Promise<TransferSessionState>; resume: () => Promise<TransferSessionState>; cancel: (reason?: unknown) => Promise<TransferSessionState>; getState: () => TransferSessionState; done: Promise<TransferSessionState> } {
  const config = input;
  let state = 'created';
  let started = false;
  let settled = false;
  let remoteHello = false;
  let localPauseState = 'running';
  let remotePaused = false;
  let chunks = 0;
  let ciphertextBytes = 0;
  let timer: NodeJS.Timeout | null = null;
  let timerKind: string | null = null;
  let sendTail: Promise<unknown> = Promise.resolve();
  let incomingTail: Promise<unknown> = Promise.resolve();
  const decoder = new StreamEnvelopeDecoder();
  let resolveDone!: (state: TransferSessionState) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<TransferSessionState>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});

  function getState(): TransferSessionState {
    return Object.freeze({ state, role: config.role, taskId: config.taskId, peerId: config.remotePeerId, chunks, ciphertextBytes, paused: remotePaused || localPauseState !== 'running', localPauseState, remotePaused });
  }

  function armTimeout(kind: string, ms: number): void {
    clearTimer();
    timerKind = kind;
    timer = setTimeout(() => { fail(new Error(`Transfer ${kind} timed out`), 'timeout'); }, ms);
  }
  function clearTimer(): void { if (timer) clearTimeout(timer); timer = null; timerKind = null; }

  function fail(error: Error, code: string): void {
    if (settled || state === 'cancelling') return;
    state = 'failing';
    clearTimer();
    settled = true;
    state = code === 'cancelled' ? 'cancelled' : 'failed';
    if (!config.stream.destroyed) config.stream.destroy();
    rejectDone(error);
  }

  function settleSuccess(): void {
    if (settled) return;
    settled = true;
    state = 'completed';
    clearTimer();
    detachTransport();
    resolveDone(getState());
  }

  function detachTransport(): void {
    config.stream.removeListener('data', onData);
    config.stream.removeListener('error', onError);
    config.stream.removeListener('close', onClose);
    config.stream.removeListener('end', onEnd);
  }

  function onData(chunk: Buffer): void {
    if (settled) return;
    config.stream.pause();
    incomingTail = incomingTail.then(async () => {
      if (settled) return;
      await decoder.push(chunk, async (kind, payload) => {
        if (kind === FRAME_KIND_CONTROL) await handleControl(payload);
        else if (kind === FRAME_KIND_CHUNK) await handleChunk(payload);
        else await handleProgress(payload);
      });
    }).then(() => { if (!settled) config.stream.resume(); }).catch((error) => fail(error as Error, 'protocol-error'));
  }

  function onEnd(): void {
    incomingTail = incomingTail.then(() => decoder.finish()).then(() => { if (!settled && state === 'closing') settleSuccess(); }).catch((error) => fail(error as Error, 'protocol-error'));
  }
  function onClose(): void { if (!settled) fail(new Error(`Transfer stream closed while ${state}`), 'transfer-error'); }
  function onError(error: Error): void { fail(error, 'transfer-error'); }

  async function handleControl(payload: Buffer): Promise<void> {
    const decoded = await config.decodeControl(Buffer.from(payload), { operation: 'decode', role: config.role, taskId: config.taskId });
    const verified = await config.verifyControl(decoded, { operation: 'verify', role: config.role, taskId: config.taskId });
    if (verified !== true) throw new Error('Transfer control verification failed');

    if (decoded.type === CONTROL_TYPES.HELLO) {
      if (state !== 'handshaking' || remoteHello) throw new Error('Transfer hello is duplicated or out of order');
      remoteHello = true;
      clearTimer();
      armTimeout('idle', config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      if (config.role === 'sender') {
        state = 'starting';
        void runSender().catch((error) => fail(error as Error, 'transfer-error'));
      } else {
        state = 'awaiting-start';
      }
      return;
    }
    if (!remoteHello) throw new Error('Transfer control before authenticated hello');

    if (decoded.type === CONTROL_TYPES.CANCEL) {
      fail(new Error(`Remote transfer cancelled: ${(decoded as CoreControlMessage & { code?: string }).code ?? 'unknown'}`), 'cancelled');
      return;
    }
    if (decoded.type === CONTROL_TYPES.PAUSE) { remotePaused = true; await sendControl(CONTROL_TYPES.PAUSED); return; }
    if (decoded.type === CONTROL_TYPES.PAUSED) { localPauseState = 'paused'; return; }
    if (decoded.type === CONTROL_TYPES.RESUME) { remotePaused = false; await sendControl(CONTROL_TYPES.RESUMED); return; }
    if (decoded.type === CONTROL_TYPES.RESUMED) { localPauseState = 'running'; return; }

    if (state === 'closing') throw new Error('Control data after completion');

    if (config.role === 'sender') {
      if (decoded.type === CONTROL_TYPES.COMPLETE_ACK && state === 'awaiting-ack') {
        state = 'closing';
        clearTimer();
        if (!config.stream.writableEnded) config.stream.end();
        armTimeout('closing', config.closingTimeoutMs ?? DEFAULT_CLOSING_TIMEOUT_MS);
        return;
      }
      throw new Error(`Unexpected control for sender: ${decoded.type}`);
    } else {
      if (decoded.type === CONTROL_TYPES.START && state === 'awaiting-start') { state = 'receiving'; return; }
      if (decoded.type === CONTROL_TYPES.COMPLETE && state === 'receiving') {
        const completion = await config.chunkWriter!.complete();
        if (!completion.published) throw new Error('Chunk writer did not confirm publication');
        state = 'closing';
        await sendControl(CONTROL_TYPES.COMPLETE_ACK);
        if (!config.stream.writableEnded) config.stream.end();
        armTimeout('closing', config.closingTimeoutMs ?? DEFAULT_CLOSING_TIMEOUT_MS);
        return;
      }
      throw new Error(`Unexpected control for receiver: ${decoded.type}`);
    }
  }

  async function handleChunk(payload: Buffer): Promise<void> {
    if (config.role !== 'receiver') throw new Error('Sender received a chunk');
    if (state !== 'receiving') throw new Error(`Chunk out of order for state ${state}`);
    const frame = decodeChunkFrame(payload);
    if (frame.taskId !== config.taskId) throw new Error('Chunk taskId mismatch');
    const progress = await config.chunkWriter!.writeChunk({
      taskId: frame.taskId, path: frame.relativePath, offset: frame.offset, sequence: frame.sequence,
      plainLength: frame.plainLength, nonce: frame.nonce, authTag: frame.authTag, ciphertext: frame.ciphertext,
    } as unknown as ChunkFrameInput);
    const encoded = await config.encodeProgress(progress, { operation: 'encode', chunk: frame });
    await sendEnvelope(FRAME_KIND_PROGRESS, Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded));
    chunks += 1;
    ciphertextBytes += frame.ciphertext.length;
  }

  async function handleProgress(payload: Buffer): Promise<void> {
    if (config.role !== 'sender') throw new Error('Receiver received progress');
    if (state !== 'sending') throw new Error(`Progress out of order for state ${state}`);
    const decoded = await config.decodeProgress(Buffer.from(payload), { operation: 'decode' });
    await config.commitProgress(decoded, null);
  }

  async function runSender(): Promise<void> {
    state = 'sending';
    await sendControl(CONTROL_TYPES.START);
    if (state !== 'sending') return;
    const iterator = config.chunkReader![Symbol.asyncIterator]();
    while (true) {
      const step = await iterator.next();
      if (step.done) break;
      while (remotePaused || localPauseState !== 'running') { await new Promise<void>((r) => setTimeout(r, 50)); if (state !== 'sending') return; }
      const chunk = step.value as ChunkFrameInput;
      await sendEnvelope(FRAME_KIND_CHUNK, encodeChunkFrame(chunk));
      chunks += 1;
      ciphertextBytes += chunk.ciphertext.length;
    }
    state = 'awaiting-ack';
    await sendControl(CONTROL_TYPES.COMPLETE);
  }

  function makeControl(type: string): CoreControlMessage {
    return { type, protocol: 1, taskId: config.taskId, fromPeerId: config.localPeerId, toPeerId: config.remotePeerId, direction: config.role === 'sender' ? 'send' : 'receive' };
  }

  async function sendControl(type: string): Promise<void> {
    sendTail = sendTail.then(async () => {
      if (settled) return;
      const encoded = await config.encodeControl(makeControl(type), { operation: 'encode' });
      const payload = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
      await writeEnvelope(FRAME_KIND_CONTROL, payload);
    });
    await sendTail;
  }

  async function sendEnvelope(kind: number, payload: Buffer): Promise<void> {
    sendTail = sendTail.then(() => writeEnvelope(kind, payload));
    await sendTail;
  }

  async function writeEnvelope(kind: number, payload: Buffer): Promise<void> {
    const encoded = encodeStreamEnvelope(kind, payload);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Transfer stream write timed out')), config.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS);
      config.stream.write(encoded, (err) => { clearTimeout(timeout); if (err) reject(err); else resolve(); });
    });
  }

  function start(): Promise<TransferSessionState> {
    if (started) return done;
    started = true;
    state = 'handshaking';
    config.stream.on('data', onData);
    config.stream.once('error', onError);
    config.stream.once('close', onClose);
    config.stream.once('end', onEnd);
    armTimeout('handshake', config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    config.stream.resume();
    void sendControl(CONTROL_TYPES.HELLO).catch((error) => fail(error as Error, 'transfer-error'));
    return done;
  }

  function pause(): Promise<TransferSessionState> {
    if (localPauseState === 'paused') return Promise.resolve(getState());
    localPauseState = 'pausing';
    void sendControl(CONTROL_TYPES.PAUSE).catch((error) => fail(error as Error, 'transfer-error'));
    return Promise.resolve(getState());
  }

  function resume(): Promise<TransferSessionState> {
    if (localPauseState === 'running') return Promise.resolve(getState());
    localPauseState = 'resuming';
    void sendControl(CONTROL_TYPES.RESUME).catch((error) => fail(error as Error, 'transfer-error'));
    return Promise.resolve(getState());
  }

  function cancel(reason?: unknown): Promise<TransferSessionState> {
    if (TERMINAL_STATES.has(state)) return done;
    if (!started) start();
    if (state === 'cancelling') return done;
    state = 'cancelling';
    const error = new Error('Transfer stream was cancelled');
    error.name = 'AbortError';
    if (reason !== undefined) error.cause = reason;
    void sendControl(CONTROL_TYPES.CANCEL).catch(() => {}).finally(() => fail(error, 'cancelled'));
    return done;
  }

  return { start, pause, resume, cancel, getState, done };
}

export class StreamEnvelopeDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private kind: number | null = null;
  private finished = false;

  get bufferedBytes(): number { return this.pending.length; }

  async push(value: Uint8Array, onFrame: (kind: number, payload: Buffer) => Promise<void>): Promise<void> {
    if (this.finished) throw new Error('Transfer stream decoder is already finished');
    const input = Buffer.from(value);
    let cursor = 0;
    while (cursor < input.length) {
      const targetLength = this.expectedLength ?? MUX_PREFIX_BYTES;
      const needed = targetLength - this.pending.length;
      const take = Math.min(needed, input.length - cursor);
      this.pending = this.pending.length === 0 ? Buffer.from(input.subarray(cursor, cursor + take)) : Buffer.concat([this.pending, input.subarray(cursor, cursor + take)]);
      cursor += take;
      if (this.expectedLength === null && this.pending.length === MUX_PREFIX_BYTES) {
        const header = decodeStreamEnvelopeHeader(this.pending);
        this.kind = header.kind;
        this.expectedLength = MUX_PREFIX_BYTES + header.payloadLength;
      }
      if (this.expectedLength !== null && this.pending.length === this.expectedLength) {
        const kind = this.kind!;
        const payload = Buffer.from(this.pending.subarray(MUX_PREFIX_BYTES));
        this.pending = Buffer.alloc(0);
        this.expectedLength = null;
        this.kind = null;
        await onFrame(kind, payload);
      }
    }
  }

  finish(): void {
    if (this.finished) throw new Error('Transfer stream decoder is already finished');
    this.finished = true;
    if (this.pending.length !== 0) throw new Error(`Transfer stream ended with a truncated frame (${this.pending.length} bytes)`);
  }
}

export function encodeStreamEnvelope(kind: number, payload: Buffer): Buffer {
  const encoded = Buffer.allocUnsafe(MUX_PREFIX_BYTES + payload.length);
  MUX_MAGIC.copy(encoded, 0);
  encoded.writeUInt8(MUX_VERSION, 8);
  encoded.writeUInt8(kind, 9);
  encoded.writeUInt16BE(0, 10);
  encoded.writeUInt32BE(payload.length, 12);
  payload.copy(encoded, MUX_PREFIX_BYTES);
  return encoded;
}

function decodeStreamEnvelopeHeader(prefix: Buffer): { kind: number; payloadLength: number } {
  if (!prefix.subarray(0, MUX_MAGIC.length).equals(MUX_MAGIC)) throw new Error('Transfer stream multiplexing magic is invalid');
  if (prefix.readUInt8(8) !== MUX_VERSION) throw new Error('Transfer stream multiplexing version is unsupported');
  const kind = prefix.readUInt8(9);
  if (prefix.readUInt16BE(10) !== 0) throw new Error('Transfer stream multiplexing flags must be zero');
  const payloadLength = prefix.readUInt32BE(12);
  const limit = kind === FRAME_KIND_CONTROL ? MAX_ENCODED_BYTES : kind === FRAME_KIND_CHUNK ? MAX_FRAME_BYTES : kind === FRAME_KIND_PROGRESS ? MAX_CONTROL_MESSAGE_BYTES : 0;
  if (limit === 0) throw new Error('Transfer stream frame kind is invalid');
  if (payloadLength <= 0 || payloadLength > limit) throw new RangeError(`Transfer stream payload length exceeds kind-${kind} bound`);
  return { kind, payloadLength };
}
