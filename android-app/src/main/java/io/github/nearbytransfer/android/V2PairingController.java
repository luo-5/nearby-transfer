package io.github.nearbytransfer.android;

import android.content.Context;
import android.util.Log;

import java.io.Closeable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Coordinates v2 discovery, bounded pairing TCP, session state and local trust persistence.
 * This is intentionally separate from the legacy HTTP/discovery stack.
 */
final class V2PairingController implements Closeable {
    private static final String TAG = "NearbyTransferV2";
    private static final List<String> PAIRING_CAPABILITIES = Collections.singletonList("pairing");

    interface Listener {
        void onPeersChanged(List<V2DiscoveryService.Peer> peers);
        void onSessionChanged(V2PairingSessionStore.Session session);
        void onStatus(String status);
        void onError(Exception error);
    }

    private final Context context;
    private final DeviceConfig device;
    private final V2PairingSessionStore sessions;
    private final Listener listener;
    private final Executor callbackExecutor;
    private final ExecutorService workExecutor = Executors.newSingleThreadExecutor();
    private final Object lock = new Object();
    private final Map<String, V2LanService.Connection> connectionsByPairingId = new HashMap<>();

    private V2LanService lanService;
    private V2DiscoveryService discoveryService;
    private boolean started;

    V2PairingController(Context context, DeviceConfig device, Listener listener, Executor callbackExecutor) throws Exception {
        if (context == null || device == null || listener == null || callbackExecutor == null) {
            throw new IllegalArgumentException("Context, device, listener, and callback executor are required");
        }
        this.context = context.getApplicationContext();
        this.device = device;
        this.sessions = new V2PairingSessionStore(device);
        this.listener = listener;
        this.callbackExecutor = callbackExecutor;
    }

    void start() throws Exception {
        synchronized (lock) {
            if (started) return;
            V2LanService transport = new V2LanService(new TransportHandler(), new TransportListener(), callbackExecutor,
                V2LanService.DEFAULT_MAX_CONNECTIONS, V2LanService.DEFAULT_MAX_CONNECTIONS_PER_IP,
                V2LanService.DEFAULT_BOOTSTRAP_TIMEOUT_MS, V2LanService.DEFAULT_MAX_BOOTSTRAP_BYTES,
                V2LanService.DEFAULT_MAX_BOOTSTRAP_FRAMES);
            int port = transport.start(0);
            V2DiscoveryService discovery;
            try {
                discovery = new V2DiscoveryService(context, device, port, PAIRING_CAPABILITIES,
                    new DiscoveryListener(), this::notifyError, this::notifyStatus);
                discovery.start();
            } catch (Exception error) {
                transport.close();
                throw error;
            }
            lanService = transport;
            discoveryService = discovery;
            started = true;
        }
        notifyStatus("协议 v2 配对已启动；请在附近设备列表中确认六位配对码。");
    }

    List<V2DiscoveryService.Peer> listPeers() {
        synchronized (lock) {
            return discoveryService == null ? Collections.emptyList() : discoveryService.listPeers();
        }
    }

    List<V2PairingSessionStore.Session> listSessions() {
        return sessions.listActive(System.currentTimeMillis());
    }

    void announceNow() {
        synchronized (lock) {
            if (discoveryService != null) discoveryService.announce();
        }
    }

    void startPairing(V2DiscoveryService.Peer peer) {
        if (peer == null || !peer.capabilities.contains("pairing")) {
            notifyError(new IllegalArgumentException("The selected device does not support protocol v2 pairing"));
            return;
        }
        workExecutor.execute(() -> {
            V2PairingSessionStore.SignedOffer signedOffer = null;
            try {
                V2LanService transport = requireStartedTransport();
                signedOffer = sessions.startOutgoing(PAIRING_CAPABILITIES, System.currentTimeMillis());
                V2LanService.Connection connection = transport.connect(peer.host, peer.port, peer.deviceId);
                synchronized (lock) { connectionsByPairingId.put(signedOffer.offer.pairingId, connection); }
                connection.sendOffer(signedOffer.offer, signedOffer.signature);
                notifySession(signedOffer.session);
                notifyStatus("已向 " + peer.deviceName + " 发送配对请求；请比对六位配对码。");
            } catch (Exception error) {
                if (signedOffer != null) {
                    sessions.cancel(signedOffer.offer.pairingId, "connection-closed", System.currentTimeMillis());
                    notifySession(sessions.get(signedOffer.offer.pairingId, true, System.currentTimeMillis()));
                }
                notifyError(error);
            }
        });
    }

    void confirmPairing(String pairingId) {
        workExecutor.execute(() -> {
            try {
                V2PairingSessionStore.Session current = requireSession(pairingId);
                if (isTerminalStatus(current.status)) {
                    notifySession(current);
                    throw pairingUnavailableError(current.status);
                }
                debugSession("confirm requested", current);
                V2LanService.Connection connection = requireConnection(pairingId);
                if (current.role == V2PairingSessionStore.Role.RESPONDER) {
                    V2PairingSessionStore.SignedOffer responderOffer = sessions.respondToIncomingOffer(pairingId, PAIRING_CAPABILITIES, System.currentTimeMillis());
                    connection.sendOffer(responderOffer.offer, responderOffer.signature);
                }
                V2PairingSessionStore.SignedConfirmation confirmation = sessions.createLocalConfirmation(pairingId, System.currentTimeMillis());
                connection.sendConfirmation(confirmation.confirmation, confirmation.signature);
                notifySession(confirmation.session);
                debugSession("local confirmation sent", confirmation.session);
                notifyStatus("已确认配对码，正在等待对端确认。");
            } catch (Exception error) {
                V2PairingSessionStore.Session latest = sessions.get(pairingId, true, System.currentTimeMillis());
                if (latest != null && isTerminalStatus(latest.status)) notifySession(latest);
                Log.w(TAG, "confirm pairing failed", error);
                notifyError(error);
            }
        });
    }

    void completePairing(String pairingId) {
        workExecutor.execute(() -> {
            try {
                V2PairingSessionStore.Session session = requireSession(pairingId);
                if (session.status != V2PairingSessionStore.Status.READY_TO_TRUST || session.peerOffer == null) {
                    throw new IllegalStateException("Both devices must confirm the pairing code before trust is stored");
                }
                V2TrustedPeerPersistence.persistCompletedPairing(context, session.peerOffer.identity, System.currentTimeMillis());
                V2PairingSessionStore.Session completed = sessions.complete(pairingId, System.currentTimeMillis());
                notifySession(completed);
                notifyStatus("已保存可信设备：" + session.peerOffer.identity.deviceName);
            } catch (Exception error) {
                notifyError(error);
            }
        });
    }

    void cancelPairing(String pairingId, String reason) {
        workExecutor.execute(() -> {
            try {
                V2PairingSessionStore.SignedCancellation cancellation = sessions.createCancellation(pairingId, reason, System.currentTimeMillis());
                V2LanService.Connection connection;
                synchronized (lock) { connection = connectionsByPairingId.remove(pairingId); }
                if (connection != null) {
                    try { connection.sendCancellation(cancellation.cancellation, cancellation.signature); }
                    finally { connection.close(); }
                }
                notifySession(cancellation.session);
            } catch (Exception error) {
                notifyError(error);
            }
        });
    }

    @Override public void close() {
        V2DiscoveryService discovery;
        V2LanService transport;
        synchronized (lock) {
            if (!started) {
                workExecutor.shutdownNow();
                return;
            }
            started = false;
            discovery = discoveryService; discoveryService = null;
            transport = lanService; lanService = null;
            connectionsByPairingId.clear();
        }
        if (discovery != null) discovery.close();
        if (transport != null) transport.close();
        workExecutor.shutdownNow();
    }

    private final class DiscoveryListener implements V2DiscoveryService.PeerListener {
        @Override public void onPeer(String deviceId, V2DiscoveryService.Peer peer) { }
        @Override public void onPeers(List<V2DiscoveryService.Peer> peers) { callbackExecutor.execute(() -> listener.onPeersChanged(peers)); }
    }

    private final class TransportListener implements V2LanService.Listener {
        @Override public void onStatus(String message) { notifyStatus(message); }
        @Override public void onProtocolError(String remoteAddress, Exception error) { notifyError(new IllegalStateException("v2 pairing connection " + remoteAddress + " failed: " + error.getMessage(), error)); }
    }

    private final class TransportHandler implements V2LanService.ControlHandler {
        @Override public void onOffer(V2Pairing.Offer offer, String signature, V2LanService.Connection connection) throws Exception {
            V2LanService.Binding binding = connection.binding();
            V2PairingSessionStore.Session existing = sessions.get(offer.pairingId, true, System.currentTimeMillis());
            V2PairingSessionStore.Session updated = existing != null && existing.role == V2PairingSessionStore.Role.INITIATOR
                && existing.status == V2PairingSessionStore.Status.AWAITING_REMOTE_OFFER
                ? sessions.receiveRemoteOffer(offer.pairingId, offer, signature, System.currentTimeMillis())
                : sessions.receiveIncomingOffer(offer, signature, System.currentTimeMillis());
            assertSessionBinding(updated, binding);
            synchronized (lock) { connectionsByPairingId.put(offer.pairingId, connection); }
            notifySession(updated);
            notifyStatus("收到来自 " + offer.identity.deviceName + " 的配对请求；请比对六位配对码。");
        }

        @Override public void onConfirmation(V2Pairing.Confirmation confirmation, String signature, V2LanService.Connection connection) throws Exception {
            V2LanService.Binding binding = connection.binding();
            V2PairingSessionStore.Session updated = sessions.receiveRemoteConfirmation(confirmation.pairingId, confirmation, signature, System.currentTimeMillis());
            assertSessionBinding(updated, binding);
            notifySession(updated);
        }

        @Override public void onCancellation(V2Pairing.Cancellation cancellation, String signature, V2LanService.Connection connection) throws Exception {
            V2LanService.Binding binding = connection.binding();
            V2PairingSessionStore.Session updated = sessions.receiveRemoteCancellation(cancellation.pairingId, cancellation, signature, System.currentTimeMillis());
            assertSessionBinding(updated, binding);
            synchronized (lock) { connectionsByPairingId.remove(cancellation.pairingId); }
            notifySession(updated);
        }

        @Override public void onConnectionClosed(V2LanService.Binding binding) {
            String pairingId = binding.pairingId();
            if (pairingId == null) return;
            synchronized (lock) { connectionsByPairingId.remove(pairingId); }
            boolean cancelled = sessions.cancel(pairingId, "connection-closed", System.currentTimeMillis());
            V2PairingSessionStore.Session session = sessions.get(pairingId, true, System.currentTimeMillis());
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "pairing connection closed: " + pairingId + ", cancelled=" + cancelled
                    + ", status=" + (session == null ? "missing" : session.status));
            }
            if (cancelled) notifySession(session);
        }
    }

    private V2LanService requireStartedTransport() {
        synchronized (lock) {
            if (!started || lanService == null) throw new IllegalStateException("Protocol v2 pairing is not running");
            return lanService;
        }
    }

    private V2LanService.Connection requireConnection(String pairingId) {
        synchronized (lock) {
            V2LanService.Connection connection = connectionsByPairingId.get(pairingId);
            if (connection == null) throw new IllegalStateException("Pairing connection is unavailable");
            return connection;
        }
    }

    private V2PairingSessionStore.Session requireSession(String pairingId) {
        V2PairingSessionStore.Session session = sessions.get(pairingId, true, System.currentTimeMillis());
        if (session == null) throw new IllegalStateException("Pairing session does not exist");
        return session;
    }

    private static void assertSessionBinding(V2PairingSessionStore.Session session, V2LanService.Binding binding) {
        if (session == null || session.peerOffer == null || !session.pairingId.equals(binding.pairingId())
            || !session.peerOffer.identity.deviceId.equals(binding.remoteDeviceId())) {
            throw new IllegalStateException("Pairing session does not match the connection binding");
        }
    }

    private static boolean isTerminalStatus(V2PairingSessionStore.Status status) {
        return status == V2PairingSessionStore.Status.CANCELLED
            || status == V2PairingSessionStore.Status.EXPIRED
            || status == V2PairingSessionStore.Status.COMPLETED;
    }

    private static IllegalStateException pairingUnavailableError(V2PairingSessionStore.Status status) {
        if (status == V2PairingSessionStore.Status.EXPIRED) {
            return new IllegalStateException("配对已过期，请重新发起配对");
        }
        if (status == V2PairingSessionStore.Status.CANCELLED) {
            return new IllegalStateException("配对连接已关闭，请重新发起配对");
        }
        return new IllegalStateException("配对已完成，无法再次确认");
    }

    private static void debugSession(String event, V2PairingSessionStore.Session session) {
        if (!BuildConfig.DEBUG || session == null) return;
        Log.d(TAG, event + ": " + session.pairingId + ", status=" + session.status
            + ", expiresAt=" + session.expiresAt);
    }

    private void notifySession(V2PairingSessionStore.Session session) {
        if (session != null) callbackExecutor.execute(() -> listener.onSessionChanged(session));
    }
    private void notifyStatus(String status) { callbackExecutor.execute(() -> listener.onStatus(status)); }
    private void notifyError(Exception error) { callbackExecutor.execute(() -> listener.onError(error)); }
}
