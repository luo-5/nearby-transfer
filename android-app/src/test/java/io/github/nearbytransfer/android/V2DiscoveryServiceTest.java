package io.github.nearbytransfer.android;

import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class V2DiscoveryServiceTest {
    private MutableClock clock;
    private TestPeerListener peerListener;
    private V2DiscoveryService service;
    private IdentityMaterial local;
    private IdentityMaterial remote;

    @Before
    public void setUp() throws Exception {
        clock = new MutableClock(1_760_000_000_000L);
        local = createIdentity("Android local");
        remote = createIdentity("Desktop remote");
        peerListener = new TestPeerListener();
        service = new V2DiscoveryService(
            local.identity,
            local.privateKey,
            47778,
            Arrays.asList("pairing", "transfer"),
            EmptyTransport::new,
            clock,
            peerListener,
            error -> { throw new AssertionError("Unexpected discovery error", error); },
            status -> { },
            Runnable::run
        );
    }

    @Test
    public void emitsAValidSignedAnnouncementWithoutOpeningNetwork() throws Exception {
        byte[] data = service.buildAnnouncement(clock.nowEpochMillis());
        V2DiscoveryAnnouncement parsed = V2DiscoveryAnnouncement.parseAndVerify(data, 0, data.length, clock.nowEpochMillis());

        assertEquals(local.identity.deviceId, parsed.identity.deviceId);
        assertEquals(47778, parsed.port);
        assertEquals(Arrays.asList("pairing", "transfer"), parsed.capabilities);
    }

    @Test
    public void addsPeersByDeviceIdAndRefreshesTheirTtl() throws Exception {
        byte[] remoteAnnouncement = signedAnnouncement(remote, 49152, Arrays.asList("pairing"));

        service.acceptDatagram(remoteAnnouncement, "192.0.2.20");
        assertEquals(1, service.listPeers().size());
        assertEquals(remote.identity.deviceId, service.listPeers().get(0).deviceId);
        assertEquals("192.0.2.20", service.listPeers().get(0).host);
        assertEquals(1, peerListener.peerIds.size());
        assertEquals(remote.identity.deviceId, peerListener.peerIds.get(0));
        assertEquals(1, peerListener.snapshots.size());

        clock.advance(PEER_REFRESH_MS);
        service.acceptDatagram(remoteAnnouncement, "192.0.2.20");
        assertEquals("A repeated identical announcement does not spam callbacks", 1, peerListener.peerIds.size());

        clock.advance(V2DiscoveryService.PEER_TTL_MS - 1L);
        service.prunePeers(clock.nowEpochMillis());
        assertEquals(1, service.listPeers().size());

        clock.advance(1L);
        service.prunePeers(clock.nowEpochMillis());
        assertTrue(service.listPeers().isEmpty());
        assertEquals("One snapshot for addition and one for expiry", 2, peerListener.snapshots.size());
        assertTrue(peerListener.snapshots.get(1).isEmpty());
    }

    @Test
    public void updatesAnExistingDeviceWhenItsAuthenticatedEndpointChanges() throws Exception {
        service.acceptDatagram(signedAnnouncement(remote, 49152, Arrays.asList("pairing")), "192.0.2.20");
        clock.advance(1L);
        service.acceptDatagram(signedAnnouncement(remote, 49153, Arrays.asList("pairing")), "192.0.2.21");

        List<V2DiscoveryService.Peer> peers = service.listPeers();
        assertEquals(1, peers.size());
        assertEquals(49153, peers.get(0).port);
        assertEquals("192.0.2.21", peers.get(0).host);
        assertEquals(2, peerListener.peerIds.size());
    }

    @Test
    public void ignoresSelfInvalidAndStaleAnnouncements() throws Exception {
        service.acceptDatagram(service.buildAnnouncement(clock.nowEpochMillis()), "192.0.2.10");
        assertTrue(service.listPeers().isEmpty());

        byte[] invalid = signedAnnouncement(remote, 49152, Arrays.asList("pairing"));
        invalid[invalid.length - 2] ^= 1;
        service.acceptDatagram(invalid, "192.0.2.20");

        byte[] stale = signedAnnouncement(remote, 49152, Arrays.asList("pairing"), clock.nowEpochMillis() - V2DiscoveryAnnouncement.MAX_CLOCK_SKEW_MS - 1L);
        service.acceptDatagram(stale, "192.0.2.20");

        assertTrue(service.listPeers().isEmpty());
        assertFalse("Invalid packets do not become application errors", peerListener.sawPeer());
    }

    private byte[] signedAnnouncement(IdentityMaterial material, int port, List<String> capabilities) throws Exception {
        return signedAnnouncement(material, port, capabilities, clock.nowEpochMillis());
    }

    private static byte[] signedAnnouncement(IdentityMaterial material, int port, List<String> capabilities, long issuedAt) throws Exception {
        V2DiscoveryAnnouncement unsigned = V2DiscoveryAnnouncement.create(material.identity, port, capabilities, issuedAt);
        String signature = V2DiscoveryAnnouncement.sign(unsigned, material.privateKey);
        return unsigned.toCanonicalJson(signature).getBytes(StandardCharsets.UTF_8);
    }

    private static IdentityMaterial createIdentity(String name) throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublic = CryptoUtil.toPublicPem(signing.getPublic());
        String encryptionPublic = CryptoUtil.toPublicPem(encryption.getPublic());
        V2Identity identity = V2Identity.create(
            CryptoUtil.deviceIdFor(signingPublic),
            name,
            CryptoUtil.fingerprintFor(signingPublic),
            signingPublic,
            encryptionPublic
        );
        return new IdentityMaterial(identity, CryptoUtil.toPrivatePem(signing.getPrivate()));
    }

    private static final long PEER_REFRESH_MS = 4_000L;

    private static final class IdentityMaterial {
        final V2Identity identity;
        final String privateKey;

        IdentityMaterial(V2Identity identity, String privateKey) {
            this.identity = identity;
            this.privateKey = privateKey;
        }
    }

    private static final class MutableClock implements V2DiscoveryService.Clock {
        private long now;

        MutableClock(long now) {
            this.now = now;
        }

        @Override
        public long nowEpochMillis() {
            return now;
        }

        void advance(long milliseconds) {
            now += milliseconds;
        }
    }

    private static final class TestPeerListener implements V2DiscoveryService.PeerListener {
        final List<String> peerIds = new ArrayList<>();
        final List<List<V2DiscoveryService.Peer>> snapshots = new ArrayList<>();

        @Override
        public void onPeer(String deviceId, V2DiscoveryService.Peer peer) {
            peerIds.add(deviceId);
        }

        @Override
        public void onPeers(List<V2DiscoveryService.Peer> peers) {
            snapshots.add(peers);
        }

        boolean sawPeer() {
            return !peerIds.isEmpty();
        }
    }

    private static final class EmptyTransport implements V2DiscoveryService.Transport {
        @Override
        public void open() {
        }

        @Override
        public void send(byte[] data) {
        }

        @Override
        public V2DiscoveryService.ReceivedDatagram receive() throws InterruptedException {
            Thread.sleep(Long.MAX_VALUE);
            return null;
        }

        @Override
        public void close() {
        }
    }
}
