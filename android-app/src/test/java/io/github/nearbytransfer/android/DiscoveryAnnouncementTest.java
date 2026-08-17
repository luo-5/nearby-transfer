package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class DiscoveryAnnouncementTest {
    private static String signingPublicKey;
    private static String encryptionPublicKey;

    @BeforeClass
    public static void createKeys() throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());
        encryptionPublicKey = CryptoUtil.toPublicPem(encryption.getPublic());
    }

    @Test
    public void acceptsValidAnnouncement() throws Exception {
        PeerDevice peer = parse(validPayload());

        assertNotNull(peer);
        assertEquals("Test sender", peer.deviceName);
        assertEquals("192.0.2.10", peer.host);
        assertEquals(47778, peer.port);
        assertEquals(signingPublicKey, peer.signingPublicKey);
        assertEquals(encryptionPublicKey, peer.encryptionPublicKey);
        assertEquals(1234L, peer.lastSeen);
    }

    @Test
    public void rejectsNonStrictNumericFields() throws Exception {
        assertRejected(with(validPayload(), "protocolVersion", "1"));
        assertRejected(with(validPayload(), "port", "47778"));
        assertRejected(with(validPayload(), "port", 47778.5));
        assertRejected(with(validPayload(), "port", new BigDecimal("47778.00000000000000000001")));
        assertRejected(with(validPayload(), "port", 0));
        assertRejected(with(validPayload(), "port", 65536));
    }

    @Test
    public void rejectsInvalidNamesAndIdentityMetadata() throws Exception {
        assertRejected(with(validPayload(), "deviceName", "   "));
        assertRejected(with(validPayload(), "deviceName", repeat('a', 129)));
        assertRejected(with(validPayload(), "deviceId", "INVALID-DEVICE-ID"));
        assertRejected(with(validPayload(), "fingerprint", "00-00-00-00-00-00"));
    }

    @Test
    public void rejectsWrongOrMalformedPublicKeys() throws Exception {
        JSONObject wrongSigningType = validPayload();
        wrongSigningType.put("signingPublicKey", encryptionPublicKey);
        wrongSigningType.put("deviceId", CryptoUtil.deviceIdFor(encryptionPublicKey));
        wrongSigningType.put("fingerprint", CryptoUtil.fingerprintFor(encryptionPublicKey));
        assertRejected(wrongSigningType);

        assertRejected(with(validPayload(), "encryptionPublicKey", signingPublicKey));
        assertRejected(with(validPayload(), "encryptionPublicKey", "not a public key"));
        assertRejected(with(validPayload(), "signingPublicKey", repeat('a', 4097)));
    }

    @Test
    public void rejectsLocalMalformedAndOversizedDatagrams() throws Exception {
        JSONObject local = validPayload();
        assertNull(parse(bytes(local), local.getString("deviceId")));

        byte[] malformed = "{not-json".getBytes(StandardCharsets.UTF_8);
        assertNull(DiscoveryAnnouncement.parse(malformed, 0, malformed.length, "192.0.2.10", "local-device", 1234L));

        JSONObject oversized = validPayload();
        oversized.put("padding", repeat('a', DiscoveryAnnouncement.MAX_BYTES));
        assertNull(parse(bytes(oversized), "local-device"));
    }

    private static JSONObject validPayload() throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("app", "nearby-transfer");
        payload.put("protocolVersion", 1);
        payload.put("type", "announce");
        payload.put("deviceId", CryptoUtil.deviceIdFor(signingPublicKey));
        payload.put("deviceName", "Test sender");
        payload.put("port", 47778);
        payload.put("signingPublicKey", signingPublicKey);
        payload.put("encryptionPublicKey", encryptionPublicKey);
        payload.put("fingerprint", CryptoUtil.fingerprintFor(signingPublicKey));
        payload.put("timestamp", 1234L);
        return payload;
    }

    private static JSONObject with(JSONObject payload, String key, Object value) throws Exception {
        payload.put(key, value);
        return payload;
    }

    private static void assertRejected(JSONObject payload) {
        assertNull(parse(payload));
    }

    private static PeerDevice parse(JSONObject payload) {
        return parse(bytes(payload), "local-device");
    }

    private static PeerDevice parse(byte[] data, String localDeviceId) {
        return DiscoveryAnnouncement.parse(data, 0, data.length, "192.0.2.10", localDeviceId, 1234L);
    }

    private static byte[] bytes(JSONObject payload) {
        return payload.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String repeat(char value, int count) {
        StringBuilder builder = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) {
            builder.append(value);
        }
        return builder.toString();
    }
}
