package io.github.nearbytransfer.android;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

final class V2TransferChunkFrame {
    static final int VERSION = 1;
    static final int FLAGS = 0;
    static final int HEADER_BYTES = 48;
    static final int TASK_ID_BYTES = 22;
    static final int MAX_RELATIVE_PATH_BYTES = 4096;
    static final int MAX_FRAME_BYTES = HEADER_BYTES + TASK_ID_BYTES + MAX_RELATIVE_PATH_BYTES
        + V2TransferCrypto.NONCE_BYTES + V2TransferCrypto.AUTH_TAG_BYTES + V2TransferCrypto.MAX_CHUNK_BYTES;

    private static final byte[] MAGIC = "NTV2CHNK".getBytes(StandardCharsets.US_ASCII);
    private static final int TASK_ID_DECODED_BYTES = 16;
    private static final int MAX_PATH_COMPONENT_BYTES = 255;
    private static final Pattern TASK_ID_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern WINDOWS_RESERVED_NAME_PATTERN = Pattern.compile(
        "^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
    );

    private V2TransferChunkFrame() {}

    static byte[] encode(
        String taskId,
        String relativePath,
        long offset,
        long sequence,
        long plainLength,
        byte[] nonce,
        byte[] authTag,
        byte[] ciphertext
    ) {
        return encode(new Frame(
            taskId,
            relativePath,
            offset,
            sequence,
            plainLength,
            nonce,
            authTag,
            ciphertext
        ));
    }

    static byte[] encode(Frame frame) {
        if (frame == null) throw new IllegalArgumentException("Transfer chunk frame is required");
        byte[] taskIdBytes = frame.taskId.getBytes(StandardCharsets.UTF_8);
        byte[] pathBytes = frame.relativePath.getBytes(StandardCharsets.UTF_8);
        int frameLength = checkedFrameLength(pathBytes.length, frame.ciphertext.length);
        ByteBuffer encoded = ByteBuffer.allocate(frameLength).order(ByteOrder.BIG_ENDIAN);
        encoded.put(MAGIC);
        encoded.put((byte) VERSION);
        encoded.put((byte) FLAGS);
        encoded.putShort((short) HEADER_BYTES);
        encoded.putInt(frameLength);
        encoded.putShort((short) taskIdBytes.length);
        encoded.putShort((short) pathBytes.length);
        encoded.putLong(frame.offset);
        encoded.putLong(frame.sequence);
        encoded.putInt(frame.plainLength);
        encoded.putInt(frame.ciphertext.length);
        encoded.put((byte) V2TransferCrypto.NONCE_BYTES);
        encoded.put((byte) V2TransferCrypto.AUTH_TAG_BYTES);
        encoded.putShort((short) 0);
        encoded.put(taskIdBytes);
        encoded.put(pathBytes);
        encoded.put(frame.nonce);
        encoded.put(frame.authTag);
        encoded.put(frame.ciphertext);
        return encoded.array();
    }

    static Frame decode(byte[] encoded) {
        if (encoded == null) throw new IllegalArgumentException("Transfer chunk frame is required");
        Header header = decodeHeader(encoded, 0, encoded.length);
        if (encoded.length < header.frameLength) {
            throw new IllegalArgumentException("Transfer chunk frame is truncated");
        }
        if (encoded.length > header.frameLength) {
            throw new IllegalArgumentException("Transfer chunk frame contains trailing bytes");
        }
        return decodeCompleteFrame(encoded, header);
    }

    static final class StreamParser {
        private byte[] pending = new byte[0];
        private boolean finished;

        List<Frame> push(byte[] chunk) {
            if (finished) throw new IllegalStateException("Transfer chunk frame parser is already finished");
            if (chunk == null) throw new IllegalArgumentException("Transfer chunk stream input is required");
            if (chunk.length == 0) return Collections.emptyList();

            byte[] input = new byte[pending.length + chunk.length];
            System.arraycopy(pending, 0, input, 0, pending.length);
            System.arraycopy(chunk, 0, input, pending.length, chunk.length);
            List<Frame> frames = new ArrayList<>();
            int cursor = 0;

            while (input.length - cursor >= HEADER_BYTES) {
                Header header = decodeHeader(input, cursor, input.length - cursor);
                if (input.length - cursor < header.frameLength) break;
                byte[] frameBytes = Arrays.copyOfRange(input, cursor, cursor + header.frameLength);
                frames.add(decodeCompleteFrame(frameBytes, header));
                cursor += header.frameLength;
            }

            pending = cursor == input.length
                ? new byte[0]
                : Arrays.copyOfRange(input, cursor, input.length);
            if (pending.length > MAX_FRAME_BYTES) {
                pending = new byte[0];
                throw new IllegalArgumentException("Buffered transfer chunk frame exceeds the maximum length");
            }
            return frames;
        }

        void finish() {
            if (finished) throw new IllegalStateException("Transfer chunk frame parser is already finished");
            finished = true;
            if (pending.length != 0) {
                pending = new byte[0];
                throw new IllegalArgumentException("Transfer chunk stream ended with a truncated frame");
            }
        }
    }

    static final class Frame {
        private final String taskId;
        private final String relativePath;
        private final long offset;
        private final long sequence;
        private final int plainLength;
        private final byte[] nonce;
        private final byte[] authTag;
        private final byte[] ciphertext;

        Frame(
            String taskId,
            String relativePath,
            long offset,
            long sequence,
            long plainLength,
            byte[] nonce,
            byte[] authTag,
            byte[] ciphertext
        ) {
            assertValidTaskId(taskId);
            assertValidRelativePath(relativePath);
            assertSafeInteger(offset, "Transfer chunk offset");
            assertSafeInteger(sequence, "Transfer chunk sequence");
            if (sequence > V2TransferCrypto.MAX_SEQUENCE) {
                throw new IllegalArgumentException("Transfer chunk sequence exceeds the supported range");
            }
            if (plainLength < 0 || plainLength > V2TransferCrypto.MAX_CHUNK_BYTES) {
                throw new IllegalArgumentException("Transfer chunk plainLength exceeds the accepted bounds");
            }
            requireExactLength(nonce, V2TransferCrypto.NONCE_BYTES, "Transfer chunk nonce");
            requireExactLength(authTag, V2TransferCrypto.AUTH_TAG_BYTES, "Transfer chunk authentication tag");
            if (ciphertext == null || ciphertext.length > V2TransferCrypto.MAX_CHUNK_BYTES
                || ciphertext.length != plainLength) {
                throw new IllegalArgumentException("Transfer chunk ciphertext length must equal plainLength");
            }

            this.taskId = taskId;
            this.relativePath = relativePath;
            this.offset = offset;
            this.sequence = sequence;
            this.plainLength = (int) plainLength;
            this.nonce = nonce.clone();
            this.authTag = authTag.clone();
            this.ciphertext = ciphertext.clone();
        }

        String taskId() { return taskId; }
        String relativePath() { return relativePath; }
        long offset() { return offset; }
        long sequence() { return sequence; }
        int plainLength() { return plainLength; }
        byte[] nonce() { return nonce.clone(); }
        byte[] authTag() { return authTag.clone(); }
        byte[] ciphertext() { return ciphertext.clone(); }
    }

    private static Header decodeHeader(byte[] encoded, int start, int available) {
        if (available < HEADER_BYTES) {
            throw new IllegalArgumentException("Transfer chunk frame header is truncated");
        }
        for (int index = 0; index < MAGIC.length; index += 1) {
            if (encoded[start + index] != MAGIC[index]) {
                throw new IllegalArgumentException("Transfer chunk frame magic is invalid");
            }
        }

        ByteBuffer header = ByteBuffer.wrap(encoded, start, HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
        header.position(start + MAGIC.length);
        if (Byte.toUnsignedInt(header.get()) != VERSION) {
            throw new IllegalArgumentException("Unsupported transfer chunk frame version");
        }
        if (Byte.toUnsignedInt(header.get()) != FLAGS) {
            throw new IllegalArgumentException("Transfer chunk frame flags must be zero");
        }
        if (Short.toUnsignedInt(header.getShort()) != HEADER_BYTES) {
            throw new IllegalArgumentException("Transfer chunk frame header length is invalid");
        }

        long frameLengthValue = Integer.toUnsignedLong(header.getInt());
        int taskIdLength = Short.toUnsignedInt(header.getShort());
        int pathLength = Short.toUnsignedInt(header.getShort());
        long offset = readSafeInteger(header.getLong(), "Transfer chunk offset");
        long sequence = readSafeInteger(header.getLong(), "Transfer chunk sequence");
        long plainLengthValue = Integer.toUnsignedLong(header.getInt());
        long ciphertextLengthValue = Integer.toUnsignedLong(header.getInt());
        int nonceLength = Byte.toUnsignedInt(header.get());
        int authTagLength = Byte.toUnsignedInt(header.get());
        int reserved = Short.toUnsignedInt(header.getShort());

        if (reserved != 0) throw new IllegalArgumentException("Transfer chunk frame reserved bits must be zero");
        if (taskIdLength != TASK_ID_BYTES) {
            throw new IllegalArgumentException("Transfer chunk task ID length is invalid");
        }
        if (pathLength == 0 || pathLength > MAX_RELATIVE_PATH_BYTES) {
            throw new IllegalArgumentException("Transfer chunk path length exceeds the accepted bounds");
        }
        if (plainLengthValue > V2TransferCrypto.MAX_CHUNK_BYTES
            || ciphertextLengthValue > V2TransferCrypto.MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException("Transfer chunk payload exceeds the maximum length");
        }
        if (ciphertextLengthValue != plainLengthValue) {
            throw new IllegalArgumentException("Transfer chunk ciphertext length must equal plainLength");
        }
        if (nonceLength != V2TransferCrypto.NONCE_BYTES
            || authTagLength != V2TransferCrypto.AUTH_TAG_BYTES) {
            throw new IllegalArgumentException("Transfer chunk nonce or authentication tag length is invalid");
        }

        long expectedLength = (long) HEADER_BYTES + taskIdLength + pathLength + nonceLength
            + authTagLength + ciphertextLengthValue;
        if (frameLengthValue != expectedLength || frameLengthValue > MAX_FRAME_BYTES) {
            throw new IllegalArgumentException("Transfer chunk frame length is inconsistent");
        }

        return new Header(
            (int) frameLengthValue,
            taskIdLength,
            pathLength,
            offset,
            sequence,
            (int) plainLengthValue,
            (int) ciphertextLengthValue,
            nonceLength,
            authTagLength
        );
    }

    private static Frame decodeCompleteFrame(byte[] encoded, Header header) {
        int cursor = HEADER_BYTES;
        byte[] taskIdBytes = Arrays.copyOfRange(encoded, cursor, cursor + header.taskIdLength);
        cursor += header.taskIdLength;
        byte[] pathBytes = Arrays.copyOfRange(encoded, cursor, cursor + header.pathLength);
        cursor += header.pathLength;
        byte[] nonce = Arrays.copyOfRange(encoded, cursor, cursor + header.nonceLength);
        cursor += header.nonceLength;
        byte[] authTag = Arrays.copyOfRange(encoded, cursor, cursor + header.authTagLength);
        cursor += header.authTagLength;
        byte[] ciphertext = Arrays.copyOfRange(encoded, cursor, cursor + header.ciphertextLength);

        return new Frame(
            decodeCanonicalUtf8(taskIdBytes, "Transfer chunk task ID"),
            decodeCanonicalUtf8(pathBytes, "Transfer chunk path"),
            header.offset,
            header.sequence,
            header.plainLength,
            nonce,
            authTag,
            ciphertext
        );
    }

    private static String decodeCanonicalUtf8(byte[] bytes, String subject) {
        final String decoded;
        try {
            CharBuffer characters = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes));
            decoded = characters.toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException(subject + " is not valid UTF-8", error);
        }
        if (!Arrays.equals(decoded.getBytes(StandardCharsets.UTF_8), bytes)) {
            throw new IllegalArgumentException(subject + " is not canonical UTF-8");
        }
        return decoded;
    }

    private static void assertValidTaskId(String taskId) {
        if (taskId == null || !TASK_ID_PATTERN.matcher(taskId).matches()) {
            throw new IllegalArgumentException("Transfer task ID must be a 16-byte base64url value");
        }
        final byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(taskId);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Transfer task ID must be a valid base64url value", error);
        }
        if (decoded.length != TASK_ID_DECODED_BYTES
            || !Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(taskId)) {
            throw new IllegalArgumentException("Transfer task ID must be a canonical 16-byte base64url value");
        }
    }

    private static void assertValidRelativePath(String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) {
            throw new IllegalArgumentException("Transfer path must be a non-empty string");
        }
        assertWellFormedString(relativePath, "Transfer path");
        if (relativePath.getBytes(StandardCharsets.UTF_8).length > MAX_RELATIVE_PATH_BYTES) {
            throw new IllegalArgumentException("Transfer path exceeds the maximum UTF-8 length");
        }
        if (relativePath.startsWith("/") || relativePath.startsWith("\\")
            || relativePath.indexOf('\\') >= 0
            || (relativePath.length() >= 2 && Character.isLetter(relativePath.charAt(0))
                && relativePath.charAt(1) == ':')) {
            throw new IllegalArgumentException("Transfer path must use a relative POSIX path");
        }

        String[] components = relativePath.split("/", -1);
        for (String component : components) {
            if (component.isEmpty() || component.equals(".") || component.equals("..")) {
                throw new IllegalArgumentException("Transfer path must not contain empty or traversal components");
            }
            if (component.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_COMPONENT_BYTES) {
                throw new IllegalArgumentException("Transfer path component exceeds the maximum UTF-8 length");
            }
            for (int index = 0; index < component.length(); index += 1) {
                char value = component.charAt(index);
                if (value < 0x20 || value == 0x7f || "<>:\"/\\|?*".indexOf(value) >= 0) {
                    throw new IllegalArgumentException("Transfer path component contains a Windows-invalid character");
                }
            }
            if (component.endsWith(".") || component.endsWith(" ")) {
                throw new IllegalArgumentException("Transfer path component must not end in a period or space");
            }
            if (isWindowsReservedName(component)) {
                throw new IllegalArgumentException("Transfer path component uses a Windows reserved device name");
            }
        }
    }

    private static boolean isWindowsReservedName(String component) {
        int period = component.indexOf('.');
        String baseName = period < 0 ? component : component.substring(0, period);
        int end = baseName.length();
        while (end > 0 && (baseName.charAt(end - 1) == '.' || baseName.charAt(end - 1) == ' ')) end -= 1;
        return WINDOWS_RESERVED_NAME_PATTERN.matcher(baseName.substring(0, end)).matches();
    }

    private static void assertWellFormedString(String value, String subject) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException(subject + " contains an unpaired surrogate");
                }
                index += 1;
            } else if (Character.isLowSurrogate(character)) {
                throw new IllegalArgumentException(subject + " contains an unpaired surrogate");
            }
        }
    }

    private static void assertSafeInteger(long value, String subject) {
        if (value < 0 || value > V2TransferCrypto.MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(subject + " must be a non-negative safe integer");
        }
    }

    private static long readSafeInteger(long value, String subject) {
        assertSafeInteger(value, subject);
        return value;
    }

    private static void requireExactLength(byte[] value, int length, String subject) {
        if (value == null || value.length != length) {
            throw new IllegalArgumentException(subject + " must contain exactly " + length + " bytes");
        }
    }

    private static int checkedFrameLength(int pathLength, int ciphertextLength) {
        long value = (long) HEADER_BYTES + TASK_ID_BYTES + pathLength
            + V2TransferCrypto.NONCE_BYTES + V2TransferCrypto.AUTH_TAG_BYTES + ciphertextLength;
        if (value > MAX_FRAME_BYTES || value > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Transfer chunk frame exceeds the maximum length");
        }
        return (int) value;
    }

    private static final class Header {
        private final int frameLength;
        private final int taskIdLength;
        private final int pathLength;
        private final long offset;
        private final long sequence;
        private final int plainLength;
        private final int ciphertextLength;
        private final int nonceLength;
        private final int authTagLength;

        private Header(
            int frameLength,
            int taskIdLength,
            int pathLength,
            long offset,
            long sequence,
            int plainLength,
            int ciphertextLength,
            int nonceLength,
            int authTagLength
        ) {
            this.frameLength = frameLength;
            this.taskIdLength = taskIdLength;
            this.pathLength = pathLength;
            this.offset = offset;
            this.sequence = sequence;
            this.plainLength = plainLength;
            this.ciphertextLength = ciphertextLength;
            this.nonceLength = nonceLength;
            this.authTagLength = authTagLength;
        }
    }
}
