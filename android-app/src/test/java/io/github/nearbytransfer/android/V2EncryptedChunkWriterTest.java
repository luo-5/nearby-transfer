package io.github.nearbytransfer.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;

public class V2EncryptedChunkWriterTest {
    private static final String TASK_ID = "ABEiM0RVZneImaq7zN3u_w";

    @Test
    public void writesFsyncsPersistsAndPublishesACompleteBatch() throws Exception {
        byte[] encryptionKey = filled(V2TransferCrypto.KEY_BYTES, 0x31);
        byte[] callerKey = encryptionKey.clone();
        MemoryStagingStore staging = new MemoryStagingStore();
        AtomicMemoryPublisher publisher = new AtomicMemoryPublisher();
        List<String> events = staging.events;
        List<V2EncryptedChunkWriter.Progress> durable = new ArrayList<>();
        V2EncryptedChunkWriter.Manifest manifest = manifest(
            file("a.txt", bytes("hello")),
            file("z-empty.txt", new byte[0])
        );
        V2EncryptedChunkWriter.ReceivePlan plan = plan(
            target("a.txt", "destination-a"),
            target("z-empty.txt", "destination-empty")
        );

        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest, plan, callerKey, null, staging, publisher,
            progress -> {
                assertTrue("progress must follow a durable force", staging.allWritesForced());
                events.add("progress:" + progress.nextSequence);
                durable.add(progress);
            }
        );
        Arrays.fill(callerKey, (byte) 0);

        V2EncryptedChunkWriter.Progress first = writer.accept(frame(encryptionKey, "a.txt", 0, 0, bytes("he")));
        assertEquals(2, first.files.get(0).committedOffset);
        assertFalse(first.files.get(0).completed);
        assertEquals("force:00000000.part", events.get(events.size() - 2));
        assertEquals("progress:1", events.get(events.size() - 1));

        V2EncryptedChunkWriter.Progress second = writer.accept(frame(encryptionKey, "a.txt", 2, 1, bytes("llo")));
        assertEquals(5, second.files.get(0).committedOffset);
        assertTrue(second.files.get(0).completed);
        V2EncryptedChunkWriter.Progress finalProgress = writer.accept(
            frame(encryptionKey, "z-empty.txt", 0, 2, new byte[0])
        );
        assertEquals(3, finalProgress.nextSequence);
        assertTrue(finalProgress.files.get(1).completed);
        assertEquals(3, durable.size());

        V2EncryptedChunkWriter.Completion completion = writer.complete();
        assertFalse(completion.cleanupPending);
        assertEquals(V2EncryptedChunkWriter.State.COMPLETED, writer.state());
        assertArrayEquals(bytes("hello"), publisher.visible.get("destination-a"));
        assertArrayEquals(new byte[0], publisher.visible.get("destination-empty"));
        assertEquals(1, publisher.commitCount);
        assertEquals(0, publisher.rollbackCount);
        assertTrue(staging.deleted);
        assertEquals(0, staging.openHandles);
        assertEquals(1, staging.maxOpenHandles);
        assertNull(internalSessionKey(writer));
        assertArrayEquals(filled(V2TransferCrypto.KEY_BYTES, 0x31), encryptionKey);
    }

    @Test
    public void rejectsOutOfOrderMetadataAndAuthenticationWithoutCommittingBytes() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x42);

        WriterFixture wrongPath = fixture(key, file("a.txt", bytes("data")));
        assertFailure(() -> wrongPath.writer.accept(frame(key, "b.txt", 0, 0, bytes("data"))));
        assertTerminalFailure(wrongPath, 0);

        WriterFixture wrongOffset = fixture(key, file("a.txt", bytes("data")));
        assertFailure(() -> wrongOffset.writer.accept(frame(key, "a.txt", 1, 0, bytes("data"))));
        assertTerminalFailure(wrongOffset, 0);

        WriterFixture wrongSequence = fixture(key, file("a.txt", bytes("data")));
        assertFailure(() -> wrongSequence.writer.accept(frame(key, "a.txt", 0, 1, bytes("data"))));
        assertTerminalFailure(wrongSequence, 0);

        WriterFixture badTag = fixture(key, file("a.txt", bytes("data")));
        V2TransferChunkFrame.Frame valid = frame(key, "a.txt", 0, 0, bytes("data"));
        byte[] changedTag = valid.authTag();
        changedTag[0] ^= 1;
        V2TransferChunkFrame.Frame tampered = new V2TransferChunkFrame.Frame(
            valid.taskId(), valid.relativePath(), valid.offset(), valid.sequence(), valid.plainLength(),
            valid.nonce(), changedTag, valid.ciphertext()
        );
        assertFailure(() -> badTag.writer.accept(tampered));
        assertTerminalFailure(badTag, 0);
    }

    @Test
    public void resumeVerifiesCompletedPrefixAndTruncatesUncommittedTail() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x53);
        MemoryStagingStore staging = new MemoryStagingStore();
        staging.seed("00000000.part", bytes("hello!"));
        staging.seed("00000001.part", bytes("worUNCOMMITTED"));
        V2EncryptedChunkWriter.Manifest manifest = manifest(
            file("a.txt", bytes("hello!")),
            file("b.txt", bytes("world"))
        );
        V2EncryptedChunkWriter.Progress resume = new V2EncryptedChunkWriter.Progress(4, Arrays.asList(
            new V2EncryptedChunkWriter.FileProgress("a.txt", 6, true),
            new V2EncryptedChunkWriter.FileProgress("b.txt", 3, false)
        ));
        AtomicMemoryPublisher publisher = new AtomicMemoryPublisher();
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest,
            plan(target("a.txt", "a"), target("b.txt", "b")),
            key,
            resume,
            staging,
            publisher,
            ignored -> {}
        );

        assertArrayEquals(bytes("wor"), staging.bytes("00000001.part"));
        assertTrue(staging.forceCount("00000001.part") > 0);
        V2EncryptedChunkWriter.Progress completeProgress = writer.accept(
            frame(key, "b.txt", 3, 4, bytes("ld"))
        );
        assertTrue(completeProgress.files.get(1).completed);
        writer.complete();
        assertArrayEquals(bytes("hello!"), publisher.visible.get("a"));
        assertArrayEquals(bytes("world"), publisher.visible.get("b"));
    }

    @Test
    public void ambiguousProgressFailureRetainsFsyncedTailForSafeRecovery() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x64);
        MemoryStagingStore staging = new MemoryStagingStore();
        V2EncryptedChunkWriter.Manifest manifest = manifest(file("a.txt", bytes("data")));
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest,
            plan(target("a.txt", "a")),
            key,
            null,
            staging,
            new AtomicMemoryPublisher(),
            ignored -> { throw new IOException("durable progress result is unknown"); }
        );

        assertFailure(() -> writer.accept(frame(key, "a.txt", 0, 0, bytes("data"))));
        assertEquals(V2EncryptedChunkWriter.State.FAILED, writer.state());
        assertArrayEquals(bytes("data"), staging.bytes("00000000.part"));
        assertTrue(staging.forceCount("00000000.part") > 0);

        V2EncryptedChunkWriter.Progress oldDurableProgress = new V2EncryptedChunkWriter.Progress(
            0,
            Collections.singletonList(new V2EncryptedChunkWriter.FileProgress("a.txt", 0, false))
        );
        AtomicMemoryPublisher publisher = new AtomicMemoryPublisher();
        V2EncryptedChunkWriter resumed = V2EncryptedChunkWriter.create(
            manifest,
            plan(target("a.txt", "a")),
            key,
            oldDurableProgress,
            staging,
            publisher,
            ignored -> {}
        );
        assertArrayEquals(new byte[0], staging.bytes("00000000.part"));
        resumed.accept(frame(key, "a.txt", 0, 0, bytes("data")));
        resumed.complete();
        assertArrayEquals(bytes("data"), publisher.visible.get("a"));
    }

    @Test
    public void hashMismatchAndCancellationRollBackUncommittedPlaintext() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x75);
        WriterFixture mismatch = fixture(key, file("a.txt", bytes("good")));
        assertFailure(() -> mismatch.writer.accept(frame(key, "a.txt", 0, 0, bytes("evil"))));
        assertTerminalFailure(mismatch, 0);
        assertTrue(mismatch.staging.forceCount("00000000.part") >= 2);

        WriterFixture cancelled = fixture(key, file("a.txt", bytes("data")));
        cancelled.staging.onForce = cancelled.writer::cancel;
        assertFailure(() -> cancelled.writer.accept(frame(key, "a.txt", 0, 0, bytes("data"))));
        assertEquals(V2EncryptedChunkWriter.State.CANCELLED, cancelled.writer.state());
        assertArrayEquals(new byte[0], cancelled.staging.bytes("00000000.part"));
        assertNull(internalSessionKey(cancelled.writer));
        assertEquals(0, cancelled.publisher.commitCount);

        WriterFixture explicit = fixture(key, file("a.txt", bytes("data")));
        explicit.writer.cancel();
        explicit.writer.cancel();
        assertEquals(V2EncryptedChunkWriter.State.CANCELLED, explicit.writer.state());
        assertFailure(() -> explicit.writer.accept(frame(key, "a.txt", 0, 0, bytes("data"))));
        assertFalse(explicit.staging.deleted);
        assertNull(internalSessionKey(explicit.writer));
    }

    @Test
    public void publicationNeverOverwritesAndRollsBackEveryFailedBatch() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x26);
        MemoryStagingStore staging = new MemoryStagingStore();
        AtomicMemoryPublisher publisher = new AtomicMemoryPublisher();
        publisher.visible.put("a", bytes("existing"));
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("new"))),
            plan(target("a.txt", "a")),
            key,
            null,
            staging,
            publisher,
            ignored -> {}
        );
        writer.accept(frame(key, "a.txt", 0, 0, bytes("new")));
        assertFailure(writer::complete);
        assertArrayEquals(bytes("existing"), publisher.visible.get("a"));
        assertEquals(1, publisher.rollbackCount);
        assertEquals(V2EncryptedChunkWriter.State.FAILED, writer.state());
        assertFalse(staging.deleted);

        WriterFixture commitFailure = fixture(key, file("a.txt", bytes("data")));
        commitFailure.publisher.failCommit = true;
        commitFailure.writer.accept(frame(key, "a.txt", 0, 0, bytes("data")));
        assertFailure(commitFailure.writer::complete);
        assertTrue(commitFailure.publisher.visible.isEmpty());
        assertTrue(commitFailure.publisher.pending.isEmpty());
        assertEquals(1, commitFailure.publisher.rollbackCount);
    }

    @Test
    public void publicationSourceIsReauthenticatedWhileBeingCopied() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x17);
        MemoryStagingStore staging = new MemoryStagingStore();
        PrefixOnlyPublisher publisher = new PrefixOnlyPublisher();
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("data"))),
            plan(target("a.txt", "a")),
            key,
            null,
            staging,
            publisher,
            ignored -> {}
        );
        writer.accept(frame(key, "a.txt", 0, 0, bytes("data")));
        assertFailure(writer::complete);
        assertEquals(1, publisher.rollbackCount);
        assertFalse(publisher.committed);
        assertEquals(V2EncryptedChunkWriter.State.FAILED, writer.state());
    }


    @Test
    public void opensAtMostOneStagingHandleForLargeManifests() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x2a);
        MemoryStagingStore staging = new MemoryStagingStore();
        List<V2EncryptedChunkWriter.FileSpec> files = new ArrayList<>();
        List<V2EncryptedChunkWriter.ReceiveTarget> targets = new ArrayList<>();
        for (int index = 0; index < 2_048; index++) {
            String path = String.format("files/%04d.txt", index);
            files.add(file(path, new byte[0]));
            targets.add(target(path, "destination-" + index));
        }

        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            new V2EncryptedChunkWriter.Manifest(TASK_ID, files),
            new V2EncryptedChunkWriter.ReceivePlan(TASK_ID, targets),
            key,
            null,
            staging,
            new AtomicMemoryPublisher(),
            ignored -> {}
        );

        assertEquals(0, staging.openHandles);
        assertEquals(1, staging.maxOpenHandles);
        writer.close();
        assertEquals(0, staging.openHandles);
    }

    @Test
    public void rejectsPublishersThatIgnoreOrLeakVerifiedSources() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x19);

        MemoryStagingStore ignoredStaging = new MemoryStagingStore();
        IgnoringPublisher ignoring = new IgnoringPublisher();
        V2EncryptedChunkWriter ignoredWriter = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("data"))),
            plan(target("a.txt", "a")),
            key,
            null,
            ignoredStaging,
            ignoring,
            ignored -> {}
        );
        ignoredWriter.accept(frame(key, "a.txt", 0, 0, bytes("data")));
        assertFailure(ignoredWriter::complete);
        assertEquals(V2EncryptedChunkWriter.State.FAILED, ignoredWriter.state());
        assertEquals(1, ignoring.rollbackCount);
        assertFalse(ignoring.committed);
        assertEquals(0, ignoredStaging.openHandles);

        MemoryStagingStore leakedStaging = new MemoryStagingStore();
        LeakingPrefixPublisher leaking = new LeakingPrefixPublisher();
        V2EncryptedChunkWriter leakedWriter = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("data"))),
            plan(target("a.txt", "a")),
            key,
            null,
            leakedStaging,
            leaking,
            ignored -> {}
        );
        leakedWriter.accept(frame(key, "a.txt", 0, 0, bytes("data")));
        assertFailure(leakedWriter::complete);
        assertEquals(V2EncryptedChunkWriter.State.FAILED, leakedWriter.state());
        assertEquals(1, leaking.rollbackCount);
        assertFalse(leaking.committed);
        assertEquals(0, leakedStaging.openHandles);
    }

    @Test
    public void crossThreadCancelWaitsForCommitAndDoesNotReverseSuccess() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x4b);
        MemoryStagingStore staging = new MemoryStagingStore();
        BlockingCommitPublisher publisher = new BlockingCommitPublisher();
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("data"))),
            plan(target("a.txt", "a")),
            key,
            null,
            staging,
            publisher,
            ignored -> {}
        );
        writer.accept(frame(key, "a.txt", 0, 0, bytes("data")));

        AtomicReference<Throwable> completionFailure = new AtomicReference<>();
        Thread completion = new Thread(() -> {
            try { writer.complete(); }
            catch (Throwable error) { completionFailure.set(error); }
        }, "v2-writer-complete");
        completion.start();
        assertTrue("commit did not start", publisher.commitStarted.await(5, TimeUnit.SECONDS));

        AtomicBoolean cancelReturned = new AtomicBoolean();
        CountDownLatch cancelStarted = new CountDownLatch(1);
        Thread cancellation = new Thread(() -> {
            cancelStarted.countDown();
            writer.cancel();
            cancelReturned.set(true);
        }, "v2-writer-cancel");
        cancellation.start();
        assertTrue(cancelStarted.await(5, TimeUnit.SECONDS));
        Thread.sleep(100);
        assertFalse("cross-thread cancel must wait for the active commit", cancelReturned.get());

        publisher.allowCommit.countDown();
        completion.join(5_000);
        cancellation.join(5_000);
        assertFalse("completion thread is still running", completion.isAlive());
        assertFalse("cancellation thread is still running", cancellation.isAlive());
        if (completionFailure.get() != null) throw new AssertionError(completionFailure.get());
        assertTrue(cancelReturned.get());
        assertEquals(V2EncryptedChunkWriter.State.COMPLETED, writer.state());
        assertArrayEquals(bytes("data"), publisher.visible.get("a"));
        assertEquals(0, staging.openHandles);
    }

    @Test
    public void validatesPathsProgressAndLocalStagingTree() throws Exception {
        assertFailure(() -> new V2EncryptedChunkWriter.FileSpec("../escape", 0, sha256(new byte[0])));
        assertFailure(() -> new V2EncryptedChunkWriter.FileSpec("CON.txt", 0, sha256(new byte[0])));
        assertFailure(() -> new V2EncryptedChunkWriter.FileSpec("e\u0301.txt", 0, sha256(new byte[0])));
        assertFailure(() -> new V2EncryptedChunkWriter.Progress(
            V2TransferCrypto.MAX_SEQUENCE + 1,
            Collections.emptyList()
        ));
        assertFailure(() -> manifest(
            file("A.txt", bytes("a")),
            file("a.txt", bytes("b"))
        ));

        Path root = Files.createTempDirectory("nearby-v2-writer-").toAbsolutePath();
        try {
            V2EncryptedChunkWriter.LocalStagingStore store = new V2EncryptedChunkWriter.LocalStagingStore(root);
            store.prepare(TASK_ID, Collections.singletonList("00000000.part"));
            V2EncryptedChunkWriter.StagingFile file = store.open(TASK_ID, "00000000.part");
            byte[] payload = bytes("safe");
            file.write(0, payload);
            file.force();
            try (InputStream input = file.openVerifiedInput()) {
                assertArrayEquals(payload, input.readAllBytes());
            }
            file.close();

            Path task = root.resolve(".nearby-transfer-" + TASK_ID + ".staging");
            Files.write(task.resolve("unexpected"), new byte[] { 1 });
            assertFailure(() -> store.prepare(TASK_ID, Collections.singletonList("00000000.part")));
            Files.delete(task.resolve("unexpected"));
            store.deleteTask(TASK_ID);
            assertFalse(Files.exists(task));
            store.close();
            assertFailure(() -> store.prepare(TASK_ID, Collections.singletonList("00000000.part")));
        } finally {
            deleteRecursively(root);
        }
    }

    private static WriterFixture fixture(byte[] key, V2EncryptedChunkWriter.FileSpec... files) throws Exception {
        MemoryStagingStore staging = new MemoryStagingStore();
        AtomicMemoryPublisher publisher = new AtomicMemoryPublisher();
        V2EncryptedChunkWriter.Manifest manifest = manifest(files);
        List<V2EncryptedChunkWriter.ReceiveTarget> targets = new ArrayList<>();
        for (V2EncryptedChunkWriter.FileSpec file : files) targets.add(target(file.path, file.path));
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest,
            new V2EncryptedChunkWriter.ReceivePlan(TASK_ID, targets),
            key,
            null,
            staging,
            publisher,
            ignored -> {}
        );
        return new WriterFixture(writer, staging, publisher);
    }

    private static V2EncryptedChunkWriter.Manifest manifest(V2EncryptedChunkWriter.FileSpec... files) {
        return new V2EncryptedChunkWriter.Manifest(TASK_ID, Arrays.asList(files));
    }

    private static V2EncryptedChunkWriter.FileSpec file(String path, byte[] bytes) {
        return new V2EncryptedChunkWriter.FileSpec(path, bytes.length, sha256(bytes));
    }

    private static V2EncryptedChunkWriter.ReceivePlan plan(V2EncryptedChunkWriter.ReceiveTarget... targets) {
        return new V2EncryptedChunkWriter.ReceivePlan(TASK_ID, Arrays.asList(targets));
    }

    private static V2EncryptedChunkWriter.ReceiveTarget target(String path, String token) {
        return new V2EncryptedChunkWriter.ReceiveTarget(path, token);
    }

    private static V2TransferChunkFrame.Frame frame(
        byte[] key, String path, long offset, long sequence, byte[] plaintext
    ) throws Exception {
        V2TransferCrypto.SealedChunk sealed = V2TransferCrypto.encryptChunk(
            key, TASK_ID, path, offset, sequence, plaintext
        );
        return new V2TransferChunkFrame.Frame(
            TASK_ID, path, offset, sequence, plaintext.length,
            sealed.nonce, sealed.authTag, sealed.ciphertext
        );
    }

    private static void assertTerminalFailure(WriterFixture fixture, int expectedBytes) throws Exception {
        assertEquals(V2EncryptedChunkWriter.State.FAILED, fixture.writer.state());
        assertEquals(expectedBytes, fixture.staging.bytes("00000000.part").length);
        assertNull(internalSessionKey(fixture.writer));
        assertEquals(0, fixture.publisher.commitCount);
    }

    private static byte[] internalSessionKey(V2EncryptedChunkWriter writer) throws Exception {
        Field field = V2EncryptedChunkWriter.class.getDeclaredField("sessionKey");
        field.setAccessible(true);
        return (byte[]) field.get(writer);
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] filled(int size, int value) {
        byte[] bytes = new byte[size];
        Arrays.fill(bytes, (byte) value);
        return bytes;
    }

    private static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte value : digest) result.append(String.format("%02x", Byte.toUnsignedInt(value)));
            Arrays.fill(digest, (byte) 0);
            return result.toString();
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (root == null || Files.notExists(root)) return;
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
            paths.sorted((left, right) -> right.getNameCount() - left.getNameCount()).forEach(path -> {
                try { Files.deleteIfExists(path); }
                catch (IOException error) { throw new DeleteFailure(error); }
            });
        } catch (DeleteFailure error) {
            throw error.cause;
        }
    }

    private static void assertFailure(ThrowingAction action) {
        try {
            action.run();
            fail("Expected operation to fail");
        } catch (AssertionError error) {
            throw error;
        } catch (Throwable expected) {
            // Expected.
        }
    }

    private interface ThrowingAction { void run() throws Exception; }

    private static final class DeleteFailure extends RuntimeException {
        final IOException cause;
        DeleteFailure(IOException cause) { super(cause); this.cause = cause; }
    }

    private static final class WriterFixture {
        final V2EncryptedChunkWriter writer;
        final MemoryStagingStore staging;
        final AtomicMemoryPublisher publisher;

        WriterFixture(
            V2EncryptedChunkWriter writer,
            MemoryStagingStore staging,
            AtomicMemoryPublisher publisher
        ) {
            this.writer = writer;
            this.staging = staging;
            this.publisher = publisher;
        }
    }

    private static final class MemoryStagingStore implements V2EncryptedChunkWriter.StagingStore {
        final Map<String, MemoryFileData> files = new LinkedHashMap<>();
        final List<String> events = new ArrayList<>();
        boolean deleted;
        Runnable onForce;
        int openHandles;
        int maxOpenHandles;

        void seed(String fileId, byte[] bytes) {
            files.put(fileId, new MemoryFileData(bytes.clone()));
        }

        byte[] bytes(String fileId) {
            MemoryFileData file = files.get(fileId);
            return file == null ? new byte[0] : file.bytes.clone();
        }

        int forceCount(String fileId) {
            MemoryFileData file = files.get(fileId);
            return file == null ? 0 : file.forceCount;
        }

        boolean allWritesForced() {
            for (MemoryFileData file : files.values()) {
                if (file.dirty) return false;
            }
            return true;
        }

        @Override public void prepare(String taskId, List<String> fileIds) {
            assertEquals(TASK_ID, taskId);
            for (String fileId : fileIds) files.computeIfAbsent(fileId, ignored -> new MemoryFileData(new byte[0]));
        }

        @Override public V2EncryptedChunkWriter.StagingFile open(String taskId, String fileId) {
            assertEquals(TASK_ID, taskId);
            MemoryFileData data = files.get(fileId);
            if (data == null) throw new IllegalArgumentException("Unknown memory staging file");
            openHandles++;
            maxOpenHandles = Math.max(maxOpenHandles, openHandles);
            return new MemoryStagingFile(fileId, data, this);
        }

        @Override public void deleteTask(String taskId) {
            assertEquals(TASK_ID, taskId);
            deleted = true;
            files.clear();
        }
    }

    private static final class MemoryFileData {
        byte[] bytes;
        boolean dirty;
        int forceCount;

        MemoryFileData(byte[] bytes) { this.bytes = bytes; }
    }

    private static final class MemoryStagingFile implements V2EncryptedChunkWriter.StagingFile {
        private final String fileId;
        private final MemoryFileData data;
        private final MemoryStagingStore owner;
        private boolean closed;

        MemoryStagingFile(String fileId, MemoryFileData data, MemoryStagingStore owner) {
            this.fileId = fileId;
            this.data = data;
            this.owner = owner;
        }

        @Override public long size() throws IOException {
            requireOpen();
            return data.bytes.length;
        }

        @Override public void truncate(long size) throws IOException {
            requireOpen();
            data.bytes = Arrays.copyOf(data.bytes, Math.toIntExact(size));
            data.dirty = true;
            owner.events.add("truncate:" + fileId + ":" + size);
        }

        @Override public void write(long offset, byte[] plaintext) throws IOException {
            requireOpen();
            int start = Math.toIntExact(offset);
            int end = Math.addExact(start, plaintext.length);
            if (start > data.bytes.length) throw new IOException("Memory write skipped bytes");
            data.bytes = Arrays.copyOf(data.bytes, Math.max(data.bytes.length, end));
            System.arraycopy(plaintext, 0, data.bytes, start, plaintext.length);
            data.dirty = true;
            owner.events.add("write:" + fileId + ":" + plaintext.length);
        }

        @Override public void force() throws IOException {
            requireOpen();
            data.dirty = false;
            data.forceCount++;
            owner.events.add("force:" + fileId);
            if (owner.onForce != null) owner.onForce.run();
        }

        @Override public InputStream openVerifiedInput() throws IOException {
            requireOpen();
            return new ByteArrayInputStream(data.bytes.clone());
        }

        @Override public void close() {
            if (closed) return;
            closed = true;
            owner.openHandles--;
            if (owner.openHandles < 0) throw new AssertionError("Memory staging handle count became negative");
        }

        private void requireOpen() throws IOException {
            if (closed) throw new IOException("Memory staging file is closed");
        }
    }

    private static class AtomicMemoryPublisher implements V2EncryptedChunkWriter.Publisher {
        final Map<String, byte[]> visible = new LinkedHashMap<>();
        final Map<String, byte[]> pending = new LinkedHashMap<>();
        int commitCount;
        int rollbackCount;
        boolean failCommit;

        @Override public V2EncryptedChunkWriter.Publication begin(String taskId) {
            assertEquals(TASK_ID, taskId);
            pending.clear();
            return new V2EncryptedChunkWriter.Publication() {
                @Override public void publishNoReplace(
                    V2EncryptedChunkWriter.ReceiveTarget target,
                    V2EncryptedChunkWriter.VerifiedSource source
                ) throws Exception {
                    if (visible.containsKey(target.destinationToken) || pending.containsKey(target.destinationToken)) {
                        throw new IOException("destination already exists");
                    }
                    assertEquals(target.path, source.relativePath());
                    try (InputStream input = source.open()) {
                        byte[] copied = input.readAllBytes();
                        if (copied.length != source.size()) throw new IOException("source size changed");
                        pending.put(target.destinationToken, copied);
                    }
                    assertFalse("publication must remain invisible before commit", visible.containsKey(target.destinationToken));
                }

                @Override public void commit() throws Exception {
                    if (failCommit) throw new IOException("atomic commit failed");
                    visible.putAll(pending);
                    pending.clear();
                    commitCount++;
                }

                @Override public void rollback() {
                    pending.clear();
                    rollbackCount++;
                }
            };
        }
    }



    private static final class IgnoringPublisher implements V2EncryptedChunkWriter.Publisher {
        int rollbackCount;
        boolean committed;

        @Override public V2EncryptedChunkWriter.Publication begin(String taskId) {
            return new V2EncryptedChunkWriter.Publication() {
                @Override public void publishNoReplace(
                    V2EncryptedChunkWriter.ReceiveTarget target,
                    V2EncryptedChunkWriter.VerifiedSource source
                ) {
                    // Deliberately ignore the source.
                }

                @Override public void commit() { committed = true; }

                @Override public void rollback() { rollbackCount++; }
            };
        }
    }

    private static final class LeakingPrefixPublisher implements V2EncryptedChunkWriter.Publisher {
        int rollbackCount;
        boolean committed;
        InputStream leaked;

        @Override public V2EncryptedChunkWriter.Publication begin(String taskId) {
            return new V2EncryptedChunkWriter.Publication() {
                @Override public void publishNoReplace(
                    V2EncryptedChunkWriter.ReceiveTarget target,
                    V2EncryptedChunkWriter.VerifiedSource source
                ) throws Exception {
                    leaked = source.open();
                    assertTrue(leaked.read() >= 0);
                    // Deliberately return without reaching EOF or closing the stream.
                }

                @Override public void commit() { committed = true; }

                @Override public void rollback() { rollbackCount++; }
            };
        }
    }

    private static final class BlockingCommitPublisher implements V2EncryptedChunkWriter.Publisher {
        final Map<String, byte[]> visible = new LinkedHashMap<>();
        final Map<String, byte[]> pending = new LinkedHashMap<>();
        final CountDownLatch commitStarted = new CountDownLatch(1);
        final CountDownLatch allowCommit = new CountDownLatch(1);

        @Override public V2EncryptedChunkWriter.Publication begin(String taskId) {
            return new V2EncryptedChunkWriter.Publication() {
                @Override public void publishNoReplace(
                    V2EncryptedChunkWriter.ReceiveTarget target,
                    V2EncryptedChunkWriter.VerifiedSource source
                ) throws Exception {
                    try (InputStream input = source.open()) {
                        pending.put(target.destinationToken, input.readAllBytes());
                    }
                }

                @Override public void commit() throws Exception {
                    commitStarted.countDown();
                    if (!allowCommit.await(5, TimeUnit.SECONDS)) {
                        throw new IOException("timed out waiting to commit");
                    }
                    visible.putAll(pending);
                    pending.clear();
                }

                @Override public void rollback() { pending.clear(); }
            };
        }
    }

    private static final class PrefixOnlyPublisher implements V2EncryptedChunkWriter.Publisher {
        int rollbackCount;
        boolean committed;

        @Override public V2EncryptedChunkWriter.Publication begin(String taskId) {
            return new V2EncryptedChunkWriter.Publication() {
                @Override public void publishNoReplace(
                    V2EncryptedChunkWriter.ReceiveTarget target,
                    V2EncryptedChunkWriter.VerifiedSource source
                ) throws Exception {
                    try (InputStream input = source.open()) {
                        assertTrue(input.read() >= 0);
                    }
                }

                @Override public void commit() { committed = true; }

                @Override public void rollback() { rollbackCount++; }
            };
        }
    }
}
