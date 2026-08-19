package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * Byte-exact framing for protocol v2 TCP messages.
 *
 * <p>Each frame is {@code u32 bodyLength || u16 headerLength || header || payload},
 * with unsigned big-endian lengths. The header is restricted canonical JSON and
 * is deliberately validated before a caller can dispatch a protocol message.</p>
 */
final class V2WireFrame {
    static final int FRAME_LENGTH_BYTES = 4;
    static final int HEADER_LENGTH_BYTES = 2;
    static final int FRAME_PREFIX_BYTES = FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES;
    static final int MAX_FRAME_SIZE = 16 * 1024 * 1024;
    static final int MAX_HEADER_SIZE = 16 * 1024;
    static final int MAX_BUFFERED_BYTES = FRAME_LENGTH_BYTES + MAX_FRAME_SIZE;

    private static final Set<String> MESSAGE_TYPES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "discovery-announce",
        "pairing-offer",
        "pairing-confirm",
        "pairing-cancel",
        "transfer-manifest",
        "transfer-decision",
        "transfer-resume",
        "transfer-progress",
        "transfer-chunk",
        "transfer-complete",
        "library-session"
    )));

    private V2WireFrame() {}

    static final class Frame {
        final JSONObject header;
        final byte[] payload;

        Frame(JSONObject header, byte[] payload) {
            if (header == null) {
                throw new IllegalArgumentException("Wire frame header is required");
            }
            this.header = header;
            this.payload = payload == null ? new byte[0] : Arrays.copyOf(payload, payload.length);
        }
    }

    static byte[] encode(Frame frame) {
        if (frame == null) {
            throw new IllegalArgumentException("Wire frame is required");
        }
        byte[] header = encodeHeader(frame.header);
        byte[] payload = frame.payload;
        long bodyLength = (long) HEADER_LENGTH_BYTES + header.length + payload.length;
        if (bodyLength > MAX_FRAME_SIZE) {
            throw new IllegalArgumentException("Wire frame exceeds the " + MAX_FRAME_SIZE + "-byte limit");
        }

        ByteBuffer encoded = ByteBuffer.allocate(FRAME_LENGTH_BYTES + (int) bodyLength).order(ByteOrder.BIG_ENDIAN);
        encoded.putInt((int) bodyLength);
        encoded.putShort((short) header.length);
        encoded.put(header);
        encoded.put(payload);
        return encoded.array();
    }

    static Frame decode(byte[] encoded) {
        Decoder decoder = new Decoder();
        List<Frame> frames = decoder.push(encoded);
        decoder.finish();
        if (frames.size() != 1) {
            throw new IllegalArgumentException("Expected exactly one wire frame, received " + frames.size());
        }
        return frames.get(0);
    }

    static final class Decoder {
        private byte[] buffer = new byte[0];

        int bufferedBytes() {
            return buffer.length;
        }

        List<Frame> push(byte[] chunk) {
            if (chunk == null) {
                throw new IllegalArgumentException("Wire decoder chunk must not be null");
            }
            if (chunk.length == 0) {
                return Collections.emptyList();
            }
            if (chunk.length > MAX_BUFFERED_BYTES - buffer.length) {
                throw new IllegalArgumentException("Wire decoder buffer exceeds the " + MAX_BUFFERED_BYTES + "-byte limit");
            }

            byte[] appended = new byte[buffer.length + chunk.length];
            System.arraycopy(buffer, 0, appended, 0, buffer.length);
            System.arraycopy(chunk, 0, appended, buffer.length, chunk.length);
            buffer = appended;

            List<Frame> decoded = new ArrayList<>();
            int offset = 0;
            while (buffer.length - offset >= FRAME_LENGTH_BYTES) {
                long frameLength = unsignedInt(buffer, offset);
                assertFrameLength(frameLength);
                int encodedLength = FRAME_LENGTH_BYTES + (int) frameLength;
                if (buffer.length - offset < encodedLength) {
                    break;
                }
                decoded.add(decodeCompleteFrame(buffer, offset, encodedLength));
                offset += encodedLength;
            }
            if (offset != 0) {
                buffer = Arrays.copyOfRange(buffer, offset, buffer.length);
            }
            return decoded;
        }

        List<Frame> finish() {
            if (buffer.length != 0) {
                throw new IllegalArgumentException("Truncated wire frame: " + buffer.length + " buffered byte(s) remain at EOF");
            }
            return Collections.emptyList();
        }
    }

    private static Frame decodeCompleteFrame(byte[] encoded, int offset, int encodedLength) {
        long frameLength = unsignedInt(encoded, offset);
        assertFrameLength(frameLength);
        if (encodedLength != FRAME_LENGTH_BYTES + (int) frameLength) {
            throw new IllegalArgumentException("Wire frame length prefix does not match the supplied bytes");
        }

        int headerLength = unsignedShort(encoded, offset + FRAME_LENGTH_BYTES);
        if (headerLength == 0 || headerLength > MAX_HEADER_SIZE) {
            throw new IllegalArgumentException("Wire header length must be between 1 and " + MAX_HEADER_SIZE + " bytes");
        }
        if (HEADER_LENGTH_BYTES + headerLength > frameLength) {
            throw new IllegalArgumentException("Wire header length exceeds its enclosing frame");
        }

        int headerStart = offset + FRAME_PREFIX_BYTES;
        int headerEnd = headerStart + headerLength;
        byte[] headerBytes = Arrays.copyOfRange(encoded, headerStart, headerEnd);
        JSONObject header = decodeHeader(headerBytes);
        int payloadEnd = offset + encodedLength;
        return new Frame(header, Arrays.copyOfRange(encoded, headerEnd, payloadEnd));
    }

    private static byte[] encodeHeader(JSONObject header) {
        validateHeader(header);
        byte[] serialized = ProtocolV2.canonicalJson(header).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (serialized.length == 0 || serialized.length > MAX_HEADER_SIZE) {
            throw new IllegalArgumentException("Wire header must be between 1 and " + MAX_HEADER_SIZE + " bytes");
        }
        return serialized;
    }

    private static JSONObject decodeHeader(byte[] serialized) {
        if (serialized.length == 0 || serialized.length > MAX_HEADER_SIZE) {
            throw new IllegalArgumentException("Wire header must be between 1 and " + MAX_HEADER_SIZE + " bytes");
        }
        Object decoded = ProtocolV2.parseCanonicalJson(serialized, "Wire header");
        if (!(decoded instanceof JSONObject)) {
            throw new IllegalArgumentException("Wire header must be a JSON object");
        }
        JSONObject header = (JSONObject) decoded;
        validateHeader(header);
        return header;
    }

    private static void validateHeader(JSONObject header) {
        if (header == null) {
            throw new IllegalArgumentException("Wire header is required");
        }
        Set<String> expected = new HashSet<>(Arrays.asList("app", "protocolVersion", "type"));
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = header.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(expected)) {
            throw new IllegalArgumentException("Wire header must contain exactly app, protocolVersion, and type");
        }

        Object app = header.opt("app");
        Object protocolVersion = header.opt("protocolVersion");
        Object type = header.opt("type");
        if (!(app instanceof String) || !ProtocolV2.APP_ID.equals(app)) {
            throw new IllegalArgumentException("Wire header app must be " + ProtocolV2.APP_ID);
        }
        if (!isExactInteger(protocolVersion) || ((Number) protocolVersion).longValue() != ProtocolV2.VERSION) {
            throw new IllegalArgumentException("Wire header protocolVersion must be the integer " + ProtocolV2.VERSION);
        }
        if (!(type instanceof String) || !MESSAGE_TYPES.contains(type)) {
            throw new IllegalArgumentException("Wire header type is not a supported protocol v2 message type");
        }
    }

    private static void assertFrameLength(long frameLength) {
        if (frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
            throw new IllegalArgumentException("Wire frame length must be an integer from "
                + HEADER_LENGTH_BYTES + " to " + MAX_FRAME_SIZE + " bytes");
        }
    }

    private static long unsignedInt(byte[] data, int offset) {
        return ((long) (data[offset] & 0xff) << 24)
            | ((long) (data[offset + 1] & 0xff) << 16)
            | ((long) (data[offset + 2] & 0xff) << 8)
            | (long) (data[offset + 3] & 0xff);
    }

    private static int unsignedShort(byte[] data, int offset) {
        return ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
    }

    private static boolean isExactInteger(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }
}
