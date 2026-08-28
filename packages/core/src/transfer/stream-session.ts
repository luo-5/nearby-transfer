/**
 * Run one authenticated transfer over a Node Duplex/Socket.
 * Ported from src/v2/transfer-stream-session.js.
 *
 * The session intentionally does not know the concrete control-message codec or
 * signature format. encodeControl, decodeControl, verifyControl, encodeProgress,
 * decodeProgress, and commitProgress are injected so this transport can evolve
 * independently from the signed control codec.
 * One session carries exactly one task in exactly one negotiated direction.
 */

import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';
import { MAX_ENCODED_BYTES as MAX_CONTROL_FRAME_BYTES, type CoreControlMessage } from './control.js';
import { MAX_CONTROL_MESSAGE_BYTES as MAX_PROGRESS_FRAME_BYTES } from './message-codec.js';
import {
  MAX_FRAME_BYTES as MAX_CHUNK_FRAME_BYTES,
  decodeFrame as decodeChunkFrame,
  encodeFrame as encodeChunkFrame,
  type ChunkFrameInput,
  type ChunkFrame,
} from './chunk-frame.js';
import { assertValidTaskId } from './manifest.js';

export const MUX_MAGIC = Buffer.from('NTV2MUX1', 'ascii');
export const MUX_VERSION = 1;
export const MUX_PREFIX_BYTES = 16;
export const MUX_FLAGS = 0;
export const FRAME_KIND_CONTROL = 1;
export const FRAME_KIND_CHUNK = 2;
export const FRAME_KIND_PROGRESS = 3;
const MAX_PEER_ID_BYTES = 128;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_WRITE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 1000;
const DEFAULT_PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CLOSING_TIMEOUT_MS = 10 * 1000;
const CONTROL_PROTOCOL = 1;

export const CONTROL_TYPES = Object.freeze({
  HELLO: 'stream-hello',
  START: 'stream-start',
  PAUSE: 'stream-pause',
  PAUSED: 'stream-paused',
  RESUME: 'stream-resume',
  RESUMED: 'stream-resumed',
  COMPLETE: 'stream-complete',
  COMPLETE_ACK: 'stream-complete-ack',
  CANCEL: 'stream-cancel',
});

const CANCEL_CODES: Set<string> = new Set(['cancelled', 'timeout', 'protocol-error', 'transfer-error']);
const TERMINAL_STATES: Set<string> = new Set(['completed', 'cancelled', 'failed']);
const INPUT_KEYS: Set<string> = new Set([
  'chunkReader',
  'chunkWriter',
  'commitProgress',
  'decodeControl',
  'decodeProgress',
  'encodeControl',
  'encodeProgress',
  'closingTimeoutMs',
  'handshakeTimeoutMs',
  'idleTimeoutMs',
  'localPeerId',
  'remotePeerId',
  'role',
  'signal',
  'stream',
  'taskId',
  'operationTimeoutMs',
  'pauseTimeoutMs',
  'verifyControl',
  'writeTimeoutMs',
]);

export interface ChunkWriterLike {
  writeChunk(chunk: ChunkFrameInput): Promise<unknown>;
  complete(): Promise<{ published: boolean }>;
  cancel(): Promise<unknown>;
  getCommittedProgress?(): unknown;
}

export interface ChunkReaderLike {
  [Symbol.asyncIterator](): AsyncIterator<ChunkFrameInput>;
  return?(): Promise<unknown>;
}

export interface TransferStreamSessionInput {
  stream: Duplex | any;
  role: 'sender' | 'receiver';
  taskId: string;
  localPeerId: string;
  remotePeerId: string;
  encodeControl: (message: CoreControlMessage, context: { operation: string; role: string; taskId: string; localPeerId: string; remotePeerId: string }) => Promise<Uint8Array> | Uint8Array;
  decodeControl: (payload: Buffer, context: { operation: string; role: string; taskId: string; localPeerId: string; remotePeerId: string }) => Promise<CoreControlMessage> | CoreControlMessage;
  verifyControl: (decoded: CoreControlMessage, context: { operation: string; role: string; taskId: string; localPeerId: string; remotePeerId: string }) => Promise<boolean> | boolean;
  encodeProgress: (progress: unknown, context: { operation: string; role: string; taskId: string; localPeerId: string; remotePeerId: string; chunk: { path: string; offset: number; sequence: number; plainLength: number } }) => Promise<Uint8Array> | Uint8Array;
  decodeProgress: (payload: Buffer, context: { operation: string; role: string; taskId: string; localPeerId: string; remotePeerId: string; chunk: { path: string; offset: number; sequence: number; plainLength: number } }) => Promise<unknown> | unknown;
  commitProgress: (progress: unknown, chunk: { path: string; offset: number; sequence: number; plainLength: number }) => Promise<void> | void;
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

interface NormalizedConfig {
  stream: Duplex;
  role: 'sender' | 'receiver';
  taskId: string;
  localPeerId: string;
  remotePeerId: string;
  encodeControl: TransferStreamSessionInput['encodeControl'];
  decodeControl: TransferStreamSessionInput['decodeControl'];
  verifyControl: TransferStreamSessionInput['verifyControl'];
  encodeProgress: TransferStreamSessionInput['encodeProgress'];
  decodeProgress: TransferStreamSessionInput['decodeProgress'];
  commitProgress: TransferStreamSessionInput['commitProgress'];
  chunkReader?: ChunkReaderLike;
  chunkWriter?: ChunkWriterLike;
  signal: AbortSignal | null;
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
  writeTimeoutMs: number;
  operationTimeoutMs: number;
  pauseTimeoutMs: number;
  closingTimeoutMs: number;
}

interface DeferredSignal {
  promise: Promise<void>;
  resolve: () => void;
}

interface DeferredCommand<T> {
  kind: string;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface DeferredProgress {
  chunk: ChunkFrameInput;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class TransferStreamSession {
  private _config: NormalizedConfig;
  private _state: string;
  private _started: boolean;
  private _settled: boolean;
  private _failureStarted: boolean;
  private _remoteHello: boolean;
  private _sendStarted: boolean;
  private _readableEnded: boolean;
  private _localPauseState: string;
  private _remotePaused: boolean;
  private _flowWaiter: DeferredSignal | null;
  private _flowCommand: DeferredCommand<TransferSessionState> | null;
  private _progressWaiter: DeferredProgress | null;
  private _chunks: number;
  private _ciphertextBytes: number;
  private _decoder: StreamEnvelopeDecoder;
  private _sendTail: Promise<unknown>;
  private _incomingTail: Promise<unknown>;
  private _readerStopped: boolean;
  private _readerIterator: AsyncIterator<ChunkFrameInput> | null;
  private _writerStopped: boolean;
  private _timer: NodeJS.Timeout | null;
  private _timerKind: string | null;
  private _resolve: ((state: TransferSessionState) => void) | null;
  private _reject: ((error: unknown) => void) | null;
  private _done: Promise<TransferSessionState>;
  private _onData: (chunk: unknown) => void;
  private _onEnd: () => void;
  private _onClose: () => void;
  private _onError: (error: unknown) => void;
  private _onAbort: () => void;

  constructor(config: NormalizedConfig) {
    this._config = config;
    this._state = 'created';
    this._started = false;
    this._settled = false;
    this._failureStarted = false;
    this._remoteHello = false;
    this._sendStarted = false;
    this._readableEnded = false;
    this._localPauseState = 'running';
    this._remotePaused = false;
    this._flowWaiter = null;
    this._flowCommand = null;
    this._progressWaiter = null;
    this._chunks = 0;
    this._ciphertextBytes = 0;
    this._decoder = new StreamEnvelopeDecoder();
    this._sendTail = Promise.resolve();
    this._incomingTail = Promise.resolve();
    this._readerStopped = false;
    this._readerIterator = null;
    this._writerStopped = false;
    this._timer = null;
    this._timerKind = null;
    this._resolve = null;
    this._reject = null;
    this._done = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this._done.catch(() => {});

    this._onData = (chunk) => this._acceptTransportData(chunk);
    this._onEnd = () => this._acceptTransportEnd();
    this._onClose = () => this._acceptTransportClose();
    this._onError = (error) => this._fail(error, 'transfer-error');
    this._onAbort = () => {
      void this.cancel(this._config.signal && (this._config.signal as unknown as { reason: unknown }).reason);
    };
  }

  get done(): Promise<TransferSessionState> {
    return this._done;
  }

  start(): Promise<TransferSessionState> {
    if (this._started) return this._done;
    this._started = true;
    this._state = 'handshaking';
    this._attachTransport();
    this._armTimeout('handshake', this._config.handshakeTimeoutMs);
    if (this._config.signal) {
      this._config.signal.addEventListener('abort', this._onAbort, { once: true });
      if (this._config.signal.aborted) {
        void this.cancel((this._config.signal as unknown as { reason: unknown }).reason);
        return this._done;
      }
    }

    this._config.stream.resume();
    void this._sendControl(this._makeControl(CONTROL_TYPES.HELLO)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return this._done;
  }

  pause(): Promise<TransferSessionState> {
    if (!this._started) throw new Error('Transfer stream must be started before it can be paused');
    if (this._localPauseState === 'paused') return Promise.resolve(this.getState());
    if (this._flowCommand && this._flowCommand.kind === 'pause') return this._flowCommand.promise;
    this._assertFlowCommandState('pause');

    const command = createDeferredCommand<TransferSessionState>('pause');
    this._flowCommand = command;
    this._localPauseState = 'pausing';
    this._wakeFlowWaiter();
    this._refreshIdleTimeout();
    void this._sendControl(this._makeControl(CONTROL_TYPES.PAUSE)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return command.promise;
  }

  resume(): Promise<TransferSessionState> {
    if (this._localPauseState === 'running') return Promise.resolve(this.getState());
    if (this._flowCommand && this._flowCommand.kind === 'resume') return this._flowCommand.promise;
    if (this._localPauseState !== 'paused' || this._flowCommand) {
      throw new Error('Transfer stream cannot resume before pause acknowledgement');
    }
    this._assertFlowCommandState('resume');

    const command = createDeferredCommand<TransferSessionState>('resume');
    this._flowCommand = command;
    this._localPauseState = 'resuming';
    this._refreshIdleTimeout();
    void this._sendControl(this._makeControl(CONTROL_TYPES.RESUME)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return command.promise;
  }

  cancel(reason?: unknown): Promise<TransferSessionState> {
    if (TERMINAL_STATES.has(this._state)) return this._done;
    if (!this._started) void this.start();
    if (this._state === 'cancelling') return this._done;

    this._state = 'cancelling';
    const error = createAbortError(reason);
    this._beginFailureSettlement(error, 'cancelled', 'cancelled', true);
    return this._done;
  }

  getState(): TransferSessionState {
    return Object.freeze({
      state: this._state,
      role: this._config.role,
      taskId: this._config.taskId,
      peerId: this._config.remotePeerId,
      chunks: this._chunks,
      ciphertextBytes: this._ciphertextBytes,
      paused: this._isFlowPaused(),
      localPauseState: this._localPauseState,
      remotePaused: this._remotePaused,
    });
  }

  private _attachTransport(): void {
    const stream = this._config.stream;
    stream.on('data', this._onData);
    stream.once('end', this._onEnd);
    stream.once('close', this._onClose);
    stream.on('error', this._onError);
  }

  private _detachTransport(): void {
    const stream = this._config.stream;
    stream.removeListener('data', this._onData);
    stream.removeListener('end', this._onEnd);
    stream.removeListener('close', this._onClose);
    stream.removeListener('error', this._onError);
    if (this._config.signal) this._config.signal.removeEventListener('abort', this._onAbort);
  }

  private _acceptTransportData(value: unknown): void {
    if (this._settled) return;
    const chunk = requireBytes(value, 'Transfer stream input');
    this._config.stream.pause();
    this._incomingTail = this._incomingTail
      .then(async () => {
        if (this._settled) return;
        await this._decoder.push(chunk, async (kind, payload) => {
          this._touchIdleTimeout();
          if (kind === FRAME_KIND_CONTROL) {
            await this._handleControlPayload(payload);
          } else if (kind === FRAME_KIND_CHUNK) {
            await this._handleChunkPayload(payload);
          } else {
            await this._handleProgressPayload(payload);
          }
        });
      })
      .then(() => {
        if (!this._settled && !this._readableEnded) this._config.stream.resume();
      })
      .catch((error) => this._fail(error, 'protocol-error'));
  }

  private _acceptTransportEnd(): void {
    this._readableEnded = true;
    this._incomingTail = this._incomingTail
      .then(() => this._decoder.finish())
      .then(() => {
        if (this._settled) return;
        if (this._state !== 'closing') {
          throw new Error(`Transfer stream ended before protocol completion while ${this._state}`);
        }
        this._settleSuccess();
      })
      .catch((error) => this._fail(error, 'protocol-error'));
  }

  private _acceptTransportClose(): void {
    if (this._settled) return;
    if (!this._readableEnded) {
      this._fail(new Error(`Transfer stream closed before EOF while ${this._state}`), 'transfer-error');
    }
  }

  private async _handleControlPayload(payload: Buffer): Promise<void> {
    const decoded = await this._runOperation(
      () => this._config.decodeControl(Buffer.from(payload), this._controlContext('decode')),
      'Transfer control decoding',
    );
    const message = inspectControlMessage(decoded);
    const verified = await this._runOperation(
      () => this._config.verifyControl(decoded, this._controlContext('verify')),
      'Transfer control verification',
    );
    if (verified !== true) throw new Error('Transfer control message signature or trust verification failed');
    this._assertControlBinding(message);

    if (message.type === CONTROL_TYPES.CANCEL) {
      if (!CANCEL_CODES.has(message.code!)) throw new TypeError('Transfer cancellation code is invalid');
      const error = createAbortError(new Error(`Remote transfer cancelled: ${message.code}`));
      this._beginFailureSettlement(error, 'cancelled', message.code!, false);
      return;
    }

    if (message.type === CONTROL_TYPES.HELLO) {
      await this._handleHello(message);
      return;
    }
    if (!this._remoteHello) throw new Error('Transfer control message arrived before the authenticated hello');

    if (message.type === CONTROL_TYPES.PAUSE || message.type === CONTROL_TYPES.PAUSED ||
        message.type === CONTROL_TYPES.RESUME || message.type === CONTROL_TYPES.RESUMED) {
      await this._handleFlowControl(message);
      return;
    }

    if (this._state === 'closing') {
      throw new Error('Control data received after transfer completion');
    }

    if (this._config.role === 'sender') {
      await this._handleSenderControl(message);
    } else {
      await this._handleReceiverControl(message);
    }
  }

  private async _handleHello(message: CoreControlMessage): Promise<void> {
    if (this._state !== 'handshaking' || this._remoteHello) {
      throw new Error('Transfer hello is duplicated or out of order');
    }
    const expectedDirection = this._config.role === 'sender' ? 'receive' : 'send';
    if (message.direction !== expectedDirection) {
      throw new Error('Transfer hello direction conflicts with the local role');
    }
    this._remoteHello = true;
    this._clearTimeout();
    this._armTimeout('idle', this._config.idleTimeoutMs);

    if (this._config.role === 'sender') {
      this._state = 'starting';
      void this._runSender().catch((error) => this._fail(error, 'transfer-error'));
    } else {
      this._state = 'awaiting-start';
    }
  }

  private async _handleFlowControl(message: CoreControlMessage): Promise<void> {
    if (this._state === 'closing') return;

    if (this._state === 'awaiting-ack') {
      if (message.type === CONTROL_TYPES.PAUSE) {
        await this._sendControl(this._makeControl(CONTROL_TYPES.PAUSED));
      } else if (message.type === CONTROL_TYPES.RESUME) {
        await this._sendControl(this._makeControl(CONTROL_TYPES.RESUMED));
      } else {
        this._acceptLateFlowAcknowledgement(message);
      }
      return;
    }

    if (!this._isActiveTransferState()) {
      throw new Error(`Flow-control message ${message.type} is out of order for state ${this._state}`);
    }

    if (message.type === CONTROL_TYPES.PAUSE) {
      if (this._remotePaused) throw new Error('Remote transfer pause is duplicated');
      this._remotePaused = true;
      this._refreshIdleTimeout();
      await this._sendControl(this._makeControl(CONTROL_TYPES.PAUSED));
      return;
    }

    if (message.type === CONTROL_TYPES.PAUSED) {
      if (this._localPauseState !== 'pausing' || !this._flowCommand || this._flowCommand.kind !== 'pause') {
        throw new Error('Transfer pause acknowledgement is unsolicited or duplicated');
      }
      this._localPauseState = 'paused';
      const command = this._flowCommand;
      this._flowCommand = null;
      this._refreshIdleTimeout();
      command.resolve(this.getState());
      return;
    }

    if (message.type === CONTROL_TYPES.RESUME) {
      if (!this._remotePaused) throw new Error('Remote transfer resume is unsolicited or duplicated');
      this._remotePaused = false;
      this._wakeFlowWaiter();
      this._refreshIdleTimeout();
      await this._sendControl(this._makeControl(CONTROL_TYPES.RESUMED));
      return;
    }

    if (this._localPauseState !== 'resuming' || !this._flowCommand || this._flowCommand.kind !== 'resume') {
      throw new Error('Transfer resume acknowledgement is unsolicited or duplicated');
    }
    this._localPauseState = 'running';
    const command = this._flowCommand;
    this._flowCommand = null;
    this._wakeFlowWaiter();
    this._refreshIdleTimeout();
    command.resolve(this.getState());
  }

  private _assertFlowCommandState(operation: string): void {
    if (this._settled || this._failureStarted || this._state === 'cancelling' || !this._isActiveTransferState()) {
      throw new Error(`Transfer stream cannot ${operation} while ${this._state}`);
    }
  }

  private _isActiveTransferState(): boolean {
    return this._state === 'sending' || this._state === 'receiving';
  }

  private _isFlowPaused(): boolean {
    return this._remotePaused || this._localPauseState !== 'running';
  }

  private async _waitUntilFlowing(): Promise<void> {
    while (this._config.role === 'sender' && this._isFlowPaused()) {
      if (this._settled || this._failureStarted || this._state !== 'sending') throw createAbortError();
      if (!this._flowWaiter) this._flowWaiter = createDeferredSignal();
      await this._flowWaiter.promise;
    }
  }

  private _wakeFlowWaiter(): void {
    if (!this._flowWaiter) return;
    const waiter = this._flowWaiter;
    this._flowWaiter = null;
    waiter.resolve();
  }

  private _refreshIdleTimeout(): void {
    if (this._settled || !this._remoteHello || !this._isActiveTransferState()) return;
    if (this._isFlowPaused()) this._armTimeout('pause', this._config.pauseTimeoutMs);
    else this._armTimeout('idle', this._config.idleTimeoutMs);
  }

  private _acceptLateFlowAcknowledgement(message: CoreControlMessage): void {
    const isPause = message.type === CONTROL_TYPES.PAUSED;
    const expectedState = isPause ? 'pausing' : 'resuming';
    const expectedKind = isPause ? 'pause' : 'resume';
    if (this._localPauseState !== expectedState || !this._flowCommand || this._flowCommand.kind !== expectedKind) {
      return;
    }
    this._localPauseState = isPause ? 'paused' : 'running';
    const command = this._flowCommand;
    this._flowCommand = null;
    command.resolve(this.getState());
  }

  private _enterClosing(): void {
    this._settleFlowCommand(new Error('Transfer completed while a flow-control command was pending'));
    this._localPauseState = 'running';
    this._remotePaused = false;
    this._wakeFlowWaiter();
    this._state = 'closing';
    this._clearTimeout();
  }

  private _finishLocalClosing(): void {
    this._endWritable();
    if (this._settled || this._state !== 'closing' || this._readableEnded) return;
    this._armTimeout('closing', this._config.closingTimeoutMs);
  }

  private async _handleSenderControl(message: CoreControlMessage): Promise<void> {
    if (message.type !== CONTROL_TYPES.COMPLETE_ACK || this._state !== 'awaiting-ack') {
      throw new Error(`Control message ${message.type} is out of order for sender state ${this._state}`);
    }
    if (message.direction !== 'receive') throw new Error('Completion acknowledgement direction is invalid');
    this._enterClosing();
    await this._sendTail;
    this._finishLocalClosing();
  }

  private async _handleReceiverControl(message: CoreControlMessage): Promise<void> {
    if (message.type === CONTROL_TYPES.START) {
      if (this._state !== 'awaiting-start' || message.direction !== 'send') {
        throw new Error('Transfer start is duplicated, directionally invalid, or out of order');
      }
      this._state = 'receiving';
      return;
    }

    if (message.type === CONTROL_TYPES.COMPLETE) {
      if (this._state !== 'receiving' || message.direction !== 'send') {
        throw new Error('Transfer completion is directionally invalid or out of order');
      }
      const completion = await this._runOperation(
        () => this._config.chunkWriter!.complete(),
        'Encrypted chunk writer completion',
      );
      assertSafeWriterCompletion(completion);
      this._writerStopped = true;
      this._enterClosing();
      await this._sendControl(this._makeControl(CONTROL_TYPES.COMPLETE_ACK));
      await this._sendTail;
      this._finishLocalClosing();
      return;
    }

    throw new Error(`Control message ${message.type} is out of order for receiver state ${this._state}`);
  }

  private async _handleChunkPayload(payload: Buffer): Promise<void> {
    if (this._config.role !== 'receiver') {
      throw new Error('Sender received a transfer chunk on the bound receive direction');
    }
    if (this._state !== 'receiving') {
      throw new Error(`Transfer chunk is out of order for receiver state ${this._state}`);
    }
    const frame = decodeChunkFrame(payload);
    if (frame.taskId !== this._config.taskId) {
      throw new Error('Transfer chunk taskId does not match the authenticated session');
    }
    const progress = await this._runOperation(
      () => this._config.chunkWriter!.writeChunk(Object.freeze({
        taskId: frame.taskId,
        relativePath: frame.relativePath,
        path: frame.relativePath,
        offset: frame.offset,
        sequence: frame.sequence,
        plainLength: frame.plainLength,
        nonce: frame.nonce,
        authTag: frame.authTag,
        ciphertext: frame.ciphertext,
      })),
      'Encrypted chunk writer write',
    );
    const encodedProgress = await this._runOperation(
      () => this._config.encodeProgress(progress, this._progressContext('encode', frame)),
      'Transfer progress encoding',
    );
    await this._sendEnvelope(
      FRAME_KIND_PROGRESS,
      requireBytes(encodedProgress, 'Encoded transfer progress'),
    );
    this._chunks += 1;
    this._ciphertextBytes += frame.ciphertext.length;
  }

  private async _handleProgressPayload(payload: Buffer): Promise<void> {
    if (this._config.role !== 'sender') {
      throw new Error('Receiver received a transfer progress acknowledgement on the bound send direction');
    }
    if (this._state !== 'sending' || !this._progressWaiter) {
      throw new Error(`Transfer progress acknowledgement is unsolicited or out of order for sender state ${this._state}`);
    }
    const waiter = this._progressWaiter;
    const decoded = await this._runOperation(
      () => this._config.decodeProgress(Buffer.from(payload), this._progressContext('decode', waiter.chunk)),
      'Transfer progress decoding',
    );
    await this._runOperation(
      () => this._config.commitProgress(decoded, {
        path: waiter.chunk.relativePath ?? waiter.chunk.path ?? '',
        offset: waiter.chunk.offset,
        sequence: waiter.chunk.sequence,
        plainLength: waiter.chunk.plainLength,
      }),
      'Transfer progress persistence',
    );
    if (this._progressWaiter !== waiter) {
      throw new Error('Transfer progress acknowledgement changed while it was being persisted');
    }
    this._progressWaiter = null;
    waiter.resolve(decoded);
  }

  private async _runSender(): Promise<void> {
    if (this._sendStarted) throw new Error('Transfer sender was started more than once');
    this._sendStarted = true;
    this._state = 'sending';
    await this._sendControl(this._makeControl(CONTROL_TYPES.START));
    if (this._state !== 'sending') return;

    const iterator = this._config.chunkReader![Symbol.asyncIterator]();
    this._readerIterator = iterator;
    while (true) {
      const step = await this._runOperation(() => iterator.next(), 'Encrypted chunk reader next');
      if (!step || typeof step !== 'object' || typeof step.done !== 'boolean') {
        throw new TypeError('Encrypted chunk reader returned an invalid iterator result');
      }
      if (step.done) break;
      await this._waitUntilFlowing();
      if (this._state !== 'sending') throw createAbortError();
      const normalized = normalizeReaderChunk(step.value, this._config.taskId);
      if (this._progressWaiter) throw new Error('Transfer sender has more than one unacknowledged chunk');
      const progressWaiter = createDeferredProgress(normalized);
      this._progressWaiter = progressWaiter;
      try {
        await this._sendEnvelope(FRAME_KIND_CHUNK, encodeChunkFrame(normalized));
        await progressWaiter.promise;
      } finally {
        if (this._progressWaiter === progressWaiter) this._progressWaiter = null;
      }
      this._chunks += 1;
      this._ciphertextBytes += normalized.ciphertext.length;
    }
    this._readerStopped = true;
    await this._waitUntilFlowing();
    if (this._state !== 'sending') return;
    this._state = 'awaiting-ack';
    await this._sendControl(this._makeControl(CONTROL_TYPES.COMPLETE));
  }

  private _makeControl(type: string, extra: Record<string, unknown> | null = null): CoreControlMessage {
    const direction = this._config.role === 'sender' ? 'send' : 'receive';
    return Object.freeze({
      type,
      protocol: CONTROL_PROTOCOL,
      taskId: this._config.taskId,
      fromPeerId: this._config.localPeerId,
      toPeerId: this._config.remotePeerId,
      direction,
      ...(extra || {}),
    });
  }

  private _progressContext(operation: string, chunk: { path?: string; relativePath?: string; offset: number; sequence: number; plainLength: number }) {
    return Object.freeze({
      operation,
      role: this._config.role,
      taskId: this._config.taskId,
      localPeerId: this._config.localPeerId,
      remotePeerId: this._config.remotePeerId,
      chunk: Object.freeze({
        path: chunk.relativePath || chunk.path || '',
        offset: chunk.offset,
        sequence: chunk.sequence,
        plainLength: chunk.plainLength,
      }),
    });
  }

  private _assertControlBinding(message: CoreControlMessage): void {
    if (message.protocol !== CONTROL_PROTOCOL) throw new Error('Transfer control protocol version is unsupported');
    if (message.taskId !== this._config.taskId) throw new Error('Transfer control taskId does not match this session');
    if (message.fromPeerId !== this._config.remotePeerId || message.toPeerId !== this._config.localPeerId) {
      throw new Error('Transfer control peer binding does not match this connection');
    }
    const expectedDirection = this._config.role === 'sender' ? 'receive' : 'send';
    if (message.direction !== expectedDirection) {
      throw new Error('Transfer control direction does not match the authenticated peer role');
    }
  }

  private _controlContext(operation: string) {
    return Object.freeze({
      operation,
      role: this._config.role,
      taskId: this._config.taskId,
      localPeerId: this._config.localPeerId,
      remotePeerId: this._config.remotePeerId,
    });
  }

  private _sendControl(message: CoreControlMessage, allowCancelling = false, allowSettled = false): Promise<unknown> {
    return this._enqueueSend(async () => {
      if ((!allowSettled && this._settled) || (this._state === 'cancelling' && !allowCancelling)) {
        throw new Error('Cannot send control data after session termination');
      }
      const encoded = await this._runOperation(
        () => this._config.encodeControl(message, this._controlContext('encode')),
        'Transfer control encoding',
      );
      const payload = requireBytes(encoded, 'Encoded transfer control frame');
      if (payload.length === 0 || payload.length > MAX_CONTROL_FRAME_BYTES) {
        throw new RangeError('Encoded transfer control frame exceeds the bounded wire-frame size');
      }
      await this._writeEnvelope(FRAME_KIND_CONTROL, payload);
    });
  }

  private _sendEnvelope(kind: number, payload: Buffer): Promise<unknown> {
    return this._enqueueSend(() => this._writeEnvelope(kind, payload));
  }

  private _enqueueSend(operation: () => Promise<void>): Promise<unknown> {
    const pending = this._sendTail.then(operation);
    this._sendTail = pending.catch(() => {});
    return pending;
  }

  private async _writeEnvelope(kind: number, payload: Buffer): Promise<void> {
    const encoded = encodeStreamEnvelope(kind, payload);
    await writeWithBackpressure(this._config.stream, encoded, this._config.writeTimeoutMs);
    this._touchIdleTimeout();
  }

  private _touchIdleTimeout(): void {
    if (this._settled || this._isFlowPaused() || this._timerKind !== 'idle') return;
    this._armTimeout('idle', this._config.idleTimeoutMs);
  }

  private _armTimeout(kind: string, milliseconds: number): void {
    this._clearTimeout();
    this._timerKind = kind;
    this._timer = setTimeout(() => {
      const error = new Error(`Transfer ${kind} timed out`);
      error.name = 'TimeoutError';
      this._fail(error, 'timeout');
    }, milliseconds);
  }

  private _clearTimeout(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._timerKind = null;
  }

  private _runOperation<T>(operation: () => Promise<T> | T, subject: string): Promise<T> {
    return runWithTimeout(operation, this._config.operationTimeoutMs, subject);
  }

  private _endWritable(): void {
    const stream = this._config.stream as unknown as { destroyed?: boolean; writableEnded?: boolean; end: () => void };
    if (!stream.destroyed && !stream.writableEnded) stream.end();
  }

  private _fail(error: unknown, code: string): void {
    if (this._settled || this._failureStarted || this._state === 'cancelling') return;
    const previousState = this._state;
    this._state = 'failing';
    this._beginFailureSettlement(
      normalizeError(error),
      code === 'cancelled' ? 'cancelled' : 'failed',
      code,
      !['created', 'closing'].includes(previousState),
    );
  }

  private _beginFailureSettlement(error: Error, state: string, code: string, notifyPeer: boolean): void {
    if (this._settled || this._failureStarted) return;
    this._failureStarted = true;
    this._clearTimeout();
    this._settleProgressWaiter(error);
    const cleanup: Array<Promise<unknown>> = [this._stopTransferResources()];
    if (notifyPeer) {
      cleanup.push(this._runOperation(
        () => this._sendControl(this._makeControl(CONTROL_TYPES.CANCEL, { code }), true, true),
        'Transfer cancellation notification',
      ));
    }
    this._settleFailure(error, state, false);
    void Promise.allSettled(cleanup).then(() => {
      const stream = this._config.stream as unknown as { destroyed?: boolean; destroy: () => void };
      if (!stream.destroyed) stream.destroy();
    });
  }

  private async _stopTransferResources(): Promise<void> {
    this._wakeFlowWaiter();
    if (this._config.role === 'sender' && !this._readerStopped) {
      this._readerStopped = true;
      const reader = this._readerIterator || this._config.chunkReader;
      if (reader && typeof reader.return === 'function') {
        try {
          await this._runOperation(() => reader.return!(), 'Encrypted chunk reader cleanup');
        } catch (_) { /* preserve the primary error */ }
      }
    }
    if (this._config.role === 'receiver' && !this._writerStopped) {
      this._writerStopped = true;
      try {
        await this._runOperation(() => this._config.chunkWriter!.cancel(), 'Encrypted chunk writer cleanup');
      } catch (_) { /* preserve the primary error */ }
    }
  }

  private _settleSuccess(): void {
    if (this._settled) return;
    this._settleFlowCommand(new Error('Transfer completed while a flow-control command was pending'));
    this._settleProgressWaiter(new Error('Transfer completed while progress acknowledgement was pending'));
    this._wakeFlowWaiter();
    this._settled = true;
    this._state = 'completed';
    this._clearTimeout();
    this._detachTransport();
    this._resolve!(this.getState());
  }

  private _settleFailure(error: Error, state: string, destroyTransport: boolean): void {
    if (this._settled) return;
    this._settleFlowCommand(error);
    this._settleProgressWaiter(error);
    this._wakeFlowWaiter();
    this._settled = true;
    this._state = state;
    this._clearTimeout();
    this._detachTransport();
    const stream = this._config.stream as unknown as { destroyed?: boolean; destroy: () => void };
    if (destroyTransport && !stream.destroyed) stream.destroy();
    this._reject!(error);
  }

  private _settleFlowCommand(error: Error): void {
    if (!this._flowCommand) return;
    const command = this._flowCommand;
    this._flowCommand = null;
    command.reject(error);
  }

  private _settleProgressWaiter(error: Error): void {
    if (!this._progressWaiter) return;
    const waiter = this._progressWaiter;
    this._progressWaiter = null;
    waiter.reject(error);
  }
}

export function createTransferStreamSession(input: TransferStreamSessionInput): TransferStreamSession {
  return new TransferStreamSession(normalizeInput(input));
}

export class StreamEnvelopeDecoder {
  private _pending: Buffer;
  private _expectedLength: number | null;
  private _kind: number | null;
  private _finished: boolean;

  constructor() {
    this._pending = Buffer.alloc(0);
    this._expectedLength = null;
    this._kind = null;
    this._finished = false;
  }

  get bufferedBytes(): number {
    return this._pending.length;
  }

  async push(value: unknown, onFrame: (kind: number, payload: Buffer) => Promise<void>): Promise<void> {
    if (this._finished) throw new Error('Transfer stream decoder is already finished');
    if (typeof onFrame !== 'function') throw new TypeError('Transfer stream decoder requires a frame callback');
    const input = requireBytes(value, 'Transfer stream decoder input');
    let cursor = 0;

    while (cursor < input.length) {
      const targetLength = this._expectedLength === null ? MUX_PREFIX_BYTES : this._expectedLength;
      const needed = targetLength - this._pending.length;
      const take = Math.min(needed, input.length - cursor);
      this._pending = appendBounded(this._pending, input.subarray(cursor, cursor + take), targetLength);
      cursor += take;

      if (this._expectedLength === null && this._pending.length === MUX_PREFIX_BYTES) {
        const header = decodeStreamEnvelopeHeader(this._pending);
        this._kind = header.kind;
        this._expectedLength = MUX_PREFIX_BYTES + header.payloadLength;
      }

      if (this._expectedLength !== null && this._pending.length === this._expectedLength) {
        const kind = this._kind!;
        const payload = Buffer.from(this._pending.subarray(MUX_PREFIX_BYTES));
        this._pending = Buffer.alloc(0);
        this._expectedLength = null;
        this._kind = null;
        await onFrame(kind, payload);
      }
    }
  }

  finish(): void {
    if (this._finished) throw new Error('Transfer stream decoder is already finished');
    this._finished = true;
    if (this._pending.length !== 0) {
      const buffered = this._pending.length;
      this._pending = Buffer.alloc(0);
      throw new Error(`Transfer stream ended with a truncated multiplexed frame (${buffered} buffered byte(s))`);
    }
  }
}

export function encodeStreamEnvelope(kind: number, value: unknown): Buffer {
  const payload = requireBytes(value, 'Transfer stream envelope payload');
  assertEnvelopeLength(kind, payload.length);
  const encoded = Buffer.allocUnsafe(MUX_PREFIX_BYTES + payload.length);
  MUX_MAGIC.copy(encoded, 0);
  encoded.writeUInt8(MUX_VERSION, 8);
  encoded.writeUInt8(kind, 9);
  encoded.writeUInt16BE(MUX_FLAGS, 10);
  encoded.writeUInt32BE(payload.length, 12);
  payload.copy(encoded, MUX_PREFIX_BYTES);
  return encoded;
}

function decodeStreamEnvelopeHeader(prefix: Buffer): { kind: number; payloadLength: number } {
  if (!prefix.subarray(0, MUX_MAGIC.length).equals(MUX_MAGIC)) {
    throw new Error('Transfer stream multiplexing magic is invalid');
  }
  if (prefix.readUInt8(8) !== MUX_VERSION) throw new Error('Transfer stream multiplexing version is unsupported');
  const kind = prefix.readUInt8(9);
  if (prefix.readUInt16BE(10) !== MUX_FLAGS) throw new Error('Transfer stream multiplexing flags must be zero');
  const payloadLength = prefix.readUInt32BE(12);
  assertEnvelopeLength(kind, payloadLength);
  return { kind, payloadLength };
}

function assertEnvelopeLength(kind: number, length: number): void {
  const limit = kind === FRAME_KIND_CONTROL
    ? MAX_CONTROL_FRAME_BYTES
    : kind === FRAME_KIND_CHUNK
      ? MAX_CHUNK_FRAME_BYTES
      : kind === FRAME_KIND_PROGRESS ? MAX_PROGRESS_FRAME_BYTES : null;
  if (limit === null) throw new Error('Transfer stream multiplexing frame kind is invalid');
  if (!Number.isSafeInteger(length) || length <= 0 || length > limit) {
    throw new RangeError(`Transfer stream multiplexed payload length exceeds the kind-${kind} bound`);
  }
}

function appendBounded(left: Buffer, right: Uint8Array, targetLength: number): Buffer {
  if (right.length === 0) return left;
  if (left.length + right.length > targetLength) throw new RangeError('Transfer stream decoder exceeded its current frame bound');
  if (left.length === 0) return Buffer.from(right);
  return Buffer.concat([left, right], left.length + right.length);
}

async function writeWithBackpressure(stream: Duplex | any, buffer: Buffer, timeoutMs: number): Promise<void> {
  if (stream.destroyed || stream.writableEnded || stream.writable === false) {
    throw new Error('Transfer stream is not writable');
  }

  let callbackDone = false;
  let drainDone = false;
  let callbackError: Error | null = null;
  let needsDrain = false;
  let resolveWait!: () => void;
  let rejectWait!: (err: unknown) => void;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error('Transfer stream write timed out');
    error.name = 'TimeoutError';
    cleanup();
    rejectWait(error);
  }, timeoutMs);

  const cleanup = (): void => {
    clearTimeout(timer);
    stream.removeListener('drain', onDrain);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
  };
  const maybeFinish = (): void => {
    if (callbackError) {
      cleanup();
      rejectWait(callbackError);
    } else if (callbackDone && (!needsDrain || drainDone)) {
      cleanup();
      resolveWait();
    }
  };
  const onDrain = (): void => {
    drainDone = true;
    maybeFinish();
  };
  const onError = (error: unknown): void => {
    cleanup();
    rejectWait(normalizeError(error));
  };
  const onClose = (): void => {
    cleanup();
    rejectWait(new Error('Transfer stream closed during write'));
  };

  stream.once('error', onError);
  stream.once('close', onClose);
  try {
    needsDrain = stream.write(buffer, (error: Error | null | undefined) => {
      callbackDone = true;
      callbackError = error || null;
      queueMicrotask(maybeFinish);
    }) === false;
    if (needsDrain) stream.once('drain', onDrain);
    else drainDone = true;
    maybeFinish();
  } catch (error) {
    cleanup();
    throw error;
  }
  return wait;
}

function normalizeInput(input: TransferStreamSessionInput): NormalizedConfig {
  assertPlainDataObject(input, 'Transfer stream session input');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new TypeError(`Transfer stream session input contains unknown field ${key}`);
  }
  for (const key of [
    'stream', 'role', 'taskId', 'localPeerId', 'remotePeerId',
    'encodeControl', 'decodeControl', 'verifyControl',
    'encodeProgress', 'decodeProgress', 'commitProgress',
  ]) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`Transfer stream session input is missing ${key}`);
  }
  if (input.role !== 'sender' && input.role !== 'receiver') throw new TypeError('Transfer stream role must be sender or receiver');
  assertValidTaskId(input.taskId);
  assertPeerId(input.localPeerId, 'Local peer ID');
  assertPeerId(input.remotePeerId, 'Remote peer ID');
  if (input.localPeerId === input.remotePeerId) throw new TypeError('Local and remote peer IDs must differ');
  assertDuplex(input.stream);
  for (const key of ['encodeControl', 'decodeControl', 'verifyControl', 'encodeProgress', 'decodeProgress', 'commitProgress'] as const) {
    if (typeof input[key] !== 'function') throw new TypeError(`${key} must be a function`);
  }

  if (input.role === 'sender') {
    if (!input.chunkReader || typeof input.chunkReader[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('Sender requires an async-iterable chunkReader');
    }
    if (input.chunkWriter !== undefined) throw new TypeError('Sender must not receive a chunkWriter');
  } else {
    assertChunkWriter(input.chunkWriter);
    if (input.chunkReader !== undefined) throw new TypeError('Receiver must not receive a chunkReader');
  }

  const signal = normalizeAbortSignal(input.signal);
  return Object.freeze({
    stream: input.stream,
    role: input.role,
    taskId: input.taskId,
    localPeerId: input.localPeerId,
    remotePeerId: input.remotePeerId,
    encodeControl: input.encodeControl,
    decodeControl: input.decodeControl,
    verifyControl: input.verifyControl,
    encodeProgress: input.encodeProgress,
    decodeProgress: input.decodeProgress,
    commitProgress: input.commitProgress,
    ...(input.chunkReader !== undefined ? { chunkReader: input.chunkReader } : {}),
    ...(input.chunkWriter !== undefined ? { chunkWriter: input.chunkWriter } : {}),
    signal,
    handshakeTimeoutMs: normalizeTimeout(input.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'Handshake timeout'),
    idleTimeoutMs: normalizeTimeout(input.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'Idle timeout'),
    writeTimeoutMs: normalizeTimeout(input.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 'Write timeout'),
    operationTimeoutMs: normalizeTimeout(input.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 'Operation timeout'),
    pauseTimeoutMs: normalizeTimeout(input.pauseTimeoutMs, DEFAULT_PAUSE_TIMEOUT_MS, 'Pause timeout'),
    closingTimeoutMs: normalizeTimeout(input.closingTimeoutMs, DEFAULT_CLOSING_TIMEOUT_MS, 'Closing timeout'),
  });
}

function inspectControlMessage(value: unknown): CoreControlMessage {
  assertPlainDataObject(value, 'Decoded transfer control message');
  const record = value as Record<string, unknown>;
  const type = readDataField(record, 'type') as string;
  const protocol = readDataField(record, 'protocol') as number;
  const taskId = readDataField(record, 'taskId') as string;
  const fromPeerId = readDataField(record, 'fromPeerId') as string;
  const toPeerId = readDataField(record, 'toPeerId') as string;
  const direction = readDataField(record, 'direction') as 'send' | 'receive';
  if (!Object.values(CONTROL_TYPES).includes(type as any)) throw new TypeError('Transfer control type is unsupported');
  if (!Number.isSafeInteger(protocol)) throw new TypeError('Transfer control protocol must be an integer');
  assertValidTaskId(taskId);
  assertPeerId(fromPeerId, 'Transfer control sender peer ID');
  assertPeerId(toPeerId, 'Transfer control receiver peer ID');
  if (direction !== 'send' && direction !== 'receive') throw new TypeError('Transfer control direction is invalid');
  const expectedKeys = ['type', 'protocol', 'taskId', 'fromPeerId', 'toPeerId', 'direction'];
  if (type === CONTROL_TYPES.CANCEL) expectedKeys.push('code');
  assertExactDataKeys(record, expectedKeys, 'Decoded transfer control message');
  const inspected: CoreControlMessage = { type: type as CoreControlMessage['type'], protocol, taskId, fromPeerId, toPeerId, direction };
  if (type === CONTROL_TYPES.CANCEL) inspected.code = readDataField(record, 'code') as string;
  return Object.freeze(inspected);
}

function readDataField(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Decoded transfer control message is missing data field ${key}`);
  }
  return descriptor.value;
}

function normalizeReaderChunk(value: unknown, taskId: string): ChunkFrameInput {
  assertPlainDataObject(value, 'Encrypted chunk reader value');
  const record = value as Record<string, unknown>;
  const path = readDataField(record, 'path') as string;
  const normalized: ChunkFrameInput = {
    taskId: readDataField(record, 'taskId') as string,
    relativePath: path,
    path,
    offset: readDataField(record, 'offset') as number,
    sequence: readDataField(record, 'sequence') as number,
    plainLength: readDataField(record, 'plainLength') as number,
    nonce: readDataField(record, 'nonce') as Uint8Array,
    authTag: readDataField(record, 'authTag') as Uint8Array,
    ciphertext: readDataField(record, 'ciphertext') as Uint8Array,
  };
  if (normalized.taskId !== taskId) throw new Error('Encrypted chunk reader emitted a cross-task chunk');
  return normalized;
}

function assertSafeWriterCompletion(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as { published?: boolean }).published !== true) {
    throw new Error('Encrypted chunk writer did not confirm atomic publication');
  }
}

function assertChunkWriter(writer: unknown): void {
  const w = writer as ChunkWriterLike;
  if (!w || typeof w !== 'object' || typeof w.writeChunk !== 'function' ||
      typeof w.complete !== 'function' || typeof w.cancel !== 'function') {
    throw new TypeError('Receiver requires a chunkWriter with writeChunk, complete, and cancel methods');
  }
}

function assertDuplex(stream: unknown): void {
  const s = stream as Duplex;
  if (!s || typeof s !== 'object' || typeof s.on !== 'function' ||
      typeof s.removeListener !== 'function' || typeof s.write !== 'function' ||
      typeof s.end !== 'function' || typeof s.destroy !== 'function' ||
      typeof s.pause !== 'function' || typeof s.resume !== 'function') {
    throw new TypeError('Transfer stream must be a Node Duplex or Socket-like object');
  }
}

function assertPeerId(value: unknown, subject: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${subject} must be bounded non-control text`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PEER_ID_BYTES) throw new RangeError(`${subject} is too long`);
}

function normalizeTimeout(value: unknown, fallback: number, subject: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMEOUT_MS) {
    throw new RangeError(`${subject} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value as number;
}

function normalizeAbortSignal(signal: unknown): AbortSignal | null {
  if (signal === undefined || signal === null) return null;
  const s = signal as AbortSignal;
  if (!s || typeof s !== 'object' || typeof s.aborted !== 'boolean' ||
      typeof s.addEventListener !== 'function' || typeof s.removeEventListener !== 'function') {
    throw new TypeError('Transfer stream signal must be an AbortSignal');
  }
  return s;
}

function assertPlainDataObject(value: unknown, subject: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${subject} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${subject} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${subject} must contain only enumerable string data properties`);
    }
  }
}

function assertExactDataKeys(value: Record<string, unknown>, expectedKeys: string[], subject: string): void {
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${subject} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${subject} contains unknown field ${key}`);
  }
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function createDeferredCommand<T>(kind: string): DeferredCommand<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { kind, promise, resolve, reject };
}

function createDeferredProgress(chunk: ChunkFrameInput): DeferredProgress {
  const deferred = createDeferredCommand<unknown>('progress');
  return Object.freeze({
    chunk,
    promise: deferred.promise,
    resolve: deferred.resolve,
    reject: deferred.reject,
  });
}

function requireBytes(value: unknown, subject: string): Buffer {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${subject} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function runWithTimeout<T>(operation: () => Promise<T> | T, timeoutMs: number, subject: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (val: any) => void, value: any): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`${subject} timed out`);
      error.name = 'TimeoutError';
      finish(reject, error);
    }, timeoutMs);

    let result: Promise<T> | T;
    try {
      result = operation();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Transfer stream failed');
}

function createAbortError(reason?: unknown): Error {
  const error = new Error('Transfer stream was cancelled');
  error.name = 'AbortError';
  if (reason !== undefined) (error as Error & { cause?: unknown }).cause = reason;
  return error;
}
