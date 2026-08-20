package io.github.nearbytransfer.android;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/** Receives one authenticated protocol-v2 encrypted transfer stream. */
final class V2TransferStreamSession implements Closeable {
    static final int MUX_VERSION = 1;
    static final int MUX_PREFIX_BYTES = 16;
    static final int MUX_FLAGS = 0;
    static final int FRAME_KIND_CONTROL = 1;
    static final int FRAME_KIND_CHUNK = 2;
    static final int FRAME_KIND_PROGRESS = 3;

    static final long DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000L;
    static final long DEFAULT_IDLE_TIMEOUT_MS = 30_000L;
    static final long DEFAULT_WRITE_TIMEOUT_MS = 30_000L;
    static final long DEFAULT_OPERATION_TIMEOUT_MS = 30_000L;
    static final long DEFAULT_PAUSE_TIMEOUT_MS = 2 * 60_000L;
    static final long DEFAULT_CLOSING_TIMEOUT_MS = 10_000L;
    static final long MAX_TIMEOUT_MS = 10 * 60_000L;

    private static final byte[] MUX_MAGIC = "NTV2MUX1".getBytes(StandardCharsets.US_ASCII);
    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern TASK_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final int READ_BUFFER_BYTES = 16 * 1024;
    private static final int CONTROL_PROTOCOL = 1;

    enum State {
        CREATED,
        HANDSHAKING,
        AWAITING_START,
        RECEIVING,
        CLOSING,
        COMPLETED,
        CANCELLED,
        FAILED,
    }

    enum LocalPauseState {
        RUNNING,
        PAUSING,
        PAUSED,
        RESUMING,
    }

    /** Receives encrypted frames only. Implementations decrypt and publish outside this transport. */
    interface ChunkWriter {
        /** Returns the signed progress acknowledgement only after its checkpoint is durable. */
        byte[] writeChunk(V2TransferChunkFrame.Frame encryptedFrame) throws Exception;

        /** Returns true only after durable verification and publication have completed. */
        boolean complete() throws Exception;

        void cancel() throws Exception;
    }

    static final class Timeouts {
        final long handshakeMs;
        final long idleMs;
        final long writeMs;
        final long operationMs;
        final long pauseMs;
        final long closingMs;

        Timeouts() {
            this(
                DEFAULT_HANDSHAKE_TIMEOUT_MS,
                DEFAULT_IDLE_TIMEOUT_MS,
                DEFAULT_WRITE_TIMEOUT_MS,
                DEFAULT_OPERATION_TIMEOUT_MS,
                DEFAULT_PAUSE_TIMEOUT_MS,
                DEFAULT_CLOSING_TIMEOUT_MS
            );
        }

        Timeouts(long handshakeMs, long idleMs, long writeMs, long operationMs,
                 long pauseMs, long closingMs) {
            this.handshakeMs = validTimeout(handshakeMs, "Handshake timeout");
            this.idleMs = validTimeout(idleMs, "Idle timeout");
            this.writeMs = validTimeout(writeMs, "Write timeout");
            this.operationMs = validTimeout(operationMs, "Operation timeout");
            this.pauseMs = validTimeout(pauseMs, "Pause timeout");
            this.closingMs = validTimeout(closingMs, "Closing timeout");
        }
    }

    static final class Snapshot {
        final State state;
        final String taskId;
        final String peerId;
        final long chunks;
        final long ciphertextBytes;
        final LocalPauseState localPauseState;
        final boolean remotePaused;

        private Snapshot(State state, String taskId, String peerId, long chunks,
                         long ciphertextBytes, LocalPauseState localPauseState,
                         boolean remotePaused) {
            this.state = state;
            this.taskId = taskId;
            this.peerId = peerId;
            this.chunks = chunks;
            this.ciphertextBytes = ciphertextBytes;
            this.localPauseState = localPauseState;
            this.remotePaused = remotePaused;
        }

        boolean paused() {
            return remotePaused || localPauseState != LocalPauseState.RUNNING;
        }
    }

    private interface OwnedTransport extends Closeable {
        InputStream input() throws IOException;
        OutputStream output() throws IOException;
        void shutdownOutput() throws IOException;
    }

    private static final class SocketTransport implements OwnedTransport {
        private final Socket socket;

        SocketTransport(Socket socket) throws IOException {
            this.socket = Objects.requireNonNull(socket, "Transfer socket is required");
            if (socket.isClosed() || !socket.isConnected()) {
                throw new IOException("Transfer socket must be connected and open");
            }
            socket.setSoTimeout(0);
        }

        @Override public InputStream input() throws IOException { return socket.getInputStream(); }
        @Override public OutputStream output() throws IOException { return socket.getOutputStream(); }

        @Override public void shutdownOutput() throws IOException {
            if (!socket.isClosed() && !socket.isOutputShutdown()) socket.shutdownOutput();
        }

        @Override public void close() throws IOException { socket.close(); }
    }

    private static final class StreamTransport implements OwnedTransport {
        private final InputStream input;
        private final OutputStream output;
        private final Closeable owner;
        private boolean outputClosed;

        StreamTransport(InputStream input, OutputStream output, Closeable owner) {
            this.input = Objects.requireNonNull(input, "Transfer input stream is required");
            this.output = Objects.requireNonNull(output, "Transfer output stream is required");
            this.owner = owner;
        }

        @Override public InputStream input() { return input; }
        @Override public OutputStream output() { return output; }

        @Override public synchronized void shutdownOutput() throws IOException {
            if (outputClosed) return;
            outputClosed = true;
            output.close();
        }

        @Override public void close() throws IOException {
            IOException failure = null;
            try { input.close(); } catch (IOException error) { failure = error; }
            try { shutdownOutput(); } catch (IOException error) { if (failure == null) failure = error; }
            if (owner != null) {
                try { owner.close(); } catch (IOException error) { if (failure == null) failure = error; }
            }
            if (failure != null) throw failure;
        }
    }

    private static final class Envelope {
        final int kind;
        final byte[] payload;

        Envelope(int kind, byte[] payload) {
            this.kind = kind;
            this.payload = payload;
        }
    }

    private static final class EnvelopeDecoder {
        private final byte[] prefix = new byte[MUX_PREFIX_BYTES];
        private int prefixBytes;
        private int kind;
        private byte[] payload;
        private int payloadBytes;
        private boolean finished;

        List<Envelope> push(byte[] bytes, int length) {
            if (finished) throw new IllegalStateException("Transfer stream decoder is already finished");
            if (bytes == null || length < 0 || length > bytes.length) {
                throw new IllegalArgumentException("Transfer stream decoder input is invalid");
            }
            if (length == 0) return Collections.emptyList();
            ArrayList<Envelope> frames = new ArrayList<>();
            int cursor = 0;
            while (cursor < length) {
                if (payload == null) {
                    int take = Math.min(MUX_PREFIX_BYTES - prefixBytes, length - cursor);
                    System.arraycopy(bytes, cursor, prefix, prefixBytes, take);
                    prefixBytes += take;
                    cursor += take;
                    if (prefixBytes == MUX_PREFIX_BYTES) decodePrefix();
                } else {
                    int take = Math.min(payload.length - payloadBytes, length - cursor);
                    System.arraycopy(bytes, cursor, payload, payloadBytes, take);
                    payloadBytes += take;
                    cursor += take;
                    if (payloadBytes == payload.length) {
                        frames.add(new Envelope(kind, payload));
                        prefixBytes = 0;
                        payload = null;
                        payloadBytes = 0;
                    }
                }
            }
            return frames;
        }

        void finish() {
            if (finished) throw new IllegalStateException("Transfer stream decoder is already finished");
            finished = true;
            if (prefixBytes != 0 || payload != null) {
                int buffered = prefixBytes + payloadBytes;
                prefixBytes = 0;
                payload = null;
                payloadBytes = 0;
                throw new IllegalArgumentException(
                    "Transfer stream ended with a truncated multiplexed frame (" + buffered + " buffered byte(s))"
                );
            }
        }

        private void decodePrefix() {
            for (int index = 0; index < MUX_MAGIC.length; index += 1) {
                if (prefix[index] != MUX_MAGIC[index]) {
                    throw new IllegalArgumentException("Transfer stream multiplexing magic is invalid");
                }
            }
            if (Byte.toUnsignedInt(prefix[8]) != MUX_VERSION) {
                throw new IllegalArgumentException("Transfer stream multiplexing version is unsupported");
            }
            kind = Byte.toUnsignedInt(prefix[9]);
            ByteBuffer header = ByteBuffer.wrap(prefix).order(ByteOrder.BIG_ENDIAN);
            if (Short.toUnsignedInt(header.getShort(10)) != MUX_FLAGS) {
                throw new IllegalArgumentException("Transfer stream multiplexing flags must be zero");
            }
            long payloadLength = Integer.toUnsignedLong(header.getInt(12));
            int limit = payloadLimit(kind);
            if (payloadLength == 0 || payloadLength > limit) {
                throw new IllegalArgumentException(
                    "Transfer stream multiplexed payload length exceeds the kind-" + kind + " bound"
                );
            }
            payload = new byte[(int) payloadLength];
        }
    }

    private static final class SessionTimeoutException extends IOException {
        SessionTimeoutException(String kind) { super("Transfer " + kind + " timed out"); }
    }

    private static final class ProtocolException extends IOException {
        ProtocolException(String message) { super(message); }
        ProtocolException(String message, Throwable cause) { super(message, cause); }
    }

    private static final class TransferException extends IOException {
        TransferException(String message, Throwable cause) { super(message, cause); }
    }

    private final OwnedTransport transport;
    private final InputStream input;
    private final OutputStream output;
    private final V2SignedStreamControl.Codec controlCodec;
    private final ChunkWriter chunkWriter;
    private final String taskId;
    private final String localPeerId;
    private final String remotePeerId;
    private final Timeouts timeouts;
    private final EnvelopeDecoder decoder = new EnvelopeDecoder();
    private final Object stateLock = new Object();
    private final Object outputLock = new Object();
    private final ExecutorService readExecutor = newDaemonExecutor("v2-transfer-read");
    private final ExecutorService writeExecutor = newDaemonExecutor("v2-transfer-write");
    private final ExecutorService operationExecutor = newDaemonExecutor("v2-transfer-operation");

    private State state = State.CREATED;
    private LocalPauseState localPauseState = LocalPauseState.RUNNING;
    private boolean remotePaused;
    private boolean remoteHello;
    private boolean writerStopped;
    private boolean terminal;
    private boolean transportClosed;
    private boolean runStarted;
    private long chunks;
    private long ciphertextBytes;
    private String deadlineKind;
    private long deadlineNanos;
    private CompletableFuture<Snapshot> flowCommand;
    private Throwable terminalError;

    V2TransferStreamSession(Socket socket, V2SignedStreamControl.Codec controlCodec,
                            ChunkWriter chunkWriter, String taskId,
                            String localPeerId, String remotePeerId) throws IOException {
        this(new SocketTransport(socket), controlCodec, chunkWriter, taskId,
            localPeerId, remotePeerId, new Timeouts());
    }

    V2TransferStreamSession(Socket socket, V2SignedStreamControl.Codec controlCodec,
                            ChunkWriter chunkWriter, String taskId,
                            String localPeerId, String remotePeerId, Timeouts timeouts) throws IOException {
        this(new SocketTransport(socket), controlCodec, chunkWriter, taskId,
            localPeerId, remotePeerId, timeouts);
    }

    V2TransferStreamSession(InputStream input, OutputStream output, Closeable owner,
                            V2SignedStreamControl.Codec controlCodec,
                            ChunkWriter chunkWriter, String taskId,
                            String localPeerId, String remotePeerId, Timeouts timeouts) {
        this(new StreamTransport(input, output, owner), controlCodec, chunkWriter,
            taskId, localPeerId, remotePeerId, timeouts);
    }

    private V2TransferStreamSession(OwnedTransport transport,
                                    V2SignedStreamControl.Codec controlCodec,
                                    ChunkWriter chunkWriter, String taskId,
                                    String localPeerId, String remotePeerId,
                                    Timeouts timeouts) {
        this.transport = Objects.requireNonNull(transport, "Transfer transport is required");
        this.controlCodec = Objects.requireNonNull(controlCodec, "Signed stream control codec is required");
        this.chunkWriter = Objects.requireNonNull(chunkWriter, "Encrypted chunk writer is required");
        this.taskId = validTaskId(taskId);
        this.localPeerId = validDeviceId(localPeerId, "Local device ID");
        this.remotePeerId = validDeviceId(remotePeerId, "Remote device ID");
        if (localPeerId.equals(remotePeerId)) throw new IllegalArgumentException("Local and remote device IDs must differ");
        this.timeouts = Objects.requireNonNull(timeouts, "Transfer timeouts are required");
        try {
            this.input = Objects.requireNonNull(transport.input(), "Transfer input stream is required");
            this.output = Objects.requireNonNull(transport.output(), "Transfer output stream is required");
        } catch (IOException error) {
            closeQuietly(transport);
            throw new IllegalArgumentException("Transfer streams are unavailable", error);
        }
    }

    Snapshot run() throws Exception {
        synchronized (stateLock) {
            if (runStarted) throw new IllegalStateException("Transfer stream session may only run once");
            runStarted = true;
            if (terminal) throw terminalFailure();
            state = State.HANDSHAKING;
            armDeadlineLocked("handshake", timeouts.handshakeMs);
        }

        try {
            sendControl(control(V2SignedStreamControl.COMMAND_HELLO, null));
            byte[] buffer = new byte[READ_BUFFER_BYTES];
            while (true) {
                int read = readWithDeadline(buffer);
                if (read == -1) {
                    decoder.finish();
                    synchronized (stateLock) {
                        if (state != State.CLOSING) {
                            throw new ProtocolException(
                                "Transfer stream ended before protocol completion while " + stateName(state)
                            );
                        }
                    }
                    return settleSuccess();
                }
                for (Envelope envelope : decoder.push(buffer, read)) {
                    touchDeadline();
                    if (envelope.kind == FRAME_KIND_CONTROL) handleControl(envelope.payload);
                    else if (envelope.kind == FRAME_KIND_CHUNK) handleChunk(envelope.payload);
                    else throw new ProtocolException("Receiver cannot accept transfer progress acknowledgements");
                }
            }
        } catch (Throwable error) {
            Throwable normalized = unwrap(error);
            State failedFrom;
            synchronized (stateLock) {
                if (terminal) throw terminalFailure();
                failedFrom = state;
            }
            String code = normalized instanceof SessionTimeoutException ? "timeout"
                : normalized instanceof ProtocolException || normalized instanceof IllegalArgumentException
                    ? "protocol-error" : "transfer-error";
            settleFailure(normalized, State.FAILED, code,
                failedFrom != State.CREATED && failedFrom != State.CLOSING);
            throw terminalFailure();
        }
    }

    CompletableFuture<Snapshot> pause() throws Exception {
        CompletableFuture<Snapshot> command;
        synchronized (stateLock) {
            assertActiveLocked("pause");
            if (localPauseState == LocalPauseState.PAUSED) {
                return CompletableFuture.completedFuture(snapshotLocked());
            }
            if (localPauseState == LocalPauseState.PAUSING && flowCommand != null) return flowCommand;
            if (localPauseState != LocalPauseState.RUNNING || flowCommand != null) {
                throw new IllegalStateException("Transfer stream cannot pause while " + stateName(state));
            }
            localPauseState = LocalPauseState.PAUSING;
            command = new CompletableFuture<>();
            flowCommand = command;
            refreshDeadlineLocked();
        }
        try {
            sendControl(control(V2SignedStreamControl.COMMAND_PAUSE, null));
            return command;
        } catch (Exception error) {
            settleFailure(error, State.FAILED, "transfer-error", true);
            throw error;
        }
    }

    CompletableFuture<Snapshot> resume() throws Exception {
        CompletableFuture<Snapshot> command;
        synchronized (stateLock) {
            assertActiveLocked("resume");
            if (localPauseState == LocalPauseState.RUNNING) {
                return CompletableFuture.completedFuture(snapshotLocked());
            }
            if (localPauseState == LocalPauseState.RESUMING && flowCommand != null) return flowCommand;
            if (localPauseState != LocalPauseState.PAUSED || flowCommand != null) {
                throw new IllegalStateException("Transfer stream cannot resume before pause acknowledgement");
            }
            localPauseState = LocalPauseState.RESUMING;
            command = new CompletableFuture<>();
            flowCommand = command;
            refreshDeadlineLocked();
        }
        try {
            sendControl(control(V2SignedStreamControl.COMMAND_RESUME, null));
            return command;
        } catch (Exception error) {
            settleFailure(error, State.FAILED, "transfer-error", true);
            throw error;
        }
    }

    void cancel() {
        synchronized (stateLock) {
            if (terminal) return;
        }
        settleFailure(new CancellationException("Transfer was cancelled locally"),
            State.CANCELLED, "cancelled", true);
    }

    Snapshot snapshot() {
        synchronized (stateLock) { return snapshotLocked(); }
    }

    @Override public void close() {
        cancel();
    }

    private void handleControl(byte[] payload) throws Exception {
        final V2SignedStreamControl.Control message;
        try {
            message = callOperation(() -> controlCodec.decodeAndVerify(payload), "control decoding");
        } catch (Exception error) {
            throw new ProtocolException("Transfer control authentication failed", error);
        }
        assertControlBinding(message);

        if (V2SignedStreamControl.COMMAND_CANCEL.equals(message.type)) {
            settleFailure(new CancellationException("Remote transfer cancelled: " + message.code),
                State.CANCELLED, message.code, false);
            throw terminalFailure();
        }
        if (V2SignedStreamControl.COMMAND_HELLO.equals(message.type)) {
            handleHello(message);
            return;
        }

        synchronized (stateLock) {
            if (!remoteHello) {
                throw new ProtocolException("Transfer control message arrived before the authenticated hello");
            }
        }
        if (isFlowControl(message.type)) {
            handleFlowControl(message);
            return;
        }

        synchronized (stateLock) {
            if (state == State.CLOSING) throw new ProtocolException("Control data received after transfer completion");
        }
        if (V2SignedStreamControl.COMMAND_START.equals(message.type)) {
            synchronized (stateLock) {
                if (state != State.AWAITING_START || !"send".equals(message.direction)) {
                    throw new ProtocolException("Transfer start is duplicated, directionally invalid, or out of order");
                }
                state = State.RECEIVING;
                refreshDeadlineLocked();
            }
            return;
        }
        if (V2SignedStreamControl.COMMAND_COMPLETE.equals(message.type)) {
            synchronized (stateLock) {
                if (state != State.RECEIVING || !"send".equals(message.direction)) {
                    throw new ProtocolException("Transfer completion is directionally invalid or out of order");
                }
            }
            final boolean published;
            try {
                published = callOperation(chunkWriter::complete, "encrypted chunk writer completion");
            } catch (Exception error) {
                throw new TransferException("Encrypted chunk writer completion failed", error);
            }
            if (!published) throw new TransferException(
                "Encrypted chunk writer did not confirm atomic publication", null
            );
            synchronized (stateLock) {
                if (terminal) throw terminalFailure();
                writerStopped = true;
                enterClosingLocked();
            }
            sendControl(control(V2SignedStreamControl.COMMAND_COMPLETE_ACK, null));
            shutdownOutput();
            synchronized (stateLock) {
                if (!terminal && state == State.CLOSING) armDeadlineLocked("closing", timeouts.closingMs);
            }
            return;
        }
        throw new ProtocolException(
            "Control message " + message.type + " is out of order for receiver state " + stateName(snapshot().state)
        );
    }

    private void handleHello(V2SignedStreamControl.Control message) throws ProtocolException {
        synchronized (stateLock) {
            if (state != State.HANDSHAKING || remoteHello) {
                throw new ProtocolException("Transfer hello is duplicated or out of order");
            }
            if (!"send".equals(message.direction)) {
                throw new ProtocolException("Transfer hello direction conflicts with the receiver role");
            }
            remoteHello = true;
            state = State.AWAITING_START;
            armDeadlineLocked("idle", timeouts.idleMs);
        }
    }

    private void handleFlowControl(V2SignedStreamControl.Control message) throws Exception {
        synchronized (stateLock) {
            if (state == State.CLOSING) return;
            if (state != State.RECEIVING) {
                throw new ProtocolException(
                    "Flow-control message " + message.type + " is out of order for state " + stateName(state)
                );
            }
        }

        if (V2SignedStreamControl.COMMAND_PAUSE.equals(message.type)) {
            synchronized (stateLock) {
                if (remotePaused) throw new ProtocolException("Remote transfer pause is duplicated");
                remotePaused = true;
                refreshDeadlineLocked();
            }
            sendControl(control(V2SignedStreamControl.COMMAND_PAUSED, null));
            return;
        }
        if (V2SignedStreamControl.COMMAND_PAUSED.equals(message.type)) {
            CompletableFuture<Snapshot> command;
            Snapshot result;
            synchronized (stateLock) {
                if (localPauseState != LocalPauseState.PAUSING || flowCommand == null) {
                    throw new ProtocolException("Transfer pause acknowledgement is unsolicited or duplicated");
                }
                localPauseState = LocalPauseState.PAUSED;
                command = flowCommand;
                flowCommand = null;
                refreshDeadlineLocked();
                result = snapshotLocked();
            }
            command.complete(result);
            return;
        }
        if (V2SignedStreamControl.COMMAND_RESUME.equals(message.type)) {
            synchronized (stateLock) {
                if (!remotePaused) throw new ProtocolException("Remote transfer resume is unsolicited or duplicated");
                remotePaused = false;
                refreshDeadlineLocked();
            }
            sendControl(control(V2SignedStreamControl.COMMAND_RESUMED, null));
            return;
        }
        if (!V2SignedStreamControl.COMMAND_RESUMED.equals(message.type)) {
            throw new ProtocolException("Unsupported transfer flow-control command");
        }
        CompletableFuture<Snapshot> command;
        Snapshot result;
        synchronized (stateLock) {
            if (localPauseState != LocalPauseState.RESUMING || flowCommand == null) {
                throw new ProtocolException("Transfer resume acknowledgement is unsolicited or duplicated");
            }
            localPauseState = LocalPauseState.RUNNING;
            command = flowCommand;
            flowCommand = null;
            refreshDeadlineLocked();
            result = snapshotLocked();
        }
        command.complete(result);
    }

    private void handleChunk(byte[] payload) throws Exception {
        synchronized (stateLock) {
            if (state != State.RECEIVING) {
                throw new ProtocolException(
                    "Transfer chunk is out of order for receiver state " + stateName(state)
                );
            }
        }
        final V2TransferChunkFrame.Frame frame;
        try {
            frame = V2TransferChunkFrame.decode(payload);
        } catch (IllegalArgumentException error) {
            throw new ProtocolException("Transfer chunk frame is invalid", error);
        }
        if (!taskId.equals(frame.taskId())) {
            throw new ProtocolException("Transfer chunk taskId does not match the authenticated session");
        }
        try {
            byte[] progress = callOperation(
                () -> chunkWriter.writeChunk(frame),
                "encrypted chunk writer write"
            );
            if (progress == null || progress.length == 0) {
                throw new ProtocolException("Encrypted chunk writer returned no durable progress acknowledgement");
            }
            writeEnvelope(FRAME_KIND_PROGRESS, progress, false);
        } catch (Exception error) {
            throw new TransferException("Encrypted chunk writer write failed", error);
        }
        synchronized (stateLock) {
            if (terminal) throw terminalFailure();
            chunks += 1;
            ciphertextBytes += frame.ciphertext().length;
        }
    }

    private void assertControlBinding(V2SignedStreamControl.Control message) throws ProtocolException {
        if (message.protocol != CONTROL_PROTOCOL) {
            throw new ProtocolException("Transfer control protocol version is unsupported");
        }
        if (!taskId.equals(message.taskId)) {
            throw new ProtocolException("Transfer control taskId does not match this session");
        }
        if (!remotePeerId.equals(message.fromPeerId) || !localPeerId.equals(message.toPeerId)) {
            throw new ProtocolException("Transfer control peer binding does not match this connection");
        }
        if (!"send".equals(message.direction)) {
            throw new ProtocolException("Transfer control direction does not match the authenticated sender role");
        }
    }

    private V2SignedStreamControl.Control control(String type, String code) {
        return new V2SignedStreamControl.Control(
            type, CONTROL_PROTOCOL, taskId, localPeerId, remotePeerId, "receive", code
        );
    }

    private void sendControl(V2SignedStreamControl.Control control) throws Exception {
        sendControl(control, false);
    }

    private void sendControl(V2SignedStreamControl.Control control, boolean allowTerminal) throws Exception {
        synchronized (stateLock) {
            if (terminal && !allowTerminal) throw terminalFailure();
        }
        final byte[] payload;
        try {
            payload = callOperation(() -> controlCodec.encode(control), "control encoding");
        } catch (Exception error) {
            throw new TransferException("Transfer control encoding failed", error);
        }
        if (payload.length == 0 || payload.length > V2WireFrame.MAX_BUFFERED_BYTES) {
            throw new ProtocolException("Encoded transfer control frame exceeds the bounded wire-frame size");
        }
        writeEnvelope(FRAME_KIND_CONTROL, payload, allowTerminal);
    }

    private void writeEnvelope(int kind, byte[] payload, boolean allowTerminal) throws Exception {
        byte[] encoded = encodeEnvelope(kind, payload);
        synchronized (outputLock) {
            synchronized (stateLock) {
                if (terminal && !allowTerminal) throw terminalFailure();
            }
            callWithTimeout(() -> {
                output.write(encoded);
                output.flush();
                return null;
            }, timeouts.writeMs, "write");
        }
        touchDeadline();
    }

    private void shutdownOutput() throws Exception {
        synchronized (outputLock) {
            callWithTimeout(() -> {
                transport.shutdownOutput();
                return null;
            }, timeouts.writeMs, "write");
        }
    }

    private int readWithDeadline(byte[] buffer) throws Exception {
        long remaining;
        String kind;
        synchronized (stateLock) {
            if (terminal) throw terminalFailure();
            kind = deadlineKind;
            remaining = remainingDeadlineMillisLocked();
        }
        if (remaining <= 0) throw new SessionTimeoutException(kind == null ? "idle" : kind);
        Future<Integer> pending = readExecutor.submit(() -> input.read(buffer));
        try {
            return pending.get(remaining, TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            pending.cancel(true);
            throw new SessionTimeoutException(kind == null ? "idle" : kind);
        } catch (ExecutionException error) {
            throw asException(unwrap(error));
        } catch (InterruptedException error) {
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw new IOException("Transfer stream read was interrupted", error);
        }
    }

    private <T> T callOperation(ThrowingCallable<T> operation, String subject) throws Exception {
        long timeout = timeouts.operationMs;
        synchronized (stateLock) {
            if (deadlineKind != null) timeout = Math.min(timeout, Math.max(1L, remainingDeadlineMillisLocked()));
        }
        return callWithTimeout(operation, timeout, subject);
    }

    private <T> T callWithTimeout(ThrowingCallable<T> operation, long timeoutMs, String subject) throws Exception {
        ExecutorService executor = "write".equals(subject) ? writeExecutor : operationExecutor;
        Future<T> pending = executor.submit(operation::call);
        try {
            return pending.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            pending.cancel(true);
            if ("write".equals(subject)) {
                closeQuietly(transport);
                writeExecutor.shutdownNow();
            }
            throw new SessionTimeoutException(subject);
        } catch (ExecutionException error) {
            throw asException(unwrap(error));
        } catch (InterruptedException error) {
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw new IOException("Transfer " + subject + " was interrupted", error);
        }
    }

    private Snapshot settleSuccess() {
        Snapshot result;
        synchronized (stateLock) {
            if (terminal) throw terminalFailure();
            terminal = true;
            state = State.COMPLETED;
            clearDeadlineLocked();
            settleFlowCommandLocked(new IllegalStateException(
                "Transfer completed while a flow-control command was pending"
            ));
            result = snapshotLocked();
        }
        closeTransportAndExecutors();
        return result;
    }

    private void settleFailure(Throwable error, State terminalState, String code, boolean notifyPeer) {
        boolean shouldNotify;
        boolean shouldCancelWriter;
        synchronized (stateLock) {
            if (terminal) return;
            terminal = true;
            state = terminalState;
            terminalError = error == null ? new IOException("Transfer stream failed") : error;
            clearDeadlineLocked();
            settleFlowCommandLocked(terminalError);
            shouldNotify = notifyPeer && runStarted;
            shouldCancelWriter = !writerStopped;
            writerStopped = true;
        }
        if (shouldNotify) {
            try { sendControl(control(V2SignedStreamControl.COMMAND_CANCEL, code), true); }
            catch (Exception ignored) { }
        }
        if (shouldCancelWriter) {
            try { callOperation(() -> { chunkWriter.cancel(); return null; }, "encrypted chunk writer cleanup"); }
            catch (Exception ignored) { }
        }
        closeTransportAndExecutors();
    }

    private void closeTransportAndExecutors() {
        synchronized (stateLock) {
            if (transportClosed) return;
            transportClosed = true;
        }
        closeQuietly(transport);
        readExecutor.shutdownNow();
        writeExecutor.shutdownNow();
        operationExecutor.shutdownNow();
    }

    private void assertActiveLocked(String operation) {
        if (terminal || state != State.RECEIVING) {
            throw new IllegalStateException("Transfer stream cannot " + operation + " while " + stateName(state));
        }
    }

    private void enterClosingLocked() {
        settleFlowCommandLocked(new IllegalStateException(
            "Transfer completed while a flow-control command was pending"
        ));
        localPauseState = LocalPauseState.RUNNING;
        remotePaused = false;
        state = State.CLOSING;
        clearDeadlineLocked();
    }

    private void settleFlowCommandLocked(Throwable error) {
        if (flowCommand == null) return;
        CompletableFuture<Snapshot> command = flowCommand;
        flowCommand = null;
        command.completeExceptionally(error);
    }

    private Snapshot snapshotLocked() {
        return new Snapshot(state, taskId, remotePeerId, chunks, ciphertextBytes,
            localPauseState, remotePaused);
    }

    private RuntimeException terminalFailure() {
        Throwable error;
        State terminalState;
        synchronized (stateLock) {
            error = terminalError;
            terminalState = state;
        }
        if (terminalState == State.CANCELLED) {
            CancellationException cancellation = new CancellationException(
                error == null ? "Transfer was cancelled" : error.getMessage()
            );
            if (error != null && error != cancellation) cancellation.initCause(error);
            return cancellation;
        }
        if (error instanceof RuntimeException) return (RuntimeException) error;
        return new IllegalStateException(error == null ? "Transfer stream is terminated" : error.getMessage(), error);
    }

    private void armDeadlineLocked(String kind, long timeoutMs) {
        deadlineKind = kind;
        deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
    }

    private void clearDeadlineLocked() {
        deadlineKind = null;
        deadlineNanos = 0L;
    }

    private void touchDeadline() {
        synchronized (stateLock) {
            if (terminal || deadlineKind == null) return;
            if ("closing".equals(deadlineKind)) return;
            refreshDeadlineLocked();
        }
    }

    private void refreshDeadlineLocked() {
        if (terminal || !remoteHello || state != State.RECEIVING) return;
        if (remotePaused || localPauseState != LocalPauseState.RUNNING) {
            armDeadlineLocked("pause", timeouts.pauseMs);
        } else {
            armDeadlineLocked("idle", timeouts.idleMs);
        }
    }

    private long remainingDeadlineMillisLocked() {
        if (deadlineKind == null) return timeouts.idleMs;
        long nanos = deadlineNanos - System.nanoTime();
        if (nanos <= 0) return 0;
        long millis = TimeUnit.NANOSECONDS.toMillis(nanos);
        return millis == 0 ? 1 : millis;
    }

    private static byte[] encodeEnvelope(int kind, byte[] payload) {
        Objects.requireNonNull(payload, "Transfer stream envelope payload is required");
        int limit = payloadLimit(kind);
        if (payload.length == 0 || payload.length > limit) {
            throw new IllegalArgumentException(
                "Transfer stream multiplexed payload length exceeds the kind-" + kind + " bound"
            );
        }
        ByteBuffer encoded = ByteBuffer.allocate(MUX_PREFIX_BYTES + payload.length).order(ByteOrder.BIG_ENDIAN);
        encoded.put(MUX_MAGIC);
        encoded.put((byte) MUX_VERSION);
        encoded.put((byte) kind);
        encoded.putShort((short) MUX_FLAGS);
        encoded.putInt(payload.length);
        encoded.put(payload);
        return encoded.array();
    }

    private static int payloadLimit(int kind) {
        if (kind == FRAME_KIND_CONTROL) return V2SignedStreamControl.MAX_PAYLOAD_BYTES;
        if (kind == FRAME_KIND_CHUNK) return V2TransferChunkFrame.MAX_FRAME_BYTES;
        if (kind == FRAME_KIND_PROGRESS) return V2TransferMessage.MAX_CONTROL_MESSAGE_BYTES;
        throw new IllegalArgumentException("Transfer stream multiplexing frame kind is invalid");
    }

    private static boolean isFlowControl(String type) {
        return V2SignedStreamControl.COMMAND_PAUSE.equals(type)
            || V2SignedStreamControl.COMMAND_PAUSED.equals(type)
            || V2SignedStreamControl.COMMAND_RESUME.equals(type)
            || V2SignedStreamControl.COMMAND_RESUMED.equals(type);
    }

    private static long validTimeout(long value, String subject) {
        if (value <= 0 || value > MAX_TIMEOUT_MS) {
            throw new IllegalArgumentException(subject + " must be between 1 and " + MAX_TIMEOUT_MS + " milliseconds");
        }
        return value;
    }

    private static String validTaskId(String value) {
        if (value == null || !TASK_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Transfer task ID must be canonical base64url text");
        }
        try {
            byte[] decoded = java.util.Base64.getUrlDecoder().decode(value);
            String canonical = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != 16 || !canonical.equals(value)) {
                throw new IllegalArgumentException("Transfer task ID must encode exactly 16 bytes");
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Transfer task ID must encode exactly 16 bytes", error);
        }
        return value;
    }

    private static String validDeviceId(String value, String subject) {
        if (value == null || !DEVICE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(subject + " must contain 16 lowercase hexadecimal characters");
        }
        return value;
    }

    private static String stateName(State state) {
        return state.name().toLowerCase().replace('_', '-');
    }

    private static Exception asException(Throwable error) {
        if (error instanceof Exception) return (Exception) error;
        return new IOException("Transfer operation failed", error);
    }

    private static Throwable unwrap(Throwable error) {
        Throwable value = error;
        while ((value instanceof ExecutionException || value instanceof java.util.concurrent.CompletionException)
            && value.getCause() != null) {
            value = value.getCause();
        }
        return value;
    }

    private static ExecutorService newDaemonExecutor(String name) {
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        };
        return Executors.newSingleThreadExecutor(factory);
    }

    private static void closeQuietly(Closeable value) {
        if (value == null) return;
        try { value.close(); } catch (Exception ignored) { }
    }

    @FunctionalInterface
    private interface ThrowingCallable<T> {
        T call() throws Exception;
    }
}
