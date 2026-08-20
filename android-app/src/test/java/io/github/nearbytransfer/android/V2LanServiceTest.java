package io.github.nearbytransfer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.security.KeyPair;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Loopback tests for the bounded protocol-v2 TCP bootstrap transport. */
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

    @Test
    public void dispatchesEnabledTransferManifestAndClosesUnlessDetached() throws Exception {
        CountDownLatch manifestReceived = new CountDownLatch(1);
        AtomicReference<V2WireFrame.Frame> received = new AtomicReference<>();
        AtomicReference<Exception> protocolError = new AtomicReference<>();
        V2LanService service = new V2LanService(noopControlHandler(), (frame, connection) -> {
            received.set(frame);
            manifestReceived.countDown();
        }, listener(protocolError));

        try {
            int port = service.start(0);
            try (Socket socket = new Socket("127.0.0.1", port)) {
                socket.setSoTimeout(3_000);
                write(socket, V2TransferMessage.TYPE_MANIFEST, "manifest".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                assertTrue("The transfer manifest was not dispatched", manifestReceived.await(3, TimeUnit.SECONDS));
                assertEquals(-1, socket.getInputStream().read());
            }
            assertNotNull(received.get());
            assertEquals(V2TransferMessage.TYPE_MANIFEST, received.get().header.getString("type"));
            assertEquals(null, protocolError.get());
        } finally {
            service.close();
        }
    }

    @Test
    public void detachedTransferSocketSurvivesBootstrapServiceShutdown() throws Exception {
        CountDownLatch detached = new CountDownLatch(1);
        AtomicReference<Socket> transferredSocket = new AtomicReference<>();
        AtomicReference<Exception> protocolError = new AtomicReference<>();
        V2LanService service = new V2LanService(noopControlHandler(), (frame, connection) -> {
            transferredSocket.set(connection.detachForTransfer());
            detached.countDown();
        }, listener(protocolError));

        Socket client = null;
        Socket serverSide = null;
        try {
            int port = service.start(0);
            client = new Socket("127.0.0.1", port);
            write(client, V2TransferMessage.TYPE_MANIFEST, "manifest".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertTrue("The transfer socket was not detached", detached.await(3, TimeUnit.SECONDS));
            serverSide = transferredSocket.get();
            assertNotNull(serverSide);

            service.close();
            client.getOutputStream().write(0x2a);
            client.getOutputStream().flush();
            serverSide.setSoTimeout(3_000);
            InputStream input = serverSide.getInputStream();
            assertEquals(0x2a, input.read());
            assertFalse(serverSide.isClosed());
            assertEquals(null, protocolError.get());
        } finally {
            if (client != null) client.close();
            if (serverSide != null) serverSide.close();
            service.close();
        }
    }

    @Test
    public void transferHandlerCanSendOneDecisionBeforeConnectionCloses() throws Exception {
        AtomicReference<Exception> protocolError = new AtomicReference<>();
        byte[] decisionPayload = "decision".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        V2LanService service = new V2LanService(noopControlHandler(), (frame, connection) -> {
            JSONObject header = new JSONObject();
            header.put("app", ProtocolV2.APP_ID);
            header.put("protocolVersion", ProtocolV2.VERSION);
            header.put("type", V2TransferMessage.TYPE_DECISION);
            connection.sendTransferDecisionFrame(new V2WireFrame.Frame(header, decisionPayload));
        }, listener(protocolError));

        try {
            int port = service.start(0);
            try (Socket socket = new Socket("127.0.0.1", port)) {
                socket.setSoTimeout(3_000);
                write(socket, V2TransferMessage.TYPE_MANIFEST, "manifest".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                V2WireFrame.Frame response = V2WireFrame.decode(socket.getInputStream().readAllBytes());
                assertEquals(V2TransferMessage.TYPE_DECISION, response.header.getString("type"));
                assertTrue(java.util.Arrays.equals(decisionPayload, response.payload));
            }
            assertEquals(null, protocolError.get());
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

    private static V2LanService.ControlHandler noopControlHandler() {
        return new V2LanService.ControlHandler() {
            @Override public void onOffer(V2Pairing.Offer offer, String signature, V2LanService.Connection connection) {
                throw new AssertionError("Unexpected offer");
            }
            @Override public void onConfirmation(V2Pairing.Confirmation confirmation, String signature, V2LanService.Connection connection) {
                throw new AssertionError("Unexpected confirmation");
            }
            @Override public void onCancellation(V2Pairing.Cancellation cancellation, String signature, V2LanService.Connection connection) {
                throw new AssertionError("Unexpected cancellation");
            }
            @Override public void onConnectionClosed(V2LanService.Binding binding) { }
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
