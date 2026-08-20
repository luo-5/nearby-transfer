package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Base64;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class V2TransferBootstrapTest {
    private static final long NOW = 1_760_000_001_000L;
    private static final String TASK_ID = "AQIDBAUGBwgJCgsMDQ4PEA";
    private static final String SESSION_ID = "ICEiIyQlJicoKSorLC0uLw";
    private static final String OTHER_SESSION_ID = "MDEyMzQ1Njc4OTo7PD0-Pw";
    private static final String SENDER_ID = "696d52f50efd19bf";
    private static final String RECEIVER_ID = "428997b2c1f7c6ec";
    private static final String OTHER_ID = "8fa1d28f6686c3eb";

    private String senderPrivateKey;
    private String senderPublicKey;
    private String receiverPrivateKey;
    private String receiverPublicKey;
    private String otherPublicKey;

    @Before
    public void setUp() throws Exception {
        KeyPair sender = CryptoUtil.generateEd25519KeyPair();
        KeyPair receiver = CryptoUtil.generateEd25519KeyPair();
        KeyPair other = CryptoUtil.generateEd25519KeyPair();
        senderPrivateKey = CryptoUtil.toPrivatePem(sender.getPrivate());
        senderPublicKey = CryptoUtil.toPublicPem(sender.getPublic());
        receiverPrivateKey = CryptoUtil.toPrivatePem(receiver.getPrivate());
        receiverPublicKey = CryptoUtil.toPublicPem(receiver.getPublic());
        otherPublicKey = CryptoUtil.toPublicPem(other.getPublic());
    }

    @Test
    public void verifiesManifestAndEncodesAcceptedOrRejectedReverseRouteDecisions() throws Exception {
        V2TransferBootstrap.VerifiedManifest manifest = verifiedManifest();
        assertEquals(TASK_ID, manifest.taskId);
        assertEquals(SESSION_ID, manifest.sessionId);
        assertEquals(SENDER_ID, manifest.message.senderDeviceId);
        assertEquals(RECEIVER_ID, manifest.message.receiverDeviceId);

        for (String outcome : Arrays.asList("accepted", "rejected")) {
            byte[] encoded = V2TransferBootstrap.encodeDecisionFrame(
                manifest,
                outcome,
                receiverPrivateKey,
                NOW
            );
            V2TransferMessage.Decision decision = V2TransferBootstrap.verifyDecisionFrame(
                encoded,
                receiverPublicKey,
                RECEIVER_ID,
                SENDER_ID,
                TASK_ID,
                SESSION_ID,
                NOW
            );
            assertEquals(outcome, decision.decision);
            assertEquals(RECEIVER_ID, decision.senderDeviceId);
            assertEquals(SENDER_ID, decision.receiverDeviceId);
            assertEquals(TASK_ID, decision.taskId);
            assertEquals(SESSION_ID, decision.sessionId);
            assertEquals(NOW, decision.issuedAt);
            assertEquals(NOW + V2TransferBootstrap.DEFAULT_DECISION_TTL_MS, decision.expiresAt);
        }
    }

    @Test
    public void decisionTtlIsPositiveBoundedAndCanReachProtocolMaximum() throws Exception {
        V2TransferBootstrap.VerifiedManifest manifest = verifiedManifest();
        byte[] maximum = V2TransferBootstrap.encodeDecisionFrame(
            manifest,
            "busy",
            receiverPrivateKey,
            NOW,
            V2TransferBootstrap.MAX_DECISION_TTL_MS
        );
        V2TransferMessage.Decision decoded = V2TransferBootstrap.verifyDecisionFrame(
            maximum,
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            SESSION_ID,
            NOW
        );
        assertEquals(NOW + V2TransferBootstrap.MAX_DECISION_TTL_MS, decoded.expiresAt);

        assertFailure(() -> V2TransferBootstrap.encodeDecisionFrame(
            manifest, "accepted", receiverPrivateKey, NOW, 0
        ));
        assertFailure(() -> V2TransferBootstrap.encodeDecisionFrame(
            manifest,
            "accepted",
            receiverPrivateKey,
            NOW,
            V2TransferBootstrap.MAX_DECISION_TTL_MS + 1
        ));
        assertFailure(() -> V2TransferBootstrap.encodeDecisionFrame(
            manifest, "free-form", receiverPrivateKey, NOW
        ));
    }

    @Test
    public void rejectsTamperedManifestWrongKeyAndWrongExpectedRoute() throws Exception {
        JSONObject signed = signedManifest(NOW, NOW + 120_000L);
        byte[] valid = frame(V2TransferMessage.TYPE_MANIFEST, canonical(signed));

        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, otherPublicKey, RECEIVER_ID, SENDER_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, senderPublicKey, OTHER_ID, SENDER_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, senderPublicKey, RECEIVER_ID, OTHER_ID, NOW
        ));

        JSONObject tampered = copy(signed);
        tampered.put("senderEphemeralPublicKey", canonicalBase64Url(new byte[32]));
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, canonical(tampered)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        JSONObject replayedSession = copy(signed);
        replayedSession.put("sessionId", OTHER_SESSION_ID);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, canonical(replayedSession)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        JSONObject wrongRoute = unsignedManifest(NOW, NOW + 120_000L);
        wrongRoute.put("receiverDeviceId", OTHER_ID);
        JSONObject signedWrongRoute = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, wrongRoute, senderPrivateKey
        );
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, canonical(signedWrongRoute)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));
    }

    @Test
    public void rejectsWrongHeadersAndMessageTypes() throws Exception {
        byte[] payload = canonical(signedManifest(NOW, NOW + 120_000L));
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_DECISION, payload),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        JSONObject wrongApp = header(V2TransferMessage.TYPE_MANIFEST);
        wrongApp.put("app", "nearby-transfeR");
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            rawFrame(canonical(wrongApp), payload), senderPublicKey, RECEIVER_ID, SENDER_ID, NOW
        ));

        JSONObject wrongVersion = header(V2TransferMessage.TYPE_MANIFEST);
        wrongVersion.put("protocolVersion", 3);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            rawFrame(canonical(wrongVersion), payload), senderPublicKey, RECEIVER_ID, SENDER_ID, NOW
        ));

        JSONObject unknownHeader = header(V2TransferMessage.TYPE_MANIFEST);
        unknownHeader.put("unknown", true);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            rawFrame(canonical(unknownHeader), payload), senderPublicKey, RECEIVER_ID, SENDER_ID, NOW
        ));
    }

    @Test
    public void rejectsExpiredUnknownMalformedNoncanonicalAndOversizeManifests() throws Exception {
        JSONObject expired = signedManifest(NOW - 120_000L, NOW - 1L);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, canonical(expired)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        JSONObject unknown = signedManifest(NOW, NOW + 120_000L);
        unknown.put("unknown", true);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, canonical(unknown)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, "{".getBytes(StandardCharsets.UTF_8)),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        byte[] canonical = canonical(signedManifest(NOW, NOW + 120_000L));
        byte[] noncanonical = new byte[canonical.length + 1];
        noncanonical[0] = ' ';
        System.arraycopy(canonical, 0, noncanonical, 1, canonical.length);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, noncanonical),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));

        byte[] oversize = new byte[V2TransferMessage.MAX_MESSAGE_BYTES + 1];
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, oversize),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        ));
    }

    @Test
    public void rejectsNoncanonicalManifestTaskAndInvalidExpectedIdentityInputs() throws Exception {
        JSONObject badTask = unsignedManifest(NOW, NOW + 120_000L);
        badTask.getJSONObject("manifest").put("taskId", TASK_ID + "=");
        assertFailure(() -> V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, badTask, senderPrivateKey
        ));

        JSONObject badSession = unsignedManifest(NOW, NOW + 120_000L);
        badSession.put("sessionId", SESSION_ID + "=");
        assertFailure(() -> V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, badSession, senderPrivateKey
        ));
        JSONObject missingSession = unsignedManifest(NOW, NOW + 120_000L);
        missingSession.remove("sessionId");
        assertFailure(() -> V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, missingSession, senderPrivateKey
        ));

        byte[] valid = manifestFrame(NOW, NOW + 120_000L);
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, senderPublicKey, RECEIVER_ID.toUpperCase(), SENDER_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, senderPublicKey, RECEIVER_ID, "not-a-device-id", NOW
        ));

        V2TransferBootstrap.verifyIncomingManifestFrame(
            valid, senderPublicKey, RECEIVER_ID, null, NOW
        );
    }

    @Test
    public void decisionVerificationRejectsTamperingWrongKeyRouteTaskTypeAndExpiry() throws Exception {
        V2TransferBootstrap.VerifiedManifest manifest = verifiedManifest();
        byte[] valid = V2TransferBootstrap.encodeDecisionFrame(
            manifest, "accepted", receiverPrivateKey, NOW
        );

        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid, otherPublicKey, RECEIVER_ID, SENDER_ID, TASK_ID, SESSION_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid, receiverPublicKey, OTHER_ID, SENDER_ID, TASK_ID, SESSION_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid, receiverPublicKey, RECEIVER_ID, OTHER_ID, TASK_ID, SESSION_ID, NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid,
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            canonicalBase64Url(new byte[16]),
            SESSION_ID,
            NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid,
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            OTHER_SESSION_ID,
            NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            valid,
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            SESSION_ID,
            NOW + V2TransferBootstrap.DEFAULT_DECISION_TTL_MS + 1
        ));

        V2WireFrame.Frame decoded = V2WireFrame.decode(valid);
        JSONObject tampered = new JSONObject(new String(decoded.payload, StandardCharsets.UTF_8));
        tampered.put("decision", "rejected");
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            frame(V2TransferMessage.TYPE_DECISION, canonical(tampered)),
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            SESSION_ID,
            NOW
        ));
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            frame(V2TransferMessage.TYPE_MANIFEST, decoded.payload),
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            SESSION_ID,
            NOW
        ));
    }

    @Test
    public void decisionVerificationRejectsUnknownMalformedNoncanonicalAndOversizePayloads() throws Exception {
        byte[] valid = V2TransferBootstrap.encodeDecisionFrame(
            verifiedManifest(), "accepted", receiverPrivateKey, NOW
        );
        V2WireFrame.Frame decoded = V2WireFrame.decode(valid);
        JSONObject unknown = new JSONObject(new String(decoded.payload, StandardCharsets.UTF_8));
        unknown.put("unknown", true);
        assertDecisionFailure(frame(V2TransferMessage.TYPE_DECISION, canonical(unknown)));
        assertDecisionFailure(frame(
            V2TransferMessage.TYPE_DECISION, "[".getBytes(StandardCharsets.UTF_8)
        ));

        byte[] noncanonical = Arrays.copyOf(decoded.payload, decoded.payload.length + 1);
        noncanonical[noncanonical.length - 1] = '\n';
        assertDecisionFailure(frame(V2TransferMessage.TYPE_DECISION, noncanonical));
        assertDecisionFailure(frame(
            V2TransferMessage.TYPE_DECISION,
            new byte[V2TransferMessage.MAX_MESSAGE_BYTES + 1]
        ));
    }

    private V2TransferBootstrap.VerifiedManifest verifiedManifest() throws Exception {
        return V2TransferBootstrap.verifyIncomingManifestFrame(
            manifestFrame(NOW, NOW + 120_000L),
            senderPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            NOW
        );
    }

    private byte[] manifestFrame(long issuedAt, long expiresAt) throws Exception {
        return frame(
            V2TransferMessage.TYPE_MANIFEST,
            canonical(signedManifest(issuedAt, expiresAt))
        );
    }

    private JSONObject signedManifest(long issuedAt, long expiresAt) throws Exception {
        return V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST,
            unsignedManifest(issuedAt, expiresAt),
            senderPrivateKey
        );
    }

    private static JSONObject unsignedManifest(long issuedAt, long expiresAt) throws Exception {
        JSONObject file = new JSONObject();
        file.put("kind", "file");
        file.put("path", "hello.txt");
        file.put("size", 12);
        file.put("sha256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        JSONObject manifest = new JSONObject();
        manifest.put("app", ProtocolV2.APP_ID);
        manifest.put("protocolVersion", ProtocolV2.VERSION);
        manifest.put("type", V2TransferMessage.TYPE_MANIFEST);
        manifest.put("taskId", TASK_ID);
        manifest.put("conflictStrategy", "auto-rename");
        manifest.put("entries", new JSONArray().put(file));
        manifest.put("totalFiles", 1);
        manifest.put("totalBytes", 12);

        JSONObject envelope = new JSONObject();
        envelope.put("app", ProtocolV2.APP_ID);
        envelope.put("protocolVersion", ProtocolV2.VERSION);
        envelope.put("type", V2TransferMessage.TYPE_MANIFEST);
        envelope.put("manifest", manifest);
        envelope.put("sessionId", SESSION_ID);
        envelope.put("senderDeviceId", SENDER_ID);
        envelope.put("receiverDeviceId", RECEIVER_ID);
        byte[] ephemeralKey = new byte[32];
        Arrays.fill(ephemeralKey, (byte) 7);
        envelope.put("senderEphemeralPublicKey", canonicalBase64Url(ephemeralKey));
        envelope.put("issuedAt", issuedAt);
        envelope.put("expiresAt", expiresAt);
        return envelope;
    }

    private static byte[] frame(String type, byte[] payload) throws Exception {
        return V2WireFrame.encode(new V2WireFrame.Frame(header(type), payload));
    }

    private static JSONObject header(String type) throws Exception {
        JSONObject header = new JSONObject();
        header.put("app", ProtocolV2.APP_ID);
        header.put("protocolVersion", ProtocolV2.VERSION);
        header.put("type", type);
        return header;
    }

    private static byte[] rawFrame(byte[] encodedHeader, byte[] payload) {
        int bodyLength = V2WireFrame.HEADER_LENGTH_BYTES + encodedHeader.length + payload.length;
        byte[] frame = new byte[V2WireFrame.FRAME_LENGTH_BYTES + bodyLength];
        frame[0] = (byte) (bodyLength >>> 24);
        frame[1] = (byte) (bodyLength >>> 16);
        frame[2] = (byte) (bodyLength >>> 8);
        frame[3] = (byte) bodyLength;
        frame[4] = (byte) (encodedHeader.length >>> 8);
        frame[5] = (byte) encodedHeader.length;
        System.arraycopy(encodedHeader, 0, frame, V2WireFrame.FRAME_PREFIX_BYTES, encodedHeader.length);
        System.arraycopy(
            payload,
            0,
            frame,
            V2WireFrame.FRAME_PREFIX_BYTES + encodedHeader.length,
            payload.length
        );
        return frame;
    }

    private static byte[] canonical(JSONObject value) throws Exception {
        return ProtocolV2.canonicalJson(value).getBytes(StandardCharsets.UTF_8);
    }

    private static String canonicalBase64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private static JSONObject copy(JSONObject value) throws Exception {
        return new JSONObject(value.toString());
    }

    private void assertDecisionFailure(byte[] encoded) {
        assertFailure(() -> V2TransferBootstrap.verifyDecisionFrame(
            encoded,
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            TASK_ID,
            SESSION_ID,
            NOW
        ));
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected transfer bootstrap validation to fail");
        } catch (IllegalArgumentException expected) {
            // Expected: untrusted bootstrap input must fail closed.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
