package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class V2ControlMessageTest {
    @Test
    public void desktopOfferPayloadVectorRoundTripsByteForByte() throws Exception {
        JSONObject vector = loadVector();
        JSONObject offerVector = vector.getJSONObject("pairingOffer");
        JSONObject wireVector = vector.getJSONObject("wireFrame");
        V2Pairing.Offer offer = V2Pairing.offerFromJson(offerVector.getJSONObject("offer"));
        byte[] expected = wireVector.getString("payloadUtf8").getBytes(StandardCharsets.UTF_8);

        byte[] encoded = V2ControlMessage.encodeOffer(offer, offerVector.getString("signatureBase64"));
        assertArrayEquals(expected, encoded);
        V2ControlMessage.Message decoded = V2ControlMessage.decode(V2Pairing.TYPE_OFFER, encoded);
        assertEquals(offer.pairingId, decoded.offer.pairingId);
        assertEquals(offerVector.getString("signatureBase64"), decoded.signature);
    }

    @Test
    public void decoderRejectsWrongEnvelopePayloadAndSignature() throws Exception {
        assertFailure(() -> V2ControlMessage.decode("transfer-manifest", new byte[] { '{', '}' }));
        assertFailure(() -> V2ControlMessage.decode(V2Pairing.TYPE_OFFER, new byte[] { '{', '}' }));
        assertFailure(() -> V2ControlMessage.decode(V2Pairing.TYPE_OFFER, "{\"signature\":\"x\",\"offer\":{}}".getBytes(StandardCharsets.UTF_8)));
        assertFailure(() -> V2ControlMessage.decode(V2Pairing.TYPE_OFFER, new byte[V2ControlMessage.MAX_CONTROL_PAYLOAD_BYTES + 1]));
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = V2ControlMessageTest.class.getResourceAsStream("/protocol-v2-discovery-and-wire.json")) {
            if (input == null) throw new AssertionError("Missing shared v2 fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected protocol input to be rejected");
        } catch (IllegalArgumentException expected) {
            // Expected.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
