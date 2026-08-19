package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2TransferMessageTest {
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    @Test
    public void sharedVectorsRoundTripAndSigningPayloadMatchByteForByte() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject vectors = fixture.getJSONObject("vectors");
        for (String name : vectorNames()) {
            JSONObject vector = vectors.getJSONObject(name);
            String type = vector.getString("type");
            String canonical = vector.getString("canonicalJson");
            V2TransferMessage.Message decoded = V2TransferMessage.decode(
                type,
                canonical.getBytes(StandardCharsets.UTF_8),
                now
            );
            assertEquals(canonical, new String(V2TransferMessage.encode(decoded, now), StandardCharsets.UTF_8));
            assertEquals(vector.getString("signingPayload"), V2TransferMessage.signingPayload(type, vector.getJSONObject("message")));

            JSONObject unsigned = copy(vector.getJSONObject("message"));
            unsigned.remove("signature");
            assertEquals(vector.getString("signingPayload"), V2TransferMessage.signingPayload(type, unsigned));
        }
        assertTrue(V2TransferMessage.decode(
            V2TransferMessage.TYPE_MANIFEST,
            vectors.getJSONObject("transferManifest").getString("canonicalJson").getBytes(StandardCharsets.UTF_8),
            now
        ) instanceof V2TransferMessage.ManifestEnvelope);
    }

    @Test
    public void rejectsUnknownMissingAndNonCanonicalFields() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject vector = fixture.getJSONObject("vectors").getJSONObject("transferManifest");

        JSONObject message = copy(vector.getJSONObject("message"));
        message.put("debug", true);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, message, now));

        JSONObject missing = copy(vector.getJSONObject("message"));
        missing.remove("receiverDeviceId");
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, missing, now));

        JSONObject unknownManifest = copy(vector.getJSONObject("message"));
        unknownManifest.getJSONObject("manifest").put("debug", true);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, unknownManifest, now));

        JSONObject unknownEntry = copy(vector.getJSONObject("message"));
        unknownEntry.getJSONObject("manifest").getJSONArray("entries").getJSONObject(0).put("debug", true);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, unknownEntry, now));

        String pretty = vector.getJSONObject("message").toString(2);
        assertFailure(() -> V2TransferMessage.decode(
            V2TransferMessage.TYPE_MANIFEST,
            pretty.getBytes(StandardCharsets.UTF_8),
            now
        ));

        String duplicateApp = vector.getString("canonicalJson").replace(
            "{\"app\":\"nearby-transfer\",",
            "{\"app\":\"nearby-transfer\",\"app\":\"nearby-transfer\","
        );
        assertFailure(() -> V2TransferMessage.decode(
            V2TransferMessage.TYPE_MANIFEST,
            duplicateApp.getBytes(StandardCharsets.UTF_8),
            now
        ));
    }

    @Test
    public void enforcesCanonicalIdentifiersKeysHashesAndDiagnostics() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject vectors = fixture.getJSONObject("vectors");

        JSONObject manifest = copy(vectors.getJSONObject("transferManifest").getJSONObject("message"));
        manifest.put("senderEphemeralPublicKey", manifest.getString("senderEphemeralPublicKey") + "=");
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, manifest, now));

        JSONObject nonCanonicalTask = copy(vectors.getJSONObject("transferDecision").getJSONObject("message"));
        String taskId = nonCanonicalTask.getString("taskId");
        nonCanonicalTask.put("taskId", taskId.substring(0, taskId.length() - 1) + "B");
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, nonCanonicalTask, now));

        JSONObject decision = copy(vectors.getJSONObject("transferDecision").getJSONObject("message"));
        decision.put("decision", "free-form-reason");
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, decision, now));

        JSONObject badSignature = copy(vectors.getJSONObject("transferDecision").getJSONObject("message"));
        badSignature.put("signature", Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[63]));
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, badSignature, now));

        JSONObject completion = copy(vectors.getJSONObject("transferCompleteSuccess").getJSONObject("message"));
        completion.put("sha256", completion.getString("sha256").toUpperCase(Locale.ROOT));
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_COMPLETE, completion, now));

        JSONObject failure = copy(vectors.getJSONObject("transferCompleteFailure").getJSONObject("message"));
        failure.put("sha256", repeat('c', 64));
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_COMPLETE, failure, now));
    }

    @Test
    public void enforcesIntegerTimeTtlAndClockBoundaries() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject base = fixture.getJSONObject("vectors").getJSONObject("transferDecision").getJSONObject("message");

        for (Object invalidIssuedAt : new Object[] { 0L, -1L, 1.5d, "1760000000100", MAX_SAFE_INTEGER + 1L }) {
            JSONObject invalid = copy(base);
            invalid.put("issuedAt", invalidIssuedAt);
            assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, invalid, now));
        }

        JSONObject reversed = copy(base);
        reversed.put("expiresAt", reversed.getLong("issuedAt"));
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, reversed, now));

        JSONObject tooLong = copy(base);
        tooLong.put("expiresAt", tooLong.getLong("issuedAt") + V2TransferMessage.MAX_MESSAGE_TTL_MS + 1L);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, tooLong, now));

        JSONObject maxTtl = copy(base);
        maxTtl.put("expiresAt", maxTtl.getLong("issuedAt") + V2TransferMessage.MAX_MESSAGE_TTL_MS);
        V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, maxTtl, maxTtl.getLong("issuedAt"));

        JSONObject futureBoundary = copy(base);
        futureBoundary.put("issuedAt", now + V2TransferMessage.MAX_CLOCK_SKEW_MS);
        futureBoundary.put("expiresAt", futureBoundary.getLong("issuedAt") + 1L);
        V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, futureBoundary, now);
        futureBoundary.put("issuedAt", futureBoundary.getLong("issuedAt") + 1L);
        futureBoundary.put("expiresAt", futureBoundary.getLong("expiresAt") + 1L);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_DECISION, futureBoundary, now));

        JSONObject expiryBoundary = copy(base);
        V2TransferMessage.fromJson(
            V2TransferMessage.TYPE_DECISION,
            expiryBoundary,
            expiryBoundary.getLong("expiresAt")
        );
        assertFailure(() -> V2TransferMessage.fromJson(
            V2TransferMessage.TYPE_DECISION,
            expiryBoundary,
            expiryBoundary.getLong("expiresAt") + 1L
        ));

        JSONObject safeBoundary = copy(base);
        safeBoundary.put("expiresAt", MAX_SAFE_INTEGER);
        safeBoundary.put("issuedAt", MAX_SAFE_INTEGER - V2TransferMessage.MAX_MESSAGE_TTL_MS);
        V2TransferMessage.fromJson(
            V2TransferMessage.TYPE_DECISION,
            safeBoundary,
            safeBoundary.getLong("issuedAt")
        );
    }

    @Test
    public void normalizesManifestSortingAndVerifiesSummaries() throws Exception {
        JSONObject fixture = loadFixture();
        long now = fixture.getLong("validationNow");
        JSONObject vector = fixture.getJSONObject("vectors").getJSONObject("transferManifest");

        JSONObject unsorted = copy(vector.getJSONObject("message"));
        JSONArray entries = unsorted.getJSONObject("manifest").getJSONArray("entries");
        Object first = entries.get(0);
        entries.put(0, entries.get(1));
        entries.put(1, first);
        V2TransferMessage.Message normalized = V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, unsorted, now);
        assertEquals(vector.getString("canonicalJson"), new String(V2TransferMessage.encode(normalized, now), StandardCharsets.UTF_8));
        String canonicalButUnnormalized = ProtocolV2.canonicalJson(unsorted);
        assertFailure(() -> V2TransferMessage.decode(
            V2TransferMessage.TYPE_MANIFEST,
            canonicalButUnnormalized.getBytes(StandardCharsets.UTF_8),
            now
        ));

        JSONObject wrongFiles = copy(vector.getJSONObject("message"));
        wrongFiles.getJSONObject("manifest").put("totalFiles", 2L);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, wrongFiles, now));

        JSONObject wrongBytes = copy(vector.getJSONObject("message"));
        wrongBytes.getJSONObject("manifest").put("totalBytes", 13L);
        assertFailure(() -> V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, wrongBytes, now));

        JSONObject omitted = copy(vector.getJSONObject("message"));
        omitted.getJSONObject("manifest").remove("totalFiles");
        omitted.getJSONObject("manifest").remove("totalBytes");
        V2TransferMessage.Message withComputedTotals = V2TransferMessage.fromJson(V2TransferMessage.TYPE_MANIFEST, omitted, now);
        assertEquals(vector.getString("canonicalJson"), new String(V2TransferMessage.encode(withComputedTotals, now), StandardCharsets.UTF_8));
        assertFailure(() -> V2TransferMessage.decode(
            V2TransferMessage.TYPE_MANIFEST,
            ProtocolV2.canonicalJson(omitted).getBytes(StandardCharsets.UTF_8),
            now
        ));
    }

    @Test
    public void signingPayloadIsStableAndExcludesOnlySignature() throws Exception {
        JSONObject fixture = loadFixture();
        JSONObject vectors = fixture.getJSONObject("vectors");
        String replacementSignature = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[64]);

        for (String name : vectorNames()) {
            JSONObject vector = vectors.getJSONObject(name);
            JSONObject changedSignature = copy(vector.getJSONObject("message"));
            changedSignature.put("signature", replacementSignature);
            assertEquals(
                vector.getString("signingPayload"),
                V2TransferMessage.signingPayload(vector.getString("type"), changedSignature)
            );
        }

        JSONObject changedDecision = copy(vectors.getJSONObject("transferDecision").getJSONObject("message"));
        changedDecision.put("decision", "rejected");
        assertNotEquals(
            vectors.getJSONObject("transferDecision").getString("signingPayload"),
            V2TransferMessage.signingPayload(V2TransferMessage.TYPE_DECISION, changedDecision)
        );

        JSONObject unknownUnsigned = copy(vectors.getJSONObject("transferDecision").getJSONObject("message"));
        unknownUnsigned.remove("signature");
        unknownUnsigned.put("debug", true);
        assertFailure(() -> V2TransferMessage.signingPayload(V2TransferMessage.TYPE_DECISION, unknownUnsigned));
    }

    private static String[] vectorNames() {
        return new String[] {
            "transferManifest", "transferDecision", "transferCompleteSuccess", "transferCompleteFailure"
        };
    }

    private static JSONObject loadFixture() throws Exception {
        try (InputStream input = V2TransferMessageTest.class.getResourceAsStream("/protocol-v2-transfer-messages.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer-message fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static JSONObject copy(JSONObject value) throws Exception {
        return new JSONObject(value.toString());
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected protocol input to be rejected");
        } catch (IllegalArgumentException expected) {
            // Expected protocol rejection.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
