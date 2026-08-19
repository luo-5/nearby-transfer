package io.github.nearbytransfer.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
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
    public void receivesPersistsAndSealsWithoutPublishingOrDeletingStaging() throws Exception {
        byte[] encryptionKey = filled(V2TransferCrypto.KEY_BYTES, 0x31);
        byte[] callerKey = encryptionKey.clone();
        MemoryStagingStore staging = new MemoryStagingStore();
        List<V2EncryptedChunkWriter.Progress> durable = new ArrayList<>();
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("hello")), file("z-empty.txt", new byte[0])),
            plan(target("a.txt", "destination-a"), target("z-empty.txt", "destination-empty")),
            callerKey,
            null,
            staging,
            progress -> {
                assertTrue("progress must follow a durable force", staging.allWritesForced());
                durable.add(progress);
            }
        );
        Arrays.fill(callerKey, (byte) 0);

        writer.accept(frame(encryptionKey, "a.txt", 0, 0, bytes("he")));
        writer.accept(frame(encryptionKey, "a.txt", 2, 1, bytes("llo")));
        writer.accept(frame(encryptionKey, "z-empty.txt", 0, 2, new byte[0]));

        V2EncryptedChunkWriter.SealedTransfer sealed = writer.sealForPublication();
        assertEquals(V2EncryptedChunkWriter.State.SEALED, writer.state());
        assertEquals(TASK_ID, sealed.taskId());
        assertEquals(2, sealed.files().size());
        assertEquals("a.txt", sealed.files().get(0).target().path);
        assertEquals("destination-a", sealed.files().get(0).target().destinationToken);
        assertEquals("z-empty.txt", sealed.files().get(1).target().path);
        assertEquals(3, durable.size());
        assertFalse("sealing must retain staging", staging.deleted);
        assertArrayEquals(bytes("hello"), staging.bytes("00000000.part"));
        assertArrayEquals(new byte[0], staging.bytes("00000001.part"));
        assertNull(internalSessionKey(writer));
        assertArrayEquals(filled(V2TransferCrypto.KEY_BYTES, 0x31), encryptionKey);

        Map<String, byte[]> published = consumeAll(sealed);
        assertArrayEquals(bytes("hello"), published.get("destination-a"));
        assertArrayEquals(new byte[0], published.get("destination-empty"));
        sealed.assertSourcesConsumedAndClosed();
        assertFalse("publication does not imply staging cleanup", staging.deleted);

        sealed.cleanupStaging();
        sealed.cleanupStaging();
        assertTrue(staging.deleted);
        assertTrue(sealed.isStagingCleaned());
        assertEquals(0, staging.openHandles);
        assertEquals(1, staging.maxOpenHandles);
    }

    @Test
    public void incompleteSealIsRejectedWithoutDestroyingReceivableState() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x42);
        WriterFixture fixture = fixture(key, file("a.txt", bytes("data")));
        fixture.writer.accept(frame(key, "a.txt", 0, 0, bytes("da")));

        assertFailure(fixture.writer::sealForPublication);
        assertEquals(V2EncryptedChunkWriter.State.RECEIVING, fixture.writer.state());
        assertNotNull(internalSessionKey(fixture.writer));
        assertFalse(fixture.staging.deleted);

        fixture.writer.accept(frame(key, "a.txt", 2, 1, bytes("ta")));
        assertNotNull(fixture.writer.sealForPublication());
        assertEquals(V2EncryptedChunkWriter.State.SEALED, fixture.writer.state());
    }

    @Test
    public void repeatedSealReturnsTheSameImmutableHandoff() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x53);
        WriterFixture fixture = fixture(key, file("a.txt", bytes("data")));
        fixture.writer.accept(frame(key, "a.txt", 0, 0, bytes("data")));

        V2EncryptedChunkWriter.SealedTransfer first = fixture.writer.sealForPublication();
        V2EncryptedChunkWriter.SealedTransfer second = fixture.writer.sealForPublication();
        assertSame(first, second);
        assertFailure(() -> fixture.writer.accept(frame(key, "a.txt", 4, 1, new byte[0])));
        fixture.writer.cancel();
        assertEquals(V2EncryptedChunkWriter.State.SEALED, fixture.writer.state());
        assertFalse(fixture.staging.deleted);
    }

    @Test
    public void sourceContractDetectsIgnoredPartialAndLeakedConsumers() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x64);

        WriterFixture ignoredFixture = completedFixture(key, bytes("data"));
        V2EncryptedChunkWriter.SealedTransfer ignored = ignoredFixture.writer.sealForPublication();
        assertFailure(ignored::assertSourcesConsumedAndClosed);
        assertFailure(ignored::cleanupStaging);
        assertFalse(ignoredFixture.staging.deleted);

        WriterFixture partialFixture = completedFixture(key, bytes("data"));
        V2EncryptedChunkWriter.VerifiedSource partial = partialFixture.writer
            .sealForPublication().files().get(0).source();
        InputStream partialInput = partial.open();
        assertTrue(partialInput.read() >= 0);
        assertFailure(partialInput::close);
        assertFailure(partial::assertFullyConsumedAndClosed);
        assertEquals(0, partialFixture.staging.openHandles);

        WriterFixture leakedFixture = completedFixture(key, bytes("data"));
        V2EncryptedChunkWriter.VerifiedSource leaked = leakedFixture.writer
            .sealForPublication().files().get(0).source();
        InputStream leakedInput = leaked.open();
        assertTrue(leakedInput.read() >= 0);
        assertFailure(leaked::assertFullyConsumedAndClosed);
        assertEquals("detection must close a leaked staging handle", 0, leakedFixture.staging.openHandles);
        assertFailure(leakedInput::read);
    }

    @Test
    public void verifiedSourceIsOneShotReauthenticatesAndRequiresClose() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x75);
        WriterFixture fixture = completedFixture(key, bytes("good"));
        V2EncryptedChunkWriter.VerifiedSource source = fixture.writer
            .sealForPublication().files().get(0).source();
        try (InputStream input = source.open()) {
            assertArrayEquals(bytes("good"), input.readAllBytes());
        }
        source.assertFullyConsumedAndClosed();
        assertFailure(source::open);

        WriterFixture mutatedFixture = completedFixture(key, bytes("good"));
        V2EncryptedChunkWriter.VerifiedSource mutated = mutatedFixture.writer
            .sealForPublication().files().get(0).source();
        mutatedFixture.staging.seed("00000000.part", bytes("evil"));
        assertFailure(() -> {
            try (InputStream input = mutated.open()) { input.readAllBytes(); }
        });
        assertFailure(mutated::assertFullyConsumedAndClosed);
    }

    @Test
    public void crossThreadCancelWaitsForSealAndCannotReverseSuccessfulHandoff() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x21);
        WriterFixture fixture = completedFixture(key, bytes("data"));
        CountDownLatch verificationStarted = new CountDownLatch(1);
        CountDownLatch allowVerification = new CountDownLatch(1);
        fixture.staging.onVerifiedRead = () -> {
            verificationStarted.countDown();
            try {
                if (!allowVerification.await(5, TimeUnit.SECONDS)) {
                    throw new AssertionError("timed out waiting to verify");
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
            }
        };

        AtomicReference<V2EncryptedChunkWriter.SealedTransfer> result = new AtomicReference<>();
        AtomicReference<Throwable> sealFailure = new AtomicReference<>();
        Thread sealing = new Thread(() -> {
            try { result.set(fixture.writer.sealForPublication()); }
            catch (Throwable error) { sealFailure.set(error); }
        }, "v2-writer-seal");
        sealing.start();
        assertTrue("seal verification did not start", verificationStarted.await(5, TimeUnit.SECONDS));

        AtomicBoolean cancelReturned = new AtomicBoolean();
        Thread cancellation = new Thread(() -> {
            fixture.writer.cancel();
            cancelReturned.set(true);
        }, "v2-writer-cancel");
        cancellation.start();
        Thread.sleep(100);
        assertFalse("cross-thread cancel must wait for active sealing", cancelReturned.get());

        allowVerification.countDown();
        sealing.join(5_000);
        cancellation.join(5_000);
        assertFalse(sealing.isAlive());
        assertFalse(cancellation.isAlive());
        if (sealFailure.get() != null) throw new AssertionError(sealFailure.get());
        assertNotNull(result.get());
        assertTrue(cancelReturned.get());
        assertEquals(V2EncryptedChunkWriter.State.SEALED, fixture.writer.state());
        assertNull(internalSessionKey(fixture.writer));
        assertFalse(fixture.staging.deleted);
    }

    @Test
    public void reentrantCancelDuringSealWinsAtVerificationCheckpoint() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x32);
        WriterFixture fixture = completedFixture(key, bytes("data"));
        fixture.staging.onVerifiedRead = fixture.writer::cancel;

        assertFailure(fixture.writer::sealForPublication);
        assertEquals(V2EncryptedChunkWriter.State.CANCELLED, fixture.writer.state());
        assertNull(internalSessionKey(fixture.writer));
        assertFalse(fixture.staging.deleted);
        assertEquals(0, fixture.staging.openHandles);
    }

    @Test
    public void rejectsInvalidFramesAndRetainsFsyncedTailAfterAmbiguousProgress() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x43);
        WriterFixture wrongPath = fixture(key, file("a.txt", bytes("data")));
        assertFailure(() -> wrongPath.writer.accept(frame(key, "b.txt", 0, 0, bytes("data"))));
        assertTerminalFailure(wrongPath, 0);

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

        MemoryStagingStore staging = new MemoryStagingStore();
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("data"))),
            plan(target("a.txt", "a")),
            key,
            null,
            staging,
            ignored -> { throw new IOException("durable progress result is unknown"); }
        );
        assertFailure(() -> writer.accept(frame(key, "a.txt", 0, 0, bytes("data"))));
        assertEquals(V2EncryptedChunkWriter.State.FAILED, writer.state());
        assertArrayEquals(bytes("data"), staging.bytes("00000000.part"));
        assertTrue(staging.forceCount("00000000.part") > 0);
    }

    @Test
    public void resumesCommittedPrefixAndTruncatesUncommittedTail() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x54);
        MemoryStagingStore staging = new MemoryStagingStore();
        staging.seed("00000000.part", bytes("hello!"));
        staging.seed("00000001.part", bytes("worUNCOMMITTED"));
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(file("a.txt", bytes("hello!")), file("b.txt", bytes("world"))),
            plan(target("a.txt", "a"), target("b.txt", "b")),
            key,
            new V2EncryptedChunkWriter.Progress(4, Arrays.asList(
                new V2EncryptedChunkWriter.FileProgress("a.txt", 6, true),
                new V2EncryptedChunkWriter.FileProgress("b.txt", 3, false)
            )),
            staging,
            ignored -> {}
        );

        assertArrayEquals(bytes("wor"), staging.bytes("00000001.part"));
        writer.accept(frame(key, "b.txt", 3, 4, bytes("ld")));
        V2EncryptedChunkWriter.SealedTransfer sealed = writer.sealForPublication();
        Map<String, byte[]> copied = consumeAll(sealed);
        assertArrayEquals(bytes("hello!"), copied.get("a"));
        assertArrayEquals(bytes("world"), copied.get("b"));
        assertFalse(staging.deleted);
    }

    @Test
    public void opensAtMostOneStagingHandleForLargeManifest() throws Exception {
        byte[] key = filled(V2TransferCrypto.KEY_BYTES, 0x65);
        int count = 2048;
        List<V2EncryptedChunkWriter.FileSpec> files = new ArrayList<>(count);
        List<V2EncryptedChunkWriter.ReceiveTarget> targets = new ArrayList<>(count);
        List<V2EncryptedChunkWriter.FileProgress> progress = new ArrayList<>(count);
        MemoryStagingStore staging = new MemoryStagingStore();
        for (int index = 0; index < count; index++) {
            String path = String.format("files/%04d.bin", index);
            files.add(file(path, new byte[0]));
            targets.add(target(path, "destination-" + index));
            progress.add(new V2EncryptedChunkWriter.FileProgress(path, 0, true));
            staging.seed(String.format("%08d.part", index), new byte[0]);
        }
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            new V2EncryptedChunkWriter.Manifest(TASK_ID, files),
            new V2EncryptedChunkWriter.ReceivePlan(TASK_ID, targets),
            key,
            new V2EncryptedChunkWriter.Progress(0, progress),
            staging,
            ignored -> {}
        );
        V2EncryptedChunkWriter.SealedTransfer sealed = writer.sealForPublication();
        assertEquals(count, sealed.files().size());
        assertEquals(1, staging.maxOpenHandles);
        assertEquals(0, staging.openHandles);
        assertFalse(staging.deleted);
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
        assertFailure(() -> manifest(file("A.txt", bytes("a")), file("a.txt", bytes("b"))));

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

    private static Map<String, byte[]> consumeAll(V2EncryptedChunkWriter.SealedTransfer sealed) throws Exception {
        Map<String, byte[]> copied = new LinkedHashMap<>();
        for (V2EncryptedChunkWriter.SealedFile file : sealed.files()) {
            V2EncryptedChunkWriter.VerifiedSource source = file.source();
            assertEquals(file.target().path, source.relativePath());
            try (InputStream input = source.open()) {
                byte[] bytes = input.readAllBytes();
                assertEquals(source.size(), bytes.length);
                copied.put(file.target().destinationToken, bytes);
            }
            source.assertFullyConsumedAndClosed();
        }
        return copied;
    }

    private static WriterFixture completedFixture(byte[] key, byte[] payload) throws Exception {
        WriterFixture fixture = fixture(key, file("a.txt", payload));
        fixture.writer.accept(frame(key, "a.txt", 0, 0, payload));
        return fixture;
    }

    private static WriterFixture fixture(byte[] key, V2EncryptedChunkWriter.FileSpec... files) throws Exception {
        MemoryStagingStore staging = new MemoryStagingStore();
        List<V2EncryptedChunkWriter.ReceiveTarget> targets = new ArrayList<>();
        for (V2EncryptedChunkWriter.FileSpec file : files) targets.add(target(file.path, file.path));
        V2EncryptedChunkWriter writer = V2EncryptedChunkWriter.create(
            manifest(files),
            new V2EncryptedChunkWriter.ReceivePlan(TASK_ID, targets),
            key,
            null,
            staging,
            ignored -> {}
        );
        return new WriterFixture(writer, staging);
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
        assertFalse(fixture.staging.deleted);
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

        WriterFixture(V2EncryptedChunkWriter writer, MemoryStagingStore staging) {
            this.writer = writer;
            this.staging = staging;
        }
    }

    private static final class MemoryStagingStore implements V2EncryptedChunkWriter.StagingStore {
        final Map<String, MemoryFileData> files = new LinkedHashMap<>();
        final List<String> events = new ArrayList<>();
        boolean deleted;
        Runnable onForce;
        Runnable onVerifiedRead;
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
            for (MemoryFileData file : files.values()) if (file.dirty) return false;
            return true;
        }

        @Override public void prepare(String taskId, List<String> fileIds) {
            assertEquals(TASK_ID, taskId);
            for (String fileId : fileIds) {
                files.computeIfAbsent(fileId, ignored -> new MemoryFileData(new byte[0]));
            }
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
            byte[] snapshot = data.bytes.clone();
            return new ByteArrayInputStream(snapshot) {
                private boolean hookCalled;

                private void callHook() {
                    if (hookCalled || owner.onVerifiedRead == null) return;
                    hookCalled = true;
                    owner.onVerifiedRead.run();
                }

                @Override public synchronized int read() {
                    callHook();
                    return super.read();
                }

                @Override public synchronized int read(byte[] buffer, int offset, int length) {
                    callHook();
                    return super.read(buffer, offset, length);
                }
            };
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
}
