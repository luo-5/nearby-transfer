package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/** Signed, replay-protected control messages for one protocol-v2 transfer stream. */
final class V2SignedStreamControl {
    static final int MAX_PAYLOAD_BYTES = 16 * 1024;
    static final long DEFAULT_TTL_MS = 30_000L;
    static final long MAX_TTL_MS = 5 * 60_000L;
    static final long MAX_CLOCK_SKEW_MS = 30_000L;

    static final String COMMAND_HELLO = "stream-hello";
    static final String COMMAND_START = "stream-start";
    static final String COMMAND_PAUSE = "stream-pause";
    static final String COMMAND_PAUSED = "stream-paused";
    static final String COMMAND_RESUME = "stream-resume";
    static final String COMMAND_RESUMED = "stream-resumed";
    static final String COMMAND_COMPLETE = "stream-complete";
    static final String COMMAND_COMPLETE_ACK = "stream-complete-ack";
    static final String COMMAND_CANCEL = "stream-cancel";

    private static final String TYPE = "transfer-stream-control";
    private static final int CONTROL_PROTOCOL = 1;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Set<String> COMMANDS = immutableSet(
        COMMAND_HELLO,
        COMMAND_START,
        COMMAND_PAUSE,
        COMMAND_PAUSED,
        COMMAND_RESUME,
        COMMAND_RESUMED,
        COMMAND_COMPLETE,
        COMMAND_COMPLETE_ACK,
        COMMAND_CANCEL
    );
    private static final Set<String> CANCEL_CODES = immutableSet(
        "cancelled",
        "timeout",
        "protocol-error",
        "transfer-error"
    );
    private static final Set<String> DIRECTIONS = immutableSet("send", "receive");
    private static final Set<String> STANDARD_FIELDS = immutableSet(
        "app",
        "protocolVersion",
        "type",
        "command",
        "controlProtocol",
        "taskId",
        "sessionId",
        "fromDeviceId",
        "toDeviceId",
        "direction",
        "sequence",
        "issuedAt",
        "expiresAt",
        "signature"
    );
    private static final Set<String> CANCEL_FIELDS;

    static {
        Set<String> cancelFields = new HashSet<>(STANDARD_FIELDS);
        cancelFields.add("code");
        CANCEL_FIELDS = Collections.unmodifiableSet(cancelFields);
    }

    private V2SignedStreamControl() {}

    /** The caller-controlled portion of a stream control message. */
    static final class Control {
        final String type;
        final int protocol;
        final String taskId;
        final String fromPeerId;
        final String toPeerId;
        final String direction;
        final String code;

        Control(String type, int protocol, String taskId, String fromPeerId, String toPeerId, String direction) {
            this(type, protocol, taskId, fromPeerId, toPeerId, direction, null);
        }

        Control(
            String type,
            int protocol,
            String taskId,
            String fromPeerId,
            String toPeerId,
            String direction,
            String code
        ) {
            assertCommand(type);
            if (protocol != CONTROL_PROTOCOL) {
                throw new IllegalArgumentException("Stream control protocol is unsupported");
            }
            assertCanonicalBase64Url(taskId, 16, "Transfer task ID");
            assertDeviceId(fromPeerId, "Stream control source peer ID");
            assertDeviceId(toPeerId, "Stream control destination peer ID");
            if (fromPeerId.equals(toPeerId)) {
                throw new IllegalArgumentException("Stream control peer IDs must differ");
            }
            if (!DIRECTIONS.contains(direction)) {
                throw new IllegalArgumentException("Stream control direction must be send or receive");
            }
            if (COMMAND_CANCEL.equals(type)) {
                if (!CANCEL_CODES.contains(code)) {
                    throw new IllegalArgumentException("Stream cancellation code is unsupported");
                }
            } else if (code != null) {
                throw new IllegalArgumentException("Only stream-cancel may include a cancellation code");
            }
            this.type = type;
            this.protocol = protocol;
            this.taskId = taskId;
            this.fromPeerId = fromPeerId;
            this.toPeerId = toPeerId;
            this.direction = direction;
            this.code = code;
        }
    }

    /**
     * A codec bound to one local identity, one remote identity, and one task.
     * Each direction owns an independent sequence beginning at zero.
     */
    static final class Codec {
        private final String localDeviceId;
        private final PrivateKey localSigningPrivateKey;
        private final String remoteDeviceId;
        private final PublicKey remoteSigningPublicKey;
        private final String taskId;
        private final String sessionId;
        private final LongSupplier clock;
        private final long ttlMillis;
        private long outgoingSequence;
        private long incomingSequence;
        private String localDirection;

        Codec(
            String localDeviceId,
            String localSigningPrivateKeyPem,
            String remoteDeviceId,
            String remoteSigningPublicKeyPem,
            String taskId,
            String sessionId,
            LongSupplier clock
        ) throws GeneralSecurityException {
            this(
                localDeviceId,
                localSigningPrivateKeyPem,
                remoteDeviceId,
                remoteSigningPublicKeyPem,
                taskId,
                sessionId,
                clock,
                DEFAULT_TTL_MS
            );
        }

        Codec(
            String localDeviceId,
            String localSigningPrivateKeyPem,
            String remoteDeviceId,
            String remoteSigningPublicKeyPem,
            String taskId,
            String sessionId,
            LongSupplier clock,
            long ttlMillis
        ) throws GeneralSecurityException {
            assertDeviceId(localDeviceId, "Local device ID");
            assertDeviceId(remoteDeviceId, "Remote device ID");
            if (localDeviceId.equals(remoteDeviceId)) {
                throw new IllegalArgumentException("Local and remote device IDs must differ");
            }
            assertCanonicalBase64Url(taskId, 16, "Transfer task ID");
            assertCanonicalBase64Url(sessionId, 16, "Transfer session ID");
            if (clock == null) {
                throw new IllegalArgumentException("Stream control clock is required");
            }
            if (ttlMillis <= 0 || ttlMillis > MAX_TTL_MS) {
                throw new IllegalArgumentException("Stream control TTL must be between 1 and 300000 milliseconds");
            }

            this.localDeviceId = localDeviceId;
            this.localSigningPrivateKey = CryptoUtil.readPrivateKey(localSigningPrivateKeyPem, "Ed25519");
            this.remoteDeviceId = remoteDeviceId;
            this.remoteSigningPublicKey = CryptoUtil.readPublicKey(remoteSigningPublicKeyPem, "Ed25519");
            this.taskId = taskId;
            this.sessionId = sessionId;
            this.clock = clock;
            this.ttlMillis = ttlMillis;
        }

        synchronized byte[] encode(Control control) throws Exception {
            if (control == null) {
                throw new IllegalArgumentException("Stream control is required");
            }
            assertLocalBinding(control);
            if (localDirection != null && !localDirection.equals(control.direction)) {
                throw new IllegalArgumentException("Stream control direction conflicts with the bound stream");
            }
            if (outgoingSequence > MAX_SAFE_INTEGER) {
                throw new IllegalStateException("Stream control outgoing sequence is exhausted");
            }
            long now = requirePositiveSafeInteger(clock.getAsLong(), "Stream control clock");
            if (now > MAX_SAFE_INTEGER - ttlMillis) {
                throw new IllegalArgumentException("Stream control expiration exceeds the safe integer range");
            }

            JSONObject unsigned = unsignedJson(
                control,
                sessionId,
                outgoingSequence,
                now,
                now + ttlMillis
            );
            String canonicalUnsigned = ProtocolV2.canonicalJson(unsigned);
            String signature = sign(canonicalUnsigned.getBytes(StandardCharsets.UTF_8), localSigningPrivateKey);
            JSONObject signed = copyObject(unsigned);
            signed.put("signature", signature);
            byte[] encoded = ProtocolV2.canonicalJson(signed).getBytes(StandardCharsets.UTF_8);
            if (encoded.length > MAX_PAYLOAD_BYTES) {
                throw new IllegalArgumentException("Stream control payload exceeds the accepted limit");
            }
            localDirection = control.direction;
            outgoingSequence += 1;
            return encoded;
        }

        synchronized Control decodeAndVerify(byte[] payload) throws Exception {
            if (payload == null || payload.length == 0 || payload.length > MAX_PAYLOAD_BYTES) {
                throw new IllegalArgumentException("Stream control payload exceeds the accepted bounds");
            }
            Object parsed = ProtocolV2.parseCanonicalJson(payload, "Stream control payload");
            if (!(parsed instanceof JSONObject)) {
                throw new IllegalArgumentException("Stream control payload must be a JSON object");
            }
            JSONObject json = (JSONObject) parsed;
            String command = requiredString(json, "command");
            assertCommand(command);
            assertExactFields(json, COMMAND_CANCEL.equals(command) ? CANCEL_FIELDS : STANDARD_FIELDS);
            assertEnvelope(json);

            String decodedTaskId = requiredString(json, "taskId");
            assertCanonicalBase64Url(decodedTaskId, 16, "Transfer task ID");
            if (!taskId.equals(decodedTaskId)) {
                throw new IllegalArgumentException("Stream control task does not match the bound task");
            }

            String decodedSessionId = requiredString(json, "sessionId");
            assertCanonicalBase64Url(decodedSessionId, 16, "Transfer session ID");
            if (!sessionId.equals(decodedSessionId)) {
                throw new IllegalArgumentException("Stream control session does not match the bound session");
            }

            String fromDeviceId = requiredString(json, "fromDeviceId");
            String toDeviceId = requiredString(json, "toDeviceId");
            assertDeviceId(fromDeviceId, "Stream control source device ID");
            assertDeviceId(toDeviceId, "Stream control destination device ID");
            if (fromDeviceId.equals(toDeviceId)) {
                throw new IllegalArgumentException("Stream control device IDs must differ");
            }
            if (!remoteDeviceId.equals(fromDeviceId) || !localDeviceId.equals(toDeviceId)) {
                throw new IllegalArgumentException("Stream control route does not match the bound peers");
            }

            String direction = requiredString(json, "direction");
            String code = COMMAND_CANCEL.equals(command) ? requiredString(json, "code") : null;
            Control control = new Control(
                command,
                CONTROL_PROTOCOL,
                decodedTaskId,
                fromDeviceId,
                toDeviceId,
                direction,
                code
            );
            long sequence = requiredNonNegativeSafeInteger(json, "sequence");
            if (sequence != incomingSequence) {
                throw new IllegalArgumentException("Stream control sequence is replayed or out of order");
            }

            long issuedAt = requiredPositiveSafeInteger(json, "issuedAt");
            long expiresAt = requiredPositiveSafeInteger(json, "expiresAt");
            assertTimeWindow(issuedAt, expiresAt, requirePositiveSafeInteger(clock.getAsLong(), "Stream control clock"));

            String encodedSignature = requiredString(json, "signature");
            byte[] decodedSignature = decodeCanonicalBase64Url(encodedSignature, 64, "Stream control signature");
            JSONObject unsigned = unsignedJson(
                control,
                sessionId,
                sequence,
                issuedAt,
                expiresAt
            );
            byte[] signedBytes = ProtocolV2.canonicalJson(unsigned).getBytes(StandardCharsets.UTF_8);
            if (!verify(signedBytes, decodedSignature, remoteSigningPublicKey)) {
                throw new IllegalArgumentException("Stream control signature verification failed");
            }
            String expectedRemoteDirection = localDirection == null ? null : oppositeDirection(localDirection);
            if (expectedRemoteDirection != null && !expectedRemoteDirection.equals(control.direction)) {
                throw new IllegalArgumentException("Remote stream control direction conflicts with the bound stream");
            }

            if (localDirection == null) {
                localDirection = oppositeDirection(control.direction);
            }
            incomingSequence += 1;
            return control;
        }

        private void assertLocalBinding(Control control) {
            if (!taskId.equals(control.taskId)) {
                throw new IllegalArgumentException("Stream control task does not match the bound task");
            }
            if (!localDeviceId.equals(control.fromPeerId) || !remoteDeviceId.equals(control.toPeerId)) {
                throw new IllegalArgumentException("Stream control route does not match the bound peers");
            }
        }
    }

    private static JSONObject unsignedJson(
        Control control,
        String sessionId,
        long sequence,
        long issuedAt,
        long expiresAt
    ) throws Exception {
        JSONObject json = new JSONObject();
        json.put("app", ProtocolV2.APP_ID);
        json.put("protocolVersion", ProtocolV2.VERSION);
        json.put("type", TYPE);
        json.put("command", control.type);
        json.put("controlProtocol", control.protocol);
        json.put("taskId", control.taskId);
        json.put("sessionId", sessionId);
        json.put("fromDeviceId", control.fromPeerId);
        json.put("toDeviceId", control.toPeerId);
        json.put("direction", control.direction);
        json.put("sequence", sequence);
        json.put("issuedAt", issuedAt);
        json.put("expiresAt", expiresAt);
        if (control.code != null) {
            json.put("code", control.code);
        }
        return json;
    }

    private static JSONObject copyObject(JSONObject source) throws Exception {
        JSONObject copy = new JSONObject();
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            copy.put(key, source.get(key));
        }
        return copy;
    }

    private static String sign(byte[] message, PrivateKey privateKey) throws GeneralSecurityException {
        Signature signer = Signature.getInstance("Ed25519", "BC");
        signer.initSign(privateKey);
        signer.update(message);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
    }

    private static boolean verify(byte[] message, byte[] encodedSignature, PublicKey publicKey) throws GeneralSecurityException {
        Signature verifier = Signature.getInstance("Ed25519", "BC");
        verifier.initVerify(publicKey);
        verifier.update(message);
        return verifier.verify(encodedSignature);
    }

    private static void assertEnvelope(JSONObject json) {
        if (!ProtocolV2.APP_ID.equals(json.opt("app"))
            || !isExactInteger(json.opt("protocolVersion"))
            || ((Number) json.opt("protocolVersion")).longValue() != ProtocolV2.VERSION
            || !TYPE.equals(json.opt("type"))
            || !isExactInteger(json.opt("controlProtocol"))
            || ((Number) json.opt("controlProtocol")).longValue() != CONTROL_PROTOCOL) {
            throw new IllegalArgumentException("Stream control protocol envelope is invalid");
        }
    }

    private static void assertCommand(String command) {
        if (!COMMANDS.contains(command)) {
            throw new IllegalArgumentException("Stream control command is unsupported");
        }
    }

    private static void assertDeviceId(String deviceId, String label) {
        if (deviceId == null || !DEVICE_ID.matcher(deviceId).matches()) {
            throw new IllegalArgumentException(label + " must be 16 lowercase hexadecimal characters");
        }
    }

    private static void assertExactFields(JSONObject json, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(expected)) {
            throw new IllegalArgumentException("Stream control contains missing or unknown fields");
        }
    }

    private static void assertTimeWindow(long issuedAt, long expiresAt, long now) {
        if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
            throw new IllegalArgumentException("Stream control expiration window is invalid");
        }
        if (issuedAt > now && issuedAt - now > MAX_CLOCK_SKEW_MS) {
            throw new IllegalArgumentException("Stream control issue time is too far in the future");
        }
        if (expiresAt < now && now - expiresAt > MAX_CLOCK_SKEW_MS) {
            throw new IllegalArgumentException("Stream control has expired");
        }
    }

    private static String oppositeDirection(String direction) {
        return "send".equals(direction) ? "receive" : "send";
    }

    private static long requiredPositiveSafeInteger(JSONObject json, String field) {
        Object value = json.opt(field);
        if (!isExactInteger(value)) {
            throw new IllegalArgumentException("Stream control field " + field + " must be an integer");
        }
        return requirePositiveSafeInteger(((Number) value).longValue(), "Stream control field " + field);
    }

    private static long requirePositiveSafeInteger(long value, String label) {
        if (value <= 0 || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(label + " must be a positive safe integer");
        }
        return value;
    }

    private static long requiredNonNegativeSafeInteger(JSONObject json, String field) {
        Object value = json.opt(field);
        if (!isExactInteger(value)) {
            throw new IllegalArgumentException("Stream control field " + field + " must be an integer");
        }
        long result = ((Number) value).longValue();
        if (result < 0 || result > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("Stream control field " + field + " must be a non-negative safe integer");
        }
        return result;
    }

    private static String requiredString(JSONObject json, String field) {
        Object value = json.opt(field);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException("Stream control field " + field + " must be a string");
        }
        return (String) value;
    }

    private static void assertCanonicalBase64Url(String value, int expectedBytes, String label) {
        decodeCanonicalBase64Url(value, expectedBytes, label);
    }

    private static byte[] decodeCanonicalBase64Url(String value, int expectedBytes, String label) {
        if (value == null || !BASE64URL.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must use unpadded base64url");
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(value);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(label + " must be valid base64url", error);
        }
        String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
        if (decoded.length != expectedBytes || !canonical.equals(value)) {
            throw new IllegalArgumentException(label + " must be canonical base64url for " + expectedBytes + " bytes");
        }
        return decoded;
    }

    private static boolean isExactInteger(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }

    private static Set<String> immutableSet(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }
}
