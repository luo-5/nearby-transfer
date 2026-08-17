package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;

final class DiscoveryAnnouncement {
    static final int MAX_BYTES = 16 * 1024;

    private static final String APP_ID = "nearby-transfer";
    private static final int PROTOCOL_VERSION = 1;
    private static final int MAX_DEVICE_NAME_LENGTH = 128;
    private static final int MAX_PUBLIC_KEY_LENGTH = 4096;
    private static final int MAX_FINGERPRINT_LENGTH = 64;

    private DiscoveryAnnouncement() {}

    static PeerDevice parse(byte[] data, int offset, int length, String host, String localDeviceId, long lastSeen) {
        if (data == null || offset < 0 || length <= 0 || length > MAX_BYTES || offset > data.length - length) {
            return null;
        }

        try {
            JSONObject payload = new JSONObject(new String(data, offset, length, StandardCharsets.UTF_8));
            return parsePayload(payload, host, localDeviceId, lastSeen);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static PeerDevice parsePayload(JSONObject payload, String host, String localDeviceId, long lastSeen) throws Exception {
        if (!APP_ID.equals(strictString(payload, "app", APP_ID.length())) ||
            strictInteger(payload, "protocolVersion") != PROTOCOL_VERSION ||
            !"announce".equals(strictString(payload, "type", "announce".length()))) {
            return null;
        }

        String deviceId = strictString(payload, "deviceId", 16);
        if (!deviceId.matches("[a-f0-9]{16}") || deviceId.equals(localDeviceId)) {
            return null;
        }

        String deviceName = strictString(payload, "deviceName", MAX_DEVICE_NAME_LENGTH);
        String signingPublicKey = strictString(payload, "signingPublicKey", MAX_PUBLIC_KEY_LENGTH);
        String encryptionPublicKey = strictString(payload, "encryptionPublicKey", MAX_PUBLIC_KEY_LENGTH);
        String fingerprint = strictString(payload, "fingerprint", MAX_FINGERPRINT_LENGTH);
        int port = strictInteger(payload, "port");
        if (port < 1 || port > 65535) {
            return null;
        }

        if (!deviceId.equals(CryptoUtil.deviceIdFor(signingPublicKey)) ||
            !fingerprint.equals(CryptoUtil.fingerprintFor(signingPublicKey))) {
            return null;
        }

        PublicKey signingKey = CryptoUtil.readPublicKey(signingPublicKey, "Ed25519");
        PublicKey encryptionKey = CryptoUtil.readPublicKey(encryptionPublicKey, "X25519");
        if (!"Ed25519".equalsIgnoreCase(signingKey.getAlgorithm()) ||
            !"X25519".equalsIgnoreCase(encryptionKey.getAlgorithm())) {
            return null;
        }

        return new PeerDevice(
            deviceId,
            deviceName,
            host,
            port,
            signingPublicKey,
            encryptionPublicKey,
            fingerprint,
            lastSeen
        );
    }

    private static String strictString(JSONObject payload, String key, int maxLength) throws Exception {
        Object value = payload.get(key);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException("Expected string field: " + key);
        }
        String text = (String) value;
        if (text.trim().isEmpty() || text.length() > maxLength) {
            throw new IllegalArgumentException("Invalid string field: " + key);
        }
        return text;
    }

    private static int strictInteger(JSONObject payload, String key) throws Exception {
        Object value = payload.get(key);
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException("Expected numeric field: " + key);
        }
        try {
            return new BigDecimal(value.toString()).intValueExact();
        } catch (NumberFormatException | ArithmeticException error) {
            throw new IllegalArgumentException("Expected integer field: " + key, error);
        }
    }
}
