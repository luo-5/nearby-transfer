package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;

public class ProtocolV2Test {
    @Test
    public void pairingCodeMatchesSharedProtocolVector() throws Exception {
        JSONObject vector = loadVector().getJSONObject("pairingCode");
        String pairingId = vector.getString("pairingId");
        JSONObject initiator = vector.getJSONObject("initiator");
        JSONObject responder = vector.getJSONObject("responder");

        assertEquals(
            vector.getString("expectedTranscript"),
            ProtocolV2.pairingCodeTranscript(pairingId, initiator, responder)
        );
        assertEquals(
            vector.getString("expectedCode"),
            ProtocolV2.derivePairingCode(pairingId, initiator, responder)
        );
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = ProtocolV2Test.class.getResourceAsStream("/protocol-v2-pairing.json")) {
            if (input == null) {
                throw new AssertionError("Missing shared protocol v2 fixture");
            }
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
}
