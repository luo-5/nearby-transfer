package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Protocol v2 signed discovery announcement value object.
 *
 * <p>This class only creates, parses and verifies announcement datagrams. It
 * deliberately does not open sockets, join multicast groups or connect to a
 * discovered endpoint. Discovery is an authenticated endpoint hint, not trust.</p>
 */
final class V2DiscoveryAnnouncement {
    static final int MAX_ANNOUNCEMENT_BYTES = 16 * 1024;
    static final long MAX_CLOCK_SKEW_MS = 30 * 1000L;
    static final int MAX_CAPABILITIES = 16;
    static final int MAX_CAPABILITY_LENGTH = 64;

    private static final String APP_ID = "nearby-transfer";
    private static final int PROTOCOL_VERSION = 2;
    private static final String TYPE = "discovery-announce";
    private static final int MAX_SIGNATURE_LENGTH = 512;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern CAPABILITY_PATTERN = Pattern.compile("^[a-z][a-z0-9-]*$");
    private static final List<String> UNSIGNED_FIELDS = Arrays.asList(
        "app", "protocolVersion", "type", "issuedAt", "identity", "port", "capabilities"
    );
    private static final List<String> SIGNED_FIELDS = Arrays.asList(
        "app", "protocolVersion", "type", "issuedAt", "identity", "port", "capabilities", "signature"
    );

    final long issuedAt;
    final V2Identity identity;
    final int port;
    final List<String> capabilities;
    final String signature;

    private V2DiscoveryAnnouncement(long issuedAt, V2Identity identity, int port, List<String> capabilities, String signature) {
        this.issuedAt = issuedAt;
        this.identity = identity;
        this.port = port;
        this.capabilities = capabilities;
        this.signature = signature;
    }

    static V2DiscoveryAnnouncement create(DeviceConfig device, int port, List<String> capabilities, long issuedAt) throws Exception {
        return create(V2Identity.fromDevice(device), port, capabilities, issuedAt);
    }

    static V2DiscoveryAnnouncement create(V2Identity identity, int port, List<String> capabilities, long issuedAt) {
        assertUnsignedFields(identity, port, capabilities, issuedAt);
        return new V2DiscoveryAnnouncement(issuedAt, identity, port, normalizeCapabilities(capabilities), null);
    }

    static String sign(V2DiscoveryAnnouncement announcement, String signingPrivateKeyPem) throws Exception {
        assertUnsignedAnnouncement(announcement);
        if (signingPrivateKeyPem == null || signingPrivateKeyPem.isEmpty() || signingPrivateKeyPem.length() > V2Identity.MAX_PUBLIC_KEY_LENGTH) {
            throw new IllegalArgumentException("Signing private key is invalid");
        }
        return CryptoUtil.sign(announcement.signingPayload(), signingPrivateKeyPem);
    }

    static boolean verify(V2DiscoveryAnnouncement announcement) {
        if (announcement == null || !isValidSignature(announcement.signature)) {
            return false;
        }
        try {
            assertUnsignedAnnouncement(announcement);
            return CryptoUtil.verify(announcement.signingPayload(), announcement.signature, announcement.identity.signingPublicKey);
        } catch (Exception error) {
            return false;
        }
    }

    static V2DiscoveryAnnouncement parseAndVerify(byte[] datagram, int offset, int length, long nowEpochMillis) throws Exception {
        if (datagram == null || offset < 0 || length <= 0 || offset > datagram.length - length || length > MAX_ANNOUNCEMENT_BYTES) {
            throw new IllegalArgumentException("Discovery datagram exceeds the accepted bounds");
        }
        byte[] serialized = Arrays.copyOfRange(datagram, offset, offset + length);
        Object parsed = ProtocolV2.parseCanonicalJson(serialized, "Discovery announcement");
        if (!(parsed instanceof JSONObject)) {
            throw new IllegalArgumentException("Discovery announcement must be an object");
        }
        JSONObject json = (JSONObject) parsed;
        V2Identity.assertExactKeys(json, SIGNED_FIELDS, "Discovery announcement");

        String signature = V2Identity.requiredString(json, "signature", "Discovery announcement");
        if (!isValidSignature(signature)) {
            throw new IllegalArgumentException("Discovery announcement signature is invalid");
        }
        V2Identity identity = V2Identity.fromJson(requiredObject(json, "identity", "Discovery announcement"));
        V2DiscoveryAnnouncement announcement = new V2DiscoveryAnnouncement(
            requiredSafePositiveLong(json, "issuedAt", "Discovery announcement"),
            identity,
            requiredPort(json),
            normalizeCapabilities(requiredArray(json, "capabilities", "Discovery announcement")),
            signature
        );
        assertEnvelope(json);
        assertFresh(announcement, nowEpochMillis);
        if (!verify(announcement)) {
            throw new IllegalArgumentException("Discovery announcement signature verification failed");
        }
        return announcement;
    }

    JSONObject toJson(String signature) throws Exception {
        if (!isValidSignature(signature)) {
            throw new IllegalArgumentException("Discovery announcement signature is invalid");
        }
        JSONObject json = unsignedJson();
        json.put("signature", signature);
        return json;
    }

    String signingPayload() throws Exception {
        return ProtocolV2.canonicalJson(unsignedJson());
    }

    String toCanonicalJson(String signature) throws Exception {
        return ProtocolV2.canonicalJson(toJson(signature));
    }

    static void assertFresh(V2DiscoveryAnnouncement announcement, long nowEpochMillis) {
        assertUnsignedAnnouncement(announcement);
        if (nowEpochMillis <= 0 || nowEpochMillis > MAX_SAFE_INTEGER || Math.abs(nowEpochMillis - announcement.issuedAt) > MAX_CLOCK_SKEW_MS) {
            throw new IllegalArgumentException("Discovery announcement is stale or has an invalid clock");
        }
    }

    private JSONObject unsignedJson() throws Exception {
        assertUnsignedAnnouncement(this);
        JSONObject json = new JSONObject();
        json.put("app", APP_ID);
        json.put("protocolVersion", PROTOCOL_VERSION);
        json.put("type", TYPE);
        json.put("issuedAt", issuedAt);
        json.put("identity", identity.toJson());
        JSONArray caps = new JSONArray();
        for (String capability : capabilities) {
            caps.put(capability);
        }
        json.put("capabilities", caps);
        json.put("port", port);
        return json;
    }

    private static void assertEnvelope(JSONObject json) {
        Object app = json.opt("app");
        Object version = json.opt("protocolVersion");
        Object type = json.opt("type");
        if (!(app instanceof String) || !(type instanceof String) || !APP_ID.equals(app) || !TYPE.equals(type) || !isExactInteger(version) || ((Number) version).longValue() != PROTOCOL_VERSION) {
            throw new IllegalArgumentException("Discovery announcement has an unsupported protocol envelope");
        }
    }

    private static void assertUnsignedAnnouncement(V2DiscoveryAnnouncement announcement) {
        if (announcement == null) {
            throw new IllegalArgumentException("Discovery announcement is required");
        }
        assertUnsignedFields(announcement.identity, announcement.port, announcement.capabilities, announcement.issuedAt);
    }

    private static void assertUnsignedFields(V2Identity identity, int port, List<String> capabilities, long issuedAt) {
        if (identity == null) {
            throw new IllegalArgumentException("Discovery identity is required");
        }
        if (issuedAt <= 0 || issuedAt > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("Discovery announcement issue time is invalid");
        }
        if (port < 1 || port > 65535) {
            throw new IllegalArgumentException("Discovery port is invalid");
        }
        normalizeCapabilities(capabilities);
    }

    private static List<String> normalizeCapabilities(List<String> capabilities) {
        if (capabilities == null || capabilities.size() > MAX_CAPABILITIES) {
            throw new IllegalArgumentException("Discovery capabilities must be a bounded array");
        }
        List<String> normalized = new ArrayList<>(capabilities.size());
        for (String capability : capabilities) {
            if (capability == null || capability.isEmpty() || capability.length() > MAX_CAPABILITY_LENGTH || !CAPABILITY_PATTERN.matcher(capability).matches()) {
                throw new IllegalArgumentException("Discovery capability is invalid");
            }
            normalized.add(capability);
        }
        if (new HashSet<>(normalized).size() != normalized.size()) {
            throw new IllegalArgumentException("Discovery capabilities must not contain duplicates");
        }
        Collections.sort(normalized);
        return Collections.unmodifiableList(normalized);
    }

    private static JSONObject requiredObject(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!(value instanceof JSONObject)) {
            throw new IllegalArgumentException(label + " field " + key + " must be an object");
        }
        return (JSONObject) value;
    }

    private static JSONArray requiredArray(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!(value instanceof JSONArray)) {
            throw new IllegalArgumentException(label + " field " + key + " must be an array");
        }
        return (JSONArray) value;
    }

    private static List<String> normalizeCapabilities(JSONArray capabilities) {
        List<String> values = new ArrayList<>(capabilities.length());
        for (int index = 0; index < capabilities.length(); index += 1) {
            Object value = capabilities.opt(index);
            if (!(value instanceof String)) {
                throw new IllegalArgumentException("Discovery capability is invalid");
            }
            values.add((String) value);
        }
        return normalizeCapabilities(values);
    }

    private static long requiredSafePositiveLong(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!isExactInteger(value)) {
            throw new IllegalArgumentException(label + " field " + key + " must be an integer");
        }
        long parsed = ((Number) value).longValue();
        if (parsed <= 0 || parsed > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(label + " issue time is invalid");
        }
        return parsed;
    }

    private static int requiredPort(JSONObject json) {
        Object value = json.opt("port");
        if (!isExactInteger(value)) {
            throw new IllegalArgumentException("Discovery port is invalid");
        }
        long parsed = ((Number) value).longValue();
        if (parsed < 1 || parsed > 65535) {
            throw new IllegalArgumentException("Discovery port is invalid");
        }
        return (int) parsed;
    }

    private static boolean isExactInteger(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }

    private static boolean isValidSignature(String signature) {
        return signature != null && !signature.isEmpty() && signature.length() <= MAX_SIGNATURE_LENGTH;
    }

}