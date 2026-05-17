package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.util.Iterator;

final class JsonUtil {
    private JsonUtil() {}

    static String canonicalTransferRequestPayload(JSONObject payload) {
        JSONObject sender = payload.optJSONObject("sender");
        JSONObject file = payload.optJSONObject("file");
        StringBuilder builder = new StringBuilder();
        builder.append('{');
        appendString(builder, "protocolVersion");
        builder.append(':');
        appendValue(builder, payload.opt("protocolVersion"));
        builder.append(',');
        appendString(builder, "transferId");
        builder.append(':');
        appendValue(builder, payload.opt("transferId"));
        builder.append(',');
        appendString(builder, "sender");
        builder.append(":{");
        appendString(builder, "deviceId");
        builder.append(':');
        appendValue(builder, sender == null ? null : sender.opt("deviceId"));
        builder.append(',');
        appendString(builder, "deviceName");
        builder.append(':');
        appendValue(builder, sender == null ? null : sender.opt("deviceName"));
        builder.append(',');
        appendString(builder, "fingerprint");
        builder.append(':');
        appendValue(builder, sender == null ? null : sender.opt("fingerprint"));
        builder.append(',');
        appendString(builder, "signingPublicKey");
        builder.append(':');
        appendValue(builder, sender == null ? null : sender.opt("signingPublicKey"));
        builder.append('}');
        builder.append(',');
        appendString(builder, "file");
        builder.append(":{");
        appendString(builder, "name");
        builder.append(':');
        appendValue(builder, file == null ? null : file.opt("name"));
        builder.append(',');
        appendString(builder, "size");
        builder.append(':');
        appendValue(builder, file == null ? null : file.opt("size"));
        builder.append(',');
        appendString(builder, "sha256");
        builder.append(':');
        appendValue(builder, file == null ? null : file.opt("sha256"));
        builder.append('}');
        builder.append(',');
        appendString(builder, "senderEphemeralPublicKey");
        builder.append(':');
        appendValue(builder, payload.opt("senderEphemeralPublicKey"));
        builder.append('}');
        return builder.toString();
    }

    static String stringify(JSONObject object) {
        StringBuilder builder = new StringBuilder();
        appendObject(builder, object);
        return builder.toString();
    }

    private static void appendObject(StringBuilder builder, JSONObject object) {
        builder.append('{');
        Iterator<String> keys = object.keys();
        boolean first = true;
        while (keys.hasNext()) {
            String key = keys.next();
            if (!first) {
                builder.append(',');
            }
            first = false;
            appendString(builder, key);
            builder.append(':');
            appendValue(builder, object.opt(key));
        }
        builder.append('}');
    }

    private static void appendValue(StringBuilder builder, Object value) {
        if (value == null || value == JSONObject.NULL) {
            builder.append("null");
        } else if (value instanceof JSONObject) {
            appendObject(builder, (JSONObject) value);
        } else if (value instanceof Number || value instanceof Boolean) {
            builder.append(String.valueOf(value));
        } else {
            appendString(builder, String.valueOf(value));
        }
    }

    private static void appendString(StringBuilder builder, String value) {
        builder.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (c <= 0x1f) {
                        builder.append(String.format("\\u%04x", (int) c));
                    } else {
                        builder.append(c);
                    }
            }
        }
        builder.append('"');
    }
}
