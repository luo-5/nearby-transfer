package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

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

    @Test
    public void canonicalJsonUsesTheRestrictedProtocolValueSubset() throws Exception {
        JSONObject object = new JSONObject();
        object.put("z", 1);
        object.put("a", new JSONArray().put(true).put(JSONObject.NULL).put("text"));
        assertEquals("{\"a\":[true,null,\"text\"],\"z\":1}", ProtocolV2.canonicalJson(object));

        assertFailure(() -> ProtocolV2.canonicalJson(1.0d), "floating point values must be rejected");
        assertFailure(() -> ProtocolV2.canonicalJson(new BigDecimal("1")), "BigDecimal values must be rejected");
        assertFailure(() -> ProtocolV2.canonicalJson(9_007_199_254_740_992L), "unsafe integers must be rejected");
        assertFailure(() -> ProtocolV2.canonicalJson("bad\ud800"), "unpaired surrogate values must be rejected");

        JSONObject badKey = new JSONObject();
        badKey.put("bad\udc00", true);
        assertFailure(() -> ProtocolV2.canonicalJson(badKey), "unpaired surrogate keys must be rejected");
    }

    @Test
    public void parseCanonicalJsonAcceptsCanonicalUtf8Only() throws Exception {
        String source = "{\"a\":[true,null,\"text\"],\"z\":1}";
        Object parsed = ProtocolV2.parseCanonicalJson(source.getBytes(StandardCharsets.UTF_8));

        assertTrue(parsed instanceof JSONObject);
        assertEquals(source, ProtocolV2.canonicalJson(parsed));
        assertEquals("text", ((JSONObject) parsed).getJSONArray("a").getString(2));
    }

    @Test
    public void parseCanonicalJsonRejectsAmbiguousOrNonCanonicalInput() {
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"z\":1,\"a\":2}"), "key order must be canonical");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{ \"a\":1}"), "whitespace must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":1.0}"), "decimal spelling must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":1e0}"), "exponent spelling must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":-0}"), "negative zero must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":9007199254740992}"), "unsafe integer text must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":1,\"a\":2}"), "duplicate keys must be rejected before JSONObject collapses them");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("{\"a\":\"\\ud800\"}"), "unpaired escaped surrogate must be rejected");
        assertFailure(() -> ProtocolV2.parseCanonicalJson("\ufeff{\"a\":1}"), "BOM must be rejected");
    }

    @Test
    public void parseCanonicalJsonRejectsMalformedUtf8() {
        byte[] malformed = new byte[] { '{', '"', 'a', '"', ':', (byte) 0xc3, '}' };
        assertFailure(() -> ProtocolV2.parseCanonicalJson(malformed), "malformed UTF-8 must be rejected");
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = ProtocolV2Test.class.getResourceAsStream("/protocol-v2-pairing.json")) {
            if (input == null) {
                throw new AssertionError("Missing shared protocol v2 fixture");
            }
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFailure(ThrowingRunnable action, String message) {
        try {
            action.run();
            fail(message);
        } catch (IllegalArgumentException expected) {
            // Expected: protocol parsing/serialization deliberately rejects this value.
        } catch (Exception error) {
            throw new AssertionError(message, error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
