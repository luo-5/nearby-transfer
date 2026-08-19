package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Immutable public identity used by protocol v2 discovery and pairing messages.
 *
 * <p>The PEM text is deliberately retained byte-for-byte: protocol v2 derives
 * deviceId and fingerprint from the UTF-8 PEM representation, rather than the
 * decoded key bytes.</p>
 */
final class V2Identity {
    static final int MAX_DEVICE_NAME_LENGTH = 128;
    static final int MAX_PUBLIC_KEY_LENGTH = 4096;

    private static final Pattern DEVICE_ID_PATTERN = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern FINGERPRINT_PATTERN = Pattern.compile("^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$");
    private static final List<String> FIELDS = Arrays.asList(
        "deviceId", "deviceName", "fingerprint", "signingPublicKey", "encryptionPublicKey"
    );

    final String deviceId;
    final String deviceName;
    final String fingerprint;
    final String signingPublicKey;
    final String encryptionPublicKey;

    private V2Identity(
        String deviceId,
        String deviceName,
        String fingerprint,
        String signingPublicKey,
        String encryptionPublicKey
    ) {
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.fingerprint = fingerprint;
        this.signingPublicKey = signingPublicKey;
        this.encryptionPublicKey = encryptionPublicKey;
    }

    static V2Identity fromDevice(DeviceConfig device) throws GeneralSecurityException {
        if (device == null) {
            throw new IllegalArgumentException("Device identity is required");
        }
        return create(
            device.deviceId,
            device.deviceName,
            device.fingerprint,
            device.signingPublicKey,
            device.encryptionPublicKey
        );
    }

    static V2Identity create(
        String deviceId,
        String deviceName,
        String fingerprint,
        String signingPublicKey,
        String encryptionPublicKey
    ) throws GeneralSecurityException {
        assertBoundedText(deviceName, MAX_DEVICE_NAME_LENGTH, "Device name");
        assertBoundedText(signingPublicKey, MAX_PUBLIC_KEY_LENGTH, "Signing public key");
        assertBoundedText(encryptionPublicKey, MAX_PUBLIC_KEY_LENGTH, "Encryption public key");
        if (deviceId == null || !DEVICE_ID_PATTERN.matcher(deviceId).matches()) {
            throw new IllegalArgumentException("Device ID must be 16 lowercase hexadecimal characters");
        }
        if (fingerprint == null || !FINGERPRINT_PATTERN.matcher(fingerprint).matches()) {
            throw new IllegalArgumentException("Device fingerprint is invalid");
        }

        try {
            CryptoUtil.readPublicKey(signingPublicKey, "Ed25519");
            CryptoUtil.readPublicKey(encryptionPublicKey, "X25519");
        } catch (GeneralSecurityException error) {
            // Treat malformed or cross-purpose public keys as untrusted protocol input,
            // rather than leaking a provider-specific parsing failure to callers.
            throw new IllegalArgumentException("Identity public keys are invalid", error);
        }

        String expectedDeviceId = CryptoUtil.deviceIdFor(signingPublicKey);
        String expectedFingerprint = CryptoUtil.fingerprintFor(signingPublicKey);
        if (!deviceId.equals(expectedDeviceId) || !fingerprint.equals(expectedFingerprint)) {
            throw new IllegalArgumentException("Identity metadata does not match signing public key");
        }
        return new V2Identity(deviceId, deviceName, fingerprint, signingPublicKey, encryptionPublicKey);
    }

    static V2Identity fromJson(JSONObject json) throws Exception {
        if (json == null) {
            throw new IllegalArgumentException("Identity is required");
        }
        assertExactKeys(json, FIELDS, "Identity");
        return create(
            requiredString(json, "deviceId", "Identity"),
            requiredString(json, "deviceName", "Identity"),
            requiredString(json, "fingerprint", "Identity"),
            requiredString(json, "signingPublicKey", "Identity"),
            requiredString(json, "encryptionPublicKey", "Identity")
        );
    }

    JSONObject toJson() throws Exception {
        JSONObject json = new JSONObject();
        json.put("deviceId", deviceId);
        json.put("deviceName", deviceName);
        json.put("fingerprint", fingerprint);
        json.put("signingPublicKey", signingPublicKey);
        json.put("encryptionPublicKey", encryptionPublicKey);
        return json;
    }

    static void assertExactKeys(JSONObject json, List<String> expected, String label) {
        if (json.length() != expected.size()) {
            throw new IllegalArgumentException(label + " contains missing or unknown fields");
        }
        for (String field : expected) {
            if (!json.has(field)) {
                throw new IllegalArgumentException(label + " is missing " + field);
            }
        }
        java.util.Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!expected.contains(key)) {
                throw new IllegalArgumentException(label + " contains unknown field " + key);
            }
        }
    }

    static String requiredString(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException(label + " field " + key + " must be a string");
        }
        return (String) value;
    }

    private static void assertBoundedText(String value, int maximumLength, String label) {
        if (value == null || value.length() == 0 || value.length() > maximumLength || value.trim().isEmpty()) {
            throw new IllegalArgumentException(label + " is invalid");
        }
    }
}