package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Base64;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2TransferMessageAuthTest {
    private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]+$");

    private KeyPair signingKey;
    private String privateKeyPem;
    private String publicKeyPem;

    @Before
    public void setUp() throws Exception {
        signingKey = CryptoUtil.generateEd25519KeyPair();
        privateKeyPem = CryptoUtil.toPrivatePem(signingKey.getPrivate());
        publicKeyPem = CryptoUtil.toPublicPem(signingKey.getPublic());
    }

    @Test
    public void signsAndVerifiesEverySharedTransferMessageKind() throws Exception {
        JSONObject fixture = loadFixture();
        JSONObject vectors = fixture.getJSONObject("vectors");
        long now = fixture.getLong("validationNow");

        for (String name : vectorNames()) {
            JSONObject vector = vectors.getJSONObject(name);
            String type = vector.getString("type");
            JSONObject original = vector.getJSONObject("message");
            String before = original.toString();

            String signature = V2TransferMessageAuth.sign(type, original, privateKeyPem);
            assertTrue(BASE64URL.matcher(signature).matches());
            assertFalse(signature.contains("="));
            assertEquals(64, Base64.getUrlDecoder().decode(signature).length);

            JSONObject signed = V2TransferMessageAuth.signedCopy(type, original, privateKeyPem);
            assertEquals(signature, signed.getString("signature"));
            V2TransferMessage.Message verified = V2TransferMessageAuth.verify(
                type, signed, publicKeyPem, now
            );
            assertEquals(type, verified.type);
            assertEquals(before, original.toString());
        }
    }

    @Test
    public void matchesSharedCrossPlatformVector() throws Exception {
        JSONObject fixture = loadAuthFixture();
        JSONObject receiver = fixture.getJSONObject("receiver");
        JSONObject vector = fixture.getJSONObject("transferDecision");
        String type = vector.getString("type");
        long now = fixture.getLong("validationNow");

        JSONObject signed = V2TransferMessageAuth.signedCopy(
            type,
            vector.getJSONObject("unsigned"),
            receiver.getString("signingPrivateKey")
        );
        assertEquals(vector.getString("canonicalSigned"), ProtocolV2.canonicalJson(signed));

        V2TransferMessage.Message verified = V2TransferMessageAuth.verify(
            type,
            new JSONObject(vector.getString("canonicalSigned")),
            receiver.getString("signingPublicKey"),
            now
        );
        assertEquals(type, verified.type);
        assertEquals(fixture.getString("sessionId"), ((V2TransferMessage.Decision) verified).sessionId);
    }

    @Test
    public void rejectsTamperingAndWrongSigningKey() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject decision = copy(fixture.getJSONObject("vectors")
            .getJSONObject("transferDecision").getJSONObject("message"));
        JSONObject signed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_DECISION, decision, privateKeyPem
        );

        JSONObject tampered = copy(signed);
        tampered.put("decision", "rejected");
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION, tampered, publicKeyPem, now
        ));

        KeyPair wrongKey = CryptoUtil.generateEd25519KeyPair();
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION,
            signed,
            CryptoUtil.toPublicPem(wrongKey.getPublic()),
            now
        ));
    }

    @Test
    public void rejectsWrongKeyTypesAndNonCanonicalSignatures() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject decision = fixture.getJSONObject("vectors")
            .getJSONObject("transferDecision").getJSONObject("message");
        KeyPair x25519 = CryptoUtil.generateX25519KeyPair();

        assertFailure(() -> V2TransferMessageAuth.sign(
            V2TransferMessage.TYPE_DECISION,
            decision,
            CryptoUtil.toPrivatePem(x25519.getPrivate())
        ));

        JSONObject signed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_DECISION, decision, privateKeyPem
        );
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION,
            signed,
            CryptoUtil.toPublicPem(x25519.getPublic()),
            now
        ));

        JSONObject padded = copy(signed);
        padded.put("signature", signed.getString("signature") + "==");
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION, padded, publicKeyPem, now
        ));

        JSONObject standardBase64 = copy(signed);
        standardBase64.put(
            "signature",
            Base64.getEncoder().encodeToString(Base64.getUrlDecoder().decode(signed.getString("signature")))
        );
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION, standardBase64, publicKeyPem, now
        ));
    }

    @Test
    public void appliesExpiryAndCheckpointValidationBeforeAcceptance() throws Exception {
        JSONObject fixture = loadFixture();
        JSONObject decision = fixture.getJSONObject("vectors")
            .getJSONObject("transferDecision").getJSONObject("message");
        JSONObject signedDecision = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_DECISION, decision, privateKeyPem
        );
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_DECISION,
            signedDecision,
            publicKeyPem,
            decision.getLong("expiresAt") + 1L
        ));

        long now = fixture.getLong("validationNow");
        JSONObject monotonicity = fixture.getJSONObject("monotonicity");
        JSONObject initialResume = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_RESUME,
            monotonicity.getJSONObject("initialResume"),
            privateKeyPem
        );
        V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_RESUME, initialResume, publicKeyPem, now
        );
        V2TransferMessage.ControlCheckpoint checkpoint = V2TransferMessage.advanceCheckpoint(
            V2TransferMessage.TYPE_RESUME, initialResume, now, null
        );

        JSONObject progressA = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_PROGRESS,
            monotonicity.getJSONObject("progressA"),
            privateKeyPem
        );
        V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_PROGRESS, progressA, publicKeyPem, now, checkpoint
        );
        checkpoint = V2TransferMessage.advanceCheckpoint(
            V2TransferMessage.TYPE_PROGRESS, progressA, now, checkpoint
        );
        final V2TransferMessage.ControlCheckpoint afterA = checkpoint;

        JSONObject regressed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_PROGRESS,
            monotonicity.getJSONObject("regressedAAfterB"),
            privateKeyPem
        );
        assertFailure(() -> V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_PROGRESS, regressed, publicKeyPem, now, afterA
        ));
    }

    @Test
    public void helpersNeverMutateCallerObjects() throws Exception {
        JSONObject fixture = loadFixture();
        JSONObject manifest = fixture.getJSONObject("vectors")
            .getJSONObject("transferManifest").getJSONObject("message");
        String before = manifest.toString();
        String originalSignature = manifest.getString("signature");

        String signature = V2TransferMessageAuth.sign(
            V2TransferMessage.TYPE_MANIFEST, manifest, privateKeyPem
        );
        JSONObject signed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, manifest, privateKeyPem
        );
        V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_MANIFEST,
            signed,
            publicKeyPem,
            fixture.getLong("validationNow")
        );

        assertEquals(before, manifest.toString());
        assertEquals(originalSignature, manifest.getString("signature"));
        assertNotEquals(originalSignature, signature);
        assertNotEquals(originalSignature, signed.getString("signature"));
    }

    private static String[] vectorNames() {
        return new String[] {
            "transferManifest",
            "transferDecision",
            "transferCompleteSuccess",
            "transferCompleteFailure",
            "transferResume",
            "transferProgress"
        };
    }

    private static JSONObject loadFixture() throws Exception {
        try (InputStream input = V2TransferMessageAuthTest.class
            .getResourceAsStream("/protocol-v2-transfer-messages.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer-message fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static JSONObject loadAuthFixture() throws Exception {
        try (InputStream input = V2TransferMessageAuthTest.class
            .getResourceAsStream("/protocol-v2-transfer-auth.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer-auth fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static JSONObject copy(JSONObject value) throws Exception {
        return new JSONObject(value.toString());
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected transfer-message authentication to fail");
        } catch (IllegalArgumentException expected) {
            // Expected protocol or key rejection.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
