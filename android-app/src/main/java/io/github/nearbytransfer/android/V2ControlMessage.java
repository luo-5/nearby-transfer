package io.github.nearbytransfer.android;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/** Canonical, bounded wire payloads for protocol v2 pairing-control frames. */
final class V2ControlMessage {
    static final int MAX_CONTROL_PAYLOAD_BYTES = 12 * 1024;

    static final class Message {
        final String type;
        final V2Pairing.Offer offer;
        final V2Pairing.Confirmation confirmation;
        final V2Pairing.Cancellation cancellation;
        final String signature;

        private Message(String type, V2Pairing.Offer offer, V2Pairing.Confirmation confirmation, V2Pairing.Cancellation cancellation, String signature) {
            this.type = type;
            this.offer = offer;
            this.confirmation = confirmation;
            this.cancellation = cancellation;
            this.signature = signature;
        }
    }

    private V2ControlMessage() {}

    static byte[] encodeOffer(V2Pairing.Offer offer, String signature) throws Exception {
        return encode(new Message(V2Pairing.TYPE_OFFER, offer, null, null, signature));
    }

    static byte[] encodeConfirmation(V2Pairing.Confirmation confirmation, String signature) throws Exception {
        return encode(new Message(V2Pairing.TYPE_CONFIRM, null, confirmation, null, signature));
    }

    static byte[] encodeCancellation(V2Pairing.Cancellation cancellation, String signature) throws Exception {
        return encode(new Message(V2Pairing.TYPE_CANCEL, null, null, cancellation, signature));
    }

    static byte[] encode(Message message) throws Exception {
        JSONObject json = toJson(validate(message));
        byte[] encoded = ProtocolV2.canonicalJson(json).getBytes(StandardCharsets.UTF_8);
        if (encoded.length > MAX_CONTROL_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("Control payload exceeds the accepted limit");
        }
        return encoded;
    }

    static Message decode(String type, byte[] payload) throws Exception {
        assertType(type);
        if (payload == null || payload.length == 0 || payload.length > MAX_CONTROL_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("Control payload exceeds the accepted bounds");
        }
        Object decoded = ProtocolV2.parseCanonicalJson(payload, "Control payload");
        if (!(decoded instanceof JSONObject)) {
            throw new IllegalArgumentException("Control payload must be a JSON object");
        }
        JSONObject json = (JSONObject) decoded;
        switch (type) {
            case V2Pairing.TYPE_OFFER:
                assertExactKeys(json, Arrays.asList("offer", "signature"), "Pairing offer message");
                Object offer = json.opt("offer");
                return validate(new Message(type, requireOffer(offer), null, null, requireSignature(json.opt("signature"))));
            case V2Pairing.TYPE_CONFIRM:
                assertExactKeys(json, Arrays.asList("confirmation", "signature"), "Pairing confirmation message");
                Object confirmation = json.opt("confirmation");
                return validate(new Message(type, null, requireConfirmation(confirmation), null, requireSignature(json.opt("signature"))));
            case V2Pairing.TYPE_CANCEL:
                assertExactKeys(json, Arrays.asList("cancellation", "signature"), "Pairing cancellation message");
                Object cancellation = json.opt("cancellation");
                return validate(new Message(type, null, null, requireCancellation(cancellation), requireSignature(json.opt("signature"))));
            default:
                throw new IllegalArgumentException("Unsupported control message type");
        }
    }

    private static Message validate(Message message) {
        if (message == null) {
            throw new IllegalArgumentException("Control message is required");
        }
        assertType(message.type);
        if (!V2Pairing.isValidSignature(message.signature)) {
            throw new IllegalArgumentException("Control message signature is invalid");
        }
        switch (message.type) {
            case V2Pairing.TYPE_OFFER:
                if (message.offer == null || message.confirmation != null || message.cancellation != null) {
                    throw new IllegalArgumentException("Pairing offer message is invalid");
                }
                return message;
            case V2Pairing.TYPE_CONFIRM:
                if (message.offer != null || message.confirmation == null || message.cancellation != null) {
                    throw new IllegalArgumentException("Pairing confirmation message is invalid");
                }
                return message;
            case V2Pairing.TYPE_CANCEL:
                if (message.offer != null || message.confirmation != null || message.cancellation == null) {
                    throw new IllegalArgumentException("Pairing cancellation message is invalid");
                }
                return message;
            default:
                throw new IllegalArgumentException("Unsupported control message type");
        }
    }

    private static JSONObject toJson(Message message) throws Exception {
        JSONObject json = new JSONObject();
        switch (message.type) {
            case V2Pairing.TYPE_OFFER:
                json.put("offer", message.offer.toJson());
                break;
            case V2Pairing.TYPE_CONFIRM:
                json.put("confirmation", message.confirmation.toJson());
                break;
            case V2Pairing.TYPE_CANCEL:
                json.put("cancellation", message.cancellation.toJson());
                break;
            default:
                throw new IllegalArgumentException("Unsupported control message type");
        }
        json.put("signature", message.signature);
        return json;
    }

    private static V2Pairing.Offer requireOffer(Object value) throws Exception {
        if (!(value instanceof JSONObject)) {
            throw new IllegalArgumentException("Pairing offer message offer must be an object");
        }
        return V2Pairing.offerFromJson((JSONObject) value);
    }

    private static V2Pairing.Confirmation requireConfirmation(Object value) throws Exception {
        if (!(value instanceof JSONObject)) {
            throw new IllegalArgumentException("Pairing confirmation message confirmation must be an object");
        }
        return V2Pairing.confirmationFromJson((JSONObject) value);
    }

    private static V2Pairing.Cancellation requireCancellation(Object value) throws Exception {
        if (!(value instanceof JSONObject)) {
            throw new IllegalArgumentException("Pairing cancellation message cancellation must be an object");
        }
        return V2Pairing.cancellationFromJson((JSONObject) value);
    }

    private static String requireSignature(Object value) {
        if (!(value instanceof String) || !V2Pairing.isValidSignature((String) value)) {
            throw new IllegalArgumentException("Control message signature is invalid");
        }
        return (String) value;
    }

    private static void assertType(String type) {
        if (!V2Pairing.TYPE_OFFER.equals(type) && !V2Pairing.TYPE_CONFIRM.equals(type) && !V2Pairing.TYPE_CANCEL.equals(type)) {
            throw new IllegalArgumentException("Unsupported control message type");
        }
    }

    private static void assertExactKeys(JSONObject json, List<String> expected, String label) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(new HashSet<>(expected))) {
            throw new IllegalArgumentException(label + " contains missing or unknown fields");
        }
    }
}
