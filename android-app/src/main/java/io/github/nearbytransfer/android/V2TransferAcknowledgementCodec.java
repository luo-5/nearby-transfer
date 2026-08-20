package io.github.nearbytransfer.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/** Produces session-bound, signed acknowledgements for durable receive checkpoints. */
final class V2TransferAcknowledgementCodec {
    static final long DEFAULT_TTL_MS = 30_000L;

    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final int SIGNATURE_BYTES = 64;
    private static final Pattern DEVICE_ID = Pattern.compile("^[a-f0-9]{16}$");
    private static final Pattern MANIFEST_HASH = Pattern.compile("^[a-f0-9]{64}$");

    interface Clock {
        long nowEpochMillis();
    }

    private final String taskId;
    private final String sessionId;
    private final String localReceiverDeviceId;
    private final String remoteSenderDeviceId;
    private final String manifestHash;
    private final List<FileMetadata> files;
    private final PrivateKey signingKey;
    private final Clock clock;
    private final long ttlMillis;

    private Checkpoint acknowledged;
    private long lastIssuedAt = -1L;

    V2TransferAcknowledgementCodec(
        String taskId,
        String sessionId,
        String localReceiverDeviceId,
        String remoteSenderDeviceId,
        String manifestHash,
        V2EncryptedChunkWriter.Manifest manifest,
        String localSigningPrivateKeyPem,
        Clock clock
    ) {
        this(
            taskId,
            sessionId,
            localReceiverDeviceId,
            remoteSenderDeviceId,
            manifestHash,
            manifest,
            localSigningPrivateKeyPem,
            clock,
            DEFAULT_TTL_MS
        );
    }

    V2TransferAcknowledgementCodec(
        String taskId,
        String sessionId,
        String localReceiverDeviceId,
        String remoteSenderDeviceId,
        String manifestHash,
        V2EncryptedChunkWriter.Manifest manifest,
        String localSigningPrivateKeyPem,
        Clock clock,
        long ttlMillis
    ) {
        requireCanonicalId(taskId, "Transfer task ID");
        requireCanonicalId(sessionId, "Transfer session ID");
        requireDeviceId(localReceiverDeviceId, "Local receiver device ID");
        requireDeviceId(remoteSenderDeviceId, "Remote sender device ID");
        if (localReceiverDeviceId.equals(remoteSenderDeviceId)) {
            throw new IllegalArgumentException("Transfer acknowledgement route must contain two devices");
        }
        if (manifestHash == null || !MANIFEST_HASH.matcher(manifestHash).matches()) {
            throw new IllegalArgumentException(
                "Transfer manifest hash must be 64 lowercase hexadecimal characters"
            );
        }
        if (manifest == null || !taskId.equals(manifest.taskId)) {
            throw new IllegalArgumentException("Transfer acknowledgement manifest does not match its task ID");
        }
        if (clock == null) throw new IllegalArgumentException("Transfer acknowledgement clock is required");
        if (ttlMillis <= 0 || ttlMillis > V2TransferMessage.MAX_MESSAGE_TTL_MS) {
            throw new IllegalArgumentException("Transfer acknowledgement TTL is outside the accepted range");
        }

        List<FileMetadata> metadata = new ArrayList<>(manifest.files.size());
        for (V2EncryptedChunkWriter.FileSpec file : manifest.files) {
            metadata.add(new FileMetadata(file.path, file.size));
        }

        this.taskId = taskId;
        this.sessionId = sessionId;
        this.localReceiverDeviceId = localReceiverDeviceId;
        this.remoteSenderDeviceId = remoteSenderDeviceId;
        this.manifestHash = manifestHash;
        this.files = Collections.unmodifiableList(metadata);
        this.signingKey = readSigningKey(localSigningPrivateKeyPem);
        this.clock = clock;
        this.ttlMillis = ttlMillis;
    }

    /** Creates the one full checkpoint frame sent immediately after an accepted decision. */
    synchronized V2WireFrame.Frame createResumeFrame(V2EncryptedChunkWriter.Progress durableProgress)
        throws Exception {
        if (acknowledged != null) {
            throw new IllegalStateException("Transfer resume acknowledgement was already created");
        }
        Checkpoint checkpoint = normalize(durableProgress);
        Timestamp timestamp = timestamp();
        JSONObject unsigned = base(V2TransferMessage.TYPE_RESUME, timestamp);
        JSONArray entries = new JSONArray();
        for (int index = 0; index < files.size(); index += 1) {
            FileMetadata file = files.get(index);
            FileState state = checkpoint.files.get(index);
            JSONObject entry = new JSONObject();
            entry.put("path", file.path);
            entry.put("size", file.size);
            entry.put("committedOffset", state.committedOffset);
            entry.put("completed", state.completed);
            entries.put(entry);
        }
        unsigned.put("files", entries);
        unsigned.put("nextSequence", checkpoint.nextSequence);
        unsigned.put("totalTransferred", checkpoint.totalTransferred);

        byte[] payload = signAndEncode(V2TransferMessage.TYPE_RESUME, unsigned, timestamp.issuedAt);
        acknowledged = checkpoint;
        lastIssuedAt = timestamp.issuedAt;
        return new V2WireFrame.Frame(header(V2TransferMessage.TYPE_RESUME), payload);
    }

    /**
     * Returns a canonical signed payload for the stream progress envelope.
     * Callers must invoke this only with the snapshot returned after the checkpoint commit succeeds.
     */
    synchronized byte[] encodeDurableProgress(V2EncryptedChunkWriter.Progress durableProgress)
        throws Exception {
        if (acknowledged == null) {
            throw new IllegalStateException("Transfer resume acknowledgement must be created first");
        }
        Checkpoint next = normalize(durableProgress);
        int changedIndex = validateAdvance(acknowledged, next);
        Timestamp timestamp = timestamp();
        FileMetadata file = files.get(changedIndex);
        FileState state = next.files.get(changedIndex);

        JSONObject unsigned = base(V2TransferMessage.TYPE_PROGRESS, timestamp);
        unsigned.put("path", file.path);
        unsigned.put("fileSize", file.size);
        unsigned.put("committedOffset", state.committedOffset);
        unsigned.put("completed", state.completed);
        unsigned.put("nextSequence", next.nextSequence);
        unsigned.put("totalTransferred", next.totalTransferred);

        byte[] payload = signAndEncode(V2TransferMessage.TYPE_PROGRESS, unsigned, timestamp.issuedAt);
        acknowledged = next;
        lastIssuedAt = timestamp.issuedAt;
        return payload;
    }

    private Checkpoint normalize(V2EncryptedChunkWriter.Progress progress) {
        if (progress == null || progress.files.size() != files.size()) {
            throw new IllegalArgumentException("Durable receive progress does not match the manifest file set");
        }

        List<FileState> normalized = new ArrayList<>(files.size());
        boolean sawIncomplete = false;
        long total = 0L;
        long minimumSequence = 0L;
        for (int index = 0; index < files.size(); index += 1) {
            FileMetadata file = files.get(index);
            V2EncryptedChunkWriter.FileProgress candidate = progress.files.get(index);
            if (candidate == null || !file.path.equals(candidate.path)) {
                throw new IllegalArgumentException(
                    "Durable receive progress changed the manifest file set or order"
                );
            }
            if (candidate.committedOffset < 0 || candidate.committedOffset > file.size) {
                throw new IllegalArgumentException("Durable receive progress exceeds manifest file bounds");
            }
            if (candidate.completed && candidate.committedOffset != file.size) {
                throw new IllegalArgumentException("Completed receive progress must cover the complete file");
            }
            if (!candidate.completed && file.size > 0 && candidate.committedOffset == file.size) {
                throw new IllegalArgumentException("Full-size receive progress must be marked completed");
            }
            if (sawIncomplete && (candidate.completed || candidate.committedOffset != 0)) {
                throw new IllegalArgumentException("Durable receive progress must be a contiguous manifest prefix");
            }
            if (!candidate.completed) sawIncomplete = true;
            if (candidate.completed || candidate.committedOffset > 0) {
                minimumSequence = checkedAdd(minimumSequence, 1L, "Transfer progress event count");
            }
            total = checkedAdd(total, candidate.committedOffset, "Transfer progress total");
            normalized.add(new FileState(candidate.committedOffset, candidate.completed));
        }
        if (progress.nextSequence < minimumSequence) {
            throw new IllegalArgumentException("Transfer next sequence is inconsistent with durable progress");
        }
        return new Checkpoint(progress.nextSequence, normalized, total);
    }

    private int validateAdvance(Checkpoint previous, Checkpoint next) {
        int changedIndex = -1;
        for (int index = 0; index < files.size(); index += 1) {
            FileState before = previous.files.get(index);
            FileState after = next.files.get(index);
            if (after.committedOffset < before.committedOffset || (before.completed && !after.completed)) {
                throw new IllegalArgumentException("Durable receive progress must not move backwards");
            }
            if (before.committedOffset != after.committedOffset || before.completed != after.completed) {
                if (changedIndex != -1) {
                    throw new IllegalArgumentException("One progress acknowledgement may advance only one file");
                }
                changedIndex = index;
            }
        }
        if (changedIndex == -1) {
            throw new IllegalArgumentException("Durable receive progress did not advance");
        }

        int expectedIndex = firstIncomplete(previous);
        if (changedIndex != expectedIndex) {
            throw new IllegalArgumentException("Durable receive progress advanced a file out of order");
        }
        FileState before = previous.files.get(changedIndex);
        FileState after = next.files.get(changedIndex);
        if (after.committedOffset == before.committedOffset && after.completed == before.completed) {
            throw new IllegalArgumentException("Durable receive progress did not commit a chunk");
        }
        if (after.committedOffset == before.committedOffset && !after.completed) {
            throw new IllegalArgumentException("Only an empty file marker may complete without adding bytes");
        }

        if (previous.nextSequence == V2TransferCrypto.MAX_SEQUENCE) {
            if (next.nextSequence != V2TransferCrypto.MAX_SEQUENCE || !allCompleted(next)) {
                throw new IllegalArgumentException(
                    "The saturated transfer sequence may only acknowledge the final chunk"
                );
            }
        } else if (next.nextSequence != previous.nextSequence + 1L) {
            throw new IllegalArgumentException("Transfer next sequence must advance by exactly one chunk");
        }
        if (next.totalTransferred < previous.totalTransferred) {
            throw new IllegalArgumentException("Transfer total must not move backwards");
        }
        return changedIndex;
    }

    private JSONObject base(String type, Timestamp timestamp) throws Exception {
        JSONObject json = new JSONObject();
        json.put("app", ProtocolV2.APP_ID);
        json.put("protocolVersion", ProtocolV2.VERSION);
        json.put("type", type);
        json.put("taskId", taskId);
        json.put("sessionId", sessionId);
        json.put("senderDeviceId", localReceiverDeviceId);
        json.put("receiverDeviceId", remoteSenderDeviceId);
        json.put("manifestHash", manifestHash);
        json.put("issuedAt", timestamp.issuedAt);
        json.put("expiresAt", timestamp.expiresAt);
        return json;
    }

    private byte[] signAndEncode(String type, JSONObject unsigned, long nowEpochMillis) throws Exception {
        String signingPayload = V2TransferMessage.signingPayload(type, unsigned);
        Signature signer = Signature.getInstance("Ed25519", "BC");
        signer.initSign(signingKey);
        signer.update(signingPayload.getBytes(StandardCharsets.UTF_8));
        byte[] signature = signer.sign();
        if (signature.length != SIGNATURE_BYTES) {
            throw new IllegalStateException("Ed25519 produced an unexpected signature length");
        }

        JSONObject signed = new JSONObject(unsigned.toString());
        signed.put("signature", Base64.getUrlEncoder().withoutPadding().encodeToString(signature));
        V2TransferMessage.Message normalized = V2TransferMessage.fromJson(type, signed, nowEpochMillis);
        return V2TransferMessage.encode(normalized, nowEpochMillis);
    }

    private Timestamp timestamp() {
        long issuedAt = clock.nowEpochMillis();
        if (issuedAt <= 0 || issuedAt > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("Transfer acknowledgement time is outside the safe integer range");
        }
        if (lastIssuedAt > issuedAt) {
            throw new IllegalStateException("Transfer acknowledgement clock moved backwards");
        }
        if (issuedAt > MAX_SAFE_INTEGER - ttlMillis) {
            throw new IllegalArgumentException("Transfer acknowledgement expiry exceeds the safe integer range");
        }
        return new Timestamp(issuedAt, issuedAt + ttlMillis);
    }

    private static JSONObject header(String type) throws Exception {
        JSONObject header = new JSONObject();
        header.put("app", ProtocolV2.APP_ID);
        header.put("protocolVersion", ProtocolV2.VERSION);
        header.put("type", type);
        return header;
    }

    private static int firstIncomplete(Checkpoint checkpoint) {
        for (int index = 0; index < checkpoint.files.size(); index += 1) {
            if (!checkpoint.files.get(index).completed) return index;
        }
        return -1;
    }

    private static boolean allCompleted(Checkpoint checkpoint) {
        return firstIncomplete(checkpoint) == -1;
    }

    private static long checkedAdd(long left, long right, String label) {
        if (left < 0 || right < 0 || left > MAX_SAFE_INTEGER - right) {
            throw new IllegalArgumentException(label + " exceeds the safe integer range");
        }
        return left + right;
    }

    private static PrivateKey readSigningKey(String pem) {
        if (pem == null || pem.isBlank()) {
            throw new IllegalArgumentException("An Ed25519 signing key is required");
        }
        try {
            PrivateKey key = CryptoUtil.readPrivateKey(pem, "Ed25519");
            if (!"Ed25519".equalsIgnoreCase(key.getAlgorithm())) {
                throw new IllegalArgumentException("Transfer acknowledgements require an Ed25519 signing key");
            }
            return key;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException(
                "Transfer acknowledgements require an Ed25519 signing key",
                error
            );
        }
    }

    private static void requireDeviceId(String value, String label) {
        if (value == null || !DEVICE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " must be 16 lowercase hexadecimal characters");
        }
    }

    private static void requireCanonicalId(String value, String label) {
        if (value == null) throw new IllegalArgumentException(label + " is required");
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(value);
            String canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(decoded);
            if (decoded.length != 16 || !canonical.equals(value)) {
                throw new IllegalArgumentException(label + " must be canonical base64url");
            }
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(label + " must be canonical base64url", error);
        }
    }

    private static final class FileMetadata {
        final String path;
        final long size;

        FileMetadata(String path, long size) {
            this.path = path;
            this.size = size;
        }
    }

    private static final class FileState {
        final long committedOffset;
        final boolean completed;

        FileState(long committedOffset, boolean completed) {
            this.committedOffset = committedOffset;
            this.completed = completed;
        }
    }

    private static final class Checkpoint {
        final long nextSequence;
        final List<FileState> files;
        final long totalTransferred;

        Checkpoint(long nextSequence, List<FileState> files, long totalTransferred) {
            this.nextSequence = nextSequence;
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
            this.totalTransferred = totalTransferred;
        }
    }

    private static final class Timestamp {
        final long issuedAt;
        final long expiresAt;

        Timestamp(long issuedAt, long expiresAt) {
            this.issuedAt = issuedAt;
            this.expiresAt = expiresAt;
        }
    }
}
