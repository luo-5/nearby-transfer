package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Base64;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

public class V2TransferCryptoTest {
    @Test
    public void senderEphemeralPublicKeyRoundTripsCanonicalWireEncoding() throws Exception {
        KeyPair pair = CryptoUtil.generateX25519KeyPair();
        String pem = CryptoUtil.toPublicPem(pair.getPublic());
        String encoded = V2TransferCrypto.encodeSenderEphemeralPublicKey(pem);

        assertEquals(32, Base64.getUrlDecoder().decode(encoded).length);
        assertFalse(encoded.contains("="));
        assertEquals(pem, V2TransferCrypto.decodeSenderEphemeralPublicKey(encoded));

        assertFailure(() -> V2TransferCrypto.decodeSenderEphemeralPublicKey(encoded + "="));
        assertFailure(() -> V2TransferCrypto.decodeSenderEphemeralPublicKey("AA"));
        assertFailure(() -> V2TransferCrypto.encodeSenderEphemeralPublicKey(
            CryptoUtil.toPublicPem(CryptoUtil.generateEd25519KeyPair().getPublic())
        ));
    }

    @Test
    public void matchesSharedNodeVectorInBothDirections() throws Exception {
        JSONObject vector = loadVector();
        byte[] senderKey = deriveSenderKey(vector);
        byte[] receiverKey = V2TransferCrypto.deriveSessionKey(
            vector.getString("receiverPrivateKeyPem"),
            vector.getString("senderPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        );

        assertEquals("nearby-transfer/v2/file-content", V2TransferCrypto.CONTEXT);
        assertEquals(V2TransferCrypto.MAX_SAFE_INTEGER, V2TransferCrypto.MAX_SEQUENCE);
        assertEquals(vector.getString("derivedKeyHex"), hex(senderKey));
        assertArrayEquals(senderKey, receiverKey);

        byte[] reverseSenderKey = V2TransferCrypto.deriveSessionKey(
            vector.getString("receiverPrivateKeyPem"),
            vector.getString("senderPublicKeyPem"),
            vector.getString("receiverDeviceId"),
            vector.getString("senderDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        );
        byte[] reverseReceiverKey = V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("receiverDeviceId"),
            vector.getString("senderDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        );
        assertArrayEquals(reverseSenderKey, reverseReceiverKey);
        assertFalse(Arrays.equals(senderKey, reverseSenderKey));

        byte[] changedManifestKey = V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            repeat('0', 64)
        );
        assertFalse(Arrays.equals(senderKey, changedManifestKey));
    }

    @Test
    public void decryptsSharedVectorAndFreshEncryptionOwnsNonce() throws Exception {
        JSONObject vector = loadVector();
        JSONObject chunk = vector.getJSONObject("chunk");
        byte[] key = deriveSenderKey(vector);
        byte[] fixtureNonce = decodeHex(chunk.getString("nonceHex"));
        byte[] fixtureCiphertext = decodeHex(chunk.getString("ciphertextHex"));
        byte[] fixtureTag = decodeHex(chunk.getString("authTagHex"));
        byte[] plaintext = chunk.getString("plaintextUtf8").getBytes(StandardCharsets.UTF_8);

        byte[] aad = V2TransferCrypto.buildChunkAad(
            vector.getString("taskId"),
            chunk.getString("path"),
            chunk.getLong("offset"),
            chunk.getLong("sequence"),
            plaintext.length
        );
        assertEquals(chunk.getString("aadHex"), hex(aad));
        assertArrayEquals(plaintext, V2TransferCrypto.decryptChunk(
            key,
            fixtureNonce,
            vector.getString("taskId"),
            chunk.getString("path"),
            chunk.getLong("offset"),
            chunk.getLong("sequence"),
            plaintext.length,
            fixtureCiphertext,
            fixtureTag
        ));

        V2TransferCrypto.SealedChunk sealed = V2TransferCrypto.encryptChunk(
            key,
            vector.getString("taskId"),
            chunk.getString("path"),
            chunk.getLong("offset"),
            chunk.getLong("sequence"),
            plaintext
        );
        V2TransferCrypto.SealedChunk sealedAgain = V2TransferCrypto.encryptChunk(
            key,
            vector.getString("taskId"),
            chunk.getString("path"),
            chunk.getLong("offset"),
            chunk.getLong("sequence"),
            plaintext
        );
        assertEquals(V2TransferCrypto.NONCE_BYTES, sealed.nonce.length);
        assertEquals(V2TransferCrypto.AUTH_TAG_BYTES, sealed.authTag.length);
        assertFalse("Fresh encryptions must not reuse a nonce", Arrays.equals(sealed.nonce, sealedAgain.nonce));
        assertArrayEquals(plaintext, V2TransferCrypto.decryptChunk(
            key,
            sealed.nonce,
            vector.getString("taskId"),
            chunk.getString("path"),
            chunk.getLong("offset"),
            chunk.getLong("sequence"),
            plaintext.length,
            sealed.ciphertext,
            sealed.authTag
        ));
    }

    @Test
    public void rejectsTamperingWithoutReturningPlaintext() throws Exception {
        JSONObject vector = loadVector();
        JSONObject chunk = vector.getJSONObject("chunk");
        byte[] key = deriveSenderKey(vector);
        byte[] nonce = decodeHex(chunk.getString("nonceHex"));
        byte[] ciphertext = decodeHex(chunk.getString("ciphertextHex"));
        byte[] tag = decodeHex(chunk.getString("authTagHex"));
        long plainLength = chunk.getLong("plainLength");

        byte[] alteredCiphertext = Arrays.copyOf(ciphertext, ciphertext.length);
        alteredCiphertext[0] ^= (byte) 0x80;
        byte[] alteredTag = Arrays.copyOf(tag, tag.length);
        alteredTag[0] ^= (byte) 0x80;
        byte[] alteredNonce = Arrays.copyOf(nonce, nonce.length);
        alteredNonce[0] ^= (byte) 0x80;
        byte[] alteredKey = Arrays.copyOf(key, key.length);
        alteredKey[0] ^= (byte) 0x80;

        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, alteredCiphertext, tag, null, null, null, null);
        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, ciphertext, alteredTag, null, null, null, null);
        expectAuthenticationFailure(vector, chunk, key, alteredNonce, plainLength, ciphertext, tag, null, null, null, null);
        expectAuthenticationFailure(vector, chunk, alteredKey, nonce, plainLength, ciphertext, tag, null, null, null, null);
        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, ciphertext, tag, "docs/other.txt", null, null, null);
        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, ciphertext, tag, null, chunk.getLong("offset") + 1, null, null);
        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, ciphertext, tag, null, null, chunk.getLong("sequence") + 1, null);
        expectAuthenticationFailure(vector, chunk, key, nonce, plainLength, ciphertext, tag, null, null, null, "AgMEBQYHCAkKCwwNDg8QEQ");
    }

    @Test
    public void rejectsWrongKeyFormatsAndInvalidBounds() throws Exception {
        JSONObject vector = loadVector();
        JSONObject chunk = vector.getJSONObject("chunk");
        byte[] key = deriveSenderKey(vector);
        byte[] nonce = decodeHex(chunk.getString("nonceHex"));
        byte[] plaintext = chunk.getString("plaintextUtf8").getBytes(StandardCharsets.UTF_8);
        KeyPair ed25519 = CryptoUtil.generateEd25519KeyPair();

        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            CryptoUtil.toPrivatePem(ed25519.getPrivate()),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            CryptoUtil.toPublicPem(ed25519.getPublic()),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPublicKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPrivateKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        String zeroPublicPem = "-----BEGIN PUBLIC KEY-----\n" +
            Base64.getEncoder().encodeToString(concat(decodeHex("302a300506032b656e032100"), new byte[32])) +
            "\n-----END PUBLIC KEY-----\n";
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            zeroPublicPem,
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertArrayEquals(key, V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem").replace("\n", "\r\n"),
            vector.getString("receiverPublicKeyPem").replace("\n", "\r\n"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId").toUpperCase(),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        ));
        assertFailure(() -> V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256").toUpperCase()
        ));

        assertFailure(() -> V2TransferCrypto.encryptChunk(new byte[31], vector.getString("taskId"), chunk.getString("path"), 0, 0, plaintext));
        assertFailure(() -> V2TransferCrypto.encryptChunk(key, vector.getString("taskId"), chunk.getString("path"), -1, 0, plaintext));
        assertFailure(() -> V2TransferCrypto.encryptChunk(key, vector.getString("taskId"), chunk.getString("path"), V2TransferCrypto.MAX_SAFE_INTEGER + 1, 0, plaintext));
        assertFailure(() -> V2TransferCrypto.encryptChunk(key, vector.getString("taskId"), chunk.getString("path"), V2TransferCrypto.MAX_SAFE_INTEGER, 0, plaintext));
        assertFailure(() -> V2TransferCrypto.encryptChunk(key, vector.getString("taskId"), chunk.getString("path"), 0, V2TransferCrypto.MAX_SEQUENCE + 1, plaintext));
        V2TransferCrypto.buildChunkAad(
            vector.getString("taskId"),
            chunk.getString("path"),
            V2TransferCrypto.MAX_SAFE_INTEGER,
            V2TransferCrypto.MAX_SEQUENCE,
            0
        );
        assertFailure(() -> V2TransferCrypto.encryptChunk(key, vector.getString("taskId"), "../escape.txt", 0, 0, plaintext));
        assertFailure(() -> V2TransferCrypto.buildChunkAad(vector.getString("taskId"), chunk.getString("path"), 0, 0, V2TransferCrypto.MAX_CHUNK_BYTES + 1L));
        assertFailure(() -> V2TransferCrypto.decryptChunk(key, nonce, vector.getString("taskId"), chunk.getString("path"), 0, 0, plaintext.length - 1L, plaintext, new byte[16]));
        assertFailure(() -> V2TransferCrypto.decryptChunk(key, nonce, vector.getString("taskId"), chunk.getString("path"), 0, 0, plaintext.length, plaintext, new byte[15]));
    }

    private static byte[] deriveSenderKey(JSONObject vector) throws Exception {
        return V2TransferCrypto.deriveSessionKey(
            vector.getString("senderPrivateKeyPem"),
            vector.getString("receiverPublicKeyPem"),
            vector.getString("senderDeviceId"),
            vector.getString("receiverDeviceId"),
            vector.getString("taskId"),
            vector.getString("manifestSha256")
        );
    }

    private static void expectAuthenticationFailure(
        JSONObject vector,
        JSONObject chunk,
        byte[] key,
        byte[] nonce,
        long plainLength,
        byte[] ciphertext,
        byte[] tag,
        String pathOverride,
        Long offsetOverride,
        Long sequenceOverride,
        String taskIdOverride
    ) throws Exception {
        byte[] returnedPlaintext = null;
        try {
            returnedPlaintext = V2TransferCrypto.decryptChunk(
                key,
                nonce,
                taskIdOverride == null ? vector.getString("taskId") : taskIdOverride,
                pathOverride == null ? chunk.getString("path") : pathOverride,
                offsetOverride == null ? chunk.getLong("offset") : offsetOverride,
                sequenceOverride == null ? chunk.getLong("sequence") : sequenceOverride,
                plainLength,
                ciphertext,
                tag
            );
            fail("Expected authentication failure");
        } catch (GeneralSecurityException expected) {
            assertEquals("Chunk authentication failed", expected.getMessage());
        }
        if (returnedPlaintext != null) {
            fail("Authentication failure returned plaintext");
        }
    }

    private static JSONObject loadVector() throws Exception {
        try (InputStream input = V2TransferCryptoTest.class.getResourceAsStream("/transfer-session-crypto-v2.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer crypto fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected invalid crypto input to be rejected");
        } catch (IllegalArgumentException | GeneralSecurityException expected) {
            // Expected.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static byte[] decodeHex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int index = 0; index < value.length(); index += 2) {
            result[index / 2] = (byte) Integer.parseInt(value.substring(index, index + 2), 16);
        }
        return result;
    }

    private static byte[] concat(byte[] first, byte[] second) {
        byte[] result = Arrays.copyOf(first, first.length + second.length);
        System.arraycopy(second, 0, result, first.length, second.length);
        return result;
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder();
        for (byte current : value) {
            result.append(String.format("%02x", current));
        }
        return result.toString();
    }

    private static String repeat(char value, int count) {
        char[] result = new char[count];
        Arrays.fill(result, value);
        return new String(result);
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
