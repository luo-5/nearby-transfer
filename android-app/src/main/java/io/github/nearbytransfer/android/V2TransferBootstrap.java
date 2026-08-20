package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.util.Base64;
import java.util.regex.Pattern;

/** Strict, socket-independent bootstrap helpers for protocol-v2 transfers. */
final class V2TransferBootstrap {
    static final long DEFAULT_DECISION_TTL_MS = 30_000L;
    static final long MAX_DECISION_TTL_MS = V2TransferMessage.MAX_MESSAGE_TTL_MS;

    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");

    private V2TransferBootstrap() {}

    /** A manifest that passed canonical decoding, route checks, and trusted-key verification. */
    static final class VerifiedManifest {
        final V2TransferMessage.ManifestEnvelope message;
        final String taskId;
        final String sessionId;

        private VerifiedManifest(V2TransferMessage.ManifestEnvelope message) throws Exception {
            this.message = message;
            this.taskId = message.manifest.getString("taskId");
            this.sessionId = message.sessionId;
        }
    }

    static VerifiedManifest verifyIncomingManifestFrame(
        byte[] encodedFrame,
        String trustedSenderSigningPublicKeyPem,
        String expectedLocalReceiverId,
        String expectedRemoteSenderId,
        long nowEpochMillis
    ) throws Exception {
        return verifyIncomingManifestFrame(
            V2WireFrame.decode(encodedFrame),
            trustedSenderSigningPublicKeyPem,
            expectedLocalReceiverId,
            expectedRemoteSenderId,
            nowEpochMillis
        );
    }

    static VerifiedManifest verifyIncomingManifestFrame(
        V2WireFrame.Frame frame,
        String trustedSenderSigningPublicKeyPem,
        String expectedLocalReceiverId,
        String expectedRemoteSenderId,
        long nowEpochMillis
    ) throws Exception {
        requireDeviceId(expectedLocalReceiverId, "Expected local receiver ID");
        if (expectedRemoteSenderId != null) {
            requireDeviceId(expectedRemoteSenderId, "Expected remote sender ID");
        }

        V2TransferMessage.Message verified = decodeAndVerify(
            frame,
            V2TransferMessage.TYPE_MANIFEST,
            trustedSenderSigningPublicKeyPem,
            nowEpochMillis
        );
        if (!(verified instanceof V2TransferMessage.ManifestEnvelope)) {
            throw new IllegalArgumentException("Bootstrap frame is not a transfer manifest");
        }
        V2TransferMessage.ManifestEnvelope manifest = (V2TransferMessage.ManifestEnvelope) verified;
        if (!expectedLocalReceiverId.equals(manifest.receiverDeviceId)) {
            throw new IllegalArgumentException("Transfer manifest receiver does not match the local device");
        }
        if (expectedRemoteSenderId != null && !expectedRemoteSenderId.equals(manifest.senderDeviceId)) {
            throw new IllegalArgumentException("Transfer manifest sender does not match the trusted peer");
        }
        return new VerifiedManifest(manifest);
    }

    static byte[] encodeDecisionFrame(
        VerifiedManifest incomingManifest,
        String decision,
        String localSigningPrivateKeyPem,
        long nowEpochMillis
    ) throws Exception {
        return V2WireFrame.encode(createDecisionFrame(
            incomingManifest,
            decision,
            localSigningPrivateKeyPem,
            nowEpochMillis,
            DEFAULT_DECISION_TTL_MS
        ));
    }

    static byte[] encodeDecisionFrame(
        VerifiedManifest incomingManifest,
        String decision,
        String localSigningPrivateKeyPem,
        long nowEpochMillis,
        long ttlMillis
    ) throws Exception {
        return V2WireFrame.encode(createDecisionFrame(
            incomingManifest,
            decision,
            localSigningPrivateKeyPem,
            nowEpochMillis,
            ttlMillis
        ));
    }

    static V2WireFrame.Frame createDecisionFrame(
        VerifiedManifest incomingManifest,
        String decision,
        String localSigningPrivateKeyPem,
        long nowEpochMillis
    ) throws Exception {
        return createDecisionFrame(
            incomingManifest,
            decision,
            localSigningPrivateKeyPem,
            nowEpochMillis,
            DEFAULT_DECISION_TTL_MS
        );
    }

    static V2WireFrame.Frame createDecisionFrame(
        VerifiedManifest incomingManifest,
        String decision,
        String localSigningPrivateKeyPem,
        long nowEpochMillis,
        long ttlMillis
    ) throws Exception {
        if (incomingManifest == null) {
            throw new IllegalArgumentException("A verified incoming manifest is required");
        }
        requirePositiveSafeInteger(nowEpochMillis, "Transfer decision time");
        if (ttlMillis <= 0 || ttlMillis > MAX_DECISION_TTL_MS) {
            throw new IllegalArgumentException("Transfer decision TTL must be between 1 and "
                + MAX_DECISION_TTL_MS + " milliseconds");
        }
        if (nowEpochMillis > MAX_SAFE_INTEGER - ttlMillis) {
            throw new IllegalArgumentException("Transfer decision expiry exceeds the safe integer range");
        }

        V2TransferMessage.ManifestEnvelope manifest = incomingManifest.message;
        JSONObject unsigned = new JSONObject();
        unsigned.put("app", ProtocolV2.APP_ID);
        unsigned.put("protocolVersion", ProtocolV2.VERSION);
        unsigned.put("type", V2TransferMessage.TYPE_DECISION);
        unsigned.put("taskId", incomingManifest.taskId);
        unsigned.put("sessionId", incomingManifest.sessionId);
        unsigned.put("senderDeviceId", manifest.receiverDeviceId);
        unsigned.put("receiverDeviceId", manifest.senderDeviceId);
        unsigned.put("decision", decision);
        unsigned.put("issuedAt", nowEpochMillis);
        unsigned.put("expiresAt", nowEpochMillis + ttlMillis);

        JSONObject signed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_DECISION,
            unsigned,
            localSigningPrivateKeyPem
        );
        V2TransferMessage.Message normalized = V2TransferMessage.fromJson(
            V2TransferMessage.TYPE_DECISION,
            signed,
            nowEpochMillis
        );
        byte[] payload = V2TransferMessage.encode(normalized, nowEpochMillis);
        return new V2WireFrame.Frame(
            header(V2TransferMessage.TYPE_DECISION),
            payload
        );
    }

    static V2TransferMessage.Decision verifyDecisionFrame(
        byte[] encodedFrame,
        String trustedDecisionSignerPublicKeyPem,
        String expectedDecisionSenderId,
        String expectedDecisionReceiverId,
        String expectedTaskId,
        String expectedSessionId,
        long nowEpochMillis
    ) throws Exception {
        requireDeviceId(expectedDecisionSenderId, "Expected decision sender ID");
        requireDeviceId(expectedDecisionReceiverId, "Expected decision receiver ID");
        requireTaskId(expectedTaskId);
        requireSessionId(expectedSessionId);

        V2TransferMessage.Message verified = decodeAndVerify(
            V2WireFrame.decode(encodedFrame),
            V2TransferMessage.TYPE_DECISION,
            trustedDecisionSignerPublicKeyPem,
            nowEpochMillis
        );
        if (!(verified instanceof V2TransferMessage.Decision)) {
            throw new IllegalArgumentException("Bootstrap frame is not a transfer decision");
        }
        V2TransferMessage.Decision decision = (V2TransferMessage.Decision) verified;
        if (!expectedDecisionSenderId.equals(decision.senderDeviceId)
            || !expectedDecisionReceiverId.equals(decision.receiverDeviceId)) {
            throw new IllegalArgumentException("Transfer decision route does not match the expected peers");
        }
        if (!expectedTaskId.equals(decision.taskId)) {
            throw new IllegalArgumentException("Transfer decision task does not match the active transfer");
        }
        if (!expectedSessionId.equals(decision.sessionId)) {
            throw new IllegalArgumentException("Transfer decision session does not match the active connection");
        }
        return decision;
    }

    private static V2TransferMessage.Message decodeAndVerify(
        V2WireFrame.Frame frame,
        String expectedType,
        String trustedSigningPublicKeyPem,
        long nowEpochMillis
    ) throws Exception {
        if (frame == null) {
            throw new IllegalArgumentException("A decoded bootstrap frame is required");
        }
        assertHeader(frame.header, expectedType);

        V2TransferMessage.Message decoded = V2TransferMessage.decode(
            expectedType,
            frame.payload,
            nowEpochMillis
        );
        return V2TransferMessageAuth.verify(
            expectedType,
            decoded.toJson(),
            trustedSigningPublicKeyPem,
            nowEpochMillis
        );
    }

    private static JSONObject header(String type) throws Exception {
        JSONObject header = new JSONObject();
        header.put("app", ProtocolV2.APP_ID);
        header.put("protocolVersion", ProtocolV2.VERSION);
        header.put("type", type);
        return header;
    }

    private static void assertHeader(JSONObject header, String expectedType) {
        Object version = header == null ? null : header.opt("protocolVersion");
        boolean exactVersion = version instanceof Byte || version instanceof Short
            || version instanceof Integer || version instanceof Long;
        if (header == null || header.length() != 3
            || !ProtocolV2.APP_ID.equals(header.opt("app"))
            || !exactVersion || ((Number) version).longValue() != ProtocolV2.VERSION
            || !expectedType.equals(header.opt("type"))) {
            throw new IllegalArgumentException("Bootstrap frame header must exactly match " + expectedType);
        }
    }

    private static void requireDeviceId(String value, String label) {
        if (value == null || !DEVICE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must be 16 lowercase hexadecimal characters");
        }
    }

    private static void requireTaskId(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Expected task ID is required");
        }
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(value);
            String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != 16 || !canonical.equals(value)) {
                throw new IllegalArgumentException("Expected task ID must be canonical base64url");
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Expected task ID must be canonical base64url", error);
        }
    }

    private static void requireSessionId(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Expected session ID is required");
        }
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(value);
            String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != 16 || !canonical.equals(value)) {
                throw new IllegalArgumentException("Expected session ID must be canonical base64url");
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Expected session ID must be canonical base64url", error);
        }
    }

    private static void requirePositiveSafeInteger(long value, String label) {
        if (value <= 0 || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(label + " must be a positive safe integer");
        }
    }
}
