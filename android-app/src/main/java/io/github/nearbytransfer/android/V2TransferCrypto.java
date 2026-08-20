package io.github.nearbytransfer.android;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.regex.Pattern;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class V2TransferCrypto {
    static final String CONTEXT = "nearby-transfer/v2/file-content";
    static final int KEY_BYTES = 32;
    static final int NONCE_BYTES = 12;
    static final int AUTH_TAG_BYTES = 16;
    static final int MAX_CHUNK_BYTES = 1024 * 1024;
    static final long MAX_SAFE_INTEGER = 9007199254740991L;
    static final long MAX_SEQUENCE = MAX_SAFE_INTEGER;

    private static final String SESSION_LABEL = "session-key";
    private static final String CHUNK_AAD_LABEL = "chunk-aad";
    private static final Pattern DEVICE_ID_PATTERN = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern TASK_ID_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern SHA256_PATTERN = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern BASE64URL_PATTERN = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Pattern BASE64_PATTERN = Pattern.compile(
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
    );
    private static final Pattern WINDOWS_RESERVED_NAME_PATTERN = Pattern.compile(
        "^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$",
        Pattern.CASE_INSENSITIVE
    );
    private static final byte[] X25519_PRIVATE_DER_PREFIX = decodeHexUnchecked("302e020100300506032b656e04220420");
    private static final byte[] X25519_PUBLIC_DER_PREFIX = decodeHexUnchecked("302a300506032b656e032100");
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private V2TransferCrypto() {}

    static String encodeSenderEphemeralPublicKey(String publicKeyPem) {
        byte[] der = readCanonicalPem(
            publicKeyPem,
            "PUBLIC KEY",
            X25519_PUBLIC_DER_PREFIX,
            KEY_BYTES,
            "Sender ephemeral X25519 public key"
        );
        byte[] raw = Arrays.copyOfRange(der, X25519_PUBLIC_DER_PREFIX.length, der.length);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    static String decodeSenderEphemeralPublicKey(String encoded) {
        if (encoded == null || !BASE64URL_PATTERN.matcher(encoded).matches()) {
            throw new IllegalArgumentException("Sender ephemeral public key must use unpadded base64url");
        }
        byte[] raw;
        try {
            raw = Base64.getUrlDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Sender ephemeral public key must use valid base64url", error);
        }
        String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        if (raw.length != KEY_BYTES || !canonical.equals(encoded)) {
            throw new IllegalArgumentException("Sender ephemeral public key must contain exactly 32 canonical bytes");
        }
        byte[] der = new byte[X25519_PUBLIC_DER_PREFIX.length + raw.length];
        System.arraycopy(X25519_PUBLIC_DER_PREFIX, 0, der, 0, X25519_PUBLIC_DER_PREFIX.length);
        System.arraycopy(raw, 0, der, X25519_PUBLIC_DER_PREFIX.length, raw.length);
        String body = Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(der);
        return "-----BEGIN PUBLIC KEY-----\n" + body + "\n-----END PUBLIC KEY-----\n";
    }

    static byte[] deriveSessionKey(
        String localPrivateKeyPem,
        String remotePublicKeyPem,
        String senderDeviceId,
        String receiverDeviceId,
        String taskId,
        String manifestSha256
    ) throws GeneralSecurityException {
        requireDeviceId(senderDeviceId, "Sender device ID");
        requireDeviceId(receiverDeviceId, "Receiver device ID");
        if (senderDeviceId.equals(receiverDeviceId)) {
            throw new IllegalArgumentException("Sender and receiver device IDs must be different");
        }
        requireTaskId(taskId);
        if (manifestSha256 == null || !SHA256_PATTERN.matcher(manifestSha256).matches()) {
            throw new IllegalArgumentException("Manifest SHA-256 must be 64 lowercase hexadecimal characters");
        }

        byte[] privateDer = readCanonicalPem(
            localPrivateKeyPem,
            "PRIVATE KEY",
            X25519_PRIVATE_DER_PREFIX,
            KEY_BYTES,
            "Local X25519 private key"
        );
        byte[] publicDer = readCanonicalPem(
            remotePublicKeyPem,
            "PUBLIC KEY",
            X25519_PUBLIC_DER_PREFIX,
            KEY_BYTES,
            "Remote X25519 public key"
        );
        PrivateKey privateKey = CryptoUtil.readPrivateKey(localPrivateKeyPem, "X25519");
        PublicKey publicKey = CryptoUtil.readPublicKey(remotePublicKeyPem, "X25519");
        if (!"X25519".equalsIgnoreCase(privateKey.getAlgorithm()) ||
            !"X25519".equalsIgnoreCase(publicKey.getAlgorithm()) ||
            !Arrays.equals(privateDer, privateKey.getEncoded()) ||
            !Arrays.equals(publicDer, publicKey.getEncoded())) {
            throw new IllegalArgumentException("Transfer session keys must use canonical X25519 PKCS#8/SPKI encoding");
        }

        byte[] sharedSecret;
        try {
            KeyAgreement agreement = KeyAgreement.getInstance("X25519", "BC");
            agreement.init(privateKey);
            agreement.doPhase(publicKey, true);
            sharedSecret = agreement.generateSecret();
        } catch (RuntimeException error) {
            // Bouncy Castle reports low-order/all-zero peer keys as an
            // IllegalStateException. Keep the public API's failure mode stable.
            throw new GeneralSecurityException("Unable to derive an X25519 shared secret", error);
        }
        try {
            if (sharedSecret.length != KEY_BYTES || isAllZero(sharedSecret)) {
                throw new GeneralSecurityException("X25519 produced an invalid shared secret");
            }
            byte[] salt = decodeHex(manifestSha256);
            byte[] info = encodeFields(
                CONTEXT,
                SESSION_LABEL,
                senderDeviceId,
                receiverDeviceId,
                taskId,
                manifestSha256
            );
            return hkdfSha256(sharedSecret, salt, info, KEY_BYTES);
        } finally {
            Arrays.fill(sharedSecret, (byte) 0);
        }
    }

    static byte[] buildChunkAad(String taskId, String path, long offset, long sequence, long plainLength) {
        requireChunkMetadata(taskId, path, offset, sequence, plainLength);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.writeBytes(encodeFields(CONTEXT, CHUNK_AAD_LABEL, taskId, path));
        output.writeBytes(encodeLong(offset));
        output.writeBytes(encodeLong(sequence));
        output.writeBytes(encodeInt((int) plainLength));
        return output.toByteArray();
    }

    static SealedChunk encryptChunk(
        byte[] key,
        String taskId,
        String path,
        long offset,
        long sequence,
        byte[] plaintext
    ) throws GeneralSecurityException {
        byte[] checkedKey = requireBytes(key, KEY_BYTES, "Session key");
        byte[] checkedPlaintext = requireBoundedBytes(plaintext, "Chunk plaintext");
        byte[] aad = buildChunkAad(taskId, path, offset, sequence, checkedPlaintext.length);
        // Nonce ownership stays inside the encryptor so callers cannot
        // accidentally reuse a caller-managed IV across chunks or retries.
        byte[] nonce = new byte[NONCE_BYTES];
        SECURE_RANDOM.nextBytes(nonce);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(checkedKey, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        byte[] sealed = cipher.doFinal(checkedPlaintext);
        int ciphertextLength = sealed.length - AUTH_TAG_BYTES;
        return new SealedChunk(
            nonce,
            Arrays.copyOfRange(sealed, 0, ciphertextLength),
            Arrays.copyOfRange(sealed, ciphertextLength, sealed.length)
        );
    }

    static byte[] decryptChunk(
        byte[] key,
        byte[] nonce,
        String taskId,
        String path,
        long offset,
        long sequence,
        long plainLength,
        byte[] ciphertext,
        byte[] authTag
    ) throws GeneralSecurityException {
        byte[] checkedKey = requireBytes(key, KEY_BYTES, "Session key");
        byte[] checkedNonce = requireBytes(nonce, NONCE_BYTES, "Chunk nonce");
        byte[] checkedCiphertext = requireBoundedBytes(ciphertext, "Chunk ciphertext");
        byte[] checkedTag = requireBytes(authTag, AUTH_TAG_BYTES, "Chunk authentication tag");
        requireChunkMetadata(taskId, path, offset, sequence, plainLength);
        if (checkedCiphertext.length != plainLength) {
            throw new IllegalArgumentException("Chunk ciphertext length must equal the authenticated plaintext length");
        }

        byte[] sealed = new byte[checkedCiphertext.length + checkedTag.length];
        System.arraycopy(checkedCiphertext, 0, sealed, 0, checkedCiphertext.length);
        System.arraycopy(checkedTag, 0, sealed, checkedCiphertext.length, checkedTag.length);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(checkedKey, "AES"), new GCMParameterSpec(128, checkedNonce));
            cipher.updateAAD(buildChunkAad(taskId, path, offset, sequence, plainLength));
            // doFinal(byte[]) returns no caller-visible plaintext unless the
            // complete GCM tag has authenticated successfully.
            byte[] plaintext = cipher.doFinal(sealed);
            if (plaintext.length != plainLength) {
                Arrays.fill(plaintext, (byte) 0);
                throw new GeneralSecurityException("Authenticated plaintext length mismatch");
            }
            return plaintext;
        } catch (AEADBadTagException error) {
            throw new GeneralSecurityException("Chunk authentication failed", error);
        } catch (GeneralSecurityException error) {
            throw new GeneralSecurityException("Chunk authentication failed", error);
        }
    }

    static final class SealedChunk {
        final byte[] nonce;
        final byte[] ciphertext;
        final byte[] authTag;

        SealedChunk(byte[] nonce, byte[] ciphertext, byte[] authTag) {
            this.nonce = Arrays.copyOf(nonce, nonce.length);
            this.ciphertext = Arrays.copyOf(ciphertext, ciphertext.length);
            this.authTag = Arrays.copyOf(authTag, authTag.length);
        }
    }

    private static void requireChunkMetadata(String taskId, String path, long offset, long sequence, long plainLength) {
        requireTaskId(taskId);
        requireRelativePath(path);
        requireIntegerRange(offset, 0, MAX_SAFE_INTEGER, "Chunk offset");
        requireIntegerRange(sequence, 0, MAX_SEQUENCE, "Chunk sequence");
        requireIntegerRange(plainLength, 0, MAX_CHUNK_BYTES, "Chunk plaintext length");
        if (offset > MAX_SAFE_INTEGER - plainLength) {
            throw new IllegalArgumentException("Chunk byte range exceeds the maximum safe integer");
        }
    }

    private static void requireDeviceId(String value, String subject) {
        if (value == null || !DEVICE_ID_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException(subject + " must be 16 lowercase hexadecimal characters");
        }
    }

    private static void requireTaskId(String taskId) {
        if (taskId == null || !TASK_ID_PATTERN.matcher(taskId).matches()) {
            throw new IllegalArgumentException("Transfer task ID must be a 16-byte base64url value");
        }
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(taskId + "==");
            String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != 16 || !canonical.equals(taskId)) {
                throw new IllegalArgumentException("Transfer task ID must be a canonical 16-byte base64url value");
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Transfer task ID must be a canonical 16-byte base64url value", error);
        }
    }

    private static void requireRelativePath(String path) {
        if (path == null || path.isEmpty()) {
            throw new IllegalArgumentException("Transfer path must be a non-empty string");
        }
        requireWellFormedString(path, "Transfer path");
        if (path.getBytes(StandardCharsets.UTF_8).length > 4096) {
            throw new IllegalArgumentException("Transfer path exceeds the maximum UTF-8 length");
        }
        if (path.startsWith("/") || path.startsWith("\\") || path.indexOf('\\') >= 0 ||
            (path.length() >= 2 && isAsciiLetter(path.charAt(0)) && path.charAt(1) == ':')) {
            throw new IllegalArgumentException("Transfer path must use a relative POSIX path");
        }
        String[] components = path.split("/", -1);
        for (String component : components) {
            if (component.isEmpty() || ".".equals(component) || "..".equals(component)) {
                throw new IllegalArgumentException("Transfer path must not contain empty or traversal components");
            }
            if (component.getBytes(StandardCharsets.UTF_8).length > 255) {
                throw new IllegalArgumentException("Transfer path component exceeds the maximum UTF-8 length");
            }
            for (int index = 0; index < component.length(); index++) {
                char value = component.charAt(index);
                if (value <= 0x1f || value == 0x7f || "<>:\"\\|?*".indexOf(value) >= 0) {
                    throw new IllegalArgumentException("Transfer path component contains a Windows-invalid character");
                }
            }
            if (component.endsWith(".") || component.endsWith(" ")) {
                throw new IllegalArgumentException("Transfer path component must not end in a period or space");
            }
            String baseName = component.split("\\.", 2)[0];
            if (WINDOWS_RESERVED_NAME_PATTERN.matcher(baseName).matches()) {
                throw new IllegalArgumentException("Transfer path component uses a Windows reserved device name");
            }
        }
    }

    private static boolean isAsciiLetter(char value) {
        return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
    }

    private static void requireWellFormedString(String value, String subject) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException(subject + " contains an unpaired surrogate");
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                throw new IllegalArgumentException(subject + " contains an unpaired surrogate");
            }
        }
    }

    private static byte[] requireBoundedBytes(byte[] value, String subject) {
        if (value == null) {
            throw new IllegalArgumentException(subject + " must be a byte array");
        }
        if (value.length > MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException(subject + " exceeds the maximum chunk size");
        }
        return Arrays.copyOf(value, value.length);
    }

    private static byte[] requireBytes(byte[] value, int length, String subject) {
        if (value == null || value.length != length) {
            throw new IllegalArgumentException(subject + " must be exactly " + length + " bytes");
        }
        return Arrays.copyOf(value, value.length);
    }

    private static byte[] readCanonicalPem(
        String value,
        String label,
        byte[] prefix,
        int rawKeyBytes,
        String subject
    ) {
        if (value == null || value.isEmpty() || value.length() > 4096 || value.indexOf('\0') >= 0) {
            throw new IllegalArgumentException(subject + " must be bounded PEM text");
        }
        String normalized = value.replace("\r\n", "\n");
        if (normalized.indexOf('\r') >= 0) {
            throw new IllegalArgumentException(subject + " must use valid PEM line endings");
        }
        String header = "-----BEGIN " + label + "-----\n";
        String footer = "\n-----END " + label + "-----";
        boolean trailingNewline = normalized.endsWith(footer + "\n");
        if (!normalized.startsWith(header) && !normalized.endsWith(footer)) {
            throw new IllegalArgumentException(subject + " must use " + label + " PEM framing");
        }
        if (!normalized.startsWith(header) || (!trailingNewline && !normalized.endsWith(footer))) {
            throw new IllegalArgumentException(subject + " must use " + label + " PEM framing");
        }
        int bodyEnd = normalized.length() - footer.length() - (trailingNewline ? 1 : 0);
        String body = normalized.substring(header.length(), bodyEnd);
        String[] lines = body.split("\n", -1);
        StringBuilder base64 = new StringBuilder();
        for (String line : lines) {
            if (line.isEmpty() || line.length() > 64 || !line.matches("^[A-Za-z0-9+/=]+$")) {
                throw new IllegalArgumentException(subject + " contains invalid PEM base64");
            }
            base64.append(line);
        }
        String encoded = base64.toString();
        if (!BASE64_PATTERN.matcher(encoded).matches()) {
            throw new IllegalArgumentException(subject + " contains non-canonical PEM base64");
        }
        byte[] der;
        try {
            der = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(subject + " contains invalid PEM base64", error);
        }
        if (!Base64.getEncoder().encodeToString(der).equals(encoded) ||
            der.length != prefix.length + rawKeyBytes || !startsWith(der, prefix)) {
            throw new IllegalArgumentException(subject + " must contain canonical X25519 key encoding");
        }
        return der;
    }

    private static boolean startsWith(byte[] value, byte[] prefix) {
        if (value.length < prefix.length) return false;
        for (int index = 0; index < prefix.length; index++) {
            if (value[index] != prefix[index]) return false;
        }
        return true;
    }

    private static void requireIntegerRange(long value, long minimum, long maximum, String subject) {
        if (value < minimum || value > maximum) {
            throw new IllegalArgumentException(subject + " must be between " + minimum + " and " + maximum);
        }
    }

    private static byte[] encodeFields(String... fields) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (String field : fields) {
            if (field == null) {
                throw new IllegalArgumentException("Protocol field must be a string");
            }
            requireWellFormedString(field, "Protocol field");
            byte[] encoded = field.getBytes(StandardCharsets.UTF_8);
            output.writeBytes(encodeInt(encoded.length));
            output.writeBytes(encoded);
        }
        return output.toByteArray();
    }

    private static byte[] encodeLong(long value) {
        return ByteBuffer.allocate(8).putLong(value).array();
    }

    private static byte[] encodeInt(int value) {
        return ByteBuffer.allocate(4).putInt(value).array();
    }

    private static byte[] hkdfSha256(byte[] inputKeyMaterial, byte[] salt, byte[] info, int outputLength)
        throws GeneralSecurityException {
        if (inputKeyMaterial == null || salt == null || info == null || outputLength <= 0 || outputLength > 255 * 32) {
            throw new IllegalArgumentException("HKDF parameters are invalid");
        }
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] pseudorandomKey = mac.doFinal(inputKeyMaterial);
        byte[] previous = new byte[0];
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int counter = 1;
            while (output.size() < outputLength) {
                mac.init(new SecretKeySpec(pseudorandomKey, "HmacSHA256"));
                mac.update(previous);
                mac.update(info);
                mac.update((byte) counter);
                byte[] next = mac.doFinal();
                Arrays.fill(previous, (byte) 0);
                previous = next;
                output.writeBytes(previous);
                counter++;
            }
            return Arrays.copyOf(output.toByteArray(), outputLength);
        } finally {
            Arrays.fill(previous, (byte) 0);
            Arrays.fill(pseudorandomKey, (byte) 0);
        }
    }

    private static byte[] decodeHex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int index = 0; index < value.length(); index += 2) {
            result[index / 2] = (byte) Integer.parseInt(value.substring(index, index + 2), 16);
        }
        return result;
    }

    private static byte[] decodeHexUnchecked(String value) {
        return decodeHex(value);
    }

    private static boolean isAllZero(byte[] value) {
        int combined = 0;
        for (byte current : value) {
            combined |= current;
        }
        return combined == 0;
    }
}
