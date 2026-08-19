package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2DiscoveryAnnouncementTest {
    private static V2Identity identity;
    private static String signingPrivateKey;

    @BeforeClass
    public static void createIdentity() throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());
        identity = V2Identity.create(
            CryptoUtil.deviceIdFor(signingPublicKey),
            "Android discovery test",
            CryptoUtil.fingerprintFor(signingPublicKey),
            signingPublicKey,
            CryptoUtil.toPublicPem(encryption.getPublic())
        );
        signingPrivateKey = CryptoUtil.toPrivatePem(signing.getPrivate());
    }

    @Test
    public void locallyGeneratedKeyCanSignAndVerifyCanonicalAnnouncement() throws Exception {
        long issuedAt = 1_760_000_000_000L;
        V2DiscoveryAnnouncement announcement = V2DiscoveryAnnouncement.create(
            identity,
            47778,
            Arrays.asList("transfer", "pairing"),
            issuedAt
        );
        String signature = V2DiscoveryAnnouncement.sign(announcement, signingPrivateKey);
        String serialized = announcement.toCanonicalJson(signature);

        assertTrue(CryptoUtil.verify(announcement.signingPayload(), signature, identity.signingPublicKey));
        V2DiscoveryAnnouncement parsed = V2DiscoveryAnnouncement.parseAndVerify(
            serialized.getBytes(StandardCharsets.UTF_8),
            0,
            serialized.getBytes(StandardCharsets.UTF_8).length,
            issuedAt + 30_000L
        );

        assertEquals(identity.deviceId, parsed.identity.deviceId);
        assertEquals(47778, parsed.port);
        assertEquals(Arrays.asList("pairing", "transfer"), parsed.capabilities);
        assertEquals(signature, parsed.signature);
        assertTrue(V2DiscoveryAnnouncement.verify(parsed));
    }

    @Test
    public void rejectsTamperingNoncanonicalAndStaleAnnouncements() throws Exception {
        long issuedAt = 1_760_000_000_000L;
        V2DiscoveryAnnouncement announcement = V2DiscoveryAnnouncement.create(identity, 47778, Collections.singletonList("pairing"), issuedAt);
        String signature = V2DiscoveryAnnouncement.sign(announcement, signingPrivateKey);
        String canonical = announcement.toCanonicalJson(signature);

        JSONObject tampered = new JSONObject(canonical);
        tampered.put("port", 47779);
        String tamperedCanonical = ProtocolV2.canonicalJson(tampered);
        expectRejected(() -> parse(tamperedCanonical, issuedAt));

        expectRejected(() -> parse(announcement.toJson(signature).toString(), issuedAt));
        expectRejected(() -> parse(canonical, issuedAt + V2DiscoveryAnnouncement.MAX_CLOCK_SKEW_MS + 1));
        expectRejected(() -> V2DiscoveryAnnouncement.create(identity, 47778, Arrays.asList("pairing", "pairing"), issuedAt));
        expectRejected(() -> V2DiscoveryAnnouncement.create(identity, 0, Collections.singletonList("pairing"), issuedAt));
        expectRejected(() -> V2DiscoveryAnnouncement.create(identity, 47778, Collections.singletonList("pairing"), 0));
    }

    @Test
    public void rejectsOversizedAndInvalidUtf8Datagrams() throws Exception {
        byte[] oversized = new byte[V2DiscoveryAnnouncement.MAX_ANNOUNCEMENT_BYTES + 1];
        expectRejected(() -> V2DiscoveryAnnouncement.parseAndVerify(oversized, 0, oversized.length, 1_760_000_000_000L));

        byte[] invalidUtf8 = new byte[] { '{', (byte) 0xc3, (byte) 0x28, '}' };
        expectRejected(() -> V2DiscoveryAnnouncement.parseAndVerify(invalidUtf8, 0, invalidUtf8.length, 1_760_000_000_000L));
    }

    @Test
    public void verifiesDesktopGeneratedDiscoveryFixtureByteForByte() throws Exception {
        JSONObject fixture = loadSharedFixture().getJSONObject("discovery");
        String canonicalUnsigned = fixture.getString("canonicalUnsigned");
        String canonicalSigned = fixture.getString("canonicalSigned");
        long now = fixture.getLong("nowEpochMillis");

        V2DiscoveryAnnouncement parsed = V2DiscoveryAnnouncement.parseAndVerify(
            canonicalSigned.getBytes(StandardCharsets.UTF_8),
            0,
            canonicalSigned.getBytes(StandardCharsets.UTF_8).length,
            now
        );

        assertEquals(canonicalUnsigned, parsed.signingPayload());
        assertEquals(canonicalSigned, parsed.toCanonicalJson(parsed.signature));
        assertEquals(fixture.getString("signatureBase64"), parsed.signature);
        assertEquals("8fa1d28f6686c3eb", parsed.identity.deviceId);
        assertTrue(V2DiscoveryAnnouncement.verify(parsed));
    }

    @Test
    public void signatureFieldIsNotPartOfSigningPayload() throws Exception {
        long issuedAt = 1_760_000_000_000L;
        V2DiscoveryAnnouncement announcement = V2DiscoveryAnnouncement.create(identity, 47778, Collections.singletonList("pairing"), issuedAt);
        String signature = V2DiscoveryAnnouncement.sign(announcement, signingPrivateKey);
        JSONObject signed = announcement.toJson(signature);

        assertFalse(announcement.signingPayload().contains("\"signature\""));
        assertTrue(CryptoUtil.verify(announcement.signingPayload(), signed.getString("signature"), identity.signingPublicKey));
    }

    private static JSONObject loadSharedFixture() throws Exception {
        try (InputStream input = V2DiscoveryAnnouncementTest.class.getResourceAsStream("/protocol-v2-discovery-and-wire.json")) {
            if (input == null) {
                throw new AssertionError("Missing shared v2 discovery fixture");
            }
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static V2DiscoveryAnnouncement parse(String text, long now) throws Exception {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        return V2DiscoveryAnnouncement.parseAndVerify(data, 0, data.length, now);
    }

    private static void expectRejected(ThrowingRunnable action) throws Exception {
        try {
            action.run();
            fail("Expected protocol validation to reject input");
        } catch (Exception expected) {
            // Expected validation failure.
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}