package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

public class V2IdentityTest {
    @Test
    public void acceptsSharedFixedPemIdentityWithoutChangingItsText() throws Exception {
        JSONObject fixture = loadFixture().getJSONObject("pairingCode").getJSONObject("responder");

        V2Identity identity = V2Identity.fromJson(fixture);

        assertEquals("b4153ead60ea8430", identity.deviceId);
        assertEquals("Android phone", identity.deviceName);
        assertEquals("B415-3EAD-60EA-8430-F3EF-6677", identity.fingerprint);
        assertEquals(fixture.getString("signingPublicKey"), identity.signingPublicKey);
        assertEquals(fixture.getString("encryptionPublicKey"), identity.encryptionPublicKey);
        assertEquals(
            ProtocolV2.canonicalJson(fixture),
            ProtocolV2.canonicalJson(identity.toJson())
        );
    }

    @Test
    public void generatedKeysAreBoundToIdentityMetadata() throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPem = CryptoUtil.toPublicPem(signing.getPublic());
        String encryptionPem = CryptoUtil.toPublicPem(encryption.getPublic());

        V2Identity identity = V2Identity.create(
            CryptoUtil.deviceIdFor(signingPem),
            "Android test device",
            CryptoUtil.fingerprintFor(signingPem),
            signingPem,
            encryptionPem
        );

        assertNotNull(identity);
        expectRejected(() -> V2Identity.create(
            identity.deviceId,
            identity.deviceName,
            identity.fingerprint,
            identity.signingPublicKey,
            identity.signingPublicKey
        ));
        expectRejected(() -> V2Identity.create(
            "0000000000000000",
            identity.deviceName,
            identity.fingerprint,
            identity.signingPublicKey,
            identity.encryptionPublicKey
        ));
        expectRejected(() -> V2Identity.create(
            identity.deviceId,
            identity.deviceName,
            "0000-0000-0000-0000-0000-0000",
            identity.signingPublicKey,
            identity.encryptionPublicKey
        ));
    }

    private static JSONObject loadFixture() throws Exception {
        try (InputStream input = V2IdentityTest.class.getResourceAsStream("/protocol-v2-pairing.json")) {
            if (input == null) {
                throw new AssertionError("Missing shared protocol v2 fixture");
            }
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void expectRejected(ThrowingRunnable action) throws Exception {
        try {
            action.run();
            fail("Expected protocol validation to reject input");
        } catch (IllegalArgumentException expected) {
            // Expected validation failure.
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}