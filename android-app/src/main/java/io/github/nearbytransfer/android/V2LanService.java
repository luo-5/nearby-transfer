package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bounded TCP bootstrap for protocol-v2 pairing and explicitly enabled transfers. */
final class V2LanService implements Closeable {
    static final int DEFAULT_MAX_CONNECTIONS = 16;
    static final int DEFAULT_MAX_CONNECTIONS_PER_IP = 4;
    static final int DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
    static final int DEFAULT_MAX_BOOTSTRAP_BYTES = 32 * 1024;
    static final int DEFAULT_MAX_TRANSFER_BOOTSTRAP_BYTES = V2TransferMessage.MAX_MESSAGE_BYTES
        + V2WireFrame.MAX_HEADER_SIZE + V2WireFrame.FRAME_PREFIX_BYTES;
    static final int DEFAULT_MAX_BOOTSTRAP_FRAMES = 8;

    interface ControlHandler {
        void onOffer(V2Pairing.Offer offer, String signature, Connection connection) throws Exception;
        void onConfirmation(V2Pairing.Confirmation confirmation, String signature, Connection connection) throws Exception;
        void onCancellation(V2Pairing.Cancellation cancellation, String signature, Connection connection) throws Exception;
        void onConnectionClosed(Binding binding);
    }

    /**
     * Handles one transfer manifest synchronously on the connection read thread.
     * The handler must either send a decision and return (the socket is closed),
     * or send an accepted decision and detach the socket for the stream runtime.
     */
    interface TransferHandler {
        void onManifestFrame(V2WireFrame.Frame frame, Connection connection) throws Exception;
    }

    interface Listener {
        void onStatus(String message);
        void onProtocolError(String remoteAddress, Exception error);
    }

    static final class Binding {
        private final String expectedDeviceId;
        private String pairingId;
        private String remoteDeviceId;

        private Binding(String expectedDeviceId) { this.expectedDeviceId = expectedDeviceId; }
        String expectedDeviceId() { return expectedDeviceId; }
        String pairingId() { return pairingId; }
        String remoteDeviceId() { return remoteDeviceId; }
    }

    final class Connection implements Closeable {
        private final Socket socket;
        private final String remoteAddress;
        private final Binding binding;
        private final V2WireFrame.Decoder decoder = new V2WireFrame.Decoder();
        private final Object outputLock = new Object();
        private int inputBytes;
        private int frameCount;
        private boolean closed;
        private boolean detached;
        private boolean readLoopStarted;
        private boolean transferManifestDispatched;
        private Thread readLoopThread;

        private Connection(Socket socket, String expectedDeviceId) {
            this.socket = socket;
            this.remoteAddress = socket.getInetAddress() == null ? "unknown" : socket.getInetAddress().getHostAddress();
            this.binding = new Binding(expectedDeviceId);
        }

        Binding binding() { return binding; }
        String remoteAddress() { return remoteAddress; }

        void sendOffer(V2Pairing.Offer offer, String signature) throws Exception {
            // register() intentionally delays the outgoing read loop. Set the longer
            // authenticated-session timeout before the first blocking read can begin.
            activatePairingDeadline();
            send(V2Pairing.TYPE_OFFER, V2ControlMessage.encodeOffer(offer, signature));
            startReadLoop();
        }
        void sendConfirmation(V2Pairing.Confirmation confirmation, String signature) throws Exception {
            send(V2Pairing.TYPE_CONFIRM, V2ControlMessage.encodeConfirmation(confirmation, signature));
        }
        void sendCancellation(V2Pairing.Cancellation cancellation, String signature) throws Exception {
            send(V2Pairing.TYPE_CANCEL, V2ControlMessage.encodeCancellation(cancellation, signature));
        }

        void sendTransferDecisionFrame(V2WireFrame.Frame frame) throws Exception {
            Object type = frame == null ? null : frame.header.opt("type");
            if (frame == null || (!V2TransferMessage.TYPE_DECISION.equals(type) && !V2TransferMessage.TYPE_RESUME.equals(type))) {
                throw new IllegalArgumentException("A transfer-decision or transfer-resume wire frame is required");
            }
            synchronized (this) {
                if (!transferManifestDispatched || detached) {
                    throw new IllegalStateException("Transfer decision is not valid for this connection");
                }
            }
            sendFrame(frame, "Transfer decision");
        }

        Socket detachForTransfer() throws Exception {
            synchronized (this) {
                if (Thread.currentThread() != readLoopThread) {
                    throw new IllegalStateException("Transfer socket may only be detached by its manifest handler");
                }
                if (closed || detached || !transferManifestDispatched || binding.pairingId != null) {
                    throw new IllegalStateException("Transfer connection is unavailable for handoff");
                }
                if (decoder.bufferedBytes() != 0) {
                    throw new IllegalStateException("Transfer socket cannot be detached with buffered bootstrap bytes");
                }
                detached = true;
            }
            socket.setSoTimeout(0);
            unregister(this);
            return socket;
        }

        private void send(String type, byte[] payload) throws Exception {
            JSONObject header = new JSONObject();
            header.put("app", ProtocolV2.APP_ID);
            header.put("protocolVersion", ProtocolV2.VERSION);
            header.put("type", type);
            sendFrame(new V2WireFrame.Frame(header, payload), "Pairing control");
        }

        private void sendFrame(V2WireFrame.Frame value, String subject) throws Exception {
            byte[] frame = V2WireFrame.encode(value);
            if (frame.length > maxBootstrapBytes) {
                throw new IllegalArgumentException(subject + " frame exceeds the accepted limit");
            }
            synchronized (outputLock) {
                if (closed || detached || socket.isClosed() || socket.isOutputShutdown()) {
                    throw new IOException("Bootstrap connection is unavailable");
                }
                OutputStream output = socket.getOutputStream();
                output.write(frame);
                output.flush();
            }
        }

        private void activatePairingDeadline() throws SocketException {
            // Ten seconds is only the pre-offer bootstrap limit. Once an authenticated offer
            // is sent or received, users need the full protocol pairing window to compare SAS.
            socket.setSoTimeout((int) V2Pairing.PAIRING_SESSION_TTL_MS);
        }

        private void startReadLoop() {
            synchronized (this) {
                if (closed || readLoopStarted) return;
                readLoopStarted = true;
            }
            io.execute(this::readLoop);
        }

        private void readLoop() {
            synchronized (this) { readLoopThread = Thread.currentThread(); }
            try {
                InputStream input = socket.getInputStream();
                byte[] buffer = new byte[4096];
                for (int read; (read = input.read(buffer)) != -1;) {
                    inputBytes += read;
                    if (inputBytes > maxBootstrapBytes) throw new IllegalArgumentException("Protocol v2 bootstrap input exceeds the accepted limit");
                    byte[] chunk = new byte[read];
                    System.arraycopy(buffer, 0, chunk, 0, read);
                    List<V2WireFrame.Frame> frames = decoder.push(chunk);
                    assertTransferManifestIsIsolated(frames, decoder.bufferedBytes());
                    for (V2WireFrame.Frame frame : frames) {
                        if (++frameCount > maxBootstrapFrames) throw new IllegalArgumentException("Protocol v2 bootstrap frame count exceeds the accepted limit");
                        receiveFrame(frame, this);
                        synchronized (this) {
                            if (detached || closed) return;
                        }
                    }
                }
                decoder.finish();
            } catch (SocketTimeoutException error) {
                reportError(remoteAddress, new IOException("Protocol v2 bootstrap timed out", error));
            } catch (Exception error) {
                reportError(remoteAddress, error);
            } finally {
                boolean shouldClose;
                synchronized (this) {
                    readLoopThread = null;
                    shouldClose = !detached;
                }
                if (shouldClose) close();
            }
        }

        @Override public void close() {
            synchronized (this) {
                if (closed || detached) return;
                closed = true;
            }
            try { socket.close(); } catch (IOException ignored) { }
            unregister(this);
            try { controlHandler.onConnectionClosed(binding); } catch (RuntimeException ignored) { }
        }
    }

    private final ControlHandler controlHandler;
    private final TransferHandler transferHandler;
    private final Listener listener;
    private final Executor callbackExecutor;
    private final int maxConnections;
    private final int maxConnectionsPerIp;
    private final int bootstrapTimeoutMs;
    private final int maxBootstrapBytes;
    private final int maxBootstrapFrames;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Object connectionsLock = new Object();
    private final Set<Connection> connections = new HashSet<>();
    private final Map<String, Integer> connectionsPerIp = new HashMap<>();
    private volatile ServerSocket serverSocket;
    private volatile boolean running;

    V2LanService(ControlHandler handler, Listener listener) {
        this(handler, null, listener, Runnable::run, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS_PER_IP,
            DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_MAX_BOOTSTRAP_BYTES, DEFAULT_MAX_BOOTSTRAP_FRAMES);
    }

    V2LanService(ControlHandler handler, TransferHandler transferHandler, Listener listener) {
        this(handler, transferHandler, listener, Runnable::run, DEFAULT_MAX_CONNECTIONS,
            DEFAULT_MAX_CONNECTIONS_PER_IP, DEFAULT_BOOTSTRAP_TIMEOUT_MS,
            DEFAULT_MAX_TRANSFER_BOOTSTRAP_BYTES, DEFAULT_MAX_BOOTSTRAP_FRAMES);
    }

    V2LanService(ControlHandler handler, Listener listener, Executor callbackExecutor, int maxConnections,
                 int maxConnectionsPerIp, int bootstrapTimeoutMs, int maxBootstrapBytes, int maxBootstrapFrames) {
        this(handler, null, listener, callbackExecutor, maxConnections, maxConnectionsPerIp,
            bootstrapTimeoutMs, maxBootstrapBytes, maxBootstrapFrames);
    }

    V2LanService(ControlHandler handler, TransferHandler transferHandler, Listener listener,
                 Executor callbackExecutor, int maxConnections, int maxConnectionsPerIp,
                 int bootstrapTimeoutMs, int maxBootstrapBytes, int maxBootstrapFrames) {
        if (handler == null || listener == null || callbackExecutor == null) throw new IllegalArgumentException("Handler, listener, and callback executor are required");
        if (maxConnections <= 0 || maxConnectionsPerIp <= 0 || bootstrapTimeoutMs <= 0 || maxBootstrapBytes <= 0 || maxBootstrapFrames <= 0) throw new IllegalArgumentException("Bootstrap transport limits must be positive");
        this.controlHandler = handler; this.transferHandler = transferHandler;
        this.listener = listener; this.callbackExecutor = callbackExecutor;
        this.maxConnections = maxConnections; this.maxConnectionsPerIp = maxConnectionsPerIp;
        this.bootstrapTimeoutMs = bootstrapTimeoutMs; this.maxBootstrapBytes = maxBootstrapBytes; this.maxBootstrapFrames = maxBootstrapFrames;
    }

    synchronized int start(int port) throws IOException {
        if (running) return serverSocket.getLocalPort();
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(port));
        socket.setSoTimeout(1000);
        serverSocket = socket;
        running = true;
        io.execute(this::acceptLoop);
        reportStatus("v2 bootstrap listener started on port " + socket.getLocalPort());
        return socket.getLocalPort();
    }

    Connection connect(String host, int port, String expectedDeviceId) throws IOException {
        assertEndpoint(host, port, expectedDeviceId);
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), bootstrapTimeoutMs);
            return register(socket, expectedDeviceId);
        } catch (IOException | RuntimeException error) {
            try { socket.close(); } catch (IOException ignored) { }
            throw error;
        }
    }

    @Override public void close() {
        running = false;
        ServerSocket listenerSocket = serverSocket;
        serverSocket = null;
        if (listenerSocket != null) try { listenerSocket.close(); } catch (IOException ignored) { }
        List<Connection> copy;
        synchronized (connectionsLock) { copy = new ArrayList<>(connections); }
        for (Connection connection : copy) connection.close();
        io.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                ServerSocket listenerSocket = serverSocket;
                if (listenerSocket == null) return;
                Socket socket = listenerSocket.accept();
                try {
                    Connection connection = register(socket, null);
                    connection.startReadLoop();
                }
                catch (IOException | RuntimeException error) {
                    String remote = socket.getInetAddress() == null ? "unknown" : socket.getInetAddress().getHostAddress();
                    try { socket.close(); } catch (IOException ignored) { }
                    reportError(remote, error);
                }
            } catch (SocketTimeoutException ignored) { }
            catch (SocketException error) { if (running) reportError("listener", error); return; }
            catch (IOException error) { if (running) reportError("listener", error); }
        }
    }

    private Connection register(Socket socket, String expectedDeviceId) throws IOException {
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(bootstrapTimeoutMs);
        Connection connection = new Connection(socket, expectedDeviceId);
        synchronized (connectionsLock) {
            if (connections.size() >= maxConnections) throw new IOException("Too many protocol v2 connections");
            int count = connectionsPerIp.containsKey(connection.remoteAddress) ? connectionsPerIp.get(connection.remoteAddress) : 0;
            if (count >= maxConnectionsPerIp) throw new IOException("Too many protocol v2 connections from this address");
            connections.add(connection);
            connectionsPerIp.put(connection.remoteAddress, count + 1);
        }
        return connection;
    }

    private void unregister(Connection connection) {
        synchronized (connectionsLock) {
            if (!connections.remove(connection)) return;
            int count = connectionsPerIp.containsKey(connection.remoteAddress) ? connectionsPerIp.get(connection.remoteAddress) : 0;
            if (count <= 1) connectionsPerIp.remove(connection.remoteAddress); else connectionsPerIp.put(connection.remoteAddress, count - 1);
        }
    }

    private void receiveFrame(V2WireFrame.Frame frame, Connection connection) throws Exception {
        Binding binding = connection.binding;
        Object typeValue = frame.header.opt("type");
        if (!(typeValue instanceof String)) throw new IllegalArgumentException("Pairing wire frame type is invalid");
        String type = (String) typeValue;
        if (V2TransferMessage.TYPE_MANIFEST.equals(type)) {
            if (transferHandler == null) {
                throw new IllegalArgumentException("This service only accepts pairing control frames");
            }
            synchronized (connection) {
                if (connection.transferManifestDispatched || binding.pairingId != null || binding.remoteDeviceId != null) {
                    throw new IllegalArgumentException("Transfer manifest must be the first and only bootstrap frame");
                }
                connection.transferManifestDispatched = true;
            }
            transferHandler.onManifestFrame(frame, connection);
            synchronized (connection) {
                if (!connection.detached && !connection.closed) connection.close();
            }
            return;
        }
        if (connection.transferManifestDispatched || (!V2Pairing.TYPE_OFFER.equals(type)
            && !V2Pairing.TYPE_CONFIRM.equals(type) && !V2Pairing.TYPE_CANCEL.equals(type))) {
            throw new IllegalArgumentException("This service only accepts pairing control frames");
        }
        V2ControlMessage.Message message = V2ControlMessage.decode(type, frame.payload);
        if (V2Pairing.TYPE_OFFER.equals(type)) {
            assertOrBind(binding, message.offer.pairingId, message.offer.identity.deviceId);
            controlHandler.onOffer(message.offer, message.signature, connection);
            connection.activatePairingDeadline();
        } else if (V2Pairing.TYPE_CONFIRM.equals(type)) {
            assertBound(binding, message.confirmation.pairingId, message.confirmation.deviceId);
            controlHandler.onConfirmation(message.confirmation, message.signature, connection);
        } else {
            assertBound(binding, message.cancellation.pairingId, message.cancellation.deviceId);
            controlHandler.onCancellation(message.cancellation, message.signature, connection);
        }
    }

    private static void assertTransferManifestIsIsolated(List<V2WireFrame.Frame> frames, int bufferedBytes) {
        boolean containsManifest = false;
        for (V2WireFrame.Frame frame : frames) {
            if (V2TransferMessage.TYPE_MANIFEST.equals(frame.header.opt("type"))) {
                containsManifest = true;
                break;
            }
        }
        if (containsManifest && (frames.size() != 1 || bufferedBytes != 0)) {
            throw new IllegalArgumentException("Transfer manifest must be the first and only bootstrap frame");
        }
    }

    private static void assertOrBind(Binding binding, String pairingId, String deviceId) {
        if (binding.expectedDeviceId != null && !binding.expectedDeviceId.equals(deviceId)) throw new IllegalArgumentException("Remote identity does not match the selected discovery peer");
        if (binding.pairingId != null && !binding.pairingId.equals(pairingId)) throw new IllegalArgumentException("A connection cannot carry multiple pairing IDs");
        if (binding.remoteDeviceId != null && !binding.remoteDeviceId.equals(deviceId)) throw new IllegalArgumentException("A connection cannot switch remote identities");
        binding.pairingId = pairingId; binding.remoteDeviceId = deviceId;
    }

    private static void assertBound(Binding binding, String pairingId, String deviceId) {
        if (binding.pairingId == null || binding.remoteDeviceId == null) throw new IllegalArgumentException("A pairing offer is required before this message");
        if (!binding.pairingId.equals(pairingId) || !binding.remoteDeviceId.equals(deviceId)) throw new IllegalArgumentException("Pairing message does not match the connection binding");
    }

    private static void assertEndpoint(String host, int port, String expectedDeviceId) {
        if (host == null || host.trim().isEmpty() || port < 1 || port > 65535 || expectedDeviceId == null || !expectedDeviceId.matches("^[a-f0-9]{16}$")) throw new IllegalArgumentException("A valid v2 discovery peer endpoint is required");
    }

    private void reportStatus(String message) { callbackExecutor.execute(() -> listener.onStatus(message)); }
    private void reportError(String remoteAddress, Exception error) { callbackExecutor.execute(() -> listener.onProtocolError(remoteAddress, error)); }
}
