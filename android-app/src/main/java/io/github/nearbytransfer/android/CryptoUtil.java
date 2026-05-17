package io.github.nearbytransfer.android;

import org.bouncycastle.jce.provider.BouncyCastleProvider;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.PublicKey;
import java.security.Security;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class CryptoUtil {
    private static final int FRAME_HEADER_BYTES = 32;
    private static final int FRAME_SIZE = 1024 * 1024;

    static {
        Security.removeProvider("BC");
        Security.insertProviderAt(new BouncyCastleProvider(), 1);
    }

    private CryptoUtil() {}

    static KeyPair generateEd25519KeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519", "BC");
        return generator.generateKeyPair();
    }

    static KeyPair generateX25519KeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("X25519", "BC");
        return generator.generateKeyPair();
    }

    static PublicKey readPublicKey(String pem, String algorithm) throws GeneralSecurityException {
        byte[] der = readPem(pem);
        return KeyFactory.getInstance(algorithm, "BC").generatePublic(new X509EncodedKeySpec(der));
    }

    static PrivateKey readPrivateKey(String pem, String algorithm) throws GeneralSecurityException {
        byte[] der = readPem(pem);
        return KeyFactory.getInstance(algorithm, "BC").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    static String toPublicPem(PublicKey key) {
        return toPem("PUBLIC KEY", key.getEncoded());
    }

    static String toPrivatePem(PrivateKey key) {
        return toPem("PRIVATE KEY", key.getEncoded());
    }

    static String fingerprintFor(String signingPublicKeyPem) throws GeneralSecurityException {
        byte[] digest = sha256Digest().digest(signingPublicKeyPem.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) {
            hex.append(String.format(Locale.ROOT, "%02X", b));
        }
        return hex.substring(0, 4) + "-" + hex.substring(4, 8) + "-" + hex.substring(8, 12)
            + "-" + hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" + hex.substring(20, 24);
    }

    static String deviceIdFor(String signingPublicKeyPem) throws GeneralSecurityException {
        byte[] digest = sha256Digest().digest(signingPublicKeyPem.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) {
            hex.append(String.format(Locale.ROOT, "%02x", b));
        }
        return hex.substring(0, 16);
    }

    static String sign(String message, String privateKeyPem) throws GeneralSecurityException {
        Signature signature = Signature.getInstance("Ed25519", "BC");
        signature.initSign(readPrivateKey(privateKeyPem, "Ed25519"));
        signature.update(message.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signature.sign());
    }

    static boolean verify(String message, String signatureBase64, String publicKeyPem) {
        try {
            Signature signature = Signature.getInstance("Ed25519", "BC");
            signature.initVerify(readPublicKey(publicKeyPem, "Ed25519"));
            signature.update(message.getBytes(StandardCharsets.UTF_8));
            return signature.verify(Base64.getDecoder().decode(signatureBase64));
        } catch (Exception error) {
            return false;
        }
    }

    static byte[] deriveTransferKey(String localPrivateKeyPem, String remotePublicKeyPem, String transferId) throws GeneralSecurityException {
        PrivateKey localPrivateKey = readPrivateKey(localPrivateKeyPem, "X25519");
        PublicKey remotePublicKey = readPublicKey(remotePublicKeyPem, "X25519");
        KeyAgreement agreement = KeyAgreement.getInstance("X25519", "BC");
        agreement.init(localPrivateKey);
        agreement.doPhase(remotePublicKey, true);
        byte[] secret = agreement.generateSecret();
        return hkdfSha256(secret, ("lan-transfer-v1:" + transferId).getBytes(StandardCharsets.UTF_8), "file-content".getBytes(StandardCharsets.UTF_8), 32);
    }

    static String sha256Hex(InputStream input) throws Exception {
        MessageDigest digest = sha256Digest();
        byte[] buffer = new byte[FRAME_SIZE];
        int read;
        while ((read = input.read(buffer)) != -1) {
            digest.update(buffer, 0, read);
        }
        return hexLower(digest.digest());
    }

    static byte[] encryptFrame(byte[] key, byte[] plain, int offset, int length, byte[] prefix, int counter) throws GeneralSecurityException {
        byte[] iv = new byte[12];
        System.arraycopy(prefix, 0, iv, 0, 8);
        ByteBuffer.wrap(iv, 8, 4).putInt(counter);

        Cipher cipher = platformCipher("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] sealed = cipher.doFinal(plain, offset, length);
        int ciphertextLength = sealed.length - 16;
        byte[] frame = new byte[FRAME_HEADER_BYTES + ciphertextLength];
        ByteBuffer.wrap(frame, 0, 4).putInt(ciphertextLength);
        System.arraycopy(iv, 0, frame, 4, 12);
        System.arraycopy(sealed, ciphertextLength, frame, 16, 16);
        System.arraycopy(sealed, 0, frame, 32, ciphertextLength);
        return frame;
    }

    static byte[] decryptFrame(byte[] key, byte[] iv, byte[] tag, byte[] ciphertext) throws GeneralSecurityException {
        byte[] sealed = new byte[ciphertext.length + tag.length];
        System.arraycopy(ciphertext, 0, sealed, 0, ciphertext.length);
        System.arraycopy(tag, 0, sealed, ciphertext.length, tag.length);
        Cipher cipher = platformCipher("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        return cipher.doFinal(sealed);
    }

    static int frameSize() {
        return FRAME_SIZE;
    }

    static String hexLower(byte[] data) {
        StringBuilder builder = new StringBuilder();
        for (byte b : data) {
            builder.append(String.format(Locale.ROOT, "%02x", b));
        }
        return builder.toString();
    }

    static MessageDigest sha256Digest() throws GeneralSecurityException {
        for (Provider provider : Security.getProviders()) {
            if (!"BC".equals(provider.getName())) {
                try {
                    return MessageDigest.getInstance("SHA-256", provider);
                } catch (GeneralSecurityException ignored) {
                }
            }
        }
        return MessageDigest.getInstance("SHA-256");
    }

    private static Cipher platformCipher(String transformation) throws GeneralSecurityException {
        for (Provider provider : Security.getProviders()) {
            if (!"BC".equals(provider.getName())) {
                try {
                    return Cipher.getInstance(transformation, provider);
                } catch (GeneralSecurityException ignored) {
                }
            }
        }
        return Cipher.getInstance(transformation);
    }

    private static byte[] hkdfSha256(byte[] inputKeyMaterial, byte[] salt, byte[] info, int length) throws GeneralSecurityException {
        Mac mac = platformMac("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(inputKeyMaterial);
        byte[] result = new byte[length];
        byte[] previous = new byte[0];
        int copied = 0;
        int counter = 1;
        while (copied < length) {
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            mac.update(previous);
            mac.update(info);
            mac.update((byte) counter);
            previous = mac.doFinal();
            int toCopy = Math.min(previous.length, length - copied);
            System.arraycopy(previous, 0, result, copied, toCopy);
            copied += toCopy;
            counter += 1;
        }
        Arrays.fill(prk, (byte) 0);
        return result;
    }

    private static Mac platformMac(String algorithm) throws GeneralSecurityException {
        for (Provider provider : Security.getProviders()) {
            if (!"BC".equals(provider.getName())) {
                try {
                    return Mac.getInstance(algorithm, provider);
                } catch (GeneralSecurityException ignored) {
                }
            }
        }
        return Mac.getInstance(algorithm);
    }

    private static String toPem(String type, byte[] der) {
        String encoded = Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(der);
        return "-----BEGIN " + type + "-----\n" + encoded + "\n-----END " + type + "-----\n";
    }

    private static byte[] readPem(String pem) {
        String base64 = pem.replaceAll("-----BEGIN [^-]+-----", "")
            .replaceAll("-----END [^-]+-----", "")
            .replaceAll("\\s", "");
        return Base64.getDecoder().decode(base64);
    }
}
