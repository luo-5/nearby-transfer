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
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

final class HttpTransferServer {
    private static final int REQUEST_BODY_LIMIT = 1024 * 1024;
    private static final int MAX_FRAME_BYTES = 16 * 1024 * 1024;
    private static final int MAX_HEADER_LINE_BYTES = 8192;
    private static final int SOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
    private static final long PENDING_TTL_MS = 5 * 60 * 1000;
    private static final long PROGRESS_MIN_BYTES = 1024 * 1024;
    private static final long PROGRESS_MIN_MS = 250;

    private final DeviceConfig device;
    private SaveTarget saveTarget;
    private final IncomingDecision incomingDecision;
    private final TransferEventSink eventSink;
    private final Map<String, PendingTransfer> pending = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final ScheduledExecutorService cleanup = Executors.newSingleThreadScheduledExecutor();

    private volatile boolean running;
    private ServerSocket serverSocket;
    private int port;

    HttpTransferServer(DeviceConfig device, SaveTarget saveTarget, IncomingDecision incomingDecision, TransferEventSink eventSink) {
        this.device = device;
        this.saveTarget = saveTarget;
        this.incomingDecision = incomingDecision;
        this.eventSink = eventSink;
    }

    int start(int requestedPort) throws IOException {
        serverSocket = new ServerSocket(requestedPort);
        port = serverSocket.getLocalPort();
        running = true;
        workers.execute(this::acceptLoop);
        cleanup.scheduleAtFixedRate(this::cleanupPending, 30, 30, TimeUnit.SECONDS);
        return port;
    }

    void stop() {
        running = false;
        try {
            if (serverSocket != null) {
                serverSocket.close();
            }
        } catch (IOException ignored) {
        }
        workers.shutdownNow();
        cleanup.shutdownNow();
    }

    void setSaveTarget(SaveTarget saveTarget) {
        this.saveTarget = saveTarget;
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                socket.setSoTimeout(SOCKET_IDLE_TIMEOUT_MS);
                workers.execute(() -> handleSocket(socket));
            } catch (IOException error) {
                if (running) {
                    eventSink.onTransferEvent(new TransferEvent("system", "system", "failed", "HTTP", 0, 0, error.getMessage()));
                }
            }
        }
    }

    private void handleSocket(Socket socket) {
        try (Socket ignored = socket) {
            HttpRequest request = HttpRequest.read(socket.getInputStream());
            OutputStream output = socket.getOutputStream();
            if ("GET".equals(request.method) && "/health".equals(request.path)) {
                respondJson(output, 200, jsonObject("ok", true, "deviceId", device.deviceId));
                return;
            }
            if ("POST".equals(request.method) && "/transfer/request".equals(request.path)) {
                handleTransferRequest(request, output);
                return;
            }
            if ("POST".equals(request.method) && request.path.startsWith("/transfer/upload/")) {
                String transferId = URLDecoder.decode(request.path.substring("/transfer/upload/".length()), "UTF-8");
                handleUpload(transferId, request, output);
                return;
            }
            respondJson(output, 404, jsonObject("ok", false, "error", "Not found"));
        } catch (Exception error) {
            try {
                respondJson(socket.getOutputStream(), 500, jsonObject("ok", false, "error", error.getMessage()));
            } catch (Exception ignored) {
            }
        }
    }

    private void handleTransferRequest(HttpRequest request, OutputStream output) throws Exception {
        String body = request.readBodyText(REQUEST_BODY_LIMIT);
        JSONObject payload = new JSONObject(body);
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
        IncomingTransfer incoming = new IncomingTransfer(
            transferId,
            sender,
            safeName,
            fileJson.getLong("size"),
            fileJson.getString("sha256"),
            saveTarget.displayPathFor(safeName)
        );

        byte[] key = CryptoUtil.deriveTransferKey(device.encryptionPrivateKey, payload.getString("senderEphemeralPublicKey"), transferId);
        boolean accepted = incomingDecision.confirm(incoming);
        if (!accepted) {
            eventSink.onTransferEvent(new TransferEvent(transferId, "receive", "rejected", safeName, 0, incoming.size, null));
            respondJson(output, 200, jsonObject("accepted", false));
            return;
        }

        SaveTarget.PendingSave pendingSave = saveTarget.prepare(safeName);
        pending.put(transferId, new PendingTransfer(System.currentTimeMillis(), key, sender, safeName, incoming.size, incoming.sha256, pendingSave));
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

    private static String validateTransferRequest(JSONObject payload) {
        if (!payload.has("transferId")) return "Missing transfer ID";
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
        long now = System.currentTimeMillis();
        for (Map.Entry<String, PendingTransfer> entry : pending.entrySet()) {
            PendingTransfer transfer = entry.getValue();
            if (now - transfer.createdAt > PENDING_TTL_MS && pending.remove(entry.getKey(), transfer)) {
                transfer.pendingSave.abort();
                eventSink.onTransferEvent(new TransferEvent(entry.getKey(), "receive", "failed", transfer.fileName, 0, transfer.size, "传输请求已过期"));
            }
        }
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
                throw new IOException("Empty HTTP request");
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                throw new IOException("Invalid HTTP request line");
            }
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
                }
            }
            return new HttpRequest(parts[0], parts[1], headers, input);
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

        InputStream bodyStream() {
            String transferEncoding = headers.get("transfer-encoding");
            if (transferEncoding != null && transferEncoding.toLowerCase(Locale.ROOT).contains("chunked")) {
                return new ChunkedInputStream(input);
            }
            long contentLength = Long.parseLong(headers.getOrDefault("content-length", "0"));
            return new FixedLengthInputStream(input, contentLength);
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
                    throw new IOException("HTTP header line is too long");
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
                remainingInChunk = Long.parseLong(sizeText.trim(), 16);
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
