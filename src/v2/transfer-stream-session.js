'use strict';

const { MAX_BUFFERED_BYTES: MAX_WIRE_FRAME_BYTES } = require('./wire-frame');
const {
  MAX_FRAME_BYTES: MAX_CHUNK_FRAME_BYTES,
  decodeFrame: decodeChunkFrame,
  encodeFrame: encodeChunkFrame
} = require('./transfer-chunk-frame');
const { assertValidTaskId } = require('./transfer-manifest');

const MUX_MAGIC = Buffer.from('NTV2MUX1', 'ascii');
const MUX_VERSION = 1;
const MUX_PREFIX_BYTES = 16;
const MUX_FLAGS = 0;
const FRAME_KIND_CONTROL = 1;
const FRAME_KIND_CHUNK = 2;
const MAX_PEER_ID_BYTES = 128;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_WRITE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 1000;
const DEFAULT_PAUSE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CLOSING_TIMEOUT_MS = 10 * 1000;
const CONTROL_PROTOCOL = 1;
const CONTROL_TYPES = Object.freeze({
  HELLO: 'stream-hello',
  START: 'stream-start',
  PAUSE: 'stream-pause',
  PAUSED: 'stream-paused',
  RESUME: 'stream-resume',
  RESUMED: 'stream-resumed',
  COMPLETE: 'stream-complete',
  COMPLETE_ACK: 'stream-complete-ack',
  CANCEL: 'stream-cancel'
});
const CANCEL_CODES = new Set(['cancelled', 'timeout', 'protocol-error', 'transfer-error']);
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed']);
const INPUT_KEYS = new Set([
  'chunkReader',
  'chunkWriter',
  'decodeControl',
  'encodeControl',
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
  'writeTimeoutMs'
]);

/**
 * Run one authenticated transfer over a Node Duplex/Socket.
 *
 * The session intentionally does not know the concrete control-message codec or
 * signature format. encodeControl, decodeControl and verifyControl are injected
 * so this transport can evolve independently from the signed control codec.
 * One session carries exactly one task in exactly one negotiated direction.
 */
function createTransferStreamSession(input) {
  return new TransferStreamSession(normalizeInput(input));
}

class TransferStreamSession {
  constructor(config) {
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
      void this.cancel(this._config.signal && this._config.signal.reason);
    };
  }

  start() {
    if (this._started) return this._done;
    this._started = true;
    this._state = 'handshaking';
    this._attachTransport();
    this._armTimeout('handshake', this._config.handshakeTimeoutMs);
    if (this._config.signal) {
      this._config.signal.addEventListener('abort', this._onAbort, { once: true });
      if (this._config.signal.aborted) {
        void this.cancel(this._config.signal.reason);
        return this._done;
      }
    }

    this._config.stream.resume();
    void this._sendControl(this._makeControl(CONTROL_TYPES.HELLO)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return this._done;
  }

  pause() {
    if (!this._started) throw new Error('Transfer stream must be started before it can be paused');
    if (this._localPauseState === 'paused') return Promise.resolve(this.getState());
    if (this._flowCommand && this._flowCommand.kind === 'pause') return this._flowCommand.promise;
    this._assertFlowCommandState('pause');

    const command = createDeferredCommand('pause');
    this._flowCommand = command;
    this._localPauseState = 'pausing';
    this._wakeFlowWaiter();
    this._refreshIdleTimeout();
    void this._sendControl(this._makeControl(CONTROL_TYPES.PAUSE)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return command.promise;
  }

  resume() {
    if (this._localPauseState === 'running') return Promise.resolve(this.getState());
    if (this._flowCommand && this._flowCommand.kind === 'resume') return this._flowCommand.promise;
    if (this._localPauseState !== 'paused' || this._flowCommand) {
      throw new Error('Transfer stream cannot resume before pause acknowledgement');
    }
    this._assertFlowCommandState('resume');

    const command = createDeferredCommand('resume');
    this._flowCommand = command;
    this._localPauseState = 'resuming';
    this._refreshIdleTimeout();
    void this._sendControl(this._makeControl(CONTROL_TYPES.RESUME)).catch((error) => {
      this._fail(error, 'transfer-error');
    });
    return command.promise;
  }

  cancel(reason) {
    if (TERMINAL_STATES.has(this._state)) return this._done;
    if (!this._started) this.start();
    if (this._state === 'cancelling') return this._done;

    this._state = 'cancelling';
    const error = createAbortError(reason);
    this._beginFailureSettlement(error, 'cancelled', 'cancelled', true);
    return this._done;
  }

  getState() {
    return Object.freeze({
      state: this._state,
      role: this._config.role,
      taskId: this._config.taskId,
      peerId: this._config.remotePeerId,
      chunks: this._chunks,
      ciphertextBytes: this._ciphertextBytes,
      paused: this._isFlowPaused(),
      localPauseState: this._localPauseState,
      remotePaused: this._remotePaused
    });
  }

  _attachTransport() {
    const stream = this._config.stream;
    stream.on('data', this._onData);
    stream.once('end', this._onEnd);
    stream.once('close', this._onClose);
    stream.on('error', this._onError);
  }

  _detachTransport() {
    const stream = this._config.stream;
    stream.removeListener('data', this._onData);
    stream.removeListener('end', this._onEnd);
    stream.removeListener('close', this._onClose);
    stream.removeListener('error', this._onError);
    if (this._config.signal) this._config.signal.removeEventListener('abort', this._onAbort);
  }

  _acceptTransportData(value) {
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
          } else {
            await this._handleChunkPayload(payload);
          }
        });
      })
      .then(() => {
        if (!this._settled && !this._readableEnded) this._config.stream.resume();
      })
      .catch((error) => this._fail(error, 'protocol-error'));
  }

  _acceptTransportEnd() {
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

  _acceptTransportClose() {
    if (this._settled) return;
    if (!this._readableEnded) {
      this._fail(new Error(`Transfer stream closed before EOF while ${this._state}`), 'transfer-error');
    }
  }

  async _handleControlPayload(payload) {
    const decoded = await this._runOperation(
      () => this._config.decodeControl(Buffer.from(payload), this._controlContext('decode')),
      'Transfer control decoding'
    );
    const message = inspectControlMessage(decoded);
    const verified = await this._runOperation(
      () => this._config.verifyControl(decoded, this._controlContext('verify')),
      'Transfer control verification'
    );
    if (verified !== true) throw new Error('Transfer control message signature or trust verification failed');
    this._assertControlBinding(message);

    if (message.type === CONTROL_TYPES.CANCEL) {
      if (!CANCEL_CODES.has(message.code)) throw new TypeError('Transfer cancellation code is invalid');
      const error = createAbortError(new Error(`Remote transfer cancelled: ${message.code}`));
      this._beginFailureSettlement(error, 'cancelled', message.code, false);
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

  async _handleHello(message) {
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


  async _handleFlowControl(message) {
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

  _assertFlowCommandState(operation) {
    if (this._settled || this._failureStarted || this._state === 'cancelling' || !this._isActiveTransferState()) {
      throw new Error(`Transfer stream cannot ${operation} while ${this._state}`);
    }
  }

  _isActiveTransferState() {
    return this._state === 'sending' || this._state === 'receiving';
  }

  _isFlowPaused() {
    return this._remotePaused || this._localPauseState !== 'running';
  }

  async _waitUntilFlowing() {
    while (this._config.role === 'sender' && this._isFlowPaused()) {
      if (this._settled || this._failureStarted || this._state !== 'sending') throw createAbortError();
      if (!this._flowWaiter) this._flowWaiter = createDeferredSignal();
      await this._flowWaiter.promise;
    }
  }

  _wakeFlowWaiter() {
    if (!this._flowWaiter) return;
    const waiter = this._flowWaiter;
    this._flowWaiter = null;
    waiter.resolve();
  }

  _refreshIdleTimeout() {
    if (this._settled || !this._remoteHello || !this._isActiveTransferState()) return;
    if (this._isFlowPaused()) this._armTimeout('pause', this._config.pauseTimeoutMs);
    else this._armTimeout('idle', this._config.idleTimeoutMs);
  }

  _acceptLateFlowAcknowledgement(message) {
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

  _enterClosing() {
    this._settleFlowCommand(new Error('Transfer completed while a flow-control command was pending'));
    this._localPauseState = 'running';
    this._remotePaused = false;
    this._wakeFlowWaiter();
    this._state = 'closing';
    this._clearTimeout();
  }

  _finishLocalClosing() {
    this._endWritable();
    if (this._settled || this._state !== 'closing' || this._readableEnded) return;
    this._armTimeout('closing', this._config.closingTimeoutMs);
  }

  async _handleSenderControl(message) {
    if (message.type !== CONTROL_TYPES.COMPLETE_ACK || this._state !== 'awaiting-ack') {
      throw new Error(`Control message ${message.type} is out of order for sender state ${this._state}`);
    }
    if (message.direction !== 'receive') throw new Error('Completion acknowledgement direction is invalid');
    this._enterClosing();
    await this._sendTail;
    this._finishLocalClosing();
  }

  async _handleReceiverControl(message) {
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
        () => this._config.chunkWriter.complete(),
        'Encrypted chunk writer completion'
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

  async _handleChunkPayload(payload) {
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
    await this._runOperation(
      () => this._config.chunkWriter.writeChunk(Object.freeze({
        taskId: frame.taskId,
        path: frame.relativePath,
        offset: frame.offset,
        sequence: frame.sequence,
        plainLength: frame.plainLength,
        nonce: frame.nonce,
        authTag: frame.authTag,
        ciphertext: frame.ciphertext
      })),
      'Encrypted chunk writer write'
    );
    this._chunks += 1;
    this._ciphertextBytes += frame.ciphertext.length;
  }

  async _runSender() {
    if (this._sendStarted) throw new Error('Transfer sender was started more than once');
    this._sendStarted = true;
    this._state = 'sending';
    await this._sendControl(this._makeControl(CONTROL_TYPES.START));
    if (this._state !== 'sending') return;

    const iterator = this._config.chunkReader[Symbol.asyncIterator]();
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
      await this._sendEnvelope(FRAME_KIND_CHUNK, encodeChunkFrame(normalized));
      this._chunks += 1;
      this._ciphertextBytes += normalized.ciphertext.length;
    }
    this._readerStopped = true;
    await this._waitUntilFlowing();
    if (this._state !== 'sending') return;
    this._state = 'awaiting-ack';
    await this._sendControl(this._makeControl(CONTROL_TYPES.COMPLETE));
  }

  _makeControl(type, extra = null) {
    const direction = this._config.role === 'sender' ? 'send' : 'receive';
    return Object.freeze({
      type,
      protocol: CONTROL_PROTOCOL,
      taskId: this._config.taskId,
      fromPeerId: this._config.localPeerId,
      toPeerId: this._config.remotePeerId,
      direction,
      ...(extra || {})
    });
  }

  _assertControlBinding(message) {
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

  _controlContext(operation) {
    return Object.freeze({
      operation,
      role: this._config.role,
      taskId: this._config.taskId,
      localPeerId: this._config.localPeerId,
      remotePeerId: this._config.remotePeerId
    });
  }

  _sendControl(message, allowCancelling = false, allowSettled = false) {
    return this._enqueueSend(async () => {
      if ((!allowSettled && this._settled) || (this._state === 'cancelling' && !allowCancelling)) {
        throw new Error('Cannot send control data after session termination');
      }
      const encoded = await this._runOperation(
        () => this._config.encodeControl(message, this._controlContext('encode')),
        'Transfer control encoding'
      );
      const payload = requireBytes(encoded, 'Encoded transfer control frame');
      if (payload.length === 0 || payload.length > MAX_WIRE_FRAME_BYTES) {
        throw new RangeError('Encoded transfer control frame exceeds the bounded wire-frame size');
      }
      await this._writeEnvelope(FRAME_KIND_CONTROL, payload);
    });
  }

  _sendEnvelope(kind, payload) {
    return this._enqueueSend(() => this._writeEnvelope(kind, payload));
  }

  _enqueueSend(operation) {
    const pending = this._sendTail.then(operation);
    this._sendTail = pending.catch(() => {});
    return pending;
  }

  async _writeEnvelope(kind, payload) {
    const encoded = encodeStreamEnvelope(kind, payload);
    await writeWithBackpressure(this._config.stream, encoded, this._config.writeTimeoutMs);
    this._touchIdleTimeout();
  }

  _touchIdleTimeout() {
    if (this._settled || this._isFlowPaused() || this._timerKind !== 'idle') return;
    this._armTimeout('idle', this._config.idleTimeoutMs);
  }

  _armTimeout(kind, milliseconds) {
    this._clearTimeout();
    this._timerKind = kind;
    this._timer = setTimeout(() => {
      const error = new Error(`Transfer ${kind} timed out`);
      error.name = 'TimeoutError';
      this._fail(error, 'timeout');
    }, milliseconds);
  }

  _clearTimeout() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._timerKind = null;
  }

  _runOperation(operation, subject) {
    return runWithTimeout(operation, this._config.operationTimeoutMs, subject);
  }

  _endWritable() {
    const stream = this._config.stream;
    if (!stream.destroyed && !stream.writableEnded) stream.end();
  }

  _fail(error, code) {
    if (this._settled || this._failureStarted || this._state === 'cancelling') return;
    const previousState = this._state;
    this._state = 'failing';
    this._beginFailureSettlement(
      normalizeError(error),
      code === 'cancelled' ? 'cancelled' : 'failed',
      code,
      !['created', 'closing'].includes(previousState)
    );
  }

  _beginFailureSettlement(error, state, code, notifyPeer) {
    if (this._settled || this._failureStarted) return;
    this._failureStarted = true;
    this._clearTimeout();
    const cleanup = [this._stopTransferResources()];
    if (notifyPeer) {
      cleanup.push(this._runOperation(
        () => this._sendControl(this._makeControl(CONTROL_TYPES.CANCEL, { code }), true, true),
        'Transfer cancellation notification'
      ));
    }
    this._settleFailure(error, state, false);
    void Promise.allSettled(cleanup).then(() => {
      if (!this._config.stream.destroyed) this._config.stream.destroy();
    });
  }

  async _stopTransferResources() {
    this._wakeFlowWaiter();
    if (this._config.role === 'sender' && !this._readerStopped) {
      this._readerStopped = true;
      const reader = this._readerIterator || this._config.chunkReader;
      if (reader && typeof reader.return === 'function') {
        try {
          await this._runOperation(() => reader.return(), 'Encrypted chunk reader cleanup');
        } catch (_) { /* preserve the primary error */ }
      }
    }
    if (this._config.role === 'receiver' && !this._writerStopped) {
      this._writerStopped = true;
      try {
        await this._runOperation(() => this._config.chunkWriter.cancel(), 'Encrypted chunk writer cleanup');
      } catch (_) { /* preserve the primary error */ }
    }
  }

  _settleSuccess() {
    if (this._settled) return;
    this._settleFlowCommand(new Error('Transfer completed while a flow-control command was pending'));
    this._wakeFlowWaiter();
    this._settled = true;
    this._state = 'completed';
    this._clearTimeout();
    this._detachTransport();
    this._resolve(this.getState());
  }

  _settleFailure(error, state, destroyTransport) {
    if (this._settled) return;
    this._settleFlowCommand(error);
    this._wakeFlowWaiter();
    this._settled = true;
    this._state = state;
    this._clearTimeout();
    this._detachTransport();
    if (destroyTransport && !this._config.stream.destroyed) this._config.stream.destroy();
    this._reject(error);
  }

  _settleFlowCommand(error) {
    if (!this._flowCommand) return;
    const command = this._flowCommand;
    this._flowCommand = null;
    command.reject(error);
  }
}

class StreamEnvelopeDecoder {
  constructor() {
    this._pending = Buffer.alloc(0);
    this._expectedLength = null;
    this._kind = null;
    this._finished = false;
  }

  get bufferedBytes() {
    return this._pending.length;
  }

  async push(value, onFrame) {
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
        const kind = this._kind;
        const payload = Buffer.from(this._pending.subarray(MUX_PREFIX_BYTES));
        this._pending = Buffer.alloc(0);
        this._expectedLength = null;
        this._kind = null;
        await onFrame(kind, payload);
      }
    }
  }

  finish() {
    if (this._finished) throw new Error('Transfer stream decoder is already finished');
    this._finished = true;
    if (this._pending.length !== 0) {
      const buffered = this._pending.length;
      this._pending = Buffer.alloc(0);
      throw new Error(`Transfer stream ended with a truncated multiplexed frame (${buffered} buffered byte(s))`);
    }
  }
}

function encodeStreamEnvelope(kind, value) {
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

function decodeStreamEnvelopeHeader(prefix) {
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

function assertEnvelopeLength(kind, length) {
  const limit = kind === FRAME_KIND_CONTROL
    ? MAX_WIRE_FRAME_BYTES
    : kind === FRAME_KIND_CHUNK ? MAX_CHUNK_FRAME_BYTES : null;
  if (limit === null) throw new Error('Transfer stream multiplexing frame kind is invalid');
  if (!Number.isSafeInteger(length) || length <= 0 || length > limit) {
    throw new RangeError(`Transfer stream multiplexed payload length exceeds the kind-${kind} bound`);
  }
}

function appendBounded(left, right, targetLength) {
  if (right.length === 0) return left;
  if (left.length + right.length > targetLength) throw new RangeError('Transfer stream decoder exceeded its current frame bound');
  if (left.length === 0) return Buffer.from(right);
  return Buffer.concat([left, right], left.length + right.length);
}

async function writeWithBackpressure(stream, buffer, timeoutMs) {
  if (stream.destroyed || stream.writableEnded || stream.writable === false) {
    throw new Error('Transfer stream is not writable');
  }

  let callbackDone = false;
  let drainDone = false;
  let callbackError = null;
  let needsDrain = false;
  let resolveWait;
  let rejectWait;
  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error('Transfer stream write timed out');
    error.name = 'TimeoutError';
    cleanup();
    rejectWait(error);
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    stream.removeListener('drain', onDrain);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
  };
  const maybeFinish = () => {
    if (callbackError) {
      cleanup();
      rejectWait(callbackError);
    } else if (callbackDone && (!needsDrain || drainDone)) {
      cleanup();
      resolveWait();
    }
  };
  const onDrain = () => {
    drainDone = true;
    maybeFinish();
  };
  const onError = (error) => {
    cleanup();
    rejectWait(normalizeError(error));
  };
  const onClose = () => {
    cleanup();
    rejectWait(new Error('Transfer stream closed during write'));
  };

  stream.once('error', onError);
  stream.once('close', onClose);
  try {
    needsDrain = stream.write(buffer, (error) => {
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

function normalizeInput(input) {
  assertPlainDataObject(input, 'Transfer stream session input');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new TypeError(`Transfer stream session input contains unknown field ${key}`);
  }
  for (const key of ['stream', 'role', 'taskId', 'localPeerId', 'remotePeerId', 'encodeControl', 'decodeControl', 'verifyControl']) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`Transfer stream session input is missing ${key}`);
  }
  if (input.role !== 'sender' && input.role !== 'receiver') throw new TypeError('Transfer stream role must be sender or receiver');
  assertValidTaskId(input.taskId);
  assertPeerId(input.localPeerId, 'Local peer ID');
  assertPeerId(input.remotePeerId, 'Remote peer ID');
  if (input.localPeerId === input.remotePeerId) throw new TypeError('Local and remote peer IDs must differ');
  assertDuplex(input.stream);
  for (const key of ['encodeControl', 'decodeControl', 'verifyControl']) {
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
    chunkReader: input.chunkReader,
    chunkWriter: input.chunkWriter,
    signal,
    handshakeTimeoutMs: normalizeTimeout(input.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'Handshake timeout'),
    idleTimeoutMs: normalizeTimeout(input.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'Idle timeout'),
    writeTimeoutMs: normalizeTimeout(input.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 'Write timeout'),
    operationTimeoutMs: normalizeTimeout(input.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 'Operation timeout'),
    pauseTimeoutMs: normalizeTimeout(input.pauseTimeoutMs, DEFAULT_PAUSE_TIMEOUT_MS, 'Pause timeout'),
    closingTimeoutMs: normalizeTimeout(input.closingTimeoutMs, DEFAULT_CLOSING_TIMEOUT_MS, 'Closing timeout')
  });
}

function inspectControlMessage(value) {
  assertPlainDataObject(value, 'Decoded transfer control message');
  const type = readDataField(value, 'type');
  const protocol = readDataField(value, 'protocol');
  const taskId = readDataField(value, 'taskId');
  const fromPeerId = readDataField(value, 'fromPeerId');
  const toPeerId = readDataField(value, 'toPeerId');
  const direction = readDataField(value, 'direction');
  if (!Object.values(CONTROL_TYPES).includes(type)) throw new TypeError('Transfer control type is unsupported');
  if (!Number.isSafeInteger(protocol)) throw new TypeError('Transfer control protocol must be an integer');
  assertValidTaskId(taskId);
  assertPeerId(fromPeerId, 'Transfer control sender peer ID');
  assertPeerId(toPeerId, 'Transfer control receiver peer ID');
  if (direction !== 'send' && direction !== 'receive') throw new TypeError('Transfer control direction is invalid');
  const expectedKeys = ['type', 'protocol', 'taskId', 'fromPeerId', 'toPeerId', 'direction'];
  if (type === CONTROL_TYPES.CANCEL) expectedKeys.push('code');
  assertExactDataKeys(value, expectedKeys, 'Decoded transfer control message');
  const inspected = { type, protocol, taskId, fromPeerId, toPeerId, direction };
  if (type === CONTROL_TYPES.CANCEL) inspected.code = readDataField(value, 'code');
  return Object.freeze(inspected);
}

function readDataField(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Decoded transfer control message is missing data field ${key}`);
  }
  return descriptor.value;
}

function normalizeReaderChunk(value, taskId) {
  assertPlainDataObject(value, 'Encrypted chunk reader value');
  const path = readDataField(value, 'path');
  const normalized = {
    taskId: readDataField(value, 'taskId'),
    relativePath: path,
    offset: readDataField(value, 'offset'),
    sequence: readDataField(value, 'sequence'),
    plainLength: readDataField(value, 'plainLength'),
    nonce: readDataField(value, 'nonce'),
    authTag: readDataField(value, 'authTag'),
    ciphertext: readDataField(value, 'ciphertext')
  };
  if (normalized.taskId !== taskId) throw new Error('Encrypted chunk reader emitted a cross-task chunk');
  return normalized;
}

function assertSafeWriterCompletion(value) {
  if (!value || typeof value !== 'object' || value.published !== true) {
    throw new Error('Encrypted chunk writer did not confirm atomic publication');
  }
}

function assertChunkWriter(writer) {
  if (!writer || typeof writer !== 'object' || typeof writer.writeChunk !== 'function' ||
      typeof writer.complete !== 'function' || typeof writer.cancel !== 'function') {
    throw new TypeError('Receiver requires a chunkWriter with writeChunk, complete, and cancel methods');
  }
}

function assertDuplex(stream) {
  if (!stream || typeof stream !== 'object' || typeof stream.on !== 'function' ||
      typeof stream.removeListener !== 'function' || typeof stream.write !== 'function' ||
      typeof stream.end !== 'function' || typeof stream.destroy !== 'function' ||
      typeof stream.pause !== 'function' || typeof stream.resume !== 'function') {
    throw new TypeError('Transfer stream must be a Node Duplex or Socket-like object');
  }
}

function assertPeerId(value, subject) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${subject} must be bounded non-control text`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PEER_ID_BYTES) throw new RangeError(`${subject} is too long`);
}

function normalizeTimeout(value, fallback, subject) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${subject} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function normalizeAbortSignal(signal) {
  if (signal === undefined) return null;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new TypeError('Transfer stream signal must be an AbortSignal');
  }
  return signal;
}

function assertPlainDataObject(value, subject) {
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

function assertExactDataKeys(value, expectedKeys, subject) {
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${subject} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${subject} contains unknown field ${key}`);
  }
}

function createDeferredSignal() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function createDeferredCommand(kind) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { kind, promise, resolve, reject };
}

function requireBytes(value, subject) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${subject} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function runWithTimeout(operation, timeoutMs, subject) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
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

    let result;
    try {
      result = operation();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error('Transfer stream failed');
}

function createAbortError(reason) {
  const error = new Error('Transfer stream was cancelled');
  error.name = 'AbortError';
  if (reason !== undefined) error.cause = reason;
  return error;
}

module.exports = {
  CONTROL_TYPES,
  FRAME_KIND_CHUNK,
  FRAME_KIND_CONTROL,
  MUX_MAGIC: Buffer.from(MUX_MAGIC),
  MUX_PREFIX_BYTES,
  MUX_VERSION,
  StreamEnvelopeDecoder,
  createTransferStreamSession,
  encodeStreamEnvelope
};
