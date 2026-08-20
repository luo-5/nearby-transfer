package io.github.nearbytransfer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Collections;

public class V2TransferAcknowledgementCodecTest {
    private static final String TASK_ID = "ABEiM0RVZneImaq7zN3u_w";
    private static final String SESSION_ID = "EBESExQVFhcYGRobHB0eHw";
    private static final String LOCAL_ID = "0011223344556677";
    private static final String REMOTE_ID = "8899aabbccddeeff";
    private static final String MANIFEST_HASH =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final long NOW = 1_900_000_000_000L;

    private KeyPair signing;
    private String privateKeyPem;
    private String publicKeyPem;
    private MutableClock clock;

    @Before
    public void setUp() throws Exception {
        signing = CryptoUtil.generateEd25519KeyPair();
        privateKeyPem = CryptoUtil.toPrivatePem(signing.getPrivate());
        publicKeyPem = CryptoUtil.toPublicPem(signing.getPublic());
        clock = new MutableClock(NOW);
    }

    @Test
    public void createsSignedFullResumeFrameWithBoundRouteAndManifest() throws Exception {
        V2TransferAcknowledgementCodec codec = codec(manifest(
            file("a.txt", 4),
            file("empty.bin", 0)
        ));

        V2WireFrame.Frame frame = codec.createResumeFrame(progress(
            2,
            state("a.txt", 4, true),
            state("empty.bin", 0, false)
        ));

        assertEquals(ProtocolV2.APP_ID, frame.header.getString("app"));
        assertEquals(ProtocolV2.VERSION, frame.header.getInt("protocolVersion"));
        assertEquals(V2TransferMessage.TYPE_RESUME, frame.header.getString("type"));
        String canonical = new String(frame.payload, StandardCharsets.UTF_8);
        assertEquals(canonical, ProtocolV2.canonicalJson(new JSONObject(canonical)));

        V2TransferMessage.Resume resume = (V2TransferMessage.Resume) V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_RESUME,
            new JSONObject(canonical),
            publicKeyPem,
            NOW
        );
        assertEquals(TASK_ID, resume.taskId);
        assertEquals(SESSION_ID, resume.sessionId);
        assertEquals(LOCAL_ID, resume.senderDeviceId);
        assertEquals(REMOTE_ID, resume.receiverDeviceId);
        assertEquals(MANIFEST_HASH, resume.manifestHash);
        assertEquals(2, resume.files.size());
        assertEquals("a.txt", resume.files.get(0).path);
        assertEquals(4, resume.totalTransferred);
        assertEquals(2, resume.nextSequence);
        assertTrue(resume.files.get(0).completed);
        assertFalse(resume.files.get(1).completed);
        assertFalse(codec.toString().contains(privateKeyPem));
    }

    @Test
    public void emitsOneSignedProgressPayloadAfterEachDurableAdvance() throws Exception {
        V2TransferAcknowledgementCodec codec = codec(manifest(file("a.txt", 5)));
        codec.createResumeFrame(progress(0, state("a.txt", 0, false)));

        clock.now += 1;
        byte[] partialPayload = codec.encodeDurableProgress(
            progress(1, state("a.txt", 2, false))
        );
        V2TransferMessage.Progress partial = verifyProgress(partialPayload, clock.now);
        assertEquals("a.txt", partial.path);
        assertEquals(5, partial.fileSize);
        assertEquals(2, partial.committedOffset);
        assertFalse(partial.completed);
        assertEquals(1, partial.nextSequence);
        assertEquals(2, partial.totalTransferred);

        clock.now += 1;
        V2TransferMessage.Progress complete = verifyProgress(
            codec.encodeDurableProgress(progress(2, state("a.txt", 5, true))),
            clock.now
        );
        assertEquals(5, complete.committedOffset);
        assertTrue(complete.completed);
        assertEquals(5, complete.totalTransferred);
    }

    @Test
    public void acknowledgesZeroByteCompletionWithoutInventingTransferredBytes() throws Exception {
        V2TransferAcknowledgementCodec codec = codec(manifest(
            file("empty.bin", 0),
            file("later.bin", 1)
        ));
        codec.createResumeFrame(progress(
            0,
            state("empty.bin", 0, false),
            state("later.bin", 0, false)
        ));

        clock.now += 1;
        V2TransferMessage.Progress empty = verifyProgress(
            codec.encodeDurableProgress(progress(
                1,
                state("empty.bin", 0, true),
                state("later.bin", 0, false)
            )),
            clock.now
        );
        assertEquals("empty.bin", empty.path);
        assertEquals(0, empty.fileSize);
        assertEquals(0, empty.committedOffset);
        assertEquals(0, empty.totalTransferred);
        assertTrue(empty.completed);
    }

    @Test
    public void rejectsWrongManifestAndMalformedFullProgress() throws Exception {
        V2EncryptedChunkWriter.Manifest valid = manifest(
            file("a.txt", 4),
            file("b.txt", 2)
        );
        assertFailure(() -> new V2TransferAcknowledgementCodec(
            "ERITFBUWFxgZGhscHR4fIA",
            SESSION_ID,
            LOCAL_ID,
            REMOTE_ID,
            MANIFEST_HASH,
            valid,
            privateKeyPem,
            clock
        ));

        V2TransferAcknowledgementCodec codec = codec(valid);
        assertFailure(() -> codec.createResumeFrame(progress(
            0,
            state("b.txt", 0, false),
            state("a.txt", 0, false)
        )));
        assertFailure(() -> codec.createResumeFrame(progress(
            1,
            state("a.txt", 5, true),
            state("b.txt", 0, false)
        )));
        assertFailure(() -> codec.createResumeFrame(progress(
            1,
            state("a.txt", 4, false),
            state("b.txt", 0, false)
        )));
        assertFailure(() -> codec.createResumeFrame(progress(
            1,
            state("a.txt", 1, false),
            state("b.txt", 2, true)
        )));
    }

    @Test
    public void rejectsSkippedRegressedDuplicateAndMultiFileAdvances() throws Exception {
        V2TransferAcknowledgementCodec codec = codec(manifest(
            file("a.txt", 4),
            file("b.txt", 2)
        ));
        codec.createResumeFrame(progress(
            1,
            state("a.txt", 2, false),
            state("b.txt", 0, false)
        ));

        assertFailure(() -> codec.encodeDurableProgress(progress(
            2,
            state("a.txt", 2, false),
            state("b.txt", 1, false)
        )));
        assertFailure(() -> codec.encodeDurableProgress(progress(
            2,
            state("a.txt", 1, false),
            state("b.txt", 0, false)
        )));
        assertFailure(() -> codec.encodeDurableProgress(progress(
            1,
            state("a.txt", 3, false),
            state("b.txt", 0, false)
        )));
        assertFailure(() -> codec.encodeDurableProgress(progress(
            2,
            state("a.txt", 4, true),
            state("b.txt", 1, false)
        )));
        assertFailure(() -> codec.encodeDurableProgress(progress(
            2,
            state("a.txt", 2, false),
            state("b.txt", 0, false)
        )));
    }

    @Test
    public void enforcesInitializationClockTtlKeyAndSequenceBounds() throws Exception {
        V2EncryptedChunkWriter.Manifest oneByte = manifest(file("a.txt", 1));
        V2TransferAcknowledgementCodec codec = codec(oneByte);
        assertFailure(() -> codec.encodeDurableProgress(progress(1, state("a.txt", 1, true))));

        assertFailure(() -> codec(oneByte, 0));
        assertFailure(() -> codec(oneByte, V2TransferMessage.MAX_MESSAGE_TTL_MS + 1));
        KeyPair wrong = CryptoUtil.generateX25519KeyPair();
        assertFailure(() -> new V2TransferAcknowledgementCodec(
            TASK_ID,
            SESSION_ID,
            LOCAL_ID,
            REMOTE_ID,
            MANIFEST_HASH,
            oneByte,
            CryptoUtil.toPrivatePem(wrong.getPrivate()),
            clock
        ));

        clock.now = 9_007_199_254_740_991L;
        assertFailure(() -> codec(oneByte).createResumeFrame(
            progress(0, state("a.txt", 0, false))
        ));

        clock.now = NOW;
        V2TransferAcknowledgementCodec saturated = codec(oneByte);
        saturated.createResumeFrame(progress(
            V2TransferCrypto.MAX_SEQUENCE,
            state("a.txt", 0, false)
        ));
        verifyProgress(
            saturated.encodeDurableProgress(progress(
                V2TransferCrypto.MAX_SEQUENCE,
                state("a.txt", 1, true)
            )),
            NOW
        );

        V2TransferAcknowledgementCodec nonTerminal = codec(manifest(file("a.txt", 2)));
        nonTerminal.createResumeFrame(progress(
            V2TransferCrypto.MAX_SEQUENCE,
            state("a.txt", 0, false)
        ));
        assertFailure(() -> nonTerminal.encodeDurableProgress(progress(
            V2TransferCrypto.MAX_SEQUENCE,
            state("a.txt", 1, false)
        )));
    }

    @Test
    public void rejectsClockRollbackWithoutAdvancingInternalCheckpoint() throws Exception {
        V2TransferAcknowledgementCodec codec = codec(manifest(file("a.txt", 2)));
        codec.createResumeFrame(progress(0, state("a.txt", 0, false)));
        clock.now = NOW - 1;
        assertFailure(() -> codec.encodeDurableProgress(progress(1, state("a.txt", 1, false))));

        clock.now = NOW + 1;
        V2TransferMessage.Progress progress = verifyProgress(
            codec.encodeDurableProgress(progress(1, state("a.txt", 1, false))),
            clock.now
        );
        assertEquals(1, progress.committedOffset);
    }

    private V2TransferMessage.Progress verifyProgress(byte[] payload, long now) throws Exception {
        String canonical = new String(payload, StandardCharsets.UTF_8);
        assertEquals(canonical, ProtocolV2.canonicalJson(new JSONObject(canonical)));
        return (V2TransferMessage.Progress) V2TransferMessageAuth.verify(
            V2TransferMessage.TYPE_PROGRESS,
            new JSONObject(canonical),
            publicKeyPem,
            now
        );
    }

    private V2TransferAcknowledgementCodec codec(V2EncryptedChunkWriter.Manifest manifest)
        throws Exception {
        return codec(manifest, V2TransferAcknowledgementCodec.DEFAULT_TTL_MS);
    }

    private V2TransferAcknowledgementCodec codec(
        V2EncryptedChunkWriter.Manifest manifest,
        long ttlMillis
    ) throws Exception {
        return new V2TransferAcknowledgementCodec(
            TASK_ID,
            SESSION_ID,
            LOCAL_ID,
            REMOTE_ID,
            MANIFEST_HASH,
            manifest,
            privateKeyPem,
            clock,
            ttlMillis
        );
    }

    private static V2EncryptedChunkWriter.Manifest manifest(
        V2EncryptedChunkWriter.FileSpec... files
    ) {
        return new V2EncryptedChunkWriter.Manifest(TASK_ID, Arrays.asList(files));
    }

    private static V2EncryptedChunkWriter.FileSpec file(String path, long size) {
        return new V2EncryptedChunkWriter.FileSpec(
            path,
            size,
            String.join("", Collections.nCopies(64, "a"))
        );
    }

    private static V2EncryptedChunkWriter.Progress progress(
        long nextSequence,
        V2EncryptedChunkWriter.FileProgress... files
    ) {
        return new V2EncryptedChunkWriter.Progress(nextSequence, Arrays.asList(files));
    }

    private static V2EncryptedChunkWriter.FileProgress state(
        String path,
        long offset,
        boolean completed
    ) {
        return new V2EncryptedChunkWriter.FileProgress(path, offset, completed);
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected transfer acknowledgement operation to fail");
        } catch (IllegalArgumentException | IllegalStateException expected) {
            // Expected strict validation failure.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static final class MutableClock implements V2TransferAcknowledgementCodec.Clock {
        long now;

        MutableClock(long now) {
            this.now = now;
        }

        @Override public long nowEpochMillis() {
            return now;
        }
    }
}
