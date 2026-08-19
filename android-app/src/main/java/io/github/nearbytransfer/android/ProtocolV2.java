package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * The Android half of the restricted canonical JSON and pairing-code contract.
 *
 * <p>Protocol JSON deliberately accepts only null, booleans, strings, arrays,
 * JSON objects, and IEEE-754 safe integers. Parsing is strict: input must be
 * valid UTF-8 and exactly equal to its canonical serialization. This rejects
 * duplicate object keys, whitespace, alternate numeric spellings, and key
 * orders that would otherwise make signature verification ambiguous.</p>
 *
 * <p>Keep this implementation dependency-free so it can be exercised in JVM
 * tests and shared by the Android v2 protocol implementation.</p>
 */
final class ProtocolV2 {
    static final String APP_ID = "nearby-transfer";
    static final int VERSION = 2;
    private static final String PAIRING_CODE_DOMAIN = "nearby-transfer/v2/pairing-code\0";
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

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

    /** Serializes the protocol's deliberately restricted JSON value subset. */
    static String canonicalJson(Object value) {
        return serialize(value, "$");
    }

    /**
     * Decodes strict UTF-8 protocol bytes and accepts them only if they are
     * byte-for-byte canonical JSON.
     */
    static Object parseCanonicalJson(byte[] serialized) {
        return parseCanonicalJson(serialized, "Protocol JSON");
    }

    static Object parseCanonicalJson(byte[] serialized, String label) {
        if (serialized == null) {
            throw new IllegalArgumentException(label + " must not be null");
        }
        return parseCanonicalJson(decodeStrictUtf8(serialized, label), label);
    }

    /**
     * Parses an already-decoded protocol string and accepts it only if it is
     * exactly canonical. Callers receiving network bytes should use the byte[]
     * overload so malformed UTF-8 is rejected before parsing.
     */
    static Object parseCanonicalJson(String serialized) {
        return parseCanonicalJson(serialized, "Protocol JSON");
    }

    static Object parseCanonicalJson(String serialized, String label) {
        if (serialized == null) {
            throw new IllegalArgumentException(label + " must not be null");
        }
        if (!serialized.isEmpty() && serialized.charAt(0) == '\ufeff') {
            throw new IllegalArgumentException(label + " must not include a UTF-8 BOM");
        }

        Object value = new RestrictedJsonParser(serialized, label).parse();
        String canonical = canonicalJson(value);
        if (!canonical.equals(serialized)) {
            throw new IllegalArgumentException(label + " is not canonical JSON");
        }
        return value;
    }

    private static String decodeStrictUtf8(byte[] serialized, String label) {
        try {
            CharBuffer decoded = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(serialized));
            return decoded.toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException(label + " must be valid UTF-8", error);
        }
    }

    private static String serialize(Object value, String path) {
        if (value == null || value == JSONObject.NULL) {
            return "null";
        }
        if (value instanceof Boolean) {
            return ((Boolean) value) ? "true" : "false";
        }
        if (value instanceof String) {
            String string = (String) value;
            assertWellFormedString(string, path);
            return quote(string);
        }
        if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            long integer = ((Number) value).longValue();
            if (integer < -MAX_SAFE_INTEGER || integer > MAX_SAFE_INTEGER) {
                throw new IllegalArgumentException("Protocol value at " + path + " must be a safe integer");
            }
            return String.valueOf(integer);
        }
        if (value instanceof Float || value instanceof Double || value instanceof BigDecimal || value instanceof Number) {
            throw new IllegalArgumentException("Protocol value at " + path + " must be a safe integer");
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder builder = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) {
                    builder.append(',');
                }
                builder.append(serialize(array.opt(index), path + "[" + index + "]"));
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
                assertWellFormedString(key, path + ".<key>");
                builder.append(quote(key));
                builder.append(':');
                builder.append(serialize(object.opt(key), path + "." + key));
            }
            return builder.append('}').toString();
        }
        throw new IllegalArgumentException("Unsupported protocol JSON value at " + path + ": " + value.getClass().getName());
    }

    /** Matches the JSON escaping used by JavaScript JSON.stringify for protocol strings. */
    private static String quote(String value) {
        StringBuilder builder = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
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
                    if (character <= 0x1f) {
                        builder.append("\\u");
                        String hex = Integer.toHexString(character);
                        for (int zeroes = hex.length(); zeroes < 4; zeroes += 1) {
                            builder.append('0');
                        }
                        builder.append(hex);
                    } else {
                        builder.append(character);
                    }
                    break;
            }
        }
        return builder.append('"').toString();
    }

    private static void assertWellFormedString(String value, String path) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException("Protocol string at " + path + " contains an unpaired surrogate");
                }
                index += 1;
            } else if (Character.isLowSurrogate(character)) {
                throw new IllegalArgumentException("Protocol string at " + path + " contains an unpaired surrogate");
            }
        }
    }

    /**
     * A deliberately small JSON parser. JSONObject cannot expose duplicate
     * object keys after parsing, so protocol input must be parsed here before
     * it can be converted into JSONObject/JSONArray values.
     */
    private static final class RestrictedJsonParser {
        private final String input;
        private final String label;
        private int index;

        RestrictedJsonParser(String input, String label) {
            this.input = input;
            this.label = label;
        }

        Object parse() {
            Object value = parseValue();
            if (index != input.length()) {
                fail("contains trailing data");
            }
            return value;
        }

        private Object parseValue() {
            if (index >= input.length()) {
                fail("is truncated");
            }
            char token = input.charAt(index);
            switch (token) {
                case 'n':
                    consumeLiteral("null");
                    return JSONObject.NULL;
                case 't':
                    consumeLiteral("true");
                    return Boolean.TRUE;
                case 'f':
                    consumeLiteral("false");
                    return Boolean.FALSE;
                case '"':
                    return parseString();
                case '[':
                    return parseArray();
                case '{':
                    return parseObject();
                default:
                    if (token == '-' || (token >= '0' && token <= '9')) {
                        return parseInteger();
                    }
                    fail("contains an invalid JSON token");
                    return null; // unreachable
            }
        }

        private JSONArray parseArray() {
            expect('[');
            JSONArray result = new JSONArray();
            if (consumeIf(']')) {
                return result;
            }
            int arrayIndex = 0;
            while (true) {
                result.put(parseValue());
                arrayIndex += 1;
                if (consumeIf(']')) {
                    return result;
                }
                expect(',');
                if (index >= input.length()) {
                    fail("is truncated in an array");
                }
            }
        }

        private JSONObject parseObject() {
            expect('{');
            JSONObject result = new JSONObject();
            Set<String> keys = new HashSet<>();
            if (consumeIf('}')) {
                return result;
            }
            while (true) {
                if (index >= input.length() || input.charAt(index) != '"') {
                    fail("has an object key that is not a string");
                }
                String key = parseString();
                if (!keys.add(key)) {
                    fail("contains a duplicate object key");
                }
                expect(':');
                putObjectValue(result, key, parseValue());
                if (consumeIf('}')) {
                    return result;
                }
                expect(',');
                if (index >= input.length()) {
                    fail("is truncated in an object");
                }
            }
        }

        private void putObjectValue(JSONObject object, String key, Object value) {
            try {
                object.put(key, value);
            } catch (JSONException error) {
                throw new IllegalArgumentException(label + " cannot construct a parsed object", error);
            }
        }
        private String parseString() {
            expect('"');
            StringBuilder result = new StringBuilder();
            while (index < input.length()) {
                char character = input.charAt(index++);
                if (character == '"') {
                    String value = result.toString();
                    assertWellFormedString(value, label + " string");
                    return value;
                }
                if (character < 0x20) {
                    fail("contains an unescaped control character in a string");
                }
                if (character == '\\') {
                    if (index >= input.length()) {
                        fail("is truncated in a string escape");
                    }
                    char escape = input.charAt(index++);
                    switch (escape) {
                        case '"':
                        case '\\':
                        case '/':
                            result.append(escape);
                            break;
                        case 'b':
                            result.append('\b');
                            break;
                        case 'f':
                            result.append('\f');
                            break;
                        case 'n':
                            result.append('\n');
                            break;
                        case 'r':
                            result.append('\r');
                            break;
                        case 't':
                            result.append('\t');
                            break;
                        case 'u':
                            result.append(parseUnicodeEscape());
                            break;
                        default:
                            fail("contains an invalid string escape");
                    }
                } else {
                    result.append(character);
                }
            }
            fail("is truncated in a string");
            return null; // unreachable
        }

        private char parseUnicodeEscape() {
            if (input.length() - index < 4) {
                fail("is truncated in a unicode escape");
            }
            int value = 0;
            for (int offset = 0; offset < 4; offset += 1) {
                char digit = input.charAt(index++);
                int hex = Character.digit(digit, 16);
                if (hex < 0) {
                    fail("contains an invalid unicode escape");
                }
                value = (value << 4) | hex;
            }
            return (char) value;
        }

        private Long parseInteger() {
            int start = index;
            consumeIf('-');
            if (index >= input.length()) {
                fail("is truncated in a number");
            }
            char firstDigit = input.charAt(index);
            if (firstDigit == '0') {
                index += 1;
                if (index < input.length() && isDigit(input.charAt(index))) {
                    fail("contains a number with a leading zero");
                }
            } else if (firstDigit >= '1' && firstDigit <= '9') {
                index += 1;
                while (index < input.length() && isDigit(input.charAt(index))) {
                    index += 1;
                }
            } else {
                fail("contains an invalid number");
            }

            if (index < input.length() && (input.charAt(index) == '.' || input.charAt(index) == 'e' || input.charAt(index) == 'E')) {
                fail("contains a non-integer number");
            }

            String lexical = input.substring(start, index);
            long parsed;
            try {
                parsed = Long.parseLong(lexical);
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException(label + " contains an integer outside the supported range", error);
            }
            if (parsed < -MAX_SAFE_INTEGER || parsed > MAX_SAFE_INTEGER) {
                fail("contains an integer outside the safe range");
            }
            return parsed;
        }

        private void consumeLiteral(String literal) {
            if (!input.regionMatches(index, literal, 0, literal.length())) {
                fail("contains an invalid literal");
            }
            index += literal.length();
        }

        private void expect(char expected) {
            if (index >= input.length() || input.charAt(index) != expected) {
                fail("expected '" + expected + "'");
            }
            index += 1;
        }

        private boolean consumeIf(char expected) {
            if (index < input.length() && input.charAt(index) == expected) {
                index += 1;
                return true;
            }
            return false;
        }

        private static boolean isDigit(char value) {
            return value >= '0' && value <= '9';
        }

        private void fail(String message) {
            throw new IllegalArgumentException(label + " " + message + " at character " + index);
        }
    }
}
