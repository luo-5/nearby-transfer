package io.github.nearbytransfer.android;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.UUID;

final class TransferClient {
    private static final long PROGRESS_MIN_BYTES = 1024 * 1024;
    private static final long PROGRESS_MIN_MS = 250;
    private static final int UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

    private TransferClient() {}

    static void send(Context context, DeviceConfig device, PeerDevice peer, SelectedFile selectedFile, TransferEventSink sink) throws Exception {
        if (selectedFile.size < 0) {
            throw new IllegalArgumentException("无法读取文件大小");
        }

        String transferId = UUID.randomUUID().toString();
        sink.onTransferEvent(new TransferEvent(transferId, "send", "preparing", selectedFile.name, 0, selectedFile.size, "正在计算文件校验值"));
        String sha256;
        try (InputStream input = context.getContentResolver().openInputStream(selectedFile.uri)) {
            if (input == null) throw new IllegalArgumentException("无法打开文件");
            sha256 = CryptoUtil.sha256Hex(input);
        }

        KeyPair ephemeral = CryptoUtil.generateX25519KeyPair();
        String ephemeralPublicKey = CryptoUtil.toPublicPem(ephemeral.getPublic());
        byte[] key = CryptoUtil.deriveTransferKey(CryptoUtil.toPrivatePem(ephemeral.getPrivate()), peer.encryptionPublicKey, transferId);

        JSONObject sender = new JSONObject();
        sender.put("deviceId", device.deviceId);
        sender.put("deviceName", device.deviceName);
        sender.put("fingerprint", device.fingerprint);
        sender.put("signingPublicKey", device.signingPublicKey);

        JSONObject file = new JSONObject();
        file.put("name", selectedFile.name);
        file.put("size", selectedFile.size);
        file.put("sha256", sha256);

        JSONObject payload = new JSONObject();
        payload.put("protocolVersion", 1);
        payload.put("transferId", transferId);
        payload.put("sender", sender);
        payload.put("file", file);
        payload.put("senderEphemeralPublicKey", ephemeralPublicKey);
        payload.put("signature", CryptoUtil.sign(JsonUtil.canonicalTransferRequestPayload(payload), device.signingPrivateKey));

        sink.onTransferEvent(new TransferEvent(transferId, "send", "requesting", selectedFile.name, 0, selectedFile.size, peer.deviceName));
        JSONObject decision = postJson(peer, "/transfer/request", payload, 120000);
        if (!decision.optBoolean("accepted")) {
            sink.onTransferEvent(new TransferEvent(transferId, "send", "rejected", selectedFile.name, 0, selectedFile.size, null));
            throw new IllegalStateException("对方已拒绝接收");
        }

        uploadEncrypted(context, peer, transferId, selectedFile, key, sink);
        sink.onTransferEvent(new TransferEvent(transferId, "send", "completed", selectedFile.name, selectedFile.size, selectedFile.size, null));
    }

    private static JSONObject postJson(PeerDevice peer, String path, JSONObject payload, int timeoutMs) throws Exception {
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) new URL("http", peer.host, peer.port, path).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(timeoutMs);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }
        return readJsonResponse(connection);
    }

    private static void uploadEncrypted(Context context, PeerDevice peer, String transferId, SelectedFile selectedFile, byte[] key, TransferEventSink sink) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http", peer.host, peer.port, "/transfer/upload/" + transferId).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(UPLOAD_IDLE_TIMEOUT_MS);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/octet-stream");
        connection.setChunkedStreamingMode(0);

        SecureRandom random = new SecureRandom();
        byte[] prefix = new byte[8];
        random.nextBytes(prefix);
        byte[] buffer = new byte[CryptoUtil.frameSize()];
        long sent = 0;
        int counter = 0;
        ProgressLimiter progressLimiter = new ProgressLimiter();

        try (InputStream input = context.getContentResolver().openInputStream(selectedFile.uri); OutputStream output = connection.getOutputStream()) {
            if (input == null) throw new IllegalArgumentException("无法打开文件");
            int read;
            while ((read = input.read(buffer)) != -1) {
                byte[] frame = CryptoUtil.encryptFrame(key, buffer, 0, read, prefix, counter++);
                output.write(frame);
                sent += read;
                if (progressLimiter.shouldEmit(read, sent, selectedFile.size)) {
                    sink.onTransferEvent(new TransferEvent(transferId, "send", "sending", selectedFile.name, sent, selectedFile.size, null));
                }
            }
        }
        if (sent != selectedFile.size) {
            throw new IllegalStateException("文件大小在发送过程中发生变化");
        }

        JSONObject result = readJsonResponse(connection);
        if (!result.optBoolean("ok", true)) {
            throw new IllegalStateException(result.optString("error", "上传失败"));
        }
    }

    private static JSONObject readJsonResponse(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String body = input == null ? "{}" : readAll(input);
        JSONObject json = body.isEmpty() ? new JSONObject() : new JSONObject(body);
        if (status < 200 || status >= 300) {
            throw new IllegalStateException(json.optString("error", "HTTP " + status));
        }
        return json;
    }

    private static String readAll(InputStream input) throws Exception {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = source.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString("UTF-8");
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
}
