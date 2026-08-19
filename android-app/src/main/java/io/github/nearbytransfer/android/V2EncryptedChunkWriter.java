package io.github.nearbytransfer.android;

import java.io.IOException;
import java.io.FilterInputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * Authenticated, resumable receiver for protocol-v2 encrypted chunk frames.
 *
 * <p>{@link Publication#commit()} is the publication linearization point for this in-memory writer.
 * The owner must bracket {@link #complete()} with a durable, recoverable task-state transition and
 * an idempotent publication identity so process death around commit can be reconciled safely.
 */
final class V2EncryptedChunkWriter implements AutoCloseable {
    private static final long MAX_SAFE_INTEGER = V2TransferCrypto.MAX_SAFE_INTEGER;
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern TASK_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");

    enum State { RECEIVING, COMPLETED, CANCELLED, FAILED, CLOSED }

    static final class FileSpec {
        final String path;
        final long size;
        final String sha256;

        FileSpec(String path, long size, String sha256) {
            requireRelativePath(path);
            requireSafeInteger(size, "Manifest file size");
            if (sha256 == null || !SHA256.matcher(sha256).matches()) {
                throw new IllegalArgumentException("Manifest SHA-256 must be lowercase hexadecimal");
            }
            this.path = path;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    static final class Manifest {
        final String taskId;
        final List<FileSpec> files;

        Manifest(String taskId, List<FileSpec> files) {
            requireTaskId(taskId);
            if (files == null || files.isEmpty()) {
                throw new IllegalArgumentException("Manifest must contain at least one file");
            }
            List<FileSpec> copy = new ArrayList<>(files.size());
            Set<String> exact = new HashSet<>();
            Set<String> windows = new HashSet<>();
            String previous = null;
            for (FileSpec file : files) {
                if (file == null) throw new IllegalArgumentException("Manifest file is required");
                if (previous != null && previous.compareTo(file.path) >= 0) {
                    throw new IllegalArgumentException("Normalized manifest files must be strictly path-sorted");
                }
                if (!exact.add(file.path) || !windows.add(file.path.toUpperCase(Locale.ROOT))) {
                    throw new IllegalArgumentException("Manifest contains duplicate or colliding file paths");
                }
                copy.add(file);
                previous = file.path;
            }
            this.taskId = taskId;
            this.files = Collections.unmodifiableList(copy);
        }
    }

    static final class ReceiveTarget {
        final String path;
        final String destinationToken;

        ReceiveTarget(String path, String destinationToken) {
            requireRelativePath(path);
            if (destinationToken == null || destinationToken.isEmpty() || destinationToken.length() > 512) {
                throw new IllegalArgumentException("Receive destination token is invalid");
            }
            for (int index = 0; index < destinationToken.length(); index++) {
                if (Character.isISOControl(destinationToken.charAt(index))) {
                    throw new IllegalArgumentException("Receive destination token contains control characters");
                }
            }
            this.path = path;
            this.destinationToken = destinationToken;
        }
    }

    static final class ReceivePlan {
        final String taskId;
        final List<ReceiveTarget> targets;

        ReceivePlan(String taskId, List<ReceiveTarget> targets) {
            requireTaskId(taskId);
            if (targets == null || targets.isEmpty()) {
                throw new IllegalArgumentException("Receive plan must contain targets");
            }
            this.taskId = taskId;
            this.targets = Collections.unmodifiableList(new ArrayList<>(targets));
        }
    }

    static final class FileProgress {
        final String path;
        final long committedOffset;
        final boolean completed;

        FileProgress(String path, long committedOffset, boolean completed) {
            requireRelativePath(path);
            requireSafeInteger(committedOffset, "Committed offset");
            this.path = path;
            this.committedOffset = committedOffset;
            this.completed = completed;
        }
    }

    static final class Progress {
        final long nextSequence;
        final List<FileProgress> files;

        Progress(long nextSequence, List<FileProgress> files) {
            requireSafeInteger(nextSequence, "Next sequence");
            if (nextSequence > V2TransferCrypto.MAX_SEQUENCE) {
                throw new IllegalArgumentException("Next sequence exceeds the supported range");
            }
            if (files == null) throw new IllegalArgumentException("Progress files are required");
            this.nextSequence = nextSequence;
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
        }
    }

    /**
     * Persists a complete progress snapshot atomically. If commit throws, callers
     * must treat the result as ambiguous; the staging bytes are deliberately
     * retained so either the old or new durable snapshot can be recovered.
     */
    interface ProgressStore {
        void commit(Progress progress) throws Exception;
    }

    /** App-private staging storage. Implementations must reject links and aliases. */
    interface StagingStore extends AutoCloseable {
        void prepare(String taskId, List<String> fileIds) throws Exception;
        StagingFile open(String taskId, String fileId) throws Exception;
        void deleteTask(String taskId) throws Exception;
        @Override default void close() throws Exception {}
    }

    interface StagingFile extends AutoCloseable {
        long size() throws Exception;
        void truncate(long size) throws Exception;
        void write(long offset, byte[] plaintext) throws Exception;
        void force() throws Exception;
        InputStream openVerifiedInput() throws Exception;
        @Override void close() throws Exception;
    }

    interface VerifiedSource {
        String relativePath();
        long size();
        InputStream open() throws Exception;
    }

    /**
     * Final-destination abstraction suitable for filesystem, SAF or MediaStore.
     * A publication must remain invisible until commit, reject every existing
     * destination instead of replacing it, and make the complete batch visible
     * atomically. A failed publication is rolled back before complete returns.
     */
    interface Publisher {
        Publication begin(String taskId) throws Exception;
    }

    interface Publication {
        void publishNoReplace(ReceiveTarget target, VerifiedSource source) throws Exception;
        void commit() throws Exception;
        void rollback() throws Exception;
    }

    static final class Completion {
        final boolean cleanupPending;
        Completion(boolean cleanupPending) { this.cleanupPending = cleanupPending; }
    }

    private static final class Record {
        final FileSpec spec;
        final ReceiveTarget target;
        final String fileId;
        long committedOffset;
        boolean completed;

        Record(FileSpec spec, ReceiveTarget target, String fileId,
               long committedOffset, boolean completed) {
            this.spec = spec;
            this.target = target;
            this.fileId = fileId;
            this.committedOffset = committedOffset;
            this.completed = completed;
        }
    }

    private final Manifest manifest;
    private final ReceivePlan plan;
    private final StagingStore staging;
    private final Publisher publisher;
    private final ProgressStore progressStore;
    private final List<Record> records = new ArrayList<>();
    private final ReentrantLock operation = new ReentrantLock();
    private volatile boolean cancelRequested;
    private volatile State state = State.RECEIVING;
    private byte[] sessionKey;
    private long nextSequence;
    private int currentIndex;

    static V2EncryptedChunkWriter create(
        Manifest manifest, ReceivePlan plan, byte[] sessionKey, Progress resumeProgress,
        StagingStore staging, Publisher publisher, ProgressStore progressStore
    ) throws Exception {
        return new V2EncryptedChunkWriter(
            manifest, plan, sessionKey, resumeProgress, staging, publisher, progressStore
        );
    }

    private V2EncryptedChunkWriter(
        Manifest manifest, ReceivePlan plan, byte[] sessionKey, Progress resumeProgress,
        StagingStore staging, Publisher publisher, ProgressStore progressStore
    ) throws Exception {
        this.manifest = Objects.requireNonNull(manifest, "Manifest is required");
        this.plan = Objects.requireNonNull(plan, "Receive plan is required");
        this.staging = Objects.requireNonNull(staging, "Staging store is required");
        this.publisher = Objects.requireNonNull(publisher, "Publisher is required");
        this.progressStore = progressStore == null ? ignored -> {} : progressStore;
        if (sessionKey == null || sessionKey.length != V2TransferCrypto.KEY_BYTES) {
            throw new IllegalArgumentException("Session key must contain exactly 32 bytes");
        }
        this.sessionKey = sessionKey.clone();
        try {
            validatePlan();
            boolean resumed = resumeProgress != null;
            Progress progress = normalizeProgress(resumeProgress);
            this.nextSequence = progress.nextSequence;
            List<String> ids = new ArrayList<>(manifest.files.size());
            for (int index = 0; index < manifest.files.size(); index++) ids.add(fileId(index));
            staging.prepare(manifest.taskId, Collections.unmodifiableList(ids));
            for (int index = 0; index < manifest.files.size(); index++) {
                FileSpec spec = manifest.files.get(index);
                FileProgress saved = progress.files.get(index);
                Record record = new Record(spec, plan.targets.get(index), ids.get(index),
                    saved.committedOffset, saved.completed);
                records.add(record);
                restoreRecord(record, resumed);
            }
            currentIndex = firstIncompleteIndex();
        } catch (Throwable error) {
            failAndClose();
            throw error;
        }
    }

    State state() { return state; }

    Progress progress() {
        operation.lock();
        try { return snapshot(nextSequence, records); }
        finally { operation.unlock(); }
    }

    Progress accept(V2TransferChunkFrame.Frame frame) throws Exception {
        if (frame == null) throw new IllegalArgumentException("Encrypted chunk frame is required");
        operation.lock();
        try {
            assertReceiving();
            try {
                Record record = currentRecord();
                if (record == null) throw new IllegalStateException("All manifest files are already complete");
                validateFrame(frame, record);
                boolean completesFile = record.spec.size == 0
                    || frame.offset() + frame.plainLength() == record.spec.size;
                boolean completesTask = completesFile && currentIndex == records.size() - 1;
                if (frame.sequence() == V2TransferCrypto.MAX_SEQUENCE && !completesTask) {
                    throw new IllegalArgumentException("Chunk sequence space is exhausted");
                }
                throwIfCancelled();
                byte[] nonce = frame.nonce();
                byte[] tag = frame.authTag();
                byte[] ciphertext = frame.ciphertext();
                byte[] plaintext = null;
                try {
                    plaintext = V2TransferCrypto.decryptChunk(
                        sessionKey, nonce, frame.taskId(), frame.relativePath(), frame.offset(),
                        frame.sequence(), frame.plainLength(), ciphertext, tag
                    );
                    throwIfCancelled();
                    try (StagingFile file = openRecord(record)) {
                        boolean stagingMayContainUncommittedBytes = false;
                        boolean progressCommitAttempted = false;
                        try {
                            if (file.size() != record.committedOffset) {
                                throw new IOException("Staging file changed outside committed progress");
                            }
                            if (plaintext.length > 0) {
                                stagingMayContainUncommittedBytes = true;
                                file.write(record.committedOffset, plaintext);
                            }
                            file.force();
                            throwIfCancelled();
                            long candidateOffset = record.committedOffset + plaintext.length;
                            if (file.size() != candidateOffset) {
                                throw new IOException("Staging file size changed unexpectedly");
                            }
                            if (completesFile) verifyFile(record, candidateOffset, file);
                            Progress candidate = candidateProgress(record, candidateOffset, completesFile);
                            progressCommitAttempted = true;
                            progressStore.commit(candidate);
                            record.committedOffset = candidateOffset;
                            record.completed = completesFile;
                            nextSequence = candidate.nextSequence;
                            if (completesFile) currentIndex++;
                            if (cancelRequested) {
                                state = State.CANCELLED;
                                clearKey();
                            }
                            return candidate;
                        } catch (Throwable error) {
                            if (stagingMayContainUncommittedBytes && !progressCommitAttempted) {
                                try {
                                    file.truncate(record.committedOffset);
                                    file.force();
                                } catch (Throwable rollbackError) {
                                    error.addSuppressed(rollbackError);
                                }
                            }
                            throw error;
                        }
                    }
                } finally {
                    Arrays.fill(nonce, (byte) 0);
                    Arrays.fill(tag, (byte) 0);
                    Arrays.fill(ciphertext, (byte) 0);
                    if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
                }
            } catch (Throwable error) {
                failAndClose();
                throw error;
            }
        } finally {
            operation.unlock();
        }
    }

    Completion complete() throws Exception {
        operation.lock();
        try {
            assertReceiving();
            try {
                if (currentIndex != records.size()) throw new IllegalStateException("Transfer is incomplete");
                throwIfCancelled();
                for (Record record : records) verifyFile(record, record.committedOffset);
                Publication publication = publisher.begin(manifest.taskId);
                try {
                    for (Record record : records) {
                        throwIfCancelled();
                        PublicationSource source = sourceFor(record);
                        try {
                            publication.publishNoReplace(record.target, source);
                            source.assertFullyConsumedAndClosed();
                        } catch (Throwable publishError) {
                            source.closeLeakedStream(publishError);
                            throw publishError;
                        }
                    }
                    throwIfCancelled();
                    publication.commit();
                } catch (Throwable publishError) {
                    try { publication.rollback(); }
                    catch (Throwable rollbackError) { publishError.addSuppressed(rollbackError); }
                    throw publishError;
                }
                // A successful commit wins over concurrent cancellation. Cross-thread cancel waits
                // for this operation lock and observes COMPLETED rather than reversing publication.
                state = State.COMPLETED;
                cancelRequested = false;
                clearKey();
                boolean cleanupPending = false;
                try { staging.deleteTask(manifest.taskId); }
                catch (Throwable ignored) { cleanupPending = true; }
                return new Completion(cleanupPending);
            } catch (Throwable error) {
                if (state == State.RECEIVING) failAndClose();
                throw error;
            }
        } finally {
            operation.unlock();
        }
    }

    void cancel() {
        // Reentrant callbacks cannot wait for their own operation. Mark cancellation
        // and let the next safe checkpoint roll back any uncommitted staging bytes.
        if (operation.isHeldByCurrentThread()) {
            if (state == State.RECEIVING) cancelRequested = true;
            return;
        }

        // Cross-thread cancellation is linearized after the active operation. In
        // particular, a commit that has already completed is never reversed.
        operation.lock();
        try {
            if (state == State.RECEIVING) {
                cancelRequested = true;
                state = State.CANCELLED;
                clearKey();
            }
        } finally { operation.unlock(); }
    }

    @Override public void close() {
        operation.lock();
        try {
            if (state == State.RECEIVING) state = State.CLOSED;
            clearKey();
        } finally { operation.unlock(); }
    }

    private void validatePlan() {
        if (!manifest.taskId.equals(plan.taskId)) {
            throw new IllegalArgumentException("Receive plan task ID does not match manifest");
        }
        if (plan.targets.size() != manifest.files.size()) {
            throw new IllegalArgumentException("Receive plan target count does not match manifest");
        }
        Set<String> tokens = new HashSet<>();
        for (int index = 0; index < manifest.files.size(); index++) {
            ReceiveTarget target = plan.targets.get(index);
            if (target == null || !manifest.files.get(index).path.equals(target.path)) {
                throw new IllegalArgumentException("Receive plan order/path does not match manifest");
            }
            if (!tokens.add(target.destinationToken)) {
                throw new IllegalArgumentException("Receive plan contains duplicate destination tokens");
            }
        }
    }

    private Progress normalizeProgress(Progress progress) {
        if (progress == null) {
            List<FileProgress> fresh = new ArrayList<>(manifest.files.size());
            for (FileSpec file : manifest.files) fresh.add(new FileProgress(file.path, 0, false));
            return new Progress(0, fresh);
        }
        if (progress.files.size() != manifest.files.size()) {
            throw new IllegalArgumentException("Resume progress does not match manifest");
        }
        boolean sawIncomplete = false;
        for (int index = 0; index < manifest.files.size(); index++) {
            FileSpec spec = manifest.files.get(index);
            FileProgress saved = progress.files.get(index);
            if (saved == null || !spec.path.equals(saved.path) || saved.committedOffset > spec.size) {
                throw new IllegalArgumentException("Resume progress does not match manifest");
            }
            if (saved.completed && saved.committedOffset != spec.size) {
                throw new IllegalArgumentException("Completed progress must cover the complete file");
            }
            if (!saved.completed && saved.committedOffset == spec.size && spec.size > 0) {
                throw new IllegalArgumentException("Full-size progress must be marked completed");
            }
            if (sawIncomplete && (saved.completed || saved.committedOffset != 0)) {
                throw new IllegalArgumentException("Resume progress must be a contiguous manifest prefix");
            }
            if (!saved.completed) sawIncomplete = true;
        }
        return progress;
    }

    private void restoreRecord(Record record, boolean resumed) throws Exception {
        try (StagingFile file = openRecord(record)) {
            long actual = file.size();
            if (!resumed && actual != 0) {
                throw new IOException("Fresh receive staging file already contains data");
            }
            if (actual < record.committedOffset) {
                throw new IOException("Staging file is shorter than committed progress");
            }
            if (actual > record.committedOffset) {
                file.truncate(record.committedOffset);
                file.force();
            }
            if (record.completed) verifyFile(record, record.committedOffset, file);
        }
    }

    private void validateFrame(V2TransferChunkFrame.Frame frame, Record record) {
        if (!manifest.taskId.equals(frame.taskId())) throw new IllegalArgumentException("Chunk task ID mismatch");
        if (!record.spec.path.equals(frame.relativePath())) throw new IllegalArgumentException("Chunk path is out of order");
        if (frame.offset() != record.committedOffset) throw new IllegalArgumentException("Chunk offset is duplicated or skipped");
        if (frame.sequence() != nextSequence) throw new IllegalArgumentException("Chunk sequence is duplicated, skipped, or out of order");
        if (record.spec.size == 0) {
            if (frame.offset() != 0 || frame.plainLength() != 0) {
                throw new IllegalArgumentException("Empty files require one zero-length authenticated marker");
            }
        } else {
            if (frame.plainLength() <= 0) throw new IllegalArgumentException("Non-empty files require non-empty chunks");
            if (frame.plainLength() > record.spec.size - record.committedOffset) {
                throw new IllegalArgumentException("Chunk exceeds manifest file bounds");
            }
        }
    }

    private void verifyFile(Record record, long expectedSize) throws Exception {
        try (StagingFile file = openRecord(record)) {
            verifyFile(record, expectedSize, file);
        }
    }

    private void verifyFile(Record record, long expectedSize, StagingFile file) throws Exception {
        if (expectedSize != record.spec.size || file.size() != record.spec.size) {
            throw new GeneralSecurityException("Received file size does not match manifest");
        }
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        try (InputStream input = file.openVerifiedInput()) {
            byte[] buffer = new byte[64 * 1024];
            try {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    throwIfCancelled();
                    digest.update(buffer, 0, read);
                    Arrays.fill(buffer, 0, read, (byte) 0);
                }
            } finally { Arrays.fill(buffer, (byte) 0); }
        }
        if (file.size() != record.spec.size) {
            throw new GeneralSecurityException("Received file changed while it was being verified");
        }
        byte[] expectedDigest = hexToBytes(record.spec.sha256);
        byte[] actualDigest = digest.digest();
        try {
            if (!MessageDigest.isEqual(expectedDigest, actualDigest)) {
                throw new GeneralSecurityException("Received file SHA-256 does not match manifest");
            }
        } finally {
            Arrays.fill(expectedDigest, (byte) 0);
            Arrays.fill(actualDigest, (byte) 0);
        }
    }

    private Progress candidateProgress(Record changed, long offset, boolean completed) {
        List<FileProgress> files = new ArrayList<>(records.size());
        for (Record record : records) {
            if (record == changed) files.add(new FileProgress(record.spec.path, offset, completed));
            else files.add(new FileProgress(record.spec.path, record.committedOffset, record.completed));
        }
        long candidateSequence = nextSequence == V2TransferCrypto.MAX_SEQUENCE
            ? nextSequence : nextSequence + 1;
        return new Progress(candidateSequence, files);
    }

    private StagingFile openRecord(Record record) throws Exception {
        return staging.open(manifest.taskId, record.fileId);
    }

    private PublicationSource sourceFor(Record record) {
        return new PublicationSource(record);
    }

    private final class PublicationSource implements VerifiedSource {
        private final Record record;
        private PublicationInputStream stream;
        private boolean openAttempted;
        private boolean verifiedAndClosed;

        PublicationSource(Record record) { this.record = record; }

        @Override public String relativePath() { return record.spec.path; }
        @Override public long size() { return record.spec.size; }

        @Override public InputStream open() throws Exception {
            if (openAttempted) throw new IllegalStateException("Published source may be opened only once");
            openAttempted = true;
            StagingFile file = openRecord(record);
            try {
                HashVerifyingInputStream verified = new HashVerifyingInputStream(
                    file.openVerifiedInput(), record.spec.size, hexToBytes(record.spec.sha256)
                );
                stream = new PublicationInputStream(verified, file, this);
                return stream;
            } catch (Throwable error) {
                try { file.close(); }
                catch (Throwable closeError) { error.addSuppressed(closeError); }
                throw error;
            }
        }

        void markClosed(boolean verified) {
            verifiedAndClosed = verified;
        }

        void assertFullyConsumedAndClosed() throws Exception {
            if (!openAttempted) {
                throw new IOException("Publisher did not open the verified source");
            }
            if (stream == null || !stream.isClosed()) {
                IOException error = new IOException("Publisher must fully consume and close the verified source");
                closeLeakedStream(error);
                throw error;
            }
            if (!verifiedAndClosed) {
                throw new IOException("Publisher did not completely verify the published source");
            }
        }

        void closeLeakedStream(Throwable owner) {
            if (stream == null || stream.isClosed()) return;
            try { stream.close(); }
            catch (Throwable closeError) { owner.addSuppressed(closeError); }
        }
    }

    private static final class PublicationInputStream extends FilterInputStream {
        private final StagingFile file;
        private final PublicationSource owner;
        private boolean closed;

        PublicationInputStream(InputStream input, StagingFile file, PublicationSource owner) {
            super(input);
            this.file = file;
            this.owner = owner;
        }

        boolean isClosed() { return closed; }

        @Override public void close() throws IOException {
            if (closed) return;
            closed = true;
            Throwable failure = null;
            try { super.close(); }
            catch (Throwable error) { failure = error; }
            try { file.close(); }
            catch (Throwable error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
            owner.markClosed(failure == null);
            if (failure instanceof IOException) throw (IOException) failure;
            if (failure != null) throw new IOException("Unable to close verified publication source", failure);
        }
    }

    private Record currentRecord() { return currentIndex >= records.size() ? null : records.get(currentIndex); }

    private int firstIncompleteIndex() {
        for (int index = 0; index < records.size(); index++) if (!records.get(index).completed) return index;
        return records.size();
    }

    private void assertReceiving() {
        if (cancelRequested) {
            state = State.CANCELLED;
            clearKey();
            throw new IllegalStateException("Encrypted chunk receiver is cancelled");
        }
        if (state != State.RECEIVING) {
            throw new IllegalStateException("Encrypted chunk receiver is " + state.name().toLowerCase(Locale.ROOT));
        }
    }

    private void throwIfCancelled() {
        if (cancelRequested) throw new IllegalStateException("Encrypted chunk receiver is cancelled");
    }

    private void failAndClose() {
        if (cancelRequested) state = State.CANCELLED;
        else if (state == State.RECEIVING) state = State.FAILED;
        clearKey();
    }

    private void clearKey() {
        if (sessionKey != null) {
            Arrays.fill(sessionKey, (byte) 0);
            sessionKey = null;
        }
    }

    private static Progress snapshot(long sequence, List<Record> records) {
        List<FileProgress> files = new ArrayList<>(records.size());
        for (Record record : records) files.add(new FileProgress(record.spec.path, record.committedOffset, record.completed));
        return new Progress(sequence, files);
    }

    private static String fileId(int index) { return String.format(Locale.ROOT, "%08d.part", index); }
    private static String taskDirectory(String taskId) { return ".nearby-transfer-" + taskId + ".staging"; }

    private static final class HashVerifyingInputStream extends FilterInputStream {
        private final long expectedSize;
        private byte[] expectedDigest;
        private final MessageDigest digest;
        private long count;
        private boolean verified;

        HashVerifyingInputStream(InputStream input, long expectedSize, byte[] expectedDigest) {
            super(input);
            this.expectedSize = expectedSize;
            this.expectedDigest = expectedDigest;
            try { this.digest = MessageDigest.getInstance("SHA-256"); }
            catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        }

        @Override public int read() throws IOException {
            int value = super.read();
            if (value < 0) verifyComplete();
            else {
                digest.update((byte) value);
                count++;
                if (count > expectedSize) throw new IOException("Published source exceeds its verified size");
            }
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            int read = super.read(buffer, offset, length);
            if (read < 0) verifyComplete();
            else if (read > 0) {
                digest.update(buffer, offset, read);
                count += read;
                if (count > expectedSize) throw new IOException("Published source exceeds its verified size");
            }
            return read;
        }

        @Override public void close() throws IOException {
            IOException failure = null;
            try {
                if (!verified) verifyComplete();
            } catch (IOException error) {
                failure = error;
            }
            try { super.close(); }
            catch (IOException error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            } finally {
                clearExpectedDigest();
            }
            if (failure != null) throw failure;
        }

        private void verifyComplete() throws IOException {
            if (verified) return;
            byte[] actual = digest.digest();
            try {
                if (count != expectedSize || !MessageDigest.isEqual(expectedDigest, actual)) {
                    throw new IOException("Published source no longer matches the verified manifest entry");
                }
                verified = true;
            } finally {
                Arrays.fill(actual, (byte) 0);
                clearExpectedDigest();
            }
        }

        private void clearExpectedDigest() {
            if (expectedDigest != null) {
                Arrays.fill(expectedDigest, (byte) 0);
                expectedDigest = null;
            }
        }
    }

    /** java.nio implementation for app-private storage and JVM tests. */
    static final class LocalStagingStore implements StagingStore {
        private final Path root;
        private boolean closed;

        LocalStagingStore(Path appPrivateStagingRoot) throws IOException {
            if (appPrivateStagingRoot == null || !appPrivateStagingRoot.isAbsolute()) {
                throw new IllegalArgumentException("App-private staging root must be absolute");
            }
            this.root = appPrivateStagingRoot.normalize();
            assertSafeDirectoryChain(root);
        }

        @Override public void prepare(String taskId, List<String> fileIds) throws Exception {
            requireOpen();
            requireTaskId(taskId);
            validateFileIds(fileIds);
            assertSafeDirectoryChain(root);
            Path task = containedTask(taskId);
            if (Files.notExists(task, LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(task);
            assertDirectory(task);
            Set<String> expected = new LinkedHashSet<>(fileIds);
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(task)) {
                for (Path entry : entries) {
                    String name = entry.getFileName().toString();
                    if (!expected.contains(name)) throw new SecurityException("Unexpected staging entry");
                    BasicFileAttributes attrs = attributes(entry);
                    if (!attrs.isRegularFile() || attrs.isSymbolicLink()) {
                        throw new SecurityException("Staging entry is not a regular file");
                    }
                }
            }
        }

        @Override public StagingFile open(String taskId, String fileId) throws Exception {
            requireOpen();
            validateFileId(fileId);
            Path task = containedTask(taskId);
            assertDirectory(task);
            Path file = task.resolve(fileId).normalize();
            assertContained(task, file);
            Set<OpenOption> options = new HashSet<>(Arrays.asList(
                StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE
            ));
            options.add(LinkOption.NOFOLLOW_LINKS);
            FileChannel channel = FileChannel.open(file, options);
            try {
                BasicFileAttributes attrs = attributes(file);
                if (!attrs.isRegularFile() || attrs.isSymbolicLink()) {
                    throw new SecurityException("Staging entry is not a regular file");
                }
                return new LocalStagingFile(file, channel, attrs.fileKey(), attrs.creationTime());
            } catch (Throwable error) {
                channel.close();
                throw error;
            }
        }

        @Override public void deleteTask(String taskId) throws Exception {
            requireOpen();
            Path task = containedTask(taskId);
            if (Files.notExists(task, LinkOption.NOFOLLOW_LINKS)) return;
            assertDirectory(task);
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(task)) {
                for (Path entry : entries) {
                    BasicFileAttributes attrs = attributes(entry);
                    if (!attrs.isRegularFile() || attrs.isSymbolicLink()) {
                        throw new SecurityException("Unsafe staging cleanup entry");
                    }
                    Files.delete(entry);
                }
            }
            Files.delete(task);
        }

        @Override public void close() { closed = true; }

        private Path containedTask(String taskId) {
            requireTaskId(taskId);
            Path task = root.resolve(taskDirectory(taskId)).normalize();
            assertContained(root, task);
            return task;
        }
        private void requireOpen() { if (closed) throw new IllegalStateException("Staging store is closed"); }
        private static void validateFileIds(List<String> ids) {
            if (ids == null || ids.isEmpty()) throw new IllegalArgumentException("Staging file IDs are required");
            Set<String> unique = new HashSet<>();
            for (String id : ids) {
                validateFileId(id);
                if (!unique.add(id)) throw new IllegalArgumentException("Duplicate staging file ID");
            }
        }
        private static void validateFileId(String id) {
            if (id == null || !id.matches("^[0-9]{8}\\.part$")) {
                throw new IllegalArgumentException("Invalid opaque staging file ID");
            }
        }
    }

    private static final class LocalStagingFile implements StagingFile {
        private final Path path;
        private final Object fileKey;
        private final FileTime creationTime;
        private FileChannel channel;

        LocalStagingFile(Path path, FileChannel channel, Object fileKey, FileTime creationTime) {
            this.path = path;
            this.channel = channel;
            this.fileKey = fileKey;
            this.creationTime = creationTime;
        }
        @Override public long size() throws Exception { verifyIdentity(); return channel.size(); }
        @Override public void truncate(long size) throws Exception {
            verifyIdentity(); channel.truncate(size); verifyIdentity();
        }
        @Override public void write(long offset, byte[] plaintext) throws Exception {
            verifyIdentity();
            ByteBuffer buffer = ByteBuffer.wrap(plaintext);
            long position = offset;
            while (buffer.hasRemaining()) {
                int written = channel.write(buffer, position);
                if (written <= 0) throw new IOException("Staging write made no progress");
                position += written;
            }
            verifyIdentity();
        }
        @Override public void force() throws Exception { verifyIdentity(); channel.force(true); verifyIdentity(); }
        @Override public InputStream openVerifiedInput() throws Exception {
            verifyIdentity();
            return new InputStream() {
                private long position;
                private boolean inputClosed;

                @Override public int read() throws IOException {
                    byte[] single = new byte[1];
                    try {
                        int read = read(single, 0, 1);
                        if (read < 0) return -1;
                        return Byte.toUnsignedInt(single[0]);
                    } finally {
                        Arrays.fill(single, (byte) 0);
                    }
                }

                @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                    Objects.checkFromIndexSize(offset, length, buffer.length);
                    if (inputClosed) throw new IOException("Verified staging input is closed");
                    if (length == 0) return 0;
                    try {
                        verifyIdentity();
                        int read = channel.read(ByteBuffer.wrap(buffer, offset, length), position);
                        if (read > 0) position += read;
                        return read;
                    } catch (IOException error) {
                        throw error;
                    } catch (Exception error) {
                        throw new IOException("Unable to read verified staging file", error);
                    }
                }

                @Override public void close() { inputClosed = true; }
            };
        }
        @Override public void close() throws Exception {
            if (channel != null) { channel.close(); channel = null; }
        }
        private void verifyIdentity() throws Exception {
            if (channel == null || !channel.isOpen()) throw new IOException("Staging file is closed");
            BasicFileAttributes attrs = attributes(path);
            boolean sameIdentity = fileKey != null || attrs.fileKey() != null
                ? Objects.equals(fileKey, attrs.fileKey())
                : Objects.equals(creationTime, attrs.creationTime());
            if (!attrs.isRegularFile() || attrs.isSymbolicLink() || !sameIdentity || attrs.size() != channel.size()) {
                throw new SecurityException("Staging file identity changed");
            }
        }
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    private static void assertSafeDirectoryChain(Path directory) throws IOException {
        Path absolute = directory.toAbsolutePath().normalize();
        Path current = absolute.getRoot();
        if (current == null) throw new IllegalArgumentException("Staging root must be absolute");
        for (Path component : absolute) {
            current = current.resolve(component);
            assertDirectory(current);
        }
    }

    private static void assertDirectory(Path directory) throws IOException {
        BasicFileAttributes attrs = attributes(directory);
        if (!attrs.isDirectory() || attrs.isSymbolicLink()) {
            throw new SecurityException("Staging path must be a real directory");
        }
    }

    private static void assertContained(Path root, Path candidate) {
        if (!candidate.normalize().startsWith(root.normalize()) || candidate.equals(root)) {
            throw new SecurityException("Staging path escapes its owned root");
        }
    }

    private static void requireTaskId(String taskId) {
        if (taskId == null || !TASK_ID.matcher(taskId).matches()) {
            throw new IllegalArgumentException("Task ID must be a 22-character base64url value");
        }
        V2TransferCrypto.buildChunkAad(taskId, "validation", 0, 0, 0);
    }

    private static void requireRelativePath(String path) {
        if (path == null || path.isEmpty()) throw new IllegalArgumentException("Transfer path is required");
        if (!Normalizer.isNormalized(path, Normalizer.Form.NFC)) {
            throw new IllegalArgumentException("Transfer path must use NFC Unicode normalization");
        }
        V2TransferCrypto.buildChunkAad("ABEiM0RVZneImaq7zN3u_w", path, 0, 0, 0);
    }

    private static void requireSafeInteger(long value, String subject) {
        if (value < 0 || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(subject + " must be a non-negative safe integer");
        }
    }

    private static byte[] hexToBytes(String hex) {
        byte[] result = new byte[hex.length() / 2];
        for (int index = 0; index < result.length; index++) {
            result[index] = (byte) Integer.parseInt(hex.substring(index * 2, index * 2 + 2), 16);
        }
        return result;
    }
}
