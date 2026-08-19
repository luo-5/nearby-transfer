package io.github.nearbytransfer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.OutputStream;
import java.net.Socket;
import java.security.KeyPair;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Loopback tests for the bounded pairing-only TCP bootstrap transport. */
public final class V2LanServiceTest {
    @Test
    public void dispatchesSignedOfferAndBindsTheConnection() throws Exception {
        CountDownLatch offerReceived = new CountDownLatch(1);
        AtomicReference<V2LanService.Binding> receivedBinding = new AtomicReference<>();
        AtomicReference<Exception> protocolError = new AtomicReference<>();
        V2LanService service = new V2LanService(new V2LanService.ControlHandler() {
            @Override public void onOffer(V2Pairing.Offer offer, String signature, V2LanService.Connection connection) {
                receivedBinding.set(connection.binding());
                offerReceived.countDown();
            }
            @Override public void onConfirmation(V2Pairing.Confirmation confirmation, String signature, V2LanService.Connection connection) {
                throw new AssertionError("Unexpected confirmation");
            }
            @Override public void onCancellation(V2Pairing.Cancellation cancellation, String signature, V2LanService.Connection connection) {
                throw new AssertionError("Unexpected cancellation");
            }
            @Override public void onConnectionClosed(V2LanService.Binding binding) { }
        }, listener(protocolError));

        try {
            int port = service.start(0);
            Peer peer = createPeer("Remote Android");
            V2Pairing.Offer offer = V2Pairing.createOffer(peer.identity, Collections.singletonList("pairing"));
            String signature = V2Pairing.signOffer(offer, peer.signingPrivateKey);
            try (Socket socket = new Socket("127.0.0.1", port)) {
                write(socket, V2Pairing.TYPE_OFFER, V2ControlMessage.encodeOffer(offer, signature));
                assertTrue("The pairing offer was not dispatched", offerReceived.await(3, TimeUnit.SECONDS));
            }

            assertNotNull(receivedBinding.get());
            assertEquals(offer.pairingId, receivedBinding.get().pairingId());
            assertEquals(peer.identity.deviceId, receivedBinding.get().remoteDeviceId());
            assertEquals(null, receivedBinding.get().expectedDeviceId());
            assertEquals(null, protocolError.get());
        } finally {
            service.close();
        }
    }

    @Test
    public void rejectsNonPairingProtocolFramesBeforeDispatch() throws Exception {
        CountDownLatch errorReceived = new CountDownLatch(1);
        AtomicInteger dispatched = new AtomicInteger();
        AtomicReference<Exception> protocolError = new AtomicReference<>();
        V2LanService service = new V2LanService(new V2LanService.ControlHandler() {
            @Override public void onOffer(V2Pairing.Offer offer, String signature, V2LanService.Connection connection) { dispatched.incrementAndGet(); }
            @Override public void onConfirmation(V2Pairing.Confirmation confirmation, String signature, V2LanService.Connection connection) { dispatched.incrementAndGet(); }
            @Override public void onCancellation(V2Pairing.Cancellation cancellation, String signature, V2LanService.Connection connection) { dispatched.incrementAndGet(); }
            @Override public void onConnectionClosed(V2LanService.Binding binding) { }
        }, new V2LanService.Listener() {
            @Override public void onStatus(String message) { }
            @Override public void onProtocolError(String remoteAddress, Exception error) {
                protocolError.set(error);
                errorReceived.countDown();
            }
        });

        try {
            int port = service.start(0);
            try (Socket socket = new Socket("127.0.0.1", port)) {
                write(socket, "transfer-manifest", new byte[0]);
                assertTrue("The non-pairing frame was not rejected", errorReceived.await(3, TimeUnit.SECONDS));
            }
            assertEquals(0, dispatched.get());
            assertNotNull(protocolError.get());
            assertTrue(protocolError.get().getMessage().contains("only accepts pairing control frames"));
        } finally {
            service.close();
        }
    }

    private static V2LanService.Listener listener(AtomicReference<Exception> protocolError) {
        return new V2LanService.Listener() {
            @Override public void onStatus(String message) { }
            @Override public void onProtocolError(String remoteAddress, Exception error) { protocolError.set(error); }
        };
    }

    private static void write(Socket socket, String type, byte[] payload) throws Exception {
        JSONObject header = new JSONObject();
        header.put("app", ProtocolV2.APP_ID);
        header.put("protocolVersion", ProtocolV2.VERSION);
        header.put("type", type);
        OutputStream output = socket.getOutputStream();
        output.write(V2WireFrame.encode(new V2WireFrame.Frame(header, payload)));
        output.flush();
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

    private static final class Peer {
        final V2Identity identity;
        final String signingPrivateKey;

        Peer(V2Identity identity, String signingPrivateKey) {
            this.identity = identity;
            this.signingPrivateKey = signingPrivateKey;
        }
    }
}
