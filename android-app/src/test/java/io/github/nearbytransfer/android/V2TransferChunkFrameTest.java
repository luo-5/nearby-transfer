package io.github.nearbytransfer.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.json.JSONObject;
import org.junit.Test;

public class V2TransferChunkFrameTest {
    @Test
    public void sharedFixtureEncodesAndDecodesExactly() throws Exception {
        JSONObject fixture = loadFixture();
        JSONObject format = fixture.getJSONObject("format");
        JSONObject vector = fixture.getJSONObject("vector");
        V2TransferChunkFrame.Frame input = frameFrom(vector);
        byte[] expected = decodeHex(vector.getString("frameHex"));

        assertEquals(format.getInt("version"), V2TransferChunkFrame.VERSION);
        assertEquals(format.getInt("headerBytes"), V2TransferChunkFrame.HEADER_BYTES);
        assertEquals(format.getInt("maxFrameBytes"), V2TransferChunkFrame.MAX_FRAME_BYTES);
        assertArrayEquals(expected, V2TransferChunkFrame.encode(input));
        assertFrameEquals(input, V2TransferChunkFrame.decode(expected));

        byte[] mutableWire = expected.clone();
        V2TransferChunkFrame.Frame detached = V2TransferChunkFrame.decode(mutableWire);
        Arrays.fill(mutableWire, (byte) 0);
        assertEquals(vector.getString("nonceHex"), encodeHex(detached.nonce()));
        assertEquals(vector.getString("authTagHex"), encodeHex(detached.authTag()));
        assertEquals(vector.getString("ciphertextHex"), encodeHex(detached.ciphertext()));

        byte[] mutableNonce = detached.nonce();
        mutableNonce[0] ^= 1;
        assertEquals(vector.getString("nonceHex"), encodeHex(detached.nonce()));
    }

    @Test
    public void supportsEmptyAuthenticatedChunksAndStreaming() throws Exception {
        JSONObject vector = loadFixture().getJSONObject("vector");
        byte[] vectorBytes = decodeHex(vector.getString("frameHex"));
        V2TransferChunkFrame.Frame empty = new V2TransferChunkFrame.Frame(
            vector.getString("taskId"),
            "empty.txt",
            0,
            0,
            0,
            filled(12, 1),
            filled(16, 2),
            new byte[0]
        );
        assertFrameEquals(empty, V2TransferChunkFrame.decode(V2TransferChunkFrame.encode(empty)));

        V2TransferChunkFrame.StreamParser byteParser = new V2TransferChunkFrame.StreamParser();
        List<V2TransferChunkFrame.Frame> streamed = new ArrayList<>();
        for (byte value : vectorBytes) streamed.addAll(byteParser.push(new byte[] { value }));
        byteParser.finish();
        assertEquals(1, streamed.size());
        assertFrameEquals(frameFrom(vector), streamed.get(0));

        byte[] emptyBytes = V2TransferChunkFrame.encode(empty);
        byte[] combined = concatenate(vectorBytes, emptyBytes);
        V2TransferChunkFrame.StreamParser combinedParser = new V2TransferChunkFrame.StreamParser();
        List<V2TransferChunkFrame.Frame> frames = new ArrayList<>();
        frames.addAll(combinedParser.push(Arrays.copyOfRange(combined, 0, 17)));
        frames.addAll(combinedParser.push(Arrays.copyOfRange(combined, 17, vectorBytes.length + 9)));
        frames.addAll(combinedParser.push(Arrays.copyOfRange(combined, vectorBytes.length + 9, combined.length)));
        combinedParser.finish();
        assertEquals(2, frames.size());
        assertFrameEquals(frameFrom(vector), frames.get(0));
        assertFrameEquals(empty, frames.get(1));
        assertFailure(() -> combinedParser.push(new byte[0]));
        assertFailure(combinedParser::finish);

        V2TransferChunkFrame.StreamParser truncated = new V2TransferChunkFrame.StreamParser();
        assertEquals(0, truncated.push(Arrays.copyOf(vectorBytes, vectorBytes.length - 1)).size());
        assertFailure(truncated::finish);
    }

    @Test
    public void rejectsMalformedHeadersLengthsUtf8AndTrailingData() throws Exception {
        byte[] frame = decodeHex(loadFixture().getJSONObject("vector").getString("frameHex"));
        assertFailure(() -> V2TransferChunkFrame.decode(Arrays.copyOf(frame, V2TransferChunkFrame.HEADER_BYTES - 1)));
        assertFailure(() -> V2TransferChunkFrame.decode(Arrays.copyOf(frame, frame.length - 1)));
        assertFailure(() -> V2TransferChunkFrame.decode(concatenate(frame, new byte[] { 0 })));

        mutateByteAndReject(frame, 0, 0);
        mutateByteAndReject(frame, 8, 2);
        mutateByteAndReject(frame, 9, 1);
        mutateShortAndReject(frame, 10, V2TransferChunkFrame.HEADER_BYTES + 1);
        mutateIntAndReject(frame, 12, frame.length - 1);
        mutateShortAndReject(frame, 16, V2TransferChunkFrame.TASK_ID_BYTES - 1);
        mutateShortAndReject(frame, 18, 0);
        mutateShortAndReject(frame, 18, V2TransferChunkFrame.MAX_RELATIVE_PATH_BYTES + 1);
        mutateIntAndReject(frame, 36, 54);
        mutateIntAndReject(frame, 40, V2TransferCrypto.MAX_CHUNK_BYTES + 1);
        mutateByteAndReject(frame, 44, 11);
        mutateByteAndReject(frame, 45, 15);
        mutateShortAndReject(frame, 46, 1);

        byte[] offsetOverflow = frame.clone();
        putLong(offsetOverflow, 20, V2TransferCrypto.MAX_SAFE_INTEGER + 1);
        assertFailure(() -> V2TransferChunkFrame.decode(offsetOverflow));
        byte[] negativeSequence = frame.clone();
        putLong(negativeSequence, 28, -1);
        assertFailure(() -> V2TransferChunkFrame.decode(negativeSequence));

        byte[] invalidUtf8Path = frame.clone();
        int pathStart = V2TransferChunkFrame.HEADER_BYTES + V2TransferChunkFrame.TASK_ID_BYTES;
        invalidUtf8Path[pathStart + "docs/".getBytes(StandardCharsets.UTF_8).length] = (byte) 0xc0;
        assertFailure(() -> V2TransferChunkFrame.decode(invalidUtf8Path));

        byte[] invalidTask = frame.clone();
        invalidTask[V2TransferChunkFrame.HEADER_BYTES] = (byte) '+';
        assertFailure(() -> V2TransferChunkFrame.decode(invalidTask));
    }

    @Test
    public void rejectsInvalidEncodeInputsWithoutKeysOrPlaintext() throws Exception {
        JSONObject vector = loadFixture().getJSONObject("vector");
        byte[] nonce = decodeHex(vector.getString("nonceHex"));
        byte[] authTag = decodeHex(vector.getString("authTagHex"));
        byte[] ciphertext = decodeHex(vector.getString("ciphertextHex"));
        String taskId = vector.getString("taskId");
        String relativePath = vector.getString("relativePath");
        long plainLength = vector.getLong("plainLength");

        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, -1, 0, plainLength, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, V2TransferCrypto.MAX_SAFE_INTEGER + 1, 0, plainLength, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, -1, plainLength, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, 0, -1, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, 0, plainLength - 1, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, 0, plainLength, new byte[11], authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, 0, plainLength, nonce, new byte[15], ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, "../escape.txt", 0, 0, plainLength, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, longRelativePath(), 0, 0, plainLength, nonce, authTag, ciphertext));
        assertFailure(() -> V2TransferChunkFrame.encode(taskId, relativePath, 0, 0, (long) V2TransferCrypto.MAX_CHUNK_BYTES + 1, nonce, authTag, new byte[0]));
        assertFailure(() -> V2TransferChunkFrame.encode(null));
        assertFailure(() -> V2TransferChunkFrame.decode(null));

        V2TransferChunkFrame.Frame frame = frameFrom(vector);
        assertFalse(frame.getClass().getDeclaredFields().length > 8);
    }

    private static V2TransferChunkFrame.Frame frameFrom(JSONObject vector) throws Exception {
        return new V2TransferChunkFrame.Frame(
            vector.getString("taskId"),
            vector.getString("relativePath"),
            vector.getLong("offset"),
            vector.getLong("sequence"),
            vector.getLong("plainLength"),
            decodeHex(vector.getString("nonceHex")),
            decodeHex(vector.getString("authTagHex")),
            decodeHex(vector.getString("ciphertextHex"))
        );
    }

    private static JSONObject loadFixture() throws Exception {
        try (InputStream input = V2TransferChunkFrameTest.class.getResourceAsStream("/protocol-v2-transfer-chunks.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer-chunk fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFrameEquals(V2TransferChunkFrame.Frame expected, V2TransferChunkFrame.Frame actual) {
        assertEquals(expected.taskId(), actual.taskId());
        assertEquals(expected.relativePath(), actual.relativePath());
        assertEquals(expected.offset(), actual.offset());
        assertEquals(expected.sequence(), actual.sequence());
        assertEquals(expected.plainLength(), actual.plainLength());
        assertArrayEquals(expected.nonce(), actual.nonce());
        assertArrayEquals(expected.authTag(), actual.authTag());
        assertArrayEquals(expected.ciphertext(), actual.ciphertext());
    }

    private static void mutateByteAndReject(byte[] source, int offset, int value) {
        byte[] changed = source.clone();
        changed[offset] = (byte) value;
        assertFailure(() -> V2TransferChunkFrame.decode(changed));
    }

    private static void mutateShortAndReject(byte[] source, int offset, int value) {
        byte[] changed = source.clone();
        changed[offset] = (byte) (value >>> 8);
        changed[offset + 1] = (byte) value;
        assertFailure(() -> V2TransferChunkFrame.decode(changed));
    }

    private static void mutateIntAndReject(byte[] source, int offset, int value) {
        byte[] changed = source.clone();
        changed[offset] = (byte) (value >>> 24);
        changed[offset + 1] = (byte) (value >>> 16);
        changed[offset + 2] = (byte) (value >>> 8);
        changed[offset + 3] = (byte) value;
        assertFailure(() -> V2TransferChunkFrame.decode(changed));
    }

    private static void putLong(byte[] destination, int offset, long value) {
        for (int index = 7; index >= 0; index -= 1) {
            destination[offset + index] = (byte) value;
            value >>>= 8;
        }
    }

    private static byte[] filled(int length, int value) {
        byte[] result = new byte[length];
        Arrays.fill(result, (byte) value);
        return result;
    }

    private static byte[] concatenate(byte[] left, byte[] right) {
        byte[] result = new byte[left.length + right.length];
        System.arraycopy(left, 0, result, 0, left.length);
        System.arraycopy(right, 0, result, left.length, right.length);
        return result;
    }

    private static String longRelativePath() {
        String component = "a".repeat(255);
        return String.join("/", java.util.Collections.nCopies(17, component));
    }

    private static byte[] decodeHex(String value) {
        if ((value.length() & 1) != 0) throw new IllegalArgumentException("Odd hex length");
        byte[] output = new byte[value.length() / 2];
        for (int index = 0; index < output.length; index += 1) {
            int high = Character.digit(value.charAt(index * 2), 16);
            int low = Character.digit(value.charAt(index * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("Invalid hex");
            output[index] = (byte) ((high << 4) | low);
        }
        return output;
    }

    private static String encodeHex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte item : value) output.append(String.format("%02x", item & 0xff));
        return output.toString();
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected protocol input to be rejected");
        } catch (IllegalArgumentException | IllegalStateException expected) {
            // Expected strict protocol rejection.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
