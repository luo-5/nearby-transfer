package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2PairingTest {
    @Test
    public void verifiesDesktopPairingOfferFixtureAndCanonicalSigningPayload() throws Exception {
        JSONObject vector = loadVector().getJSONObject("pairingOffer");
        V2Pairing.Offer offer = V2Pairing.offerFromJson(vector.getJSONObject("offer"));

        assertEquals(vector.getString("canonicalSigningPayload"), V2Pairing.offerSigningPayload(offer));
        assertTrue(V2Pairing.verifyOffer(offer, vector.getString("signatureBase64")));
        assertFalse(V2Pairing.verifyOffer(offer, "invalid"));
        assertEquals("AQIDBAUGBwgJCgsMDQ4PEA", offer.pairingId);
    }

    @Test
    public void createsCanonicalMessagesAndPairingCode() throws Exception {
        V2Identity identity = V2Identity.fromJson(loadVector().getJSONObject("pairingOffer").getJSONObject("offer").getJSONObject("identity"));
        V2Pairing.Offer offer = V2Pairing.createOffer(identity, Arrays.asList("pairing"), "AQIDBAUGBwgJCgsMDQ4PEA", 1760000000100L);
        assertEquals("[\"pairing\"]", ProtocolV2.canonicalJson(new org.json.JSONArray(offer.capabilities)));
        assertEquals(offer.pairingId, V2Pairing.createConfirmation(offer.pairingId, 1760000000200L, identity.deviceId, "123456").pairingId);
        assertEquals(6, V2Pairing.derivePairingCode(offer.pairingId, identity, identity).length());
        assertTrue(V2Pairing.isFresh(1760000000100L, 1760000000100L));
        assertFalse(V2Pairing.isFresh(1760000000100L, 1760000000100L + V2Pairing.PAIRING_SESSION_TTL_MS + 1));
    }

    @Test
    public void rejectsInvalidPairingInputs() throws Exception {
        V2Identity identity = V2Identity.fromJson(loadVector().getJSONObject("pairingOffer").getJSONObject("offer").getJSONObject("identity"));
        assertFailure(() -> V2Pairing.createOffer(identity, Arrays.asList("Pairing"), "AQIDBAUGBwgJCgsMDQ4PEA", 1L));
        assertFailure(() -> V2Pairing.createConfirmation("invalid", 1L, identity.deviceId, "123456"));
        assertFailure(() -> V2Pairing.createConfirmation("AQIDBAUGBwgJCgsMDQ4PEA", 1L, identity.deviceId, "12345x"));
        assertFailure(() -> V2Pairing.createCancellation("AQIDBAUGBwgJCgsMDQ4PEA", 1L, identity.deviceId, "arbitrary"));
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = V2PairingTest.class.getResourceAsStream("/protocol-v2-discovery-and-wire.json")) {
            if (input == null) throw new AssertionError("Missing shared v2 fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected invalid pairing input to be rejected");
        } catch (IllegalArgumentException expected) {
            // Expected.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
