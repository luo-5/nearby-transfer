package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2WireFrameTest {
    @Test
    public void sharedDesktopWireFixtureRoundTripsByteForByte() throws Exception {
        JSONObject vector = loadVector().getJSONObject("wireFrame");
        JSONObject expectedHeader = vector.getJSONObject("header");
        byte[] expectedPayload = vector.getString("payloadUtf8").getBytes(StandardCharsets.UTF_8);
        byte[] encoded = hex(vector.getString("encodedHex"));

        V2WireFrame.Frame decoded = V2WireFrame.decode(encoded);
        assertEquals(ProtocolV2.canonicalJson(expectedHeader), ProtocolV2.canonicalJson(decoded.header));
        assertArrayEquals(expectedPayload, decoded.payload);
        assertArrayEquals(encoded, V2WireFrame.encode(decoded));

        V2WireFrame.Frame expected = new V2WireFrame.Frame(expectedHeader, expectedPayload);
        assertArrayEquals(encoded, V2WireFrame.encode(expected));
    }

    @Test
    public void decoderAcceptsSplitPacketsAndConsecutiveFrames() throws Exception {
        byte[] encoded = hex(loadVector().getJSONObject("wireFrame").getString("encodedHex"));
        V2WireFrame.Decoder decoder = new V2WireFrame.Decoder();

        assertTrue(decoder.push(Arrays.copyOfRange(encoded, 0, 3)).isEmpty());
        assertEquals(3, decoder.bufferedBytes());
        assertTrue(decoder.push(Arrays.copyOfRange(encoded, 3, 37)).isEmpty());
        assertEquals(37, decoder.bufferedBytes());
        List<V2WireFrame.Frame> frames = decoder.push(Arrays.copyOfRange(encoded, 37, encoded.length));
        assertEquals(1, frames.size());
        assertEquals(0, decoder.bufferedBytes());
        decoder.finish();

        byte[] consecutive = new byte[encoded.length * 2];
        System.arraycopy(encoded, 0, consecutive, 0, encoded.length);
        System.arraycopy(encoded, 0, consecutive, encoded.length, encoded.length);
        frames = decoder.push(consecutive);
        assertEquals(2, frames.size());
        decoder.finish();
    }

    @Test
    public void decoderRejectsTruncationBadLengthsAndNonCanonicalHeaders() throws Exception {
        assertFailure(() -> V2WireFrame.decode(new byte[] { 0, 0, 0, 1 }), "frame body shorter than u16 header length must be rejected");
        assertFailure(() -> V2WireFrame.decode(new byte[] { 0, 0, 0, 2, 0, 0 }), "zero-length header must be rejected");

        V2WireFrame.Decoder decoder = new V2WireFrame.Decoder();
        decoder.push(new byte[] { 0, 0, 0 });
        assertFailure(decoder::finish, "truncated length prefix must be rejected at EOF");

        byte[] nonCanonicalHeader = "{\"type\":\"pairing-offer\",\"protocolVersion\":2,\"app\":\"nearby-transfer\"}".getBytes(StandardCharsets.UTF_8);
        assertFailure(() -> V2WireFrame.decode(frameWithHeader(nonCanonicalHeader)), "noncanonical header order must be rejected");

        byte[] malformedUtf8Header = new byte[] { '{', '"', 'a', 'p', 'p', '"', ':', '"', (byte) 0xc3, '"', '}' };
        assertFailure(() -> V2WireFrame.decode(frameWithHeader(malformedUtf8Header)), "invalid UTF-8 header must be rejected");
    }

    @Test
    public void encoderAndDecoderRejectUnknownOrUnsupportedHeaders() throws Exception {
        JSONObject unknown = validHeader();
        unknown.put("unknown", true);
        assertFailure(() -> V2WireFrame.encode(new V2WireFrame.Frame(unknown, new byte[0])), "unknown header keys must be rejected");

        JSONObject unsupported = validHeader();
        unsupported.put("type", "unknown-v2-message");
        assertFailure(() -> V2WireFrame.encode(new V2WireFrame.Frame(unsupported, new byte[0])), "unsupported message types must be rejected");

        byte[] header = "{\"app\":\"nearby-transfer\",\"protocolVersion\":2,\"type\":\"pairing-offer\",\"unknown\":true}".getBytes(StandardCharsets.UTF_8);
        assertFailure(() -> V2WireFrame.decode(frameWithHeader(header)), "unknown decoded header keys must be rejected");
    }

    private static JSONObject validHeader() throws Exception {
        JSONObject header = new JSONObject();
        header.put("app", "nearby-transfer");
        header.put("protocolVersion", 2);
        header.put("type", "pairing-offer");
        return header;
    }

    private static byte[] frameWithHeader(byte[] header) {
        byte[] frame = new byte[6 + header.length];
        int bodyLength = 2 + header.length;
        frame[0] = (byte) (bodyLength >>> 24);
        frame[1] = (byte) (bodyLength >>> 16);
        frame[2] = (byte) (bodyLength >>> 8);
        frame[3] = (byte) bodyLength;
        frame[4] = (byte) (header.length >>> 8);
        frame[5] = (byte) header.length;
        System.arraycopy(header, 0, frame, 6, header.length);
        return frame;
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = V2WireFrameTest.class.getResourceAsStream("/protocol-v2-discovery-and-wire.json")) {
            if (input == null) {
                throw new AssertionError("Missing shared discovery and wire fixture");
            }
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static byte[] hex(String encoded) {
        if ((encoded.length() & 1) != 0) {
            throw new IllegalArgumentException("Hex input must contain complete bytes");
        }
        byte[] value = new byte[encoded.length() / 2];
        for (int index = 0; index < value.length; index += 1) {
            int upper = Character.digit(encoded.charAt(index * 2), 16);
            int lower = Character.digit(encoded.charAt(index * 2 + 1), 16);
            if (upper < 0 || lower < 0) {
                throw new IllegalArgumentException("Hex input is invalid");
            }
            value[index] = (byte) ((upper << 4) | lower);
        }
        return value;
    }

    private static void assertFailure(ThrowingRunnable action, String message) {
        try {
            action.run();
            fail(message);
        } catch (IllegalArgumentException expected) {
            // Expected: untrusted wire input must fail closed.
        } catch (Exception error) {
            throw new AssertionError(message, error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
