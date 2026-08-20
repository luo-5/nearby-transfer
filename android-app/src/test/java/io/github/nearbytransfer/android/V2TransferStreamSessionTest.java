package io.github.nearbytransfer.android;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2TransferStreamSessionTest {
    private static final String SENDER_ID = "1111111111111111";
    private static final String RECEIVER_ID = "2222222222222222";
    private static final String OTHER_ID = "3333333333333333";
    private static final String TASK_ID = "AAECAwQFBgcICQoLDA0ODw";
    private static final String OTHER_TASK_ID = "EBESExQVFhcYGRobHB0eHw";
    private static final String SESSION_ID = "ICEiIyQlJicoKSorLC0uLw";
    private static final long NOW = 1_800_000_000_000L;
    private static final V2TransferStreamSession.Timeouts TEST_TIMEOUTS =
        new V2TransferStreamSession.Timeouts(1_000, 1_000, 1_000, 1_000, 1_000, 1_000);

    private KeyPair senderKeys;
    private KeyPair receiverKeys;
    private String senderPrivatePem;
    private String senderPublicPem;
    private String receiverPrivatePem;
    private String receiverPublicPem;
    private final List<Harness> harnesses = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        senderKeys = CryptoUtil.generateEd25519KeyPair();
        receiverKeys = CryptoUtil.generateEd25519KeyPair();
        senderPrivatePem = CryptoUtil.toPrivatePem(senderKeys.getPrivate());
        senderPublicPem = CryptoUtil.toPublicPem(senderKeys.getPublic());
        receiverPrivatePem = CryptoUtil.toPrivatePem(receiverKeys.getPrivate());
        receiverPublicPem = CryptoUtil.toPublicPem(receiverKeys.getPublic());
    }

    @After
    public void tearDown() {
        for (Harness harness : harnesses) harness.close();
        harnesses.clear();
    }

    @Test(timeout = 10_000)
    public void rejectsNoncanonicalTaskIdAtTheSessionBoundary() throws Exception {
        String noncanonical = TASK_ID.substring(0, TASK_ID.length() - 1) + "x";
        assertArrayEquals(
            java.util.Base64.getUrlDecoder().decode(TASK_ID),
            java.util.Base64.getUrlDecoder().decode(noncanonical)
        );

        assertThrows(IllegalArgumentException.class, () -> new V2TransferStreamSession(
            new ByteArrayInputStream(new byte[0]),
            new ByteArrayOutputStream(),
            null,
            receiverCodec(TASK_ID),
            new RecordingWriter(),
            noncanonical,
            RECEIVER_ID,
            SENDER_ID,
            TEST_TIMEOUTS
        ));
    }

    @Test(timeout = 10_000)
    public void socketReceiverCompletesEmptyTransferAndOwnsSocket() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        ServerSocket listener = new ServerSocket(0);
        Socket senderSocket = new Socket("127.0.0.1", listener.getLocalPort());
        Socket receiverSocket = listener.accept();
        listener.close();
        senderSocket.setSoTimeout(2_000);

        V2SignedStreamControl.Codec receiverCodec = receiverCodec(TASK_ID);
        V2SignedStreamControl.Codec senderCodec = senderCodec(TASK_ID);
        V2TransferStreamSession session = new V2TransferStreamSession(
            receiverSocket, receiverCodec, writer, TASK_ID, RECEIVER_ID, SENDER_ID, TEST_TIMEOUTS
        );
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<V2TransferStreamSession.Snapshot> done = executor.submit(session::run);
        try {
            assertControl(senderCodec, readEnvelope(senderSocket.getInputStream()),
                V2SignedStreamControl.COMMAND_HELLO, "receive");
            sendControl(senderSocket.getOutputStream(), senderCodec,
                control(V2SignedStreamControl.COMMAND_HELLO, TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
            sendControl(senderSocket.getOutputStream(), senderCodec,
                control(V2SignedStreamControl.COMMAND_START, TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
            sendControl(senderSocket.getOutputStream(), senderCodec,
                control(V2SignedStreamControl.COMMAND_COMPLETE, TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
            assertControl(senderCodec, readEnvelope(senderSocket.getInputStream()),
                V2SignedStreamControl.COMMAND_COMPLETE_ACK, "receive");
            assertEquals(-1, senderSocket.getInputStream().read());
            senderSocket.shutdownOutput();

            V2TransferStreamSession.Snapshot result = done.get(2, TimeUnit.SECONDS);
            assertEquals(V2TransferStreamSession.State.COMPLETED, result.state);
            assertEquals(0, result.chunks);
            assertEquals(1, writer.completeCount.get());
            assertEquals(0, writer.cancelCount.get());
            assertTrue(receiverSocket.isClosed());
        } finally {
            senderSocket.close();
            session.close();
            executor.shutdownNow();
        }
    }

    @Test(timeout = 10_000)
    public void receivesSmallEncryptedChunkWithoutExposingPlaintext() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHandshake();

        byte[] ciphertext = new byte[] { 9, 8, 7, 6 };
        V2TransferChunkFrame.Frame chunk = chunk(TASK_ID, "folder/a.txt", ciphertext, 0, 0);
        harness.sendEnvelope(V2TransferStreamSession.FRAME_KIND_CHUNK, V2TransferChunkFrame.encode(chunk));
        harness.completeTransfer();

        V2TransferStreamSession.Snapshot result = harness.awaitSuccess();
        assertEquals(1, result.chunks);
        assertEquals(ciphertext.length, result.ciphertextBytes);
        assertEquals(1, writer.frames.size());
        assertArrayEquals(ciphertext, writer.frames.get(0).ciphertext());
        assertFalse(writer.sawPlaintext);
    }

    @Test(timeout = 10_000)
    public void acceptsFragmentedAndCoalescedJsCompatibleEnvelopes() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.start();
        harness.consumeReceiverHello();

        byte[] hello = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            harness.senderCodec.encode(control(V2SignedStreamControl.COMMAND_HELLO,
                TASK_ID, SENDER_ID, RECEIVER_ID, "send")));
        byte[] start = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            harness.senderCodec.encode(control(V2SignedStreamControl.COMMAND_START,
                TASK_ID, SENDER_ID, RECEIVER_ID, "send")));
        byte[] chunk = envelope(V2TransferStreamSession.FRAME_KIND_CHUNK,
            V2TransferChunkFrame.encode(chunk(TASK_ID, "a.bin", new byte[] { 1, 2, 3 }, 0, 0)));
        byte[] complete = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            harness.senderCodec.encode(control(V2SignedStreamControl.COMMAND_COMPLETE,
                TASK_ID, SENDER_ID, RECEIVER_ID, "send")));
        byte[] coalesced = concat(hello, start, chunk, complete);

        for (int index = 0; index < 13; index += 1) {
            harness.senderOutput.write(coalesced, index, 1);
            harness.senderOutput.flush();
        }
        harness.senderOutput.write(coalesced, 13, coalesced.length - 13);
        harness.senderOutput.flush();

        assertProgress(harness.readReceiverEnvelope(), 0);
        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_COMPLETE_ACK, "receive");
        harness.senderOutput.close();
        assertEquals(V2TransferStreamSession.State.COMPLETED, harness.awaitSuccess().state);
        assertEquals(1, writer.frames.size());

        byte[] encodedChunkEnvelope = envelope(V2TransferStreamSession.FRAME_KIND_CHUNK, new byte[] { 1, 2, 3 });
        assertArrayEquals("NTV2MUX1".getBytes(StandardCharsets.US_ASCII), Arrays.copyOf(encodedChunkEnvelope, 8));
        assertEquals(1, Byte.toUnsignedInt(encodedChunkEnvelope[8]));
        assertEquals(2, Byte.toUnsignedInt(encodedChunkEnvelope[9]));
        assertEquals(0, encodedChunkEnvelope[10]);
        assertEquals(0, encodedChunkEnvelope[11]);
        assertEquals(3, ByteBuffer.wrap(encodedChunkEnvelope).order(ByteOrder.BIG_ENDIAN).getInt(12));
    }

    @Test(timeout = 10_000)
    public void rejectsReplayedAndTamperedSignedControls() throws Exception {
        RecordingWriter replayWriter = new RecordingWriter();
        Harness replay = harness(replayWriter, TEST_TIMEOUTS);
        replay.start();
        replay.consumeReceiverHello();
        byte[] helloPayload = replay.senderCodec.encode(control(V2SignedStreamControl.COMMAND_HELLO,
            TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
        replay.sendRaw(concat(
            envelope(V2TransferStreamSession.FRAME_KIND_CONTROL, helloPayload),
            envelope(V2TransferStreamSession.FRAME_KIND_CONTROL, helloPayload)
        ));
        assertCancel(replay, "protocol-error");
        replay.awaitFailure();
        assertEquals(1, replayWriter.cancelCount.get());

        RecordingWriter tamperedWriter = new RecordingWriter();
        Harness tampered = harness(tamperedWriter, TEST_TIMEOUTS);
        tampered.start();
        tampered.consumeReceiverHello();
        byte[] signed = tampered.senderCodec.encode(control(V2SignedStreamControl.COMMAND_HELLO,
            TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
        byte[] changed = signed.clone();
        int signature = new String(changed, StandardCharsets.UTF_8).indexOf("\"signature\":\"") + 13;
        changed[signature] = changed[signature] == 'A' ? (byte) 'B' : (byte) 'A';
        tampered.sendEnvelope(V2TransferStreamSession.FRAME_KIND_CONTROL, changed);
        assertCancel(tampered, "protocol-error");
        tampered.awaitFailure();
        assertEquals(1, tamperedWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void rejectsChunkBeforeAuthenticatedStart() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHello();
        harness.sendEnvelope(V2TransferStreamSession.FRAME_KIND_CHUNK,
            V2TransferChunkFrame.encode(chunk(TASK_ID, "early.bin", new byte[] { 3 }, 0, 0)));

        assertCancel(harness, "protocol-error");
        harness.awaitFailure();
        assertTrue(writer.frames.isEmpty());
        assertEquals(1, writer.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void rejectsWrongTaskPeersAndDirectionBindings() throws Exception {
        RecordingWriter taskWriter = new RecordingWriter();
        Harness wrongTask = harness(
            taskWriter,
            TEST_TIMEOUTS,
            receiverCodec(OTHER_TASK_ID),
            senderCodec(OTHER_TASK_ID),
            TASK_ID,
            RECEIVER_ID,
            SENDER_ID
        );
        wrongTask.start();
        wrongTask.awaitFailure();
        assertEquals(1, taskWriter.cancelCount.get());

        RecordingWriter peerWriter = new RecordingWriter();
        Harness wrongPeer = harness(
            peerWriter,
            TEST_TIMEOUTS,
            receiverCodec(TASK_ID),
            senderCodec(TASK_ID),
            TASK_ID,
            RECEIVER_ID,
            OTHER_ID
        );
        wrongPeer.start();
        wrongPeer.awaitFailure();
        assertEquals(1, peerWriter.cancelCount.get());

        RecordingWriter directionWriter = new RecordingWriter();
        Harness wrongDirection = harness(directionWriter, TEST_TIMEOUTS);
        wrongDirection.start();
        wrongDirection.consumeReceiverHello();
        V2SignedStreamControl.Codec independentSender = senderCodec(TASK_ID);
        wrongDirection.sendEnvelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            independentSender.encode(control(V2SignedStreamControl.COMMAND_HELLO,
                TASK_ID, SENDER_ID, RECEIVER_ID, "receive")));
        assertCancel(wrongDirection, "protocol-error");
        wrongDirection.awaitFailure();
        assertEquals(1, directionWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void rejectsMalformedAndOversizeMuxFramesBeforeAllocatingPayload() throws Exception {
        RecordingWriter malformedWriter = new RecordingWriter();
        Harness malformed = harness(malformedWriter, TEST_TIMEOUTS);
        malformed.start();
        malformed.consumeReceiverHello();
        byte[] badMagic = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL, new byte[] { 1 });
        badMagic[0] = 'X';
        malformed.sendRaw(badMagic);
        assertCancel(malformed, "protocol-error");
        malformed.awaitFailure();

        RecordingWriter controlWriter = new RecordingWriter();
        Harness oversizedControl = harness(controlWriter, TEST_TIMEOUTS);
        oversizedControl.start();
        oversizedControl.consumeReceiverHello();
        byte[] controlPrefix = new byte[V2TransferStreamSession.MUX_PREFIX_BYTES];
        ByteBuffer controlHeader = ByteBuffer.wrap(controlPrefix).order(ByteOrder.BIG_ENDIAN);
        controlHeader.put("NTV2MUX1".getBytes(StandardCharsets.US_ASCII));
        controlHeader.put((byte) 1);
        controlHeader.put((byte) V2TransferStreamSession.FRAME_KIND_CONTROL);
        controlHeader.putShort((short) 0);
        controlHeader.putInt(V2SignedStreamControl.MAX_PAYLOAD_BYTES + 1);
        oversizedControl.sendRaw(controlPrefix);
        assertCancel(oversizedControl, "protocol-error");
        oversizedControl.awaitFailure();
        assertEquals(1, controlWriter.cancelCount.get());

        RecordingWriter oversizeWriter = new RecordingWriter();
        Harness oversize = harness(oversizeWriter, TEST_TIMEOUTS);
        oversize.start();
        oversize.consumeReceiverHello();
        byte[] prefix = new byte[V2TransferStreamSession.MUX_PREFIX_BYTES];
        ByteBuffer header = ByteBuffer.wrap(prefix).order(ByteOrder.BIG_ENDIAN);
        header.put("NTV2MUX1".getBytes(StandardCharsets.US_ASCII));
        header.put((byte) 1);
        header.put((byte) V2TransferStreamSession.FRAME_KIND_CHUNK);
        header.putShort((short) 0);
        header.putInt(V2TransferChunkFrame.MAX_FRAME_BYTES + 1);
        oversize.sendRaw(prefix);
        assertCancel(oversize, "protocol-error");
        oversize.awaitFailure();
        assertEquals(1, oversizeWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void localPauseAndResumeRequireAuthenticatedAcknowledgements() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHandshake();

        CompletableFuture<V2TransferStreamSession.Snapshot> paused = harness.session.pause();
        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_PAUSE, "receive");
        assertFalse(paused.isDone());
        harness.sendControl(V2SignedStreamControl.COMMAND_PAUSED);
        assertEquals(V2TransferStreamSession.LocalPauseState.PAUSED,
            paused.get(1, TimeUnit.SECONDS).localPauseState);

        CompletableFuture<V2TransferStreamSession.Snapshot> resumed = harness.session.resume();
        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_RESUME, "receive");
        harness.sendControl(V2SignedStreamControl.COMMAND_RESUMED);
        assertEquals(V2TransferStreamSession.LocalPauseState.RUNNING,
            resumed.get(1, TimeUnit.SECONDS).localPauseState);

        harness.completeTransfer();
        assertEquals(V2TransferStreamSession.State.COMPLETED, harness.awaitSuccess().state);
    }

    @Test(timeout = 10_000)
    public void remotePauseAndResumeAreAcknowledgedInOrder() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHandshake();

        harness.sendControl(V2SignedStreamControl.COMMAND_PAUSE);
        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_PAUSED, "receive");
        assertTrue(harness.session.snapshot().remotePaused);

        harness.sendControl(V2SignedStreamControl.COMMAND_RESUME);
        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_RESUMED, "receive");
        assertFalse(harness.session.snapshot().remotePaused);

        harness.completeTransfer();
        harness.awaitSuccess();
    }

    @Test(timeout = 10_000)
    public void remoteAndLocalCancelCleanUpExactlyOnce() throws Exception {
        RecordingWriter remoteWriter = new RecordingWriter();
        Harness remote = harness(remoteWriter, TEST_TIMEOUTS);
        remote.startAndHandshake();
        remote.sendCancel("cancelled");
        remote.awaitCancellation();
        assertEquals(V2TransferStreamSession.State.CANCELLED, remote.session.snapshot().state);
        assertEquals(1, remoteWriter.cancelCount.get());
        remote.session.close();
        assertEquals(1, remoteWriter.cancelCount.get());

        RecordingWriter localWriter = new RecordingWriter();
        Harness local = harness(localWriter, TEST_TIMEOUTS);
        local.startAndHandshake();
        local.session.cancel();
        assertCancel(local, "cancelled");
        local.awaitCancellation();
        assertEquals(1, localWriter.cancelCount.get());
        assertTrue(local.ownerClosed.get());
        local.session.cancel();
        assertEquals(1, localWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void handshakeAndClosingTimeoutsAreBoundedAndCleanResources() throws Exception {
        V2TransferStreamSession.Timeouts shortHandshake =
            new V2TransferStreamSession.Timeouts(80, 1_000, 1_000, 1_000, 1_000, 1_000);
        RecordingWriter handshakeWriter = new RecordingWriter();
        Harness handshake = harness(handshakeWriter, shortHandshake);
        handshake.start();
        handshake.consumeReceiverHello();
        assertCancel(handshake, "timeout");
        handshake.awaitFailure();
        assertEquals(V2TransferStreamSession.State.FAILED, handshake.session.snapshot().state);
        assertEquals(1, handshakeWriter.cancelCount.get());
        assertTrue(handshake.ownerClosed.get());

        V2TransferStreamSession.Timeouts shortClosing =
            new V2TransferStreamSession.Timeouts(1_000, 1_000, 1_000, 1_000, 1_000, 80);
        RecordingWriter closingWriter = new RecordingWriter();
        Harness closing = harness(closingWriter, shortClosing);
        closing.startAndHandshake();
        closing.sendControl(V2SignedStreamControl.COMMAND_COMPLETE);
        assertControl(closing.senderCodec, closing.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_COMPLETE_ACK, "receive");
        closing.awaitFailure();
        assertEquals(1, closingWriter.completeCount.get());
        assertEquals(0, closingWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void idleAndBlockedWriteTimeoutsCloseOwnedResources() throws Exception {
        V2TransferStreamSession.Timeouts shortIdle =
            new V2TransferStreamSession.Timeouts(1_000, 80, 1_000, 1_000, 1_000, 1_000);
        RecordingWriter idleWriter = new RecordingWriter();
        Harness idle = harness(idleWriter, shortIdle);
        idle.startAndHandshake();
        assertCancel(idle, "timeout");
        idle.awaitFailure();
        assertEquals(1, idleWriter.cancelCount.get());
        assertTrue(idle.ownerClosed.get());

        V2TransferStreamSession.Timeouts shortWrite =
            new V2TransferStreamSession.Timeouts(1_000, 1_000, 80, 1_000, 1_000, 1_000);
        RecordingWriter writeWriter = new RecordingWriter();
        BlockingOutputStream blocked = new BlockingOutputStream();
        AtomicBoolean ownerClosed = new AtomicBoolean();
        V2TransferStreamSession session = new V2TransferStreamSession(
            new ByteArrayInputStream(new byte[0]),
            blocked,
            () -> ownerClosed.set(true),
            receiverCodec(TASK_ID),
            writeWriter,
            TASK_ID,
            RECEIVER_ID,
            SENDER_ID,
            shortWrite
        );
        ExecutorService executor = Executors.newSingleThreadExecutor();
        long started = System.nanoTime();
        Future<V2TransferStreamSession.Snapshot> done = executor.submit(session::run);
        try {
            try {
                done.get(2, TimeUnit.SECONDS);
                fail("Expected blocked transfer write to time out");
            } catch (ExecutionException expected) {
                assertNotNull(expected.getCause());
            }
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            assertTrue("Write timeout cleanup took " + elapsedMs + " ms", elapsedMs < 1_000);
            assertTrue(blocked.closed.get());
            assertTrue(ownerClosed.get());
            assertEquals(1, writeWriter.cancelCount.get());
        } finally {
            session.close();
            executor.shutdownNow();
        }
    }

    @Test(timeout = 10_000)
    public void writerFailureCancelsTransferWithoutPublishing() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        writer.writeFailure = new IOException("staging failed");
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHandshake();
        harness.sendEnvelope(V2TransferStreamSession.FRAME_KIND_CHUNK,
            V2TransferChunkFrame.encode(chunk(TASK_ID, "fail.bin", new byte[] { 1 }, 0, 0)));

        assertCancel(harness, "transfer-error");
        harness.awaitFailure();
        assertEquals(0, writer.completeCount.get());
        assertEquals(1, writer.cancelCount.get());

        RecordingWriter unpublishedWriter = new RecordingWriter();
        unpublishedWriter.publish = false;
        Harness unpublished = harness(unpublishedWriter, TEST_TIMEOUTS);
        unpublished.startAndHandshake();
        unpublished.sendControl(V2SignedStreamControl.COMMAND_COMPLETE);
        assertCancel(unpublished, "transfer-error");
        unpublished.awaitFailure();
        assertEquals(1, unpublishedWriter.completeCount.get());
        assertEquals(1, unpublishedWriter.cancelCount.get());
    }

    @Test(timeout = 10_000)
    public void duplicateCompletionNeverCompletesWriterTwice() throws Exception {
        RecordingWriter writer = new RecordingWriter();
        Harness harness = harness(writer, TEST_TIMEOUTS);
        harness.startAndHandshake();
        byte[] first = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            harness.senderCodec.encode(control(V2SignedStreamControl.COMMAND_COMPLETE,
                TASK_ID, SENDER_ID, RECEIVER_ID, "send")));
        byte[] second = envelope(V2TransferStreamSession.FRAME_KIND_CONTROL,
            harness.senderCodec.encode(control(V2SignedStreamControl.COMMAND_COMPLETE,
                TASK_ID, SENDER_ID, RECEIVER_ID, "send")));
        harness.sendRaw(concat(first, second));

        assertControl(harness.senderCodec, harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_COMPLETE_ACK, "receive");
        harness.awaitFailure();
        assertEquals(1, writer.completeCount.get());
        assertEquals(0, writer.cancelCount.get());
    }

    private Harness harness(RecordingWriter writer, V2TransferStreamSession.Timeouts timeouts) throws Exception {
        return harness(writer, timeouts, receiverCodec(TASK_ID), senderCodec(TASK_ID),
            TASK_ID, RECEIVER_ID, SENDER_ID);
    }

    private Harness harness(RecordingWriter writer, V2TransferStreamSession.Timeouts timeouts,
                            V2SignedStreamControl.Codec receiverCodec,
                            V2SignedStreamControl.Codec senderCodec,
                            String taskId, String localPeerId, String remotePeerId) throws Exception {
        Harness harness = new Harness(writer, timeouts, receiverCodec, senderCodec,
            taskId, localPeerId, remotePeerId);
        harnesses.add(harness);
        return harness;
    }

    private V2SignedStreamControl.Codec senderCodec(String taskId) throws Exception {
        return new V2SignedStreamControl.Codec(
            SENDER_ID, senderPrivatePem, RECEIVER_ID, receiverPublicPem, taskId, SESSION_ID, () -> NOW
        );
    }

    private V2SignedStreamControl.Codec receiverCodec(String taskId) throws Exception {
        return new V2SignedStreamControl.Codec(
            RECEIVER_ID, receiverPrivatePem, SENDER_ID, senderPublicPem, taskId, SESSION_ID, () -> NOW
        );
    }

    private static V2SignedStreamControl.Control control(String type, String taskId,
                                                          String from, String to, String direction) {
        return new V2SignedStreamControl.Control(type, 1, taskId, from, to, direction);
    }

    private static V2SignedStreamControl.Control cancelControl(String taskId, String from,
                                                                String to, String direction,
                                                                String code) {
        return new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_CANCEL, 1, taskId, from, to, direction, code
        );
    }

    private static V2TransferChunkFrame.Frame chunk(String taskId, String path, byte[] ciphertext,
                                                     long offset, long sequence) {
        byte[] nonce = new byte[V2TransferCrypto.NONCE_BYTES];
        byte[] authTag = new byte[V2TransferCrypto.AUTH_TAG_BYTES];
        Arrays.fill(nonce, (byte) 4);
        Arrays.fill(authTag, (byte) 5);
        return new V2TransferChunkFrame.Frame(
            taskId, path, offset, sequence, ciphertext.length, nonce, authTag, ciphertext
        );
    }

    private static void sendControl(OutputStream output, V2SignedStreamControl.Codec codec,
                                    V2SignedStreamControl.Control control) throws Exception {
        output.write(envelope(V2TransferStreamSession.FRAME_KIND_CONTROL, codec.encode(control)));
        output.flush();
    }

    private static V2SignedStreamControl.Control assertControl(V2SignedStreamControl.Codec codec,
                                                                Envelope frame, String type,
                                                                String direction) throws Exception {
        assertEquals(V2TransferStreamSession.FRAME_KIND_CONTROL, frame.kind);
        V2SignedStreamControl.Control decoded = codec.decodeAndVerify(frame.payload);
        assertEquals(type, decoded.type);
        assertEquals(direction, decoded.direction);
        assertEquals(TASK_ID, decoded.taskId);
        assertEquals(RECEIVER_ID, decoded.fromPeerId);
        assertEquals(SENDER_ID, decoded.toPeerId);
        return decoded;
    }

    private static void assertProgress(Envelope frame, long sequence) {
        assertEquals(V2TransferStreamSession.FRAME_KIND_PROGRESS, frame.kind);
        assertArrayEquals(("progress:" + sequence).getBytes(StandardCharsets.US_ASCII), frame.payload);
    }

    private static byte[] envelope(int kind, byte[] payload) {
        ByteBuffer frame = ByteBuffer.allocate(V2TransferStreamSession.MUX_PREFIX_BYTES + payload.length)
            .order(ByteOrder.BIG_ENDIAN);
        frame.put("NTV2MUX1".getBytes(StandardCharsets.US_ASCII));
        frame.put((byte) V2TransferStreamSession.MUX_VERSION);
        frame.put((byte) kind);
        frame.putShort((short) V2TransferStreamSession.MUX_FLAGS);
        frame.putInt(payload.length);
        frame.put(payload);
        return frame.array();
    }

    private static Envelope readEnvelope(InputStream input) throws Exception {
        byte[] prefix = readExactly(input, V2TransferStreamSession.MUX_PREFIX_BYTES);
        assertArrayEquals("NTV2MUX1".getBytes(StandardCharsets.US_ASCII), Arrays.copyOf(prefix, 8));
        assertEquals(V2TransferStreamSession.MUX_VERSION, Byte.toUnsignedInt(prefix[8]));
        assertEquals(0, Short.toUnsignedInt(ByteBuffer.wrap(prefix).order(ByteOrder.BIG_ENDIAN).getShort(10)));
        int kind = Byte.toUnsignedInt(prefix[9]);
        int length = ByteBuffer.wrap(prefix).order(ByteOrder.BIG_ENDIAN).getInt(12);
        if (length <= 0 || length > V2WireFrame.MAX_BUFFERED_BYTES) {
            throw new IOException("Test received an invalid multiplexed frame length");
        }
        return new Envelope(kind, readExactly(input, length));
    }

    private static byte[] readExactly(InputStream input, int length) throws Exception {
        byte[] result = new byte[length];
        int cursor = 0;
        while (cursor < length) {
            int read = input.read(result, cursor, length - cursor);
            if (read == -1) throw new EOFException("Unexpected stream EOF");
            cursor += read;
        }
        return result;
    }

    private static byte[] concat(byte[]... values) {
        int length = 0;
        for (byte[] value : values) length += value.length;
        byte[] result = new byte[length];
        int cursor = 0;
        for (byte[] value : values) {
            System.arraycopy(value, 0, result, cursor, value.length);
            cursor += value.length;
        }
        return result;
    }

    private static void awaitState(V2TransferStreamSession session, V2TransferStreamSession.State state)
        throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            if (session.snapshot().state == state) return;
            Thread.sleep(5);
        }
        fail("Session did not enter state " + state + "; current=" + session.snapshot().state);
    }

    private static final class Envelope {
        final int kind;
        final byte[] payload;

        Envelope(int kind, byte[] payload) {
            this.kind = kind;
            this.payload = payload;
        }
    }

    private static final class RecordingWriter implements V2TransferStreamSession.ChunkWriter {
        final List<V2TransferChunkFrame.Frame> frames = new ArrayList<>();
        final AtomicInteger completeCount = new AtomicInteger();
        final AtomicInteger cancelCount = new AtomicInteger();
        volatile Exception writeFailure;
        volatile boolean publish = true;
        volatile boolean sawPlaintext;

        @Override public synchronized byte[] writeChunk(V2TransferChunkFrame.Frame encryptedFrame) throws Exception {
            if (writeFailure != null) throw writeFailure;
            frames.add(encryptedFrame);
            sawPlaintext = false;
            return ("progress:" + encryptedFrame.sequence()).getBytes(StandardCharsets.US_ASCII);
        }

        @Override public boolean complete() {
            completeCount.incrementAndGet();
            return publish;
        }

        @Override public void cancel() {
            cancelCount.incrementAndGet();
        }
    }

    private static final class BlockingOutputStream extends OutputStream {
        final AtomicBoolean closed = new AtomicBoolean();

        @Override public synchronized void write(int value) throws IOException {
            while (!closed.get()) {
                try { wait(); }
                catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Blocked test output was interrupted", error);
                }
            }
            throw new IOException("Blocked test output was closed");
        }

        @Override public void write(byte[] value, int offset, int length) throws IOException {
            write(0);
        }

        @Override public synchronized void close() {
            closed.set(true);
            notifyAll();
        }
    }

    private final class Harness implements Closeable {
        final RecordingWriter writer;
        final PipedInputStream receiverInput;
        final PipedOutputStream senderOutput;
        final PipedInputStream senderInput;
        final PipedOutputStream receiverOutput;
        final AtomicBoolean ownerClosed = new AtomicBoolean();
        final V2SignedStreamControl.Codec senderCodec;
        final V2TransferStreamSession session;
        final ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<V2TransferStreamSession.Snapshot> done;
        int progressRead;

        Harness(RecordingWriter writer, V2TransferStreamSession.Timeouts timeouts,
                V2SignedStreamControl.Codec receiverCodec,
                V2SignedStreamControl.Codec senderCodec,
                String taskId, String localPeerId, String remotePeerId) throws Exception {
            this.writer = writer;
            this.senderCodec = senderCodec;
            receiverInput = new PipedInputStream(256 * 1024);
            senderOutput = new PipedOutputStream(receiverInput);
            senderInput = new PipedInputStream(256 * 1024);
            receiverOutput = new PipedOutputStream(senderInput);
            session = new V2TransferStreamSession(
                receiverInput,
                receiverOutput,
                () -> ownerClosed.set(true),
                receiverCodec,
                writer,
                taskId,
                localPeerId,
                remotePeerId,
                timeouts
            );
        }

        void start() {
            done = executor.submit(session::run);
        }

        void consumeReceiverHello() throws Exception {
            assertControl(senderCodec, readReceiverEnvelope(),
                V2SignedStreamControl.COMMAND_HELLO, "receive");
        }

        void startAndHello() throws Exception {
            start();
            consumeReceiverHello();
            sendControl(V2SignedStreamControl.COMMAND_HELLO);
            awaitState(session, V2TransferStreamSession.State.AWAITING_START);
        }

        void startAndHandshake() throws Exception {
            startAndHello();
            sendControl(V2SignedStreamControl.COMMAND_START);
            awaitState(session, V2TransferStreamSession.State.RECEIVING);
        }

        void sendControl(String type) throws Exception {
            V2TransferStreamSessionTest.sendControl(senderOutput, senderCodec,
                control(type, TASK_ID, SENDER_ID, RECEIVER_ID, "send"));
        }

        void sendCancel(String code) throws Exception {
            V2TransferStreamSessionTest.sendControl(senderOutput, senderCodec,
                cancelControl(TASK_ID, SENDER_ID, RECEIVER_ID, "send", code));
        }

        void sendEnvelope(int kind, byte[] payload) throws Exception {
            sendRaw(envelope(kind, payload));
        }

        void sendRaw(byte[] bytes) throws Exception {
            senderOutput.write(bytes);
            senderOutput.flush();
        }

        Envelope readReceiverEnvelope() throws Exception {
            return readEnvelope(senderInput);
        }

        void completeTransfer() throws Exception {
            sendControl(V2SignedStreamControl.COMMAND_COMPLETE);
            while (true) {
                Envelope frame = readReceiverEnvelope();
                if (frame.kind == V2TransferStreamSession.FRAME_KIND_PROGRESS) {
                    assertTrue(progressRead < writer.frames.size());
                    assertProgress(frame, writer.frames.get(progressRead).sequence());
                    progressRead += 1;
                    continue;
                }
                assertControl(senderCodec, frame,
                    V2SignedStreamControl.COMMAND_COMPLETE_ACK, "receive");
                break;
            }
            senderOutput.close();
        }

        V2TransferStreamSession.Snapshot awaitSuccess() throws Exception {
            assertNotNull(done);
            return done.get(2, TimeUnit.SECONDS);
        }

        void awaitFailure() throws Exception {
            assertNotNull(done);
            try {
                done.get(2, TimeUnit.SECONDS);
                fail("Expected transfer session failure");
            } catch (ExecutionException | CancellationException expected) {
                // Expected terminal failure.
            }
        }

        void awaitCancellation() throws Exception {
            awaitFailure();
            assertEquals(V2TransferStreamSession.State.CANCELLED, session.snapshot().state);
        }

        @Override public void close() {
            session.close();
            try { senderOutput.close(); } catch (Exception ignored) { }
            try { senderInput.close(); } catch (Exception ignored) { }
            executor.shutdownNow();
        }
    }

    private static void assertCancel(Harness harness, String code) throws Exception {
        V2SignedStreamControl.Control cancel = assertControl(
            harness.senderCodec,
            harness.readReceiverEnvelope(),
            V2SignedStreamControl.COMMAND_CANCEL,
            "receive"
        );
        assertEquals(code, cancel.code);
    }
}
