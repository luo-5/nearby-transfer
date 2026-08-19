package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Strict canonical-JSON models for protocol-v2 file-transfer control messages. */
final class V2TransferMessage {
    static final String TYPE_MANIFEST = "transfer-manifest";
    static final String TYPE_DECISION = "transfer-decision";
    static final String TYPE_COMPLETE = "transfer-complete";
    static final int MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
    static final long MAX_MESSAGE_TTL_MS = 5 * 60 * 1000L;
    static final long MAX_CLOCK_SKEW_MS = 30 * 1000L;

    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final String SIGNATURE_PLACEHOLDER = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(new byte[64]);
    private static final long MAX_FILE_SIZE_BYTES = 1_099_511_627_776L;
    private static final long MAX_TOTAL_SIZE_BYTES = 4_398_046_511_104L;
    private static final int MAX_MANIFEST_ENTRIES = 10_000;
    private static final int MAX_TRANSFER_FILES = 8_192;
    private static final int MAX_RELATIVE_PATH_BYTES = 4_096;
    private static final int MAX_PATH_COMPONENT_BYTES = 255;

    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern TASK_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern WINDOWS_RESERVED = Pattern.compile(
        "^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
    );
    private static final Set<String> DECISIONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "accepted", "rejected", "busy", "unauthorized", "invalid-manifest", "expired", "unsupported"
    )));
    private static final Set<String> COMPLETION_DIAGNOSTICS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "success", "hash-mismatch", "size-mismatch", "sequence-mismatch", "cancelled", "io-error", "protocol-error"
    )));

    private V2TransferMessage() {}

    abstract static class Message {
        final String type;
        final long issuedAt;
        final long expiresAt;
        final String signature;

        Message(String type, long issuedAt, long expiresAt, String signature) {
            this.type = type;
            this.issuedAt = issuedAt;
            this.expiresAt = expiresAt;
            this.signature = signature;
        }

        abstract JSONObject toJson() throws Exception;
    }

    static final class ManifestEnvelope extends Message {
        final JSONObject manifest;
        final String senderDeviceId;
        final String receiverDeviceId;
        final String senderEphemeralPublicKey;

        ManifestEnvelope(JSONObject manifest, String senderDeviceId, String receiverDeviceId,
                         String senderEphemeralPublicKey, long issuedAt, long expiresAt, String signature) {
            super(TYPE_MANIFEST, issuedAt, expiresAt, signature);
            this.manifest = manifest;
            this.senderDeviceId = senderDeviceId;
            this.receiverDeviceId = receiverDeviceId;
            this.senderEphemeralPublicKey = senderEphemeralPublicKey;
        }

        @Override JSONObject toJson() throws Exception {
            JSONObject json = baseEnvelope(type);
            json.put("manifest", manifest);
            json.put("senderDeviceId", senderDeviceId);
            json.put("receiverDeviceId", receiverDeviceId);
            json.put("senderEphemeralPublicKey", senderEphemeralPublicKey);
            json.put("issuedAt", issuedAt);
            json.put("expiresAt", expiresAt);
            json.put("signature", signature);
            return json;
        }
    }

    static final class Decision extends Message {
        final String taskId;
        final String senderDeviceId;
        final String receiverDeviceId;
        final String decision;

        Decision(String taskId, String senderDeviceId, String receiverDeviceId, String decision,
                 long issuedAt, long expiresAt, String signature) {
            super(TYPE_DECISION, issuedAt, expiresAt, signature);
            this.taskId = taskId;
            this.senderDeviceId = senderDeviceId;
            this.receiverDeviceId = receiverDeviceId;
            this.decision = decision;
        }

        @Override JSONObject toJson() throws Exception {
            JSONObject json = baseEnvelope(type);
            json.put("taskId", taskId);
            json.put("senderDeviceId", senderDeviceId);
            json.put("receiverDeviceId", receiverDeviceId);
            json.put("decision", decision);
            json.put("issuedAt", issuedAt);
            json.put("expiresAt", expiresAt);
            json.put("signature", signature);
            return json;
        }
    }

    static final class Complete extends Message {
        final String taskId;
        final String senderDeviceId;
        final String receiverDeviceId;
        final String status;
        final String diagnostic;
        final String sha256;
        final long bytes;
        final long sequence;

        Complete(String taskId, String senderDeviceId, String receiverDeviceId, String status,
                 String diagnostic, String sha256, long bytes, long sequence,
                 long issuedAt, long expiresAt, String signature) {
            super(TYPE_COMPLETE, issuedAt, expiresAt, signature);
            this.taskId = taskId;
            this.senderDeviceId = senderDeviceId;
            this.receiverDeviceId = receiverDeviceId;
            this.status = status;
            this.diagnostic = diagnostic;
            this.sha256 = sha256;
            this.bytes = bytes;
            this.sequence = sequence;
        }

        @Override JSONObject toJson() throws Exception {
            JSONObject json = baseEnvelope(type);
            json.put("taskId", taskId);
            json.put("senderDeviceId", senderDeviceId);
            json.put("receiverDeviceId", receiverDeviceId);
            json.put("status", status);
            json.put("diagnostic", diagnostic);
            json.put("sha256", sha256 == null ? JSONObject.NULL : sha256);
            json.put("bytes", bytes);
            json.put("sequence", sequence);
            json.put("issuedAt", issuedAt);
            json.put("expiresAt", expiresAt);
            json.put("signature", signature);
            return json;
        }
    }

    static byte[] encode(Message message, long nowEpochMillis) throws Exception {
        if (message == null) throw new IllegalArgumentException("Transfer message is required");
        Message normalized = fromJson(message.type, message.toJson(), nowEpochMillis);
        byte[] encoded = ProtocolV2.canonicalJson(normalized.toJson()).getBytes(StandardCharsets.UTF_8);
        assertPayloadBounds(encoded);
        return encoded;
    }

    static Message decode(String type, byte[] payload, long nowEpochMillis) throws Exception {
        assertType(type);
        assertPayloadBounds(payload);
        Object parsed = ProtocolV2.parseCanonicalJson(payload, "Transfer message payload");
        if (!(parsed instanceof JSONObject)) {
            throw new IllegalArgumentException("Transfer message payload must be an object");
        }
        Message normalized = fromJson(type, (JSONObject) parsed, nowEpochMillis);
        String normalizedCanonical = ProtocolV2.canonicalJson(normalized.toJson());
        String receivedCanonical = new String(payload, StandardCharsets.UTF_8);
        if (!normalizedCanonical.equals(receivedCanonical)) {
            throw new IllegalArgumentException("Transfer message payload is not in normalized canonical form");
        }
        return normalized;
    }

    static String signingPayload(String type, JSONObject json) throws Exception {
        assertType(type);
        if (json == null) throw new IllegalArgumentException("Transfer message is required");

        JSONObject candidate = new JSONObject();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            candidate.put(key, json.opt(key));
        }
        if (!candidate.has("signature")) {
            candidate.put("signature", SIGNATURE_PLACEHOLDER);
        }

        Object issuedAtValue = candidate.opt("issuedAt");
        if (!isExactInteger(issuedAtValue)) {
            throw new IllegalArgumentException("Transfer message issuedAt must be an integer");
        }
        long issuedAt = ((Number) issuedAtValue).longValue();
        assertPositiveSafeInteger(issuedAt, "Transfer message issuedAt");

        // Exclude signature bytes and use issuedAt as the validation clock so
        // the signed payload stays stable after the message expires.
        Message normalized = fromJson(type, candidate, issuedAt);
        JSONObject unsigned = normalized.toJson();
        unsigned.remove("signature");
        return ProtocolV2.canonicalJson(unsigned);
    }

    static Message fromJson(String type, JSONObject json, long nowEpochMillis) throws Exception {
        assertType(type);
        assertPositiveSafeInteger(nowEpochMillis, "Transfer message validation time");
        if (json == null) throw new IllegalArgumentException("Transfer message is required");
        switch (type) {
            case TYPE_MANIFEST:
                return manifestFromJson(json, nowEpochMillis);
            case TYPE_DECISION:
                return decisionFromJson(json, nowEpochMillis);
            case TYPE_COMPLETE:
                return completeFromJson(json, nowEpochMillis);
            default:
                throw new IllegalArgumentException("Unsupported transfer message type");
        }
    }

    private static ManifestEnvelope manifestFromJson(JSONObject json, long now) throws Exception {
        assertExactKeys(json, Arrays.asList(
            "app", "protocolVersion", "type", "manifest", "senderDeviceId", "receiverDeviceId",
            "senderEphemeralPublicKey", "issuedAt", "expiresAt", "signature"
        ), "Transfer manifest envelope");
        assertProtocolEnvelope(json, TYPE_MANIFEST, "Transfer manifest envelope");
        Object manifestValue = json.opt("manifest");
        if (!(manifestValue instanceof JSONObject)) {
            throw new IllegalArgumentException("Transfer manifest envelope manifest must be an object");
        }
        JSONObject manifest = normalizeManifest((JSONObject) manifestValue);
        String sender = requiredString(json, "senderDeviceId", "Transfer manifest envelope");
        String receiver = requiredString(json, "receiverDeviceId", "Transfer manifest envelope");
        assertRoute(sender, receiver);
        String key = requiredString(json, "senderEphemeralPublicKey", "Transfer manifest envelope");
        assertCanonicalBase64Url(key, 32, "Sender ephemeral public key");
        long issuedAt = requiredPositiveSafeLong(json, "issuedAt", "Transfer manifest envelope");
        long expiresAt = requiredPositiveSafeLong(json, "expiresAt", "Transfer manifest envelope");
        assertTimeWindow(issuedAt, expiresAt, now);
        String signature = requiredString(json, "signature", "Transfer manifest envelope");
        assertCanonicalBase64Url(signature, 64, "Transfer message signature");
        return new ManifestEnvelope(manifest, sender, receiver, key, issuedAt, expiresAt, signature);
    }

    private static Decision decisionFromJson(JSONObject json, long now) throws Exception {
        assertExactKeys(json, Arrays.asList(
            "app", "protocolVersion", "type", "taskId", "senderDeviceId", "receiverDeviceId",
            "decision", "issuedAt", "expiresAt", "signature"
        ), "Transfer decision");
        assertProtocolEnvelope(json, TYPE_DECISION, "Transfer decision");
        String taskId = requiredString(json, "taskId", "Transfer decision");
        assertTaskId(taskId);
        String sender = requiredString(json, "senderDeviceId", "Transfer decision");
        String receiver = requiredString(json, "receiverDeviceId", "Transfer decision");
        assertRoute(sender, receiver);
        String decision = requiredString(json, "decision", "Transfer decision");
        if (!DECISIONS.contains(decision)) {
            throw new IllegalArgumentException("Transfer decision diagnostic is unsupported");
        }
        long issuedAt = requiredPositiveSafeLong(json, "issuedAt", "Transfer decision");
        long expiresAt = requiredPositiveSafeLong(json, "expiresAt", "Transfer decision");
        assertTimeWindow(issuedAt, expiresAt, now);
        String signature = requiredString(json, "signature", "Transfer decision");
        assertCanonicalBase64Url(signature, 64, "Transfer message signature");
        return new Decision(taskId, sender, receiver, decision, issuedAt, expiresAt, signature);
    }

    private static Complete completeFromJson(JSONObject json, long now) throws Exception {
        assertExactKeys(json, Arrays.asList(
            "app", "protocolVersion", "type", "taskId", "senderDeviceId", "receiverDeviceId",
            "status", "diagnostic", "sha256", "bytes", "sequence", "issuedAt", "expiresAt", "signature"
        ), "Transfer completion");
        assertProtocolEnvelope(json, TYPE_COMPLETE, "Transfer completion");
        String taskId = requiredString(json, "taskId", "Transfer completion");
        assertTaskId(taskId);
        String sender = requiredString(json, "senderDeviceId", "Transfer completion");
        String receiver = requiredString(json, "receiverDeviceId", "Transfer completion");
        assertRoute(sender, receiver);
        String status = requiredString(json, "status", "Transfer completion");
        if (!"success".equals(status) && !"failed".equals(status)) {
            throw new IllegalArgumentException("Transfer completion status must be success or failed");
        }
        String diagnostic = requiredString(json, "diagnostic", "Transfer completion");
        if (!COMPLETION_DIAGNOSTICS.contains(diagnostic)) {
            throw new IllegalArgumentException("Transfer completion diagnostic is unsupported");
        }
        Object hashValue = json.opt("sha256");
        String sha256 = hashValue == JSONObject.NULL ? null : requireStringValue(hashValue, "Transfer completion SHA-256");
        if ("success".equals(status)) {
            if (!"success".equals(diagnostic)) {
                throw new IllegalArgumentException("Successful transfer completion must use the success diagnostic");
            }
            assertSha256(sha256);
        } else {
            if ("success".equals(diagnostic)) {
                throw new IllegalArgumentException("Failed transfer completion must use a failure diagnostic");
            }
            if (sha256 != null) {
                throw new IllegalArgumentException("Failed transfer completion must not claim a verified SHA-256");
            }
        }
        long bytes = requiredNonNegativeSafeLong(json, "bytes", "Transfer completion byte count");
        long sequence = requiredNonNegativeSafeLong(json, "sequence", "Transfer completion sequence");
        long issuedAt = requiredPositiveSafeLong(json, "issuedAt", "Transfer completion");
        long expiresAt = requiredPositiveSafeLong(json, "expiresAt", "Transfer completion");
        assertTimeWindow(issuedAt, expiresAt, now);
        String signature = requiredString(json, "signature", "Transfer completion");
        assertCanonicalBase64Url(signature, 64, "Transfer message signature");
        return new Complete(taskId, sender, receiver, status, diagnostic, sha256, bytes, sequence, issuedAt, expiresAt, signature);
    }

    private static JSONObject normalizeManifest(JSONObject manifest) throws Exception {
        assertAllowedKeys(manifest, Arrays.asList(
            "app", "protocolVersion", "type", "taskId", "conflictStrategy", "entries", "totalFiles", "totalBytes"
        ), "Transfer manifest");
        assertProtocolEnvelope(manifest, TYPE_MANIFEST, "Transfer manifest");
        String taskId = requiredString(manifest, "taskId", "Transfer manifest");
        assertTaskId(taskId);
        if (!"auto-rename".equals(requiredString(manifest, "conflictStrategy", "Transfer manifest"))) {
            throw new IllegalArgumentException("Transfer manifest conflict strategy must be auto-rename");
        }
        Object entriesValue = manifest.opt("entries");
        if (!(entriesValue instanceof JSONArray)) {
            throw new IllegalArgumentException("Transfer manifest entries must be an array");
        }
        JSONArray entries = (JSONArray) entriesValue;
        if (entries.length() == 0 || entries.length() > MAX_MANIFEST_ENTRIES) {
            throw new IllegalArgumentException("Transfer manifest must contain a bounded non-empty entry list");
        }

        List<JSONObject> normalizedEntries = new ArrayList<>(entries.length());
        Set<String> seenPaths = new HashSet<>();
        Set<String> seenWindowsPaths = new HashSet<>();
        Set<String> directories = new HashSet<>();
        List<String> filePaths = new ArrayList<>();
        long totalBytes = 0;
        int totalFiles = 0;

        for (int index = 0; index < entries.length(); index += 1) {
            Object entryValue = entries.opt(index);
            if (!(entryValue instanceof JSONObject)) {
                throw new IllegalArgumentException("Transfer manifest entry must be an object");
            }
            JSONObject entry = normalizeManifestEntry((JSONObject) entryValue);
            String path = entry.getString("path");
            String windowsPath = windowsComparisonPath(path);
            if (!seenPaths.add(path) || !seenWindowsPaths.add(windowsPath)) {
                throw new IllegalArgumentException("Transfer manifest contains duplicate or Windows-colliding paths");
            }
            if ("directory".equals(entry.getString("kind"))) {
                directories.add(path);
            } else {
                totalFiles += 1;
                if (totalFiles > MAX_TRANSFER_FILES) {
                    throw new IllegalArgumentException("Transfer manifest exceeds the maximum file count");
                }
                filePaths.add(path);
                totalBytes = checkedAdd(totalBytes, entry.getLong("size"), "Transfer manifest total size");
                if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
                    throw new IllegalArgumentException("Transfer manifest exceeds the maximum total size");
                }
            }
            normalizedEntries.add(entry);
        }

        for (String directory : directories) assertParentsDeclared(directory, directories, "Transfer directory parent is not declared: ");
        for (String file : filePaths) assertParentsDeclared(file, directories, "Transfer file parent directory is not declared: ");
        normalizedEntries.sort((left, right) -> left.optString("path").compareTo(right.optString("path")));

        if (manifest.has("totalFiles") && requiredNonNegativeSafeLong(manifest, "totalFiles", "Transfer manifest totalFiles") != totalFiles) {
            throw new IllegalArgumentException("Transfer manifest totalFiles does not match its file entries");
        }
        if (manifest.has("totalBytes") && requiredNonNegativeSafeLong(manifest, "totalBytes", "Transfer manifest totalBytes") != totalBytes) {
            throw new IllegalArgumentException("Transfer manifest totalBytes does not match its file entries");
        }

        JSONArray normalizedArray = new JSONArray();
        for (JSONObject entry : normalizedEntries) normalizedArray.put(entry);
        JSONObject normalized = baseEnvelope(TYPE_MANIFEST);
        normalized.put("taskId", taskId);
        normalized.put("conflictStrategy", "auto-rename");
        normalized.put("entries", normalizedArray);
        normalized.put("totalFiles", totalFiles);
        normalized.put("totalBytes", totalBytes);
        return normalized;
    }

    private static JSONObject normalizeManifestEntry(JSONObject entry) throws Exception {
        String kind = requiredString(entry, "kind", "Transfer manifest entry");
        String path = requiredString(entry, "path", "Transfer manifest entry");
        assertRelativePath(path);
        JSONObject normalized = new JSONObject();
        if ("directory".equals(kind)) {
            assertExactKeys(entry, Arrays.asList("kind", "path"), "Transfer directory entry");
            normalized.put("kind", "directory");
            normalized.put("path", path);
            return normalized;
        }
        if ("file".equals(kind)) {
            assertExactKeys(entry, Arrays.asList("kind", "path", "size", "sha256"), "Transfer file entry");
            long size = requiredNonNegativeSafeLong(entry, "size", "Transfer file size");
            if (size > MAX_FILE_SIZE_BYTES) {
                throw new IllegalArgumentException("Transfer file size exceeds the configured maximum");
            }
            String sha256 = requiredString(entry, "sha256", "Transfer file entry");
            assertSha256(sha256);
            normalized.put("kind", "file");
            normalized.put("path", path);
            normalized.put("size", size);
            normalized.put("sha256", sha256);
            return normalized;
        }
        throw new IllegalArgumentException("Transfer manifest entry kind must be file or directory");
    }

    private static void assertRelativePath(String path) {
        if (path.isEmpty()) throw new IllegalArgumentException("Transfer path must be non-empty");
        assertWellFormedString(path, "Transfer path");
        if (path.getBytes(StandardCharsets.UTF_8).length > MAX_RELATIVE_PATH_BYTES) {
            throw new IllegalArgumentException("Transfer path exceeds the maximum UTF-8 length");
        }
        if (path.startsWith("/") || path.startsWith("\\") || path.indexOf('\\') >= 0 ||
            (path.length() >= 2 && Character.isLetter(path.charAt(0)) && path.charAt(1) == ':')) {
            throw new IllegalArgumentException("Transfer path must use a relative POSIX path");
        }
        for (String component : path.split("/", -1)) {
            if (component.isEmpty() || ".".equals(component) || "..".equals(component)) {
                throw new IllegalArgumentException("Transfer path must not contain empty or traversal components");
            }
            if (component.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_COMPONENT_BYTES) {
                throw new IllegalArgumentException("Transfer path component exceeds the maximum UTF-8 length");
            }
            for (int index = 0; index < component.length(); index += 1) {
                char character = component.charAt(index);
                if (character <= 0x1f || character == 0x7f || "<>:\"/\\|?*".indexOf(character) >= 0) {
                    throw new IllegalArgumentException("Transfer path component contains a Windows-invalid character");
                }
            }
            if (component.endsWith(".") || component.endsWith(" ")) {
                throw new IllegalArgumentException("Transfer path component must not end in a period or space");
            }
            String baseName = component.split("\\.", 2)[0].replaceAll("[. ]+$", "");
            if (WINDOWS_RESERVED.matcher(baseName).matches()) {
                throw new IllegalArgumentException("Transfer path component uses a Windows reserved device name");
            }
        }
    }

    private static void assertParentsDeclared(String path, Set<String> directories, String prefix) {
        int slash = path.indexOf('/');
        while (slash >= 0) {
            String parent = path.substring(0, slash);
            if (!directories.contains(parent)) throw new IllegalArgumentException(prefix + parent);
            slash = path.indexOf('/', slash + 1);
        }
    }

    private static String windowsComparisonPath(String path) {
        String[] components = path.split("/", -1);
        for (int index = 0; index < components.length; index += 1) {
            components[index] = components[index].toUpperCase(Locale.ROOT);
        }
        return String.join("/", components);
    }

    private static void assertTimeWindow(long issuedAt, long expiresAt, long now) {
        if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_MS) {
            throw new IllegalArgumentException("Transfer message expiration window is invalid");
        }
        if (issuedAt > now && issuedAt - now > MAX_CLOCK_SKEW_MS) {
            throw new IllegalArgumentException("Transfer message issue time is too far in the future");
        }
        if (expiresAt < now) {
            throw new IllegalArgumentException("Transfer message has expired");
        }
    }

    private static void assertRoute(String sender, String receiver) {
        assertDeviceId(sender, "Sender device ID");
        assertDeviceId(receiver, "Receiver device ID");
        if (sender.equals(receiver)) throw new IllegalArgumentException("Transfer message sender and receiver must differ");
    }

    private static void assertDeviceId(String value, String label) {
        if (!DEVICE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must be 16 lowercase hexadecimal characters");
        }
    }

    private static void assertTaskId(String value) {
        if (!TASK_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Transfer task ID must be a 16-byte base64url value");
        }
        assertCanonicalBase64Url(value, 16, "Transfer task ID");
    }

    private static void assertSha256(String value) {
        if (value == null || !SHA256.matcher(value).matches()) {
            throw new IllegalArgumentException("Transfer SHA-256 must be 64 lowercase hexadecimal characters");
        }
    }

    private static void assertCanonicalBase64Url(String value, int expectedBytes, String label) {
        if (value == null || !BASE64URL.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must use unpadded base64url");
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(value);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(label + " must be valid base64url", error);
        }
        String reencoded = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
        if (decoded.length != expectedBytes || !reencoded.equals(value)) {
            throw new IllegalArgumentException(label + " must be canonical base64url for " + expectedBytes + " bytes");
        }
    }

    private static JSONObject baseEnvelope(String type) throws Exception {
        JSONObject json = new JSONObject();
        json.put("app", ProtocolV2.APP_ID);
        json.put("protocolVersion", ProtocolV2.VERSION);
        json.put("type", type);
        return json;
    }

    private static void assertProtocolEnvelope(JSONObject json, String expectedType, String label) {
        Object app = json.opt("app");
        Object version = json.opt("protocolVersion");
        Object type = json.opt("type");
        if (!(app instanceof String) || !ProtocolV2.APP_ID.equals(app)
            || !isExactInteger(version) || ((Number) version).longValue() != ProtocolV2.VERSION
            || !(type instanceof String) || !expectedType.equals(type)) {
            throw new IllegalArgumentException(label + " protocol envelope is invalid");
        }
    }

    private static String requiredString(JSONObject json, String key, String label) {
        return requireStringValue(json.opt(key), label + " field " + key);
    }

    private static String requireStringValue(Object value, String label) {
        if (!(value instanceof String)) throw new IllegalArgumentException(label + " must be a string");
        return (String) value;
    }

    private static long requiredPositiveSafeLong(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!isExactInteger(value)) throw new IllegalArgumentException(label + " field " + key + " must be an integer");
        long result = ((Number) value).longValue();
        assertPositiveSafeInteger(result, label + " field " + key);
        return result;
    }

    private static long requiredNonNegativeSafeLong(JSONObject json, String key, String label) {
        Object value = json.opt(key);
        if (!isExactInteger(value)) throw new IllegalArgumentException(label + " must be an integer");
        long result = ((Number) value).longValue();
        if (result < 0 || result > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(label + " must be a non-negative safe integer");
        }
        return result;
    }

    private static void assertPositiveSafeInteger(long value, String label) {
        if (value <= 0 || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(label + " must be a positive safe integer");
        }
    }

    private static long checkedAdd(long left, long right, String label) {
        if (right > MAX_SAFE_INTEGER - left) throw new IllegalArgumentException(label + " exceeds safe integer precision");
        return left + right;
    }

    private static boolean isExactInteger(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }

    private static void assertAllowedKeys(JSONObject json, List<String> allowed, String label) {
        if (json == null) throw new IllegalArgumentException(label + " is required");
        Set<String> allowedSet = new HashSet<>(allowed);
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!allowedSet.contains(key)) throw new IllegalArgumentException(label + " contains unknown field " + key);
        }
    }

    private static void assertExactKeys(JSONObject json, List<String> expected, String label) {
        assertAllowedKeys(json, expected, label);
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) actual.add(keys.next());
        if (!actual.equals(new HashSet<>(expected))) {
            throw new IllegalArgumentException(label + " contains missing or unknown fields");
        }
    }

    private static void assertPayloadBounds(byte[] payload) {
        if (payload == null || payload.length == 0 || payload.length > MAX_MESSAGE_BYTES) {
            throw new IllegalArgumentException("Transfer message payload exceeds the accepted bounds");
        }
    }

    private static void assertType(String type) {
        if (!TYPE_MANIFEST.equals(type) && !TYPE_DECISION.equals(type) && !TYPE_COMPLETE.equals(type)) {
            throw new IllegalArgumentException("Unsupported transfer message type");
        }
    }

    private static void assertWellFormedString(String value, String label) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException(label + " contains an unpaired surrogate");
                }
                index += 1;
            } else if (Character.isLowSurrogate(character)) {
                throw new IllegalArgumentException(label + " contains an unpaired surrogate");
            }
        }
    }
}
