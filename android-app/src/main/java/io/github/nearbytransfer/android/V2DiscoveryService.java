package io.github.nearbytransfer.android;

import android.content.Context;
import android.net.wifi.WifiManager;

import java.io.Closeable;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Protocol v2 LAN discovery service.
 *
 * <p>This service is intentionally separate from the legacy {@link DiscoveryService}:
 * it only accepts signed {@link V2DiscoveryAnnouncement} datagrams and never falls
 * back to protocol v1. Discovery authenticates an endpoint hint; it does not grant
 * trust or start a transfer.</p>
 */
final class V2DiscoveryService implements Closeable {
    static final String MULTICAST_ADDRESS = "239.255.77.77";
    static final int DISCOVERY_PORT = 47777;
    static final long PEER_TTL_MS = 10_000L;
    static final long ANNOUNCE_INTERVAL_MS = 2_000L;
    static final long PRUNE_INTERVAL_MS = 1_000L;

    interface PeerListener {
        /** Called when the latest authenticated announcement for one device changes. */
        void onPeer(String deviceId, Peer peer);

        /** Called with an immutable, deterministic snapshot after the peer set changes. */
        void onPeers(List<Peer> peers);
    }

    interface ErrorListener {
        void onError(Exception error);
    }

    interface StatusListener {
        void onStatus(String message);
    }

    interface Clock {
        long nowEpochMillis();
    }

    interface TransportFactory {
        Transport create() throws Exception;
    }

    interface Transport extends Closeable {
        void open() throws Exception;

        void send(byte[] data) throws Exception;

        ReceivedDatagram receive() throws Exception;
    }

    static final class ReceivedDatagram {
        final byte[] data;
        final String host;

        ReceivedDatagram(byte[] data, String host) {
            this.data = data == null ? null : data.clone();
            this.host = host;
        }
    }

    /** Immutable peer projection safe to retain from listener callbacks. */
    static final class Peer {
        final String deviceId;
        final String deviceName;
        final String fingerprint;
        final String signingPublicKey;
        final String encryptionPublicKey;
        final String host;
        final int port;
        final List<String> capabilities;
        final long announcedAtEpochMillis;
        final long lastSeenEpochMillis;

        private Peer(V2DiscoveryAnnouncement announcement, String host, long lastSeenEpochMillis) {
            this(
                announcement.identity.deviceId,
                announcement.identity.deviceName,
                announcement.identity.fingerprint,
                announcement.identity.signingPublicKey,
                announcement.identity.encryptionPublicKey,
                host,
                announcement.port,
                announcement.capabilities,
                announcement.issuedAt,
                lastSeenEpochMillis
            );
        }

        private Peer(
            String deviceId,
            String deviceName,
            String fingerprint,
            String signingPublicKey,
            String encryptionPublicKey,
            String host,
            int port,
            List<String> capabilities,
            long announcedAtEpochMillis,
            long lastSeenEpochMillis
        ) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.fingerprint = fingerprint;
            this.signingPublicKey = signingPublicKey;
            this.encryptionPublicKey = encryptionPublicKey;
            this.host = host;
            this.port = port;
            this.capabilities = Collections.unmodifiableList(new ArrayList<>(capabilities));
            this.announcedAtEpochMillis = announcedAtEpochMillis;
            this.lastSeenEpochMillis = lastSeenEpochMillis;
        }

        private Peer withLastSeen(long lastSeenEpochMillis) {
            return new Peer(
                deviceId,
                deviceName,
                fingerprint,
                signingPublicKey,
                encryptionPublicKey,
                host,
                port,
                capabilities,
                announcedAtEpochMillis,
                lastSeenEpochMillis
            );
        }

        private boolean hasSameEndpointAndIdentity(V2DiscoveryAnnouncement announcement, String otherHost) {
            return host.equals(otherHost)
                && port == announcement.port
                && deviceName.equals(announcement.identity.deviceName)
                && fingerprint.equals(announcement.identity.fingerprint)
                && signingPublicKey.equals(announcement.identity.signingPublicKey)
                && encryptionPublicKey.equals(announcement.identity.encryptionPublicKey)
                && capabilities.equals(announcement.capabilities);
        }
    }

    private final V2Identity localIdentity;
    private final String signingPrivateKey;
    private final int advertisedTcpPort;
    private final List<String> capabilities;
    private final TransportFactory transportFactory;
    private final Clock clock;
    private final PeerListener peerListener;
    private final ErrorListener errorListener;
    private final StatusListener statusListener;
    private final Executor callbackExecutor;
    private final Map<String, Peer> peers = new HashMap<>();
    private final Object lifecycleLock = new Object();
    private final Object peersLock = new Object();

    private volatile boolean running;
    private volatile Transport transport;
    private ScheduledExecutorService scheduler;
    private ExecutorService ioExecutor;

    V2DiscoveryService(
        Context context,
        DeviceConfig device,
        int advertisedTcpPort,
        List<String> capabilities,
        PeerListener peerListener,
        ErrorListener errorListener,
        StatusListener statusListener
    ) throws Exception {
        this(
            V2Identity.fromDevice(device),
            device.signingPrivateKey,
            advertisedTcpPort,
            capabilities,
            new AndroidMulticastTransportFactory(context),
            System::currentTimeMillis,
            peerListener,
            errorListener,
            statusListener,
            null
        );
    }

    /**
     * Injectable constructor for JVM tests. The supplied transport must not call UI
     * code from {@link Transport#receive()}; callbacks are dispatched separately.
     */
    V2DiscoveryService(
        V2Identity localIdentity,
        String signingPrivateKey,
        int advertisedTcpPort,
        List<String> capabilities,
        TransportFactory transportFactory,
        Clock clock,
        PeerListener peerListener,
        ErrorListener errorListener,
        StatusListener statusListener,
        Executor callbackExecutor
    ) {
        if (localIdentity == null || signingPrivateKey == null || signingPrivateKey.trim().isEmpty()) {
            throw new IllegalArgumentException("A local protocol v2 identity and signing private key are required");
        }
        if (advertisedTcpPort < 1 || advertisedTcpPort > 65535) {
            throw new IllegalArgumentException("The advertised TCP port is invalid");
        }
        if (transportFactory == null || clock == null) {
            throw new IllegalArgumentException("Discovery transport and clock are required");
        }
        // Reuse announcement validation so invalid local capability sets fail before networking starts.
        V2DiscoveryAnnouncement.create(localIdentity, advertisedTcpPort, capabilities, 1L);
        this.localIdentity = localIdentity;
        this.signingPrivateKey = signingPrivateKey;
        this.advertisedTcpPort = advertisedTcpPort;
        this.capabilities = Collections.unmodifiableList(new ArrayList<>(capabilities));
        this.transportFactory = transportFactory;
        this.clock = clock;
        this.peerListener = peerListener;
        this.errorListener = errorListener;
        this.statusListener = statusListener;
        this.callbackExecutor = callbackExecutor == null ? Runnable::run : callbackExecutor;
    }

    void start() {
        synchronized (lifecycleLock) {
            if (running) {
                return;
            }
            running = true;
            ioExecutor = Executors.newSingleThreadExecutor();
            scheduler = Executors.newScheduledThreadPool(2);
            ioExecutor.execute(this::openAndReceive);
            scheduler.scheduleAtFixedRate(this::announceSafely, 0, ANNOUNCE_INTERVAL_MS, TimeUnit.MILLISECONDS);
            scheduler.scheduleAtFixedRate(this::prunePeersSafely, PRUNE_INTERVAL_MS, PRUNE_INTERVAL_MS, TimeUnit.MILLISECONDS);
        }
        notifyStatus("协议 v2 发现服务启动，UDP 端口 " + DISCOVERY_PORT);
    }

    void stop() {
        ScheduledExecutorService scheduled;
        ExecutorService io;
        Transport activeTransport;
        synchronized (lifecycleLock) {
            if (!running && scheduler == null && ioExecutor == null && transport == null) {
                return;
            }
            running = false;
            scheduled = scheduler;
            scheduler = null;
            io = ioExecutor;
            ioExecutor = null;
            activeTransport = transport;
            transport = null;
        }
        if (scheduled != null) {
            scheduled.shutdownNow();
        }
        closeQuietly(activeTransport);
        if (io != null) {
            io.shutdownNow();
        }
        synchronized (peersLock) {
            peers.clear();
        }
        notifyStatus("协议 v2 发现服务已停止");
    }

    @Override
    public void close() {
        stop();
    }

    /** Queues an immediate signed announcement without blocking the caller/UI thread. */
    void announce() {
        ExecutorService io;
        synchronized (lifecycleLock) {
            io = ioExecutor;
        }
        if (running && io != null) {
            try {
                io.execute(this::announceSafely);
            } catch (RejectedExecutionException ignored) {
                // stop() won the race; there is nothing to announce.
            }
        }
    }

    List<Peer> listPeers() {
        prunePeers(clock.nowEpochMillis());
        synchronized (peersLock) {
            return snapshotLocked();
        }
    }

    /**
     * Pure ingestion boundary used by the receive loop and JVM tests. Invalid packets,
     * loopback packets and stale announcements are deliberately ignored without error
     * callbacks because they are expected on a shared LAN multicast group.
     */
    void acceptDatagram(byte[] data, String host) {
        if (data == null || host == null || host.trim().isEmpty()) {
            return;
        }
        final V2DiscoveryAnnouncement announcement;
        try {
            announcement = V2DiscoveryAnnouncement.parseAndVerify(data, 0, data.length, clock.nowEpochMillis());
        } catch (Exception ignored) {
            return;
        }
        if (localIdentity.deviceId.equals(announcement.identity.deviceId)) {
            return;
        }

        final Peer updated;
        final boolean changed;
        synchronized (peersLock) {
            Peer existing = peers.get(announcement.identity.deviceId);
            if (existing == null || !existing.hasSameEndpointAndIdentity(announcement, host)) {
                updated = new Peer(announcement, host, clock.nowEpochMillis());
                peers.put(updated.deviceId, updated);
                changed = true;
            } else {
                updated = existing.withLastSeen(clock.nowEpochMillis());
                peers.put(updated.deviceId, updated);
                changed = false;
            }
        }
        if (changed) {
            notifyPeer(updated);
            notifyPeersChanged();
        }
    }

    /** Package-private deterministic TTL boundary for JVM tests. */
    void prunePeers(long nowEpochMillis) {
        boolean changed = false;
        synchronized (peersLock) {
            java.util.Iterator<Map.Entry<String, Peer>> iterator = peers.entrySet().iterator();
            while (iterator.hasNext()) {
                Peer peer = iterator.next().getValue();
                if (nowEpochMillis - peer.lastSeenEpochMillis >= PEER_TTL_MS) {
                    iterator.remove();
                    changed = true;
                }
            }
        }
        if (changed) {
            notifyPeersChanged();
        }
    }

    /** Package-private signing helper used by JVM tests; it does not open a socket. */
    byte[] buildAnnouncement(long issuedAtEpochMillis) throws Exception {
        V2DiscoveryAnnouncement unsigned = V2DiscoveryAnnouncement.create(
            localIdentity,
            advertisedTcpPort,
            capabilities,
            issuedAtEpochMillis
        );
        String signature = V2DiscoveryAnnouncement.sign(unsigned, signingPrivateKey);
        return unsigned.toCanonicalJson(signature).getBytes(StandardCharsets.UTF_8);
    }

    private void openAndReceive() {
        Transport opened = null;
        try {
            opened = transportFactory.create();
            opened.open();
            synchronized (lifecycleLock) {
                if (!running) {
                    closeQuietly(opened);
                    return;
                }
                transport = opened;
            }
            notifyStatus("已加入协议 v2 发现组播 " + MULTICAST_ADDRESS + ":" + DISCOVERY_PORT);
            announceSafely();
            while (running) {
                ReceivedDatagram datagram = opened.receive();
                if (datagram != null) {
                    acceptDatagram(datagram.data, datagram.host);
                }
            }
        } catch (Exception error) {
            if (running) {
                notifyError(error);
            }
        } finally {
            synchronized (lifecycleLock) {
                if (transport == opened) {
                    transport = null;
                }
            }
            closeQuietly(opened);
        }
    }

    private void announceSafely() {
        if (!running) {
            return;
        }
        Transport activeTransport = transport;
        if (activeTransport == null) {
            return;
        }
        try {
            activeTransport.send(buildAnnouncement(clock.nowEpochMillis()));
        } catch (Exception error) {
            if (running) {
                notifyError(error);
            }
        }
    }

    private void prunePeersSafely() {
        try {
            prunePeers(clock.nowEpochMillis());
        } catch (Exception error) {
            if (running) {
                notifyError(error);
            }
        }
    }

    private List<Peer> snapshotLocked() {
        List<Peer> snapshot = new ArrayList<>(peers.values());
        Collections.sort(snapshot, Comparator
            .comparing((Peer peer) -> peer.deviceName, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(peer -> peer.deviceId));
        return Collections.unmodifiableList(snapshot);
    }

    private void notifyPeer(Peer peer) {
        if (peerListener == null) {
            return;
        }
        dispatch(() -> peerListener.onPeer(peer.deviceId, peer));
    }

    private void notifyPeersChanged() {
        if (peerListener == null) {
            return;
        }
        final List<Peer> snapshot;
        synchronized (peersLock) {
            snapshot = snapshotLocked();
        }
        dispatch(() -> peerListener.onPeers(snapshot));
    }

    private void notifyStatus(String status) {
        if (statusListener != null) {
            dispatch(() -> statusListener.onStatus(status));
        }
    }

    private void notifyError(Exception error) {
        if (errorListener != null) {
            dispatch(() -> errorListener.onError(error));
        }
    }

    private void dispatch(Runnable callback) {
        try {
            callbackExecutor.execute(callback);
        } catch (RejectedExecutionException ignored) {
            // The host's callback executor was shut down during service shutdown.
        }
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Exception ignored) {
            // Closing is best effort and must not retain a multicast lock/socket.
        }
    }

    private static final class AndroidMulticastTransportFactory implements TransportFactory {
        private final Context context;

        AndroidMulticastTransportFactory(Context context) {
            if (context == null) {
                throw new IllegalArgumentException("Android context is required for multicast discovery");
            }
            this.context = context.getApplicationContext();
        }

        @Override
        public Transport create() {
            return new AndroidMulticastTransport(context);
        }
    }

    private static final class AndroidMulticastTransport implements Transport {
        private final Context context;
        private MulticastSocket socket;
        private WifiManager.MulticastLock multicastLock;
        private InetAddress group;

        AndroidMulticastTransport(Context context) {
            this.context = context;
        }

        @Override
        public void open() throws Exception {
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                multicastLock = wifiManager.createMulticastLock("nearby-transfer-v2-discovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
            try {
                group = InetAddress.getByName(MULTICAST_ADDRESS);
                socket = new MulticastSocket(null);
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                socket.setTimeToLive(1);
                socket.joinGroup(group);
            } catch (Exception error) {
                close();
                throw error;
            }
        }

        @Override
        public void send(byte[] data) throws IOException {
            if (socket == null || socket.isClosed()) {
                throw new SocketException("Protocol v2 discovery socket is closed");
            }
            DatagramPacket packet = new DatagramPacket(data, data.length, group, DISCOVERY_PORT);
            try {
                socket.send(packet);
            } catch (SocketException primaryError) {
                // Some Android Wi-Fi stacks refuse multicast sends from a socket that is also
                // bound to a shared discovery port (EPERM), while allowing a short-lived
                // outbound multicast socket. Keep the receive socket alive and retry once.
                try (MulticastSocket outbound = new MulticastSocket()) {
                    outbound.setTimeToLive(1);
                    outbound.send(packet);
                } catch (IOException fallbackError) {
                    fallbackError.addSuppressed(primaryError);
                    throw fallbackError;
                }
            }
        }

        @Override
        public ReceivedDatagram receive() throws IOException {
            if (socket == null || socket.isClosed()) {
                throw new SocketException("Protocol v2 discovery socket is closed");
            }
            byte[] buffer = new byte[V2DiscoveryAnnouncement.MAX_ANNOUNCEMENT_BYTES + 1];
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            socket.receive(packet);
            byte[] data = new byte[packet.getLength()];
            System.arraycopy(packet.getData(), packet.getOffset(), data, 0, packet.getLength());
            return new ReceivedDatagram(data, packet.getAddress().getHostAddress());
        }

        @Override
        public void close() {
            if (socket != null) {
                socket.close();
                socket = null;
            }
            if (multicastLock != null && multicastLock.isHeld()) {
                multicastLock.release();
            }
            multicastLock = null;
        }
    }
}
