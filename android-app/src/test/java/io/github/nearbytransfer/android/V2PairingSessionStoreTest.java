package io.github.nearbytransfer.android;

import org.junit.Test;

import java.security.KeyPair;
import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class V2PairingSessionStoreTest {
    private static final long NOW = 1_760_000_000_000L;

    @Test
    public void completesSignedTwoPartyHandshakeWithMatchingSas() throws Exception {
        Peer initiator = createPeer("Initiator");
        Peer responder = createPeer("Responder");
        V2PairingSessionStore initiatorStore = initiator.newStore();
        V2PairingSessionStore responderStore = responder.newStore();

        V2PairingSessionStore.SignedOffer initiatorOffer = initiatorStore.startOutgoing(Arrays.asList("pairing"), NOW);
        V2PairingSessionStore.Session responderSession = responderStore.receiveIncomingOffer(
            initiatorOffer.offer, initiatorOffer.signature, NOW + 1L
        );
        assertEquals(V2PairingSessionStore.Role.RESPONDER, responderSession.role);
        assertEquals(V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION, responderSession.status);

        V2PairingSessionStore.SignedOffer responderOffer = responderStore.respondToIncomingOffer(
            initiatorOffer.offer.pairingId, Arrays.asList("pairing"), NOW + 2L
        );
        V2PairingSessionStore.Session initiatorSession = initiatorStore.receiveRemoteOffer(
            initiatorOffer.offer.pairingId, responderOffer.offer, responderOffer.signature, NOW + 3L
        );
        assertEquals(initiatorSession.pairingCode, responderSession.pairingCode);
        assertEquals(6, initiatorSession.pairingCode.length());

        V2PairingSessionStore.SignedConfirmation initiatorConfirmation = initiatorStore.createLocalConfirmation(
            initiatorOffer.offer.pairingId, NOW + 4L
        );
        V2PairingSessionStore.SignedConfirmation responderConfirmation = responderStore.createLocalConfirmation(
            initiatorOffer.offer.pairingId, NOW + 5L
        );

        V2PairingSessionStore.Session initiatorReady = initiatorStore.receiveRemoteConfirmation(
            initiatorOffer.offer.pairingId, responderConfirmation.confirmation, responderConfirmation.signature, NOW + 6L
        );
        V2PairingSessionStore.Session responderReady = responderStore.receiveRemoteConfirmation(
            initiatorOffer.offer.pairingId, initiatorConfirmation.confirmation, initiatorConfirmation.signature, NOW + 7L
        );
        assertEquals(V2PairingSessionStore.Status.READY_TO_TRUST, initiatorReady.status);
        assertEquals(V2PairingSessionStore.Status.READY_TO_TRUST, responderReady.status);
        assertEquals(responder.identity.deviceId, initiatorReady.peerOffer.identity.deviceId);
        assertEquals(initiator.identity.deviceId, responderReady.peerOffer.identity.deviceId);

        assertEquals(V2PairingSessionStore.Status.COMPLETED,
            initiatorStore.complete(initiatorOffer.offer.pairingId, NOW + 8L).status);
    }

    @Test
    public void rejectsWrongSasAndInvalidSignaturesWithoutConfirmingSession() throws Exception {
        Peer initiator = createPeer("Initiator");
        Peer responder = createPeer("Responder");
        V2PairingSessionStore initiatorStore = initiator.newStore();
        V2PairingSessionStore responderStore = responder.newStore();
        V2PairingSessionStore.SignedOffer initiatorOffer = initiatorStore.startOutgoing(Arrays.asList("pairing"), NOW);

        assertFailure(() -> responderStore.receiveIncomingOffer(initiatorOffer.offer, "not-a-signature", NOW + 1L));
        responderStore.receiveIncomingOffer(initiatorOffer.offer, initiatorOffer.signature, NOW + 1L);
        V2PairingSessionStore.SignedOffer responderOffer = responderStore.respondToIncomingOffer(
            initiatorOffer.offer.pairingId, Arrays.asList("pairing"), NOW + 2L
        );
        initiatorStore.receiveRemoteOffer(initiatorOffer.offer.pairingId, responderOffer.offer, responderOffer.signature, NOW + 3L);
        initiatorStore.createLocalConfirmation(initiatorOffer.offer.pairingId, NOW + 4L);

        V2Pairing.Confirmation wrongCode = V2Pairing.createConfirmation(
            initiatorOffer.offer.pairingId, NOW + 5L, responder.identity.deviceId, "000000"
        );
        String validWrongCodeSignature = V2Pairing.signConfirmation(wrongCode, responder.signingPrivateKey);
        assertFailure(() -> initiatorStore.receiveRemoteConfirmation(
            initiatorOffer.offer.pairingId, wrongCode, validWrongCodeSignature, NOW + 5L
        ));
        assertEquals(V2PairingSessionStore.Status.AWAITING_REMOTE_CONFIRMATION,
            initiatorStore.get(initiatorOffer.offer.pairingId, true, NOW + 5L).status);

        V2PairingSessionStore.SignedConfirmation responderConfirmation = responderStore.createLocalConfirmation(
            initiatorOffer.offer.pairingId, NOW + 6L
        );
        assertFailure(() -> initiatorStore.receiveRemoteConfirmation(
            initiatorOffer.offer.pairingId, responderConfirmation.confirmation, "invalid", NOW + 6L
        ));
        assertEquals(V2PairingSessionStore.Status.AWAITING_REMOTE_CONFIRMATION,
            initiatorStore.get(initiatorOffer.offer.pairingId, true, NOW + 6L).status);
    }

    @Test
    public void expiresSessionsAtExactlyOneHundredTwentySeconds() throws Exception {
        Peer initiator = createPeer("Initiator");
        V2PairingSessionStore store = initiator.newStore();
        V2PairingSessionStore.SignedOffer offer = store.startOutgoing(Arrays.asList("pairing"), NOW);

        assertNotNull(store.get(offer.offer.pairingId, false, NOW + V2PairingSessionStore.PAIRING_SESSION_TTL_MS - 1L));
        assertNull(store.get(offer.offer.pairingId, false, NOW + V2PairingSessionStore.PAIRING_SESSION_TTL_MS));
        assertEquals(V2PairingSessionStore.Status.EXPIRED,
            store.get(offer.offer.pairingId, true, NOW + V2PairingSessionStore.PAIRING_SESSION_TTL_MS).status);
    }

    @Test
    public void cancelsActiveSessionAndHidesItFromActiveReads() throws Exception {
        Peer initiator = createPeer("Initiator");
        V2PairingSessionStore store = initiator.newStore();
        V2PairingSessionStore.SignedOffer offer = store.startOutgoing(Arrays.asList("pairing"), NOW);

        assertTrue(store.cancel(offer.offer.pairingId, "user-cancelled", NOW + 1L));
        assertNull(store.get(offer.offer.pairingId, false, NOW + 1L));
        V2PairingSessionStore.Session terminal = store.get(offer.offer.pairingId, true, NOW + 1L);
        assertNotNull(terminal);
        assertEquals(V2PairingSessionStore.Status.CANCELLED, terminal.status);
        assertEquals("user-cancelled", terminal.cancellationReason);
    }

    private static Peer createPeer(String name) throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());
        return new Peer(
            V2Identity.create(
                CryptoUtil.deviceIdFor(signingPublicKey),
                name,
                CryptoUtil.fingerprintFor(signingPublicKey),
                signingPublicKey,
                CryptoUtil.toPublicPem(encryption.getPublic())
            ),
            CryptoUtil.toPrivatePem(signing.getPrivate())
        );
    }

    private static void assertFailure(ThrowingRunnable action) {
        try {
            action.run();
            fail("Expected operation to fail");
        } catch (IllegalArgumentException expected) {
            // Expected untrusted input rejection.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static final class Peer {
        final V2Identity identity;
        final String signingPrivateKey;

        Peer(V2Identity identity, String signingPrivateKey) {
            this.identity = identity;
            this.signingPrivateKey = signingPrivateKey;
        }

        V2PairingSessionStore newStore() {
            return new V2PairingSessionStore(identity, signingPrivateKey);
        }
    }
}