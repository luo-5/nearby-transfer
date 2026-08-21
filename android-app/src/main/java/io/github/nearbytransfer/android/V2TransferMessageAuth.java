package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;

/** Ed25519 authentication helpers for strict protocol-v2 transfer messages. */
final class V2TransferMessageAuth {
    private static final int SIGNATURE_BYTES = 64;

    private V2TransferMessageAuth() {}

    static String sign(String type, JSONObject message, String privateKeyPem) throws Exception {
        String payload = V2TransferMessage.signingPayload(type, copy(message));
        PrivateKey privateKey = readPrivateKey(privateKeyPem);
        Signature signer = Signature.getInstance("Ed25519", "BC");
        signer.initSign(privateKey);
        signer.update(payload.getBytes(StandardCharsets.UTF_8));
        byte[] signature = signer.sign();
        if (signature.length != SIGNATURE_BYTES) {
            throw new IllegalStateException("Ed25519 produced an unexpected signature length");
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
    }

    static JSONObject signedCopy(String type, JSONObject message, String privateKeyPem) throws Exception {
        JSONObject signed = copy(message);
        signed.put("signature", sign(type, signed, privateKeyPem));
        return signed;
    }

    static V2TransferMessage.Message verify(String type, JSONObject message, String publicKeyPem,
                                            long nowEpochMillis) throws Exception {
        return verify(type, message, publicKeyPem, nowEpochMillis, null);
    }

    static V2TransferMessage.Message verify(String type, JSONObject message, String publicKeyPem,
                                            long nowEpochMillis,
                                            V2TransferMessage.ControlCheckpoint checkpoint) throws Exception {
        JSONObject candidate = copy(message);
        V2TransferMessage.Message normalized = V2TransferMessage.fromJson(
            type, candidate, nowEpochMillis, checkpoint
        );
        byte[] signatureBytes = decodeSignature(normalized.signature);
        String payload = V2TransferMessage.signingPayload(type, candidate);
        PublicKey publicKey = readPublicKey(publicKeyPem);

        Signature verifier = Signature.getInstance("Ed25519", "BC");
        verifier.initVerify(publicKey);
        verifier.update(payload.getBytes(StandardCharsets.UTF_8));
        if (!verifier.verify(signatureBytes)) {
            throw new IllegalArgumentException("Transfer message signature verification failed");
        }
        return normalized;
    }

    private static PrivateKey readPrivateKey(String pem) {
        if (pem == null || pem.isBlank()) {
            throw new IllegalArgumentException("An Ed25519 private key is required");
        }
        try {
            PrivateKey key = CryptoUtil.readPrivateKey(pem, "Ed25519");
            if (!"Ed25519".equalsIgnoreCase(key.getAlgorithm()) && !"EdDSA".equalsIgnoreCase(key.getAlgorithm())) {
                throw new IllegalArgumentException("Transfer message signing requires an Ed25519 private key");
            }
            return key;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Transfer message signing requires an Ed25519 private key", error);
        }
    }

    private static PublicKey readPublicKey(String pem) {
        if (pem == null || pem.isBlank()) {
            throw new IllegalArgumentException("An Ed25519 public key is required");
        }
        try {
            PublicKey key = CryptoUtil.readPublicKey(pem, "Ed25519");
            if (!"Ed25519".equalsIgnoreCase(key.getAlgorithm()) && !"EdDSA".equalsIgnoreCase(key.getAlgorithm())) {
                throw new IllegalArgumentException("Transfer message verification requires an Ed25519 public key");
            }
            return key;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Transfer message verification requires an Ed25519 public key", error);
        }
    }

    private static byte[] decodeSignature(String encoded) {
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(encoded);
            String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != SIGNATURE_BYTES || !canonical.equals(encoded)) {
                throw new IllegalArgumentException("Transfer message signature must be canonical base64url");
            }
            return decoded;
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Transfer message signature must be canonical base64url", error);
        }
    }

    private static JSONObject copy(JSONObject message) throws Exception {
        if (message == null) {
            throw new IllegalArgumentException("Transfer message is required");
        }
        return new JSONObject(message.toString());
    }
}
