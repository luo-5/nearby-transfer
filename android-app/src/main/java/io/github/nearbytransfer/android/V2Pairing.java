package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Protocol v2 pairing messages, validation, and Ed25519 signing primitives. */
final class V2Pairing {
    static final long MAX_CLOCK_SKEW_MS = 30_000L;
    static final long PAIRING_SESSION_TTL_MS = 300_000L;
    static final int MAX_SIGNATURE_LENGTH = 512;

    static final String TYPE_OFFER = "pairing-offer";
    static final String TYPE_CONFIRM = "pairing-confirm";
    static final String TYPE_CANCEL = "pairing-cancel";

    private static final Pattern PAIRING_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern PAIRING_CODE = Pattern.compile("^[0-9]{6}$");
    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern CAPABILITY = Pattern.compile("^[a-z][a-z0-9-]*$");
    private static final Set<String> CANCEL_REASONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "connection-closed", "rejected", "timeout", "user-cancelled"
    )));
    private static final SecureRandom RANDOM = new SecureRandom();

    private V2Pairing() {}

    static final class Offer {
        final String pairingId;
        final long issuedAt;
        final V2Identity identity;
        final List<String> capabilities;

        private Offer(String pairingId, long issuedAt, V2Identity identity, List<String> capabilities) {
            this.pairingId = pairingId;
            this.issuedAt = issuedAt;
            this.identity = identity;
            this.capabilities = capabilities;
        }

        JSONObject toJson() throws Exception {
            JSONObject json = envelope(TYPE_OFFER);
            json.put("pairingId", pairingId);
            json.put("issuedAt", issuedAt);
            json.put("identity", identity.toJson());
            json.put("capabilities", new JSONArray(capabilities));
            return json;
        }
    }

    static final class Confirmation {
        final String pairingId;
        final long issuedAt;
        final String deviceId;
        final String pairingCode;

        private Confirmation(String pairingId, long issuedAt, String deviceId, String pairingCode) {
            this.pairingId = pairingId;
            this.issuedAt = issuedAt;
            this.deviceId = deviceId;
            this.pairingCode = pairingCode;
        }

        JSONObject toJson() throws Exception {
            JSONObject json = envelope(TYPE_CONFIRM);
            json.put("pairingId", pairingId);
            json.put("issuedAt", issuedAt);
            json.put("deviceId", deviceId);
            json.put("pairingCode", pairingCode);
            return json;
        }
    }

    static final class Cancellation {
        final String pairingId;
        final long issuedAt;
        final String deviceId;
        final String reason;

        private Cancellation(String pairingId, long issuedAt, String deviceId, String reason) {
            this.pairingId = pairingId;
            this.issuedAt = issuedAt;
            this.deviceId = deviceId;
            this.reason = reason;
        }

        JSONObject toJson() throws Exception {
            JSONObject json = envelope(TYPE_CANCEL);
            json.put("pairingId", pairingId);
            json.put("issuedAt", issuedAt);
            json.put("deviceId", deviceId);
            json.put("reason", reason);
            return json;
        }
    }

    static Offer createOffer(V2Identity identity, List<String> capabilities, String pairingId, long issuedAt) {
        assertPairingId(pairingId);
        assertPositiveSafeInteger(issuedAt, "Pairing offer issue time");
        if (identity == null) {
            throw new IllegalArgumentException("Pairing offer identity is required");
        }
        return new Offer(pairingId, issuedAt, identity, normalizeCapabilities(capabilities));
    }

    static Offer createOffer(V2Identity identity, List<String> capabilities) {
        return createOffer(identity, capabilities, createPairingId(), System.currentTimeMillis());
    }

    static Confirmation createConfirmation(String pairingId, long issuedAt, String deviceId, String pairingCode) {
        assertPairingId(pairingId);
        assertPositiveSafeInteger(issuedAt, "Pairing confirmation issue time");
        assertDeviceId(deviceId, "Pairing confirmation device ID");
        if (pairingCode == null || !PAIRING_CODE.matcher(pairingCode).matches()) {
            throw new IllegalArgumentException("Pairing confirmation code is invalid");
        }
        return new Confirmation(pairingId, issuedAt, deviceId, pairingCode);
    }

    static Cancellation createCancellation(String pairingId, long issuedAt, String deviceId, String reason) {
        assertPairingId(pairingId);
        assertPositiveSafeInteger(issuedAt, "Pairing cancellation issue time");
        assertDeviceId(deviceId, "Pairing cancellation device ID");
        if (reason == null || !CANCEL_REASONS.contains(reason)) {
            throw new IllegalArgumentException("Pairing cancellation reason is invalid");
        }
        return new Cancellation(pairingId, issuedAt, deviceId, reason);
    }

    static Offer offerFromJson(JSONObject json) throws Exception {
        assertExactKeys(json, Arrays.asList("app", "protocolVersion", "type", "pairingId", "issuedAt", "identity", "capabilities"), "Pairing offer");
        assertEnvelope(json, TYPE_OFFER, "Pairing offer");
        Object identity = json.opt("identity");
        Object capabilities = json.opt("capabilities");
        if (!(identity instanceof JSONObject) || !(capabilities instanceof JSONArray)) {
            throw new IllegalArgumentException("Pairing offer has invalid identity or capabilities");
        }
        return createOffer(
            V2Identity.fromJson((JSONObject) identity),
            capabilitiesFromJson((JSONArray) capabilities),
            requiredString(json, "pairingId", "Pairing offer"),
            requiredPositiveSafeLong(json, "issuedAt", "Pairing offer")
        );
    }

    static Confirmation confirmationFromJson(JSONObject json) throws Exception {
        assertExactKeys(json, Arrays.asList("app", "protocolVersion", "type", "pairingId", "issuedAt", "deviceId", "pairingCode"), "Pairing confirmation");
        assertEnvelope(json, TYPE_CONFIRM, "Pairing confirmation");
        return createConfirmation(
            requiredString(json, "pairingId", "Pairing confirmation"),
            requiredPositiveSafeLong(json, "issuedAt", "Pairing confirmation"),
            requiredString(json, "deviceId", "Pairing confirmation"),
            requiredString(json, "pairingCode", "Pairing confirmation")
        );
    }

    static Cancellation cancellationFromJson(JSONObject json) throws Exception {
        assertExactKeys(json, Arrays.asList("app", "protocolVersion", "type", "pairingId", "issuedAt", "deviceId", "reason"), "Pairing cancellation");
        assertEnvelope(json, TYPE_CANCEL, "Pairing cancellation");
        return createCancellation(
            requiredString(json, "pairingId", "Pairing cancellation"),
            requiredPositiveSafeLong(json, "issuedAt", "Pairing cancellation"),
            requiredString(json, "deviceId", "Pairing cancellation"),
            requiredString(json, "reason", "Pairing cancellation")
        );
    }

    static String offerSigningPayload(Offer offer) throws Exception {
        if (offer == null) {
            throw new IllegalArgumentException("Pairing offer is required");
        }
        return ProtocolV2.canonicalJson(offer.toJson());
    }

    static String confirmationSigningPayload(Confirmation confirmation) throws Exception {
        if (confirmation == null) {
            throw new IllegalArgumentException("Pairing confirmation is required");
        }
        return ProtocolV2.canonicalJson(confirmation.toJson());
    }

    static String cancellationSigningPayload(Cancellation cancellation) throws Exception {
        if (cancellation == null) {
            throw new IllegalArgumentException("Pairing cancellation is required");
        }
        return ProtocolV2.canonicalJson(cancellation.toJson());
    }

    static String signOffer(Offer offer, String signingPrivateKey) throws Exception {
        return CryptoUtil.sign(offerSigningPayload(offer), signingPrivateKey);
    }

    static String signConfirmation(Confirmation confirmation, String signingPrivateKey) throws Exception {
        return CryptoUtil.sign(confirmationSigningPayload(confirmation), signingPrivateKey);
    }

    static String signCancellation(Cancellation cancellation, String signingPrivateKey) throws Exception {
        return CryptoUtil.sign(cancellationSigningPayload(cancellation), signingPrivateKey);
    }

    static boolean verifyOffer(Offer offer, String signature) {
        return offer != null && isValidSignature(signature)
            && CryptoUtil.verify(quietOfferPayload(offer), signature, offer.identity.signingPublicKey);
    }

    static boolean verifyConfirmation(Confirmation confirmation, String signature, V2Identity signer) {
        return confirmation != null && signer != null && isValidSignature(signature)
            && CryptoUtil.verify(quietConfirmationPayload(confirmation), signature, signer.signingPublicKey);
    }

    static boolean verifyCancellation(Cancellation cancellation, String signature, V2Identity signer) {
        return cancellation != null && signer != null && isValidSignature(signature)
            && CryptoUtil.verify(quietCancellationPayload(cancellation), signature, signer.signingPublicKey);
    }

    static boolean isFresh(long issuedAt, long nowEpochMillis) {
        return issuedAt > 0 && issuedAt <= nowEpochMillis + MAX_CLOCK_SKEW_MS
            && nowEpochMillis - issuedAt <= PAIRING_SESSION_TTL_MS;
    }

    static String derivePairingCode(String pairingId, V2Identity initiator, V2Identity responder) throws Exception {
        if (initiator == null || responder == null) {
            throw new IllegalArgumentException("Pairing identities are required");
        }
        return ProtocolV2.derivePairingCode(pairingId, initiator.toJson(), responder.toJson());
    }

    static String createPairingId() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static boolean isValidSignature(String signature) {
        return signature != null && !signature.isEmpty() && signature.length() <= MAX_SIGNATURE_LENGTH;
    }

    private static String quietOfferPayload(Offer offer) {
        try {
            return offerSigningPayload(offer);
        } catch (Exception error) {
            return "";
        }
    }

    private static String quietConfirmationPayload(Confirmation confirmation) {
        try {
            return confirmationSigningPayload(confirmation);
        } catch (Exception error) {
            return "";
        }
    }

    private static String quietCancellationPayload(Cancellation cancellation) {
        try {
            return cancellationSigningPayload(cancellation);
        } catch (Exception error) {
            return "";
        }
    }

    private static JSONObject envelope(String type) throws Exception {
        JSONObject json = new JSONObject();
        json.put("app", ProtocolV2.APP_ID);
        json.put("protocolVersion", ProtocolV2.VERSION);
        json.put("type", type);
        return json;
    }

    private static void assertEnvelope(JSONObject json, String expectedType, String label) {
        Object app = json.opt("app");
        Object version = json.opt("protocolVersion");
        Object type = json.opt("type");
        if (!(app instanceof String) || !ProtocolV2.APP_ID.equals(app)
            || !isExactInteger(version) || ((Number) version).longValue() != ProtocolV2.VERSION
            || !(type instanceof String) || !expectedType.equals(type)) {
            throw new IllegalArgumentException(label + " has an unsupported protocol envelope");
        }
    }

    private static List<String> capabilitiesFromJson(JSONArray values) {
        List<String> capabilities = new ArrayList<>(values.length());
        for (int index = 0; index < values.length(); index += 1) {
            Object value = values.opt(index);
            if (!(value instanceof String)) {
                throw new IllegalArgumentException("Pairing capability is invalid");
            }
            capabilities.add((String) value);
        }
        return capabilities;
    }

    private static List<String> normalizeCapabilities(List<String> capabilities) {
        if (capabilities == null || capabilities.size() > 16) {
            throw new IllegalArgumentException("Capabilities must be a bounded array");
        }
        List<String> normalized = new ArrayList<>(capabilities.size());
        for (String capability : capabilities) {
            if (capability == null || capability.isEmpty() || capability.length() > 64 || !CAPABILITY.matcher(capability).matches()) {
                throw new IllegalArgumentException("Capability is invalid");
            }
            normalized.add(capability);
        }
        if (new HashSet<>(normalized).size() != normalized.size()) {
            throw new IllegalArgumentException("Capabilities must not contain duplicates");
        }
        Collections.sort(normalized);
        return Collections.unmodifiableList(normalized);
    }

    private static void assertPairingId(String pairingId) {
        if (pairingId == null || !PAIRING_ID.matcher(pairingId).matches()) {
            throw new IllegalArgumentException("Pairing ID must be a 16-byte base64url value");
        }
    }

    private static void assertDeviceId(String deviceId, String label) {
        if (deviceId == null || !DEVICE_ID.matcher(deviceId).matches()) {
            throw new IllegalArgumentException(label + " is invalid");
        }
    }

    private static void assertPositiveSafeInteger(long value, String label) {
        if (value <= 0 || value > 9_007_199_254_740_991L) {
            throw new IllegalArgumentException(label + " must be a positive safe integer");
        }
    }

    private static long requiredPositiveSafeLong(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!isExactInteger(value)) {
            throw new IllegalArgumentException(label + " field " + key + " must be an integer");
        }
        long result = ((Number) value).longValue();
        assertPositiveSafeInteger(result, label + " issue time");
        return result;
    }

    private static String requiredString(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException(label + " field " + key + " must be a string");
        }
        return (String) value;
    }

    private static void assertExactKeys(JSONObject json, List<String> expected, String label) {
        if (json == null) {
            throw new IllegalArgumentException(label + " is required");
        }
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(new HashSet<>(expected))) {
            throw new IllegalArgumentException(label + " contains missing or unknown fields");
        }
    }

    private static boolean isExactInteger(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }
}
