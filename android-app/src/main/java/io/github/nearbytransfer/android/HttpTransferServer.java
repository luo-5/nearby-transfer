package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

final class HttpTransferServer {
    private static final int REQUEST_BODY_LIMIT = 1024 * 1024;
    private static final int MAX_FRAME_BYTES = 16 * 1024 * 1024;
    private static final int MAX_HEADER_LINE_BYTES = 8192;
    private static final int SOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
    private static final int MAX_ACTIVE_CONNECTIONS = 16;
    private static final long PENDING_TTL_MS = 5 * 60 * 1000;
    private static final long PROGRESS_MIN_BYTES = 1024 * 1024;
    private static final long PROGRESS_MIN_MS = 250;
    private static final Pattern CANONICAL_UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", Pattern.CASE_INSENSITIVE);

    private final DeviceConfig device;
    private volatile SaveTarget saveTarget;
    private final IncomingDecision incomingDecision;
    private final TransferEventSink eventSink;
    private final Map<String, PendingTransfer> pending = new ConcurrentHashMap<>();
    private final RuntimeFactory runtimeFactory;
    private final Object lifecycleLock = new Object();
    private final int maxActiveConnections;
    private final Set<Socket> activeSockets = ConcurrentHashMap.newKeySet();

    private volatile boolean running;
    private volatile ServerSocket serverSocket;
    private volatile ExecutorService workers;
    private volatile ScheduledExecutorService cleanup;
    private volatile Semaphore connectionPermits;
    private volatile int port;

    HttpTransferServer(DeviceConfig device, SaveTarget saveTarget, IncomingDecision incomingDecision, TransferEventSink eventSink) {
        this(device, saveTarget, incomingDecision, eventSink, RuntimeFactory.DEFAULT, MAX_ACTIVE_CONNECTIONS);
    }

    HttpTransferServer(
        DeviceConfig device,
        SaveTarget saveTarget,
        IncomingDecision incomingDecision,
        TransferEventSink eventSink,
        RuntimeFactory runtimeFactory
    ) {
        this(device, saveTarget, incomingDecision, eventSink, runtimeFactory, MAX_ACTIVE_CONNECTIONS);
    }

    HttpTransferServer(
        DeviceConfig device,
        SaveTarget saveTarget,
        IncomingDecision incomingDecision,
        TransferEventSink eventSink,
        RuntimeFactory runtimeFactory,
        int maxActiveConnections
    ) {
        if (maxActiveConnections <= 0) {
            throw new IllegalArgumentException("maxActiveConnections must be positive");
        }
        this.device = device;
        this.saveTarget = saveTarget;
        this.incomingDecision = incomingDecision;
        this.eventSink = eventSink;
        this.runtimeFactory = runtimeFactory;
        this.maxActiveConnections = maxActiveConnections;
    }

    int start(int requestedPort) throws IOException {
        synchronized (lifecycleLock) {
            if (running) {
                return port;
            }

            ServerSocket createdSocket = null;
            ExecutorService createdWorkers = null;
            ScheduledExecutorService createdCleanup = null;
            Semaphore createdConnectionPermits = null;
            try {
                createdSocket = runtimeFactory.openServerSocket(requestedPort);
                createdWorkers = runtimeFactory.newWorkerExecutor();
                createdCleanup = runtimeFactory.newCleanupExecutor();
                createdConnectionPermits = new Semaphore(maxActiveConnections);

                serverSocket = createdSocket;
                workers = createdWorkers;
                cleanup = createdCleanup;
                connectionPermits = createdConnectionPermits;
                port = createdSocket.getLocalPort();
                running = true;

                ServerSocket acceptSocket = createdSocket;
                ExecutorService acceptWorkers = createdWorkers;
                Semaphore acceptConnectionPermits = createdConnectionPermits;
                createdWorkers.execute(() -> acceptLoop(acceptSocket, acceptWorkers, acceptConnectionPermits));
                ScheduledExecutorService cleanupRuntime = createdCleanup;
                createdCleanup.scheduleAtFixedRate(() -> cleanupPending(cleanupRuntime), 30, 30, TimeUnit.SECONDS);
                return port;
            } catch (Throwable error) {
                running = false;
                port = 0;
                serverSocket = null;
                workers = null;
                cleanup = null;
                connectionPermits = null;
                closeQuietly(createdSocket);
                closeActiveSockets();
                shutdownNowQuietly(createdCleanup);
                shutdownNowQuietly(createdWorkers);
                if (error instanceof IOException) {
                    throw (IOException) error;
                }
                if (error instanceof RuntimeException) {
                    throw (RuntimeException) error;
                }
                if (error instanceof Error) {
                    throw (Error) error;
                }
                throw new IOException("Unable to start HTTP transfer server", error);
            }
        }
    }

    void stop() {
        List<PendingTransfer> transfersToAbort;
        synchronized (lifecycleLock) {
            running = false;
            port = 0;

            ServerSocket socketToClose = serverSocket;
            ExecutorService workersToStop = workers;
            ScheduledExecutorService cleanupToStop = cleanup;
            serverSocket = null;
            workers = null;
            cleanup = null;
            connectionPermits = null;

            closeQuietly(socketToClose);
            closeActiveSockets();
            shutdownNowQuietly(cleanupToStop);
            shutdownNowQuietly(workersToStop);
            transfersToAbort = removeAllPending();
        }

        for (PendingTransfer transfer : transfersToAbort) {
            abortQuietly(transfer);
        }
    }

    private static void closeQuietly(ServerSocket socket) {
        if (socket == null) {
            return;
        }
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    private static void closeQuietly(Socket socket) {
        if (socket == null) {
            return;
        }
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    private void closeActiveSockets() {
        for (Socket socket : activeSockets) {
            closeQuietly(socket);
        }
    }

    private static void shutdownNowQuietly(ExecutorService executor) {
        if (executor == null) {
            return;
        }
        try {
            executor.shutdownNow();
        } catch (RuntimeException ignored) {
        }
    }

    private List<PendingTransfer> removeAllPending() {
        List<PendingTransfer> removed = new ArrayList<>();
        for (Map.Entry<String, PendingTransfer> entry : pending.entrySet()) {
            PendingTransfer transfer = entry.getValue();
            if (pending.remove(entry.getKey(), transfer)) {
                removed.add(transfer);
            }
        }
        return removed;
    }

    void setSaveTarget(SaveTarget saveTarget) {
        this.saveTarget = saveTarget;
    }

    private void acceptLoop(ServerSocket acceptSocket, ExecutorService acceptWorkers, Semaphore acceptConnectionPermits) {
        while (isActiveRuntime(acceptSocket, acceptWorkers)) {
            Socket socket = null;
            try {
                socket = acceptSocket.accept();
                socket.setSoTimeout(SOCKET_IDLE_TIMEOUT_MS);
                if (!acceptConnectionPermits.tryAcquire()) {
                    closeQuietly(socket);
                    socket = null;
                    continue;
                }
                if (!isActiveRuntime(acceptSocket, acceptWorkers)) {
                    acceptConnectionPermits.release();
                    closeQuietly(socket);
                    socket = null;
                    continue;
                }
                Socket acceptedSocket = socket;
                activeSockets.add(acceptedSocket);
                acceptWorkers.execute(() -> handleSocket(acceptedSocket, acceptConnectionPermits));
                socket = null;
            } catch (IOException | RuntimeException error) {
                if (socket != null && activeSockets.remove(socket)) {
                    acceptConnectionPermits.release();
                }
                closeQuietly(socket);
                if (isActiveRuntime(acceptSocket, acceptWorkers)) {
                    eventSink.onTransferEvent(new TransferEvent("system", "system", "failed", "HTTP", 0, 0, error.getMessage()));
                }
            }
        }
    }

    private boolean isActiveRuntime(ServerSocket expectedSocket, ExecutorService expectedWorkers) {
        return running && serverSocket == expectedSocket && workers == expectedWorkers;
    }

    private void handleSocket(Socket socket, Semaphore permits) {
        try {
            OutputStream output = socket.getOutputStream();
            try {
                HttpRequest request = HttpRequest.read(socket.getInputStream());
                if ("GET".equals(request.method) && "/health".equals(request.path)) {
                    respondJson(output, 200, jsonObject("ok", true, "deviceId", device.deviceId));
                    return;
                }
                if ("POST".equals(request.method) && "/transfer/request".equals(request.path)) {
                    handleTransferRequest(request, output);
                    return;
                }
                if ("POST".equals(request.method) && request.path.startsWith("/transfer/upload/")) {
                    String transferId = decodePathSegment(request.path.substring("/transfer/upload/".length()));
                    if (!isCanonicalTransferId(transferId)) {
                        respondJson(output, 400, jsonObject("ok", false, "error", "Invalid transfer ID"));
                        return;
                    }
                    handleUpload(transferId, request, output);
                    return;
                }
                respondJson(output, 404, jsonObject("ok", false, "error", "Not found"));
            } catch (BadHttpRequestException error) {
                respondJson(output, 400, jsonObject("ok", false, "error", error.getMessage()));
            } catch (Exception error) {
                respondJson(output, 500, jsonObject("ok", false, "error", error.getMessage()));
            }
        } catch (Exception ignored) {
        } finally {
            closeQuietly(socket);
            activeSockets.remove(socket);
            permits.release();
        }
    }

    private void handleTransferRequest(HttpRequest request, OutputStream output) throws Exception {
        String body = request.readBodyText(REQUEST_BODY_LIMIT);
        JSONObject payload;
        try {
            payload = new JSONObject(body);
        } catch (RuntimeException error) {
            respondJson(output, 400, jsonObject("ok", false, "error", "Invalid JSON body"));
            return;
        }
        String validationError = validateTransferRequest(payload);
        if (validationError != null) {
            eventSink.onTransferEvent(new TransferEvent("request-error", "system", "failed", "传输请求", 0, 0, "请求格式错误：" + validationError));
            respondJson(output, 400, jsonObject("ok", false, "error", validationError));
            return;
        }

        JSONObject senderJson = payload.getJSONObject("sender");
        JSONObject fileJson = payload.getJSONObject("file");
        String transferId = payload.getString("transferId");
        String safeName = safeFilename(fileJson.getString("name"));
        eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "requesting", safeName, 0, fileJson.getLong("size"), "收到来自 " + senderJson.getString("deviceName") + " 的请求"));
        if (!CryptoUtil.verify(JsonUtil.canonicalTransferRequestPayload(payload), payload.getString("signature"), senderJson.getString("signingPublicKey"))) {
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "failed", safeName, 0, fileJson.getLong("size"), "请求签名校验失败"));
            respondJson(output, 400, jsonObject("ok", false, "error", "Invalid transfer request signature"));
            return;
        }
        if (!senderJson.getString("fingerprint").equals(CryptoUtil.fingerprintFor(senderJson.getString("signingPublicKey")))) {
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "failed", safeName, 0, fileJson.getLong("size"), "发送方指纹不匹配"));
            respondJson(output, 400, jsonObject("ok", false, "error", "Sender fingerprint does not match identity key"));
            return;
        }
        if (!senderJson.getString("deviceId").equals(CryptoUtil.deviceIdFor(senderJson.getString("signingPublicKey")))) {
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "failed", safeName, 0, fileJson.getLong("size"), "发送方设备 ID 不匹配"));
            respondJson(output, 400, jsonObject("ok", false, "error", "Sender device ID does not match identity key"));
            return;
        }

        PeerDevice sender = new PeerDevice(
            senderJson.getString("deviceId"),
            senderJson.getString("deviceName"),
            "",
            0,
            senderJson.getString("signingPublicKey"),
            "",
            senderJson.getString("fingerprint"),
            System.currentTimeMillis()
        );
        SaveTarget requestSaveTarget = saveTarget;
        IncomingTransfer incoming = new IncomingTransfer(
            transferId,
            sender,
            safeName,
            fileJson.getLong("size"),
            fileJson.getString("sha256"),
            requestSaveTarget.displayPathFor(safeName)
        );

        byte[] key;
        try {
            key = CryptoUtil.deriveTransferKey(
                device.encryptionPrivateKey,
                payload.getString("senderEphemeralPublicKey"),
                transferId
            );
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            eventSink.onTransferEvent(new TransferEvent(
                transferId,
                "receive",
                "failed",
                safeName,
                0,
                fileJson.getLong("size"),
                "发送方临时公钥无效"
            ));
            respondJson(output, 400, jsonObject("ok", false, "error", "Invalid sender ephemeral public key"));
            return;
        }
        boolean accepted = incomingDecision.confirm(incoming);
        if (!accepted) {
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "rejected", safeName, 0, incoming.size, null));
            respondJson(output, 200, jsonObject("accepted", false));
            return;
        }

        SaveTarget.PendingSave pendingSave = requestSaveTarget.prepare(safeName);
        PendingTransfer transfer = new PendingTransfer(System.currentTimeMillis(), key, sender, safeName, incoming.size, incoming.sha256, pendingSave);
        boolean registered;
        synchronized (lifecycleLock) {
            registered = running && pending.putIfAbsent(transferId, transfer) == null;
        }
        if (!registered) {
            abortQuietly(transfer);
            String error = running ? "Transfer ID is already pending" : "Transfer server is stopping";
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "failed", safeName, 0, incoming.size, error));
            respondJson(output, 409, jsonObject("accepted", false, "error", error));
            return;
        }
        eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "accepted", safeName, 0, incoming.size, null));
        respondJson(output, 200, jsonObject("accepted", true, "transferId", transferId));
    }

    private void handleUpload(String transferId, HttpRequest request, OutputStream output) throws Exception {
        PendingTransfer transfer = pending.remove(transferId);
        if (transfer == null) {
            respondJson(output, 404, jsonObject("ok", false, "error", "Transfer is not pending or was already used"));
            return;
        }

        MessageDigest hash = CryptoUtil.sha256Digest();
        long received = 0;
        ProgressLimiter progressLimiter = new ProgressLimiter();
        try {
            try (InputStream body = request.bodyStream(); OutputStream fileOutput = transfer.pendingSave.openOutputStream()) {
                while (true) {
                    byte[] lengthBytes = readOptional(body, 4);
                    if (lengthBytes == null) {
                        break;
                    }
                    int encryptedLength = ByteBuffer.wrap(lengthBytes).getInt();
                    if (encryptedLength < 0 || encryptedLength > MAX_FRAME_BYTES) {
                        throw new IOException("Encrypted frame is too large");
                    }
                    byte[] iv = readFully(body, 12);
                    byte[] tag = readFully(body, 16);
                    byte[] ciphertext = readFully(body, encryptedLength);
                    byte[] plain = CryptoUtil.decryptFrame(transfer.key, iv, tag, ciphertext);
                    if (received + plain.length > transfer.size) {
                        throw new IOException("Received file is larger than declared size");
                    }
                    fileOutput.write(plain);
                    hash.update(plain);
                    received += plain.length;
                    if (progressLimiter.shouldEmit(plain.length, received, transfer.size)) {
                        eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "receiving", transfer.fileName, received, transfer.size, null));
                    }
                }
            }

            String actualSha256 = CryptoUtil.hexLower(hash.digest());
            if (received != transfer.size) {
                throw new IOException("Received file size does not match metadata");
            }
            if (!actualSha256.equalsIgnoreCase(transfer.sha256)) {
                throw new IOException("SHA-256 verification failed");
            }

            transfer.pendingSave.commit();

            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "completed", transfer.fileName, received, transfer.size, transfer.pendingSave.displayPath()));
            respondJson(output, 200, jsonObject("ok", true, "sha256", actualSha256, "path", transfer.pendingSave.displayPath()));
        } catch (Exception error) {
            transfer.pendingSave.abort();
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "failed", transfer.fileName, received, transfer.size, error.getMessage()));
            respondJson(output, 400, jsonObject("ok", false, "error", error.getMessage()));
        }
    }

    private static String decodePathSegment(String value) throws BadHttpRequestException {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception error) {
            throw new BadHttpRequestException("Invalid URL encoding");
        }
    }

    private static boolean isCanonicalTransferId(String value) {
        return value != null && CANONICAL_UUID.matcher(value).matches();
    }

    private static String validateTransferRequest(JSONObject payload) {
        if (!payload.has("transferId")) return "Missing transfer ID";
        if (!isCanonicalTransferId(payload.optString("transferId", ""))) return "Invalid transfer ID";
        if (payload.optInt("protocolVersion") != 1) return "Unsupported protocol version";
        if (!payload.has("sender")) return "Missing sender metadata";
        if (!payload.has("file")) return "Missing file metadata";
        if (!payload.has("senderEphemeralPublicKey")) return "Missing sender ephemeral public key";
        if (!payload.has("signature")) return "Missing transfer request signature";
        JSONObject sender = payload.optJSONObject("sender");
        if (sender == null || sender.optString("deviceId").isEmpty() || sender.optString("deviceName").isEmpty()
            || sender.optString("fingerprint").isEmpty() || sender.optString("signingPublicKey").isEmpty()) {
            return "Incomplete sender metadata";
        }
        JSONObject file = payload.optJSONObject("file");
        if (file == null || file.optString("name").isEmpty()) return "Missing file name";
        if (file.optLong("size", -1) < 0) return "Invalid file size";
        if (!file.optString("sha256").matches("(?i)^[a-f0-9]{64}$")) return "Invalid file hash";
        return null;
    }

    static String safeFilename(String fileName) {
        String name = fileName == null || fileName.trim().isEmpty() ? "file" : new File(fileName).getName();
        String safe = name.replaceAll("[<>:\"/\\\\|?*\\p{Cntrl}]", "_").trim();
        return safe.isEmpty() ? "file" : safe;
    }

    static File uniqueDestination(File directory, String fileName) {
        String safe = safeFilename(fileName);
        int dot = safe.lastIndexOf('.');
        String base = dot > 0 ? safe.substring(0, dot) : safe;
        String ext = dot > 0 ? safe.substring(dot) : "";
        File candidate = new File(directory, safe);
        int index = 1;
        while (candidate.exists()) {
            candidate = new File(directory, base + " (" + index + ")" + ext);
            index += 1;
        }
        return candidate;
    }

    private static byte[] readOptional(InputStream input, int length) throws IOException {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(buffer, offset, length - offset);
            if (read == -1) {
                if (offset == 0) {
                    return null;
                }
                throw new EOFException("Unexpected end of encrypted stream");
            }
            offset += read;
        }
        return buffer;
    }

    private static byte[] readFully(InputStream input, int length) throws IOException {
        byte[] result = readOptional(input, length);
        if (result == null) {
            throw new EOFException("Unexpected end of encrypted stream");
        }
        return result;
    }

    private static JSONObject jsonObject(Object... values) throws Exception {
        JSONObject json = new JSONObject();
        for (int i = 0; i < values.length; i += 2) {
            json.put(String.valueOf(values[i]), values[i + 1]);
        }
        return json;
    }

    private static void respondJson(OutputStream output, int statusCode, JSONObject payload) throws IOException {
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        String statusText = statusCode == 200 ? "OK" : "Error";
        String headers = "HTTP/1.1 " + statusCode + " " + statusText + "\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(body);
        output.flush();
    }

    private void cleanupPending() {
        ScheduledExecutorService expectedCleanup;
        synchronized (lifecycleLock) {
            expectedCleanup = cleanup;
        }
        cleanupPending(expectedCleanup);
    }

    private void cleanupPending(ScheduledExecutorService expectedCleanup) {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, PendingTransfer> entry : pending.entrySet()) {
            PendingTransfer transfer = entry.getValue();
            boolean removed;
            synchronized (lifecycleLock) {
                if (!running || cleanup != expectedCleanup) {
                    return;
                }
                removed = now - transfer.createdAt > PENDING_TTL_MS && pending.remove(entry.getKey(), transfer);
            }
            if (removed) {
                abortQuietly(transfer);
                if (isActiveCleanupRuntime(expectedCleanup)) {
                    eventSink.onTransferEvent(new TransferEvent(entry.getKey(), "receive", "failed", transfer.fileName, 0, transfer.size, "传输请求已过期"));
                }
            }
        }
    }

    private boolean isActiveCleanupRuntime(ScheduledExecutorService expectedCleanup) {
        synchronized (lifecycleLock) {
            return running && cleanup == expectedCleanup;
        }
    }

    private static void abortQuietly(PendingTransfer transfer) {
        try {
            transfer.pendingSave.abort();
        } catch (RuntimeException ignored) {
        }
    }

    interface RuntimeFactory {
        RuntimeFactory DEFAULT = new RuntimeFactory() {
            @Override
            public ServerSocket openServerSocket(int requestedPort) throws IOException {
                return new ServerSocket(requestedPort);
            }

            @Override
            public ExecutorService newWorkerExecutor() {
                return Executors.newCachedThreadPool();
            }

            @Override
            public ScheduledExecutorService newCleanupExecutor() {
                return Executors.newSingleThreadScheduledExecutor();
            }
        };

        ServerSocket openServerSocket(int requestedPort) throws IOException;
        ExecutorService newWorkerExecutor();
        ScheduledExecutorService newCleanupExecutor();
    }

    private static final class PendingTransfer {
        final long createdAt;
        final byte[] key;
        final PeerDevice sender;
        final String fileName;
        final long size;
        final String sha256;
        final SaveTarget.PendingSave pendingSave;

        PendingTransfer(long createdAt, byte[] key, PeerDevice sender, String fileName, long size, String sha256, SaveTarget.PendingSave pendingSave) {
            this.createdAt = createdAt;
            this.key = key;
            this.sender = sender;
            this.fileName = fileName;
            this.size = size;
            this.sha256 = sha256;
            this.pendingSave = pendingSave;
        }
    }

    private static final class ProgressLimiter {
        private long bytesSinceLastEvent;
        private long lastEventAt;

        boolean shouldEmit(long deltaBytes, long currentBytes, long totalBytes) {
            bytesSinceLastEvent += deltaBytes;
            long now = System.currentTimeMillis();
            boolean complete = totalBytes > 0 && currentBytes >= totalBytes;
            if (complete || bytesSinceLastEvent >= PROGRESS_MIN_BYTES || now - lastEventAt >= PROGRESS_MIN_MS) {
                bytesSinceLastEvent = 0;
                lastEventAt = now;
                return true;
            }
            return false;
        }
    }

    private static final class BadHttpRequestException extends IOException {
        BadHttpRequestException(String message) {
            super(message);
        }
    }

    private static final class HttpRequest {
        final String method;
        final String path;
        final Map<String, String> headers;
        final InputStream input;

        private HttpRequest(String method, String path, Map<String, String> headers, InputStream input) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.input = input;
        }

        static HttpRequest read(InputStream input) throws IOException {
            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                throw new BadHttpRequestException("Empty HTTP request");
            }
            String[] parts = requestLine.split(" ", -1);
            if (parts.length != 3 || parts[0].isEmpty() || parts[1].isEmpty() || parts[2].isEmpty()) {
                throw new BadHttpRequestException("Invalid HTTP request line");
            }
            String method = parts[0];
            String requestPath = parts[1];
            String version = parts[2];
            if (!isHttpToken(method) || !method.equals(method.toUpperCase(Locale.ROOT))) {
                throw new BadHttpRequestException("Invalid HTTP method");
            }
            if (!requestPath.startsWith("/") || containsControlCharacters(requestPath) || requestPath.indexOf(' ') >= 0) {
                throw new BadHttpRequestException("Invalid HTTP path");
            }
            if (!"HTTP/1.1".equals(version) && !"HTTP/1.0".equals(version)) {
                throw new BadHttpRequestException("Unsupported HTTP version");
            }

            Map<String, String> headers = new HashMap<>();
            String line;
            while (true) {
                line = readLine(input);
                if (line == null) {
                    throw new BadHttpRequestException("Incomplete HTTP headers");
                }
                if (line.isEmpty()) {
                    break;
                }
                int colon = line.indexOf(':');
                if (colon <= 0) {
                    throw new BadHttpRequestException("Invalid HTTP header");
                }
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(colon + 1).trim();
                if (!isHttpToken(name) || containsControlCharacters(value)) {
                    throw new BadHttpRequestException("Invalid HTTP header");
                }
                if (headers.containsKey(name)) {
                    throw new BadHttpRequestException("Duplicate HTTP header: " + name);
                }
                headers.put(name, value);
            }
            return new HttpRequest(method, requestPath, headers, input);
        }

        String readBodyText(int limit) throws IOException {
            try (InputStream body = bodyStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int total = 0;
                int read;
                while ((read = body.read(buffer)) != -1) {
                    total += read;
                    if (total > limit) {
                        throw new IOException("Request body is too large");
                    }
                    output.write(buffer, 0, read);
                }
                return output.toString("UTF-8");
            }
        }

        InputStream bodyStream() throws BadHttpRequestException {
            String transferEncoding = headers.get("transfer-encoding");
            if (transferEncoding != null) {
                String normalized = transferEncoding.toLowerCase(Locale.ROOT);
                if (!"chunked".equals(normalized)) {
                    throw new BadHttpRequestException("Unsupported transfer encoding");
                }
                return new ChunkedInputStream(input);
            }
            String contentLengthText = headers.getOrDefault("content-length", "0");
            if (!contentLengthText.matches("^[0-9]+$")) {
                throw new BadHttpRequestException("Invalid Content-Length");
            }
            long contentLength;
            try {
                contentLength = Long.parseLong(contentLengthText);
            } catch (NumberFormatException error) {
                throw new BadHttpRequestException("Invalid Content-Length");
            }
            return new FixedLengthInputStream(input, contentLength);
        }

        private static boolean isHttpToken(String value) {
            if (value == null || value.isEmpty()) return false;
            for (int i = 0; i < value.length(); i += 1) {
                char c = value.charAt(i);
                boolean allowed = c == '!' || c == '#' || c == '$' || c == '%' || c == '&' || c == '\''
                    || c == '*' || c == '+' || c == '-' || c == '.' || c == '^' || c == '_' || c == '`'
                    || c == '|' || c == '~' || Character.isDigit(c) || Character.isLetter(c);
                if (!allowed) return false;
            }
            return true;
        }

        private static boolean containsControlCharacters(String value) {
            for (int i = 0; i < value.length(); i += 1) {
                char c = value.charAt(i);
                if (c < 0x20 || c == 0x7f) return true;
            }
            return false;
        }

        private static String readLine(InputStream input) throws IOException {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int previous = -1;
            while (true) {
                int next = input.read();
                if (next == -1) {
                    return output.size() == 0 ? null : output.toString("UTF-8");
                }
                if (previous == '\r' && next == '\n') {
                    byte[] data = output.toByteArray();
                    return new String(data, 0, Math.max(0, data.length - 1), StandardCharsets.UTF_8);
                }
                output.write(next);
                if (output.size() > MAX_HEADER_LINE_BYTES) {
                    throw new BadHttpRequestException("HTTP header line is too long");
                }
                previous = next;
            }
        }
    }

    private static final class FixedLengthInputStream extends InputStream {
        private final InputStream input;
        private long remaining;

        FixedLengthInputStream(InputStream input, long remaining) {
            this.input = input;
            this.remaining = remaining;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int value = input.read();
            if (value != -1) remaining -= 1;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0) return -1;
            int read = input.read(buffer, offset, (int) Math.min(length, remaining));
            if (read != -1) remaining -= read;
            return read;
        }
    }

    private static final class ChunkedInputStream extends InputStream {
        private final InputStream input;
        private long remainingInChunk;
        private boolean done;

        ChunkedInputStream(InputStream input) {
            this.input = input;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int read = read(one, 0, 1);
            return read == -1 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (done) return -1;
            if (remainingInChunk == 0) {
                String line = HttpRequest.readLine(input);
                if (line == null) throw new EOFException("Missing chunk header");
                int semicolon = line.indexOf(';');
                String sizeText = semicolon >= 0 ? line.substring(0, semicolon) : line;
                try {
                    remainingInChunk = Long.parseLong(sizeText.trim(), 16);
                } catch (NumberFormatException error) {
                    throw new BadHttpRequestException("Invalid chunk size");
                }
                if (remainingInChunk < 0) {
                    throw new BadHttpRequestException("Invalid chunk size");
                }
                if (remainingInChunk == 0) {
                    do {
                        line = HttpRequest.readLine(input);
                    } while (line != null && !line.isEmpty());
                    done = true;
                    return -1;
                }
            }
            int read = input.read(buffer, offset, (int) Math.min(length, remainingInChunk));
            if (read == -1) throw new EOFException("Unexpected end of chunked body");
            remainingInChunk -= read;
            if (remainingInChunk == 0) {
                int cr = input.read();
                int lf = input.read();
                if (cr != '\r' || lf != '\n') {
                    throw new IOException("Invalid chunk terminator");
                }
            }
            return read;
        }
    }
}
