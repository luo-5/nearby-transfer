package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.Signature;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2SignedStreamControlTest {
    private static final String ALICE_ID = "1111111111111111";
    private static final String BOB_ID = "2222222222222222";
    private static final String OTHER_ID = "3333333333333333";
    private static final String TASK_ID = "AAECAwQFBgcICQoLDA0ODw";
    private static final String OTHER_TASK_ID = "EBESExQVFhcYGRobHB0eHw";
    private static final long NOW = 1_800_000_000_000L;

    private KeyPair aliceKeys;
    private KeyPair bobKeys;
    private KeyPair otherKeys;
    private String alicePrivatePem;
    private String alicePublicPem;
    private String bobPrivatePem;
    private String bobPublicPem;
    private AtomicLong clock;

    @Before
    public void setUp() throws Exception {
        aliceKeys = CryptoUtil.generateEd25519KeyPair();
        bobKeys = CryptoUtil.generateEd25519KeyPair();
        otherKeys = CryptoUtil.generateEd25519KeyPair();
        alicePrivatePem = CryptoUtil.toPrivatePem(aliceKeys.getPrivate());
        alicePublicPem = CryptoUtil.toPublicPem(aliceKeys.getPublic());
        bobPrivatePem = CryptoUtil.toPrivatePem(bobKeys.getPrivate());
        bobPublicPem = CryptoUtil.toPublicPem(bobKeys.getPublic());
        clock = new AtomicLong(NOW);
    }

    @Test
    public void boundCodecsRoundTripControlsInBothDirections() throws Exception {
        V2SignedStreamControl.Codec alice = aliceCodec(clock);
        V2SignedStreamControl.Codec bob = bobCodec(clock);

        V2SignedStreamControl.Control hello = bob.decodeAndVerify(alice.encode(
            control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send")
        ));
        assertEquals(V2SignedStreamControl.COMMAND_HELLO, hello.type);
        assertEquals(1, hello.protocol);
        assertEquals(TASK_ID, hello.taskId);
        assertEquals(ALICE_ID, hello.fromPeerId);
        assertEquals(BOB_ID, hello.toPeerId);
        assertEquals("send", hello.direction);
        assertNull(hello.code);

        V2SignedStreamControl.Control reply = alice.decodeAndVerify(bob.encode(
            control(V2SignedStreamControl.COMMAND_HELLO, BOB_ID, ALICE_ID, "receive")
        ));
        assertEquals(V2SignedStreamControl.COMMAND_HELLO, reply.type);
        assertEquals("receive", reply.direction);

        V2SignedStreamControl.Control start = bob.decodeAndVerify(alice.encode(
            control(V2SignedStreamControl.COMMAND_START, ALICE_ID, BOB_ID, "send")
        ));
        assertEquals(V2SignedStreamControl.COMMAND_START, start.type);
    }

    @Test
    public void matchesSharedCrossPlatformVector() throws Exception {
        JSONObject fixture = loadSharedFixture();
        JSONObject sender = fixture.getJSONObject("sender");
        JSONObject receiver = fixture.getJSONObject("receiver");
        JSONObject stream = fixture.getJSONObject("streamControl");
        JSONObject core = stream.getJSONObject("core");
        String taskId = fixture.getString("taskId");
        long now = fixture.getLong("validationNow");

        assertEquals(sender.getString("deviceId"), CryptoUtil.deviceIdFor(sender.getString("signingPublicKey")));
        assertEquals(receiver.getString("deviceId"), CryptoUtil.deviceIdFor(receiver.getString("signingPublicKey")));

        V2SignedStreamControl.Codec encoder = new V2SignedStreamControl.Codec(
            sender.getString("deviceId"),
            sender.getString("signingPrivateKey"),
            receiver.getString("deviceId"),
            receiver.getString("signingPublicKey"),
            taskId,
            () -> now
        );
        V2SignedStreamControl.Control outgoing = new V2SignedStreamControl.Control(
            core.getString("type"),
            core.getInt("protocol"),
            core.getString("taskId"),
            core.getString("fromPeerId"),
            core.getString("toPeerId"),
            core.getString("direction")
        );
        assertEquals(stream.getString("canonicalSigned"), new String(encoder.encode(outgoing), StandardCharsets.UTF_8));

        V2SignedStreamControl.Codec decoder = new V2SignedStreamControl.Codec(
            receiver.getString("deviceId"),
            receiver.getString("signingPrivateKey"),
            sender.getString("deviceId"),
            sender.getString("signingPublicKey"),
            taskId,
            () -> now
        );
        V2SignedStreamControl.Control decoded = decoder.decodeAndVerify(
            stream.getString("canonicalSigned").getBytes(StandardCharsets.UTF_8)
        );
        assertEquals(outgoing.type, decoded.type);
        assertEquals(outgoing.taskId, decoded.taskId);
        assertEquals(outgoing.fromPeerId, decoded.fromPeerId);
        assertEquals(outgoing.toPeerId, decoded.toPeerId);
        assertEquals(outgoing.direction, decoded.direction);
    }

    @Test
    public void encodedPayloadIsCanonicalAndSignsEveryUnsignedField() throws Exception {
        byte[] encoded = aliceCodec(clock).encode(
            control(V2SignedStreamControl.COMMAND_PAUSE, ALICE_ID, BOB_ID, "send")
        );
        JSONObject signed = (JSONObject) ProtocolV2.parseCanonicalJson(encoded);
        assertEquals(new String(encoded, StandardCharsets.UTF_8), ProtocolV2.canonicalJson(signed));
        assertEquals("nearby-transfer", signed.getString("app"));
        assertEquals(2, signed.getLong("protocolVersion"));
        assertEquals("transfer-stream-control", signed.getString("type"));
        assertEquals(1, signed.getLong("controlProtocol"));
        assertEquals(0, signed.getLong("sequence"));
        assertEquals(NOW + V2SignedStreamControl.DEFAULT_TTL_MS, signed.getLong("expiresAt"));

        String encodedSignature = signed.getString("signature");
        assertFalse(encodedSignature.contains("="));
        byte[] signatureBytes = Base64.getUrlDecoder().decode(encodedSignature);
        assertEquals(64, signatureBytes.length);
        signed.remove("signature");

        Signature verifier = Signature.getInstance("Ed25519", "BC");
        verifier.initVerify(CryptoUtil.readPublicKey(alicePublicPem, "Ed25519"));
        verifier.update(ProtocolV2.canonicalJson(signed).getBytes(StandardCharsets.UTF_8));
        assertTrue(verifier.verify(signatureBytes));
    }

    @Test
    public void cancelRequiresAndRoundTripsOnlySupportedCodes() throws Exception {
        V2SignedStreamControl.Control cancel = new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_CANCEL,
            1,
            TASK_ID,
            BOB_ID,
            ALICE_ID,
            "receive",
            "protocol-error"
        );
        V2SignedStreamControl.Control decoded = aliceCodec(clock).decodeAndVerify(bobCodec(clock).encode(cancel));
        assertEquals(V2SignedStreamControl.COMMAND_CANCEL, decoded.type);
        assertEquals("receive", decoded.direction);
        assertEquals("protocol-error", decoded.code);

        assertFailure(() -> control(V2SignedStreamControl.COMMAND_CANCEL, ALICE_ID, BOB_ID, "send"));
        assertFailure(() -> new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_CANCEL, 1, TASK_ID, ALICE_ID, BOB_ID, "send", "other"
        ));
        assertFailure(() -> new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_START, 1, TASK_ID, ALICE_ID, BOB_ID, "send", "cancelled"
        ));
        assertFailure(() -> control("unknown", ALICE_ID, BOB_ID, "send"));
        assertFailure(() -> control(V2SignedStreamControl.COMMAND_START, ALICE_ID, BOB_ID, "both"));
        assertFailure(() -> new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_START, 2, TASK_ID, ALICE_ID, BOB_ID, "send"
        ));
    }

    @Test
    public void tamperIsRejectedWithoutAdvancingIncomingSequence() throws Exception {
        V2SignedStreamControl.Codec alice = aliceCodec(clock);
        V2SignedStreamControl.Codec bob = bobCodec(clock);
        byte[] valid = alice.encode(control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send"));
        JSONObject tampered = (JSONObject) ProtocolV2.parseCanonicalJson(valid);
        tampered.put("direction", "receive");

        assertFailure(() -> bob.decodeAndVerify(canonicalBytes(tampered)));
        assertEquals(V2SignedStreamControl.COMMAND_HELLO, bob.decodeAndVerify(valid).type);
    }

    @Test
    public void wrongKeyPeerAndTaskBindingsAreRejected() throws Exception {
        byte[] payload = aliceCodec(clock).encode(
            control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send")
        );
        String otherPublicPem = CryptoUtil.toPublicPem(otherKeys.getPublic());

        V2SignedStreamControl.Codec wrongKey = new V2SignedStreamControl.Codec(
            BOB_ID, bobPrivatePem, ALICE_ID, otherPublicPem, TASK_ID, clock::get
        );
        V2SignedStreamControl.Codec wrongPeer = new V2SignedStreamControl.Codec(
            BOB_ID, bobPrivatePem, OTHER_ID, alicePublicPem, TASK_ID, clock::get
        );
        V2SignedStreamControl.Codec wrongTask = new V2SignedStreamControl.Codec(
            BOB_ID, bobPrivatePem, ALICE_ID, alicePublicPem, OTHER_TASK_ID, clock::get
        );

        assertFailure(() -> wrongKey.decodeAndVerify(payload));
        assertFailure(() -> wrongPeer.decodeAndVerify(payload));
        assertFailure(() -> wrongTask.decodeAndVerify(payload));
    }

    @Test
    public void staleExpiredAndExcessivelyFutureControlsAreRejected() throws Exception {
        AtomicLong senderClock = new AtomicLong(NOW);
        AtomicLong receiverClock = new AtomicLong(NOW);
        V2SignedStreamControl.Codec sender = aliceCodec(senderClock, 100L);
        V2SignedStreamControl.Codec receiver = bobCodec(receiverClock);
        byte[] expiring = sender.encode(control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send"));
        receiverClock.set(NOW + 100L + V2SignedStreamControl.MAX_CLOCK_SKEW_MS + 1L);
        assertFailure(() -> receiver.decodeAndVerify(expiring));

        AtomicLong futureClock = new AtomicLong(NOW + V2SignedStreamControl.MAX_CLOCK_SKEW_MS + 1L);
        byte[] future = aliceCodec(futureClock).encode(
            control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send")
        );
        assertFailure(() -> bobCodec(new AtomicLong(NOW)).decodeAndVerify(future));

        assertFailure(() -> aliceCodec(clock, 0));
        assertFailure(() -> aliceCodec(clock, V2SignedStreamControl.MAX_TTL_MS + 1L));
    }

    @Test
    public void unknownAndMissingFieldsAreRejectedWithoutConsumingSequence() throws Exception {
        V2SignedStreamControl.Codec alice = aliceCodec(clock);
        V2SignedStreamControl.Codec bob = bobCodec(clock);
        byte[] valid = alice.encode(control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send"));
        JSONObject unknown = (JSONObject) ProtocolV2.parseCanonicalJson(valid);
        unknown.put("extra", true);
        JSONObject missing = (JSONObject) ProtocolV2.parseCanonicalJson(valid);
        missing.remove("direction");

        assertFailure(() -> bob.decodeAndVerify(canonicalBytes(unknown)));
        assertFailure(() -> bob.decodeAndVerify(canonicalBytes(missing)));
        assertEquals(V2SignedStreamControl.COMMAND_HELLO, bob.decodeAndVerify(valid).type);
    }

    @Test
    public void malformedAndOversizedPayloadsAreRejected() throws Exception {
        V2SignedStreamControl.Codec bob = bobCodec(clock);
        assertFailure(() -> bob.decodeAndVerify(new byte[V2SignedStreamControl.MAX_PAYLOAD_BYTES + 1]));
        assertFailure(() -> bob.decodeAndVerify(new byte[0]));
        assertFailure(() -> bob.decodeAndVerify(new byte[] { '{', '"', 'x', '"', ':', (byte) 0xc3, 0x28, '}' }));
        assertFailure(() -> bob.decodeAndVerify("{}".getBytes(StandardCharsets.UTF_8)));
        assertFailure(() -> bob.decodeAndVerify("{ \"app\":\"nearby-transfer\"}".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void replayAndOutOfOrderControlsDoNotAdvanceExpectedSequence() throws Exception {
        V2SignedStreamControl.Codec alice = aliceCodec(clock);
        V2SignedStreamControl.Codec bob = bobCodec(clock);
        byte[] zero = alice.encode(control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send"));
        byte[] one = alice.encode(control(V2SignedStreamControl.COMMAND_START, ALICE_ID, BOB_ID, "send"));

        assertFailure(() -> bob.decodeAndVerify(one));
        assertEquals(V2SignedStreamControl.COMMAND_HELLO, bob.decodeAndVerify(zero).type);
        assertFailure(() -> bob.decodeAndVerify(zero));
        assertEquals(V2SignedStreamControl.COMMAND_START, bob.decodeAndVerify(one).type);

        JSONObject first = (JSONObject) ProtocolV2.parseCanonicalJson(zero);
        JSONObject second = (JSONObject) ProtocolV2.parseCanonicalJson(one);
        assertEquals(0, first.getLong("sequence"));
        assertEquals(1, second.getLong("sequence"));
    }

    @Test
    public void base64urlAndIdentityBindingsAreStrict() throws Exception {
        assertFailure(() -> new V2SignedStreamControl.Codec(
            "AAAAAAAAAAAAAAAA", alicePrivatePem, BOB_ID, bobPublicPem, TASK_ID, clock::get
        ));
        assertFailure(() -> new V2SignedStreamControl.Codec(
            ALICE_ID, alicePrivatePem, ALICE_ID, bobPublicPem, TASK_ID, clock::get
        ));
        assertFailure(() -> new V2SignedStreamControl.Codec(
            ALICE_ID, alicePrivatePem, BOB_ID, bobPublicPem, TASK_ID + "=", clock::get
        ));
        assertFailure(() -> new V2SignedStreamControl.Codec(
            ALICE_ID, alicePrivatePem, BOB_ID, bobPublicPem, "AA", clock::get
        ));
    }

    @Test
    public void codecRejectsWrongCoreBindingAndDirectionChanges() throws Exception {
        V2SignedStreamControl.Codec alice = aliceCodec(clock);
        assertFailure(() -> alice.encode(control(V2SignedStreamControl.COMMAND_HELLO, BOB_ID, ALICE_ID, "send")));
        assertFailure(() -> alice.encode(new V2SignedStreamControl.Control(
            V2SignedStreamControl.COMMAND_HELLO, 1, OTHER_TASK_ID, ALICE_ID, BOB_ID, "send"
        )));
        alice.encode(control(V2SignedStreamControl.COMMAND_HELLO, ALICE_ID, BOB_ID, "send"));
        assertFailure(() -> alice.encode(control(V2SignedStreamControl.COMMAND_START, ALICE_ID, BOB_ID, "receive")));
    }

    private static V2SignedStreamControl.Control control(
        String type,
        String fromPeerId,
        String toPeerId,
        String direction
    ) {
        return new V2SignedStreamControl.Control(type, 1, TASK_ID, fromPeerId, toPeerId, direction);
    }

    private V2SignedStreamControl.Codec aliceCodec(AtomicLong source) throws Exception {
        return aliceCodec(source, V2SignedStreamControl.DEFAULT_TTL_MS);
    }

    private V2SignedStreamControl.Codec aliceCodec(AtomicLong source, long ttl) throws Exception {
        return new V2SignedStreamControl.Codec(
            ALICE_ID,
            alicePrivatePem,
            BOB_ID,
            bobPublicPem,
            TASK_ID,
            source::get,
            ttl
        );
    }

    private V2SignedStreamControl.Codec bobCodec(AtomicLong source) throws Exception {
        return new V2SignedStreamControl.Codec(
            BOB_ID,
            bobPrivatePem,
            ALICE_ID,
            alicePublicPem,
            TASK_ID,
            source::get
        );
    }

    private static byte[] canonicalBytes(JSONObject json) {
        return ProtocolV2.canonicalJson(json).getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject loadSharedFixture() throws Exception {
        try (InputStream input = V2SignedStreamControlTest.class
            .getResourceAsStream("/protocol-v2-transfer-auth.json")) {
            if (input == null) throw new AssertionError("Missing shared transfer-auth fixture");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected protocol input to be rejected");
        } catch (IllegalArgumentException | IllegalStateException expected) {
            // Expected.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
