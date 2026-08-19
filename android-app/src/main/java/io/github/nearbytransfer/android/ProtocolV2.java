package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * The Android half of the restricted canonical JSON and pairing-code contract.
 * Keep this implementation dependency-free so it can be exercised in JVM tests.
 */
final class ProtocolV2 {
    static final String APP_ID = "nearby-transfer";
    static final int VERSION = 2;
    private static final String PAIRING_CODE_DOMAIN = "nearby-transfer/v2/pairing-code\0";

    private ProtocolV2() {}

    static String pairingCodeTranscript(String pairingId, JSONObject initiator, JSONObject responder) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("app", APP_ID);
        payload.put("protocolVersion", VERSION);
        payload.put("type", "pairing-code");
        payload.put("pairingId", pairingId);
        payload.put("initiator", initiator);
        payload.put("responder", responder);
        return canonicalJson(payload);
    }

    static String derivePairingCode(String pairingId, JSONObject initiator, JSONObject responder) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(PAIRING_CODE_DOMAIN.getBytes(StandardCharsets.UTF_8));
        digest.update(pairingCodeTranscript(pairingId, initiator, responder).getBytes(StandardCharsets.UTF_8));
        byte[] hash = digest.digest();
        long firstWord = ((long) (hash[0] & 0xff) << 24)
            | ((long) (hash[1] & 0xff) << 16)
            | ((long) (hash[2] & 0xff) << 8)
            | (long) (hash[3] & 0xff);
        return String.format(java.util.Locale.ROOT, "%06d", firstWord % 1_000_000L);
    }

    static String canonicalJson(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) {
            return "null";
        }
        if (value instanceof Boolean) {
            return ((Boolean) value) ? "true" : "false";
        }
        if (value instanceof String) {
            return JSONObject.quote((String) value);
        }
        if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            return String.valueOf(value);
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder builder = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) {
                    builder.append(',');
                }
                builder.append(canonicalJson(array.get(index)));
            }
            return builder.append(']').toString();
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) {
                keys.add(iterator.next());
            }
            Collections.sort(keys);
            StringBuilder builder = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index += 1) {
                if (index > 0) {
                    builder.append(',');
                }
                String key = keys.get(index);
                builder.append(JSONObject.quote(key));
                builder.append(':');
                builder.append(canonicalJson(object.get(key)));
            }
            return builder.append('}').toString();
        }
        throw new IllegalArgumentException("Unsupported protocol JSON value: " + value.getClass().getName());
    }
}
