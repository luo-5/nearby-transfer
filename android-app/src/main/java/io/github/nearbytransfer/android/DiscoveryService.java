package io.github.nearbytransfer.android;

import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

final class DiscoveryService {
    interface PeerListener {
        void onPeers(List<PeerDevice> peers);
    }

    interface ErrorListener {
        void onError(Exception error);
    }

    interface StatusListener {
        void onStatus(String message);
    }

    private static final String APP_ID = "nearby-transfer";
    private static final int PROTOCOL_VERSION = 1;
    private static final String MULTICAST_ADDRESS = "239.255.77.77";
    private static final int DISCOVERY_PORT = 47777;
    private static final long PEER_TTL_MS = 10000;

    private final Context context;
    private final DeviceConfig device;
    private final int port;
    private final PeerListener peerListener;
    private final ErrorListener errorListener;
    private final StatusListener statusListener;
    private final Map<String, PeerDevice> peers = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(3);

    private volatile boolean running;
    private MulticastSocket socket;
    private WifiManager.MulticastLock multicastLock;
    private boolean announcedOnce;

    DiscoveryService(Context context, DeviceConfig device, int port, PeerListener peerListener, ErrorListener errorListener, StatusListener statusListener) {
        this.context = context.getApplicationContext();
        this.device = device;
        this.port = port;
        this.peerListener = peerListener;
        this.errorListener = errorListener;
        this.statusListener = statusListener;
    }

    void start() {
        if (running) {
            return;
        }
        running = true;
        notifyStatus("发现服务启动，UDP 端口 " + DISCOVERY_PORT);

        scheduler.execute(this::receiveLoop);
        scheduler.scheduleAtFixedRate(this::announceSafely, 0, 2, TimeUnit.SECONDS);
        scheduler.scheduleAtFixedRate(this::prunePeers, 2, 2, TimeUnit.SECONDS);
    }

    void stop() {
        running = false;
        scheduler.shutdownNow();
        if (socket != null) {
            socket.close();
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
        }
    }

    void announce() {
        announceSafely();
    }

    List<PeerDevice> listPeers() {
        List<PeerDevice> result = new ArrayList<>(peers.values());
        Collections.sort(result, (a, b) -> a.deviceName.compareToIgnoreCase(b.deviceName));
        return result;
    }

    private void receiveLoop() {
        try {
            WifiManager wifiManager = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                try {
                    multicastLock = wifiManager.createMulticastLock("nearby-transfer-discovery");
                    multicastLock.setReferenceCounted(false);
                    multicastLock.acquire();
                    notifyStatus("已获取 Wi-Fi 多播锁");
                } catch (SecurityException error) {
                    errorListener.onError(error);
                }
            }

            InetAddress group = InetAddress.getByName(MULTICAST_ADDRESS);
            socket = new MulticastSocket(null);
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(DISCOVERY_PORT));
            socket.setTimeToLive(1);
            socket.joinGroup(group);
            notifyStatus("已加入发现组播 " + MULTICAST_ADDRESS + ":" + DISCOVERY_PORT);

            byte[] buffer = new byte[65535];
            while (running) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                handleMessage(packet);
            }
        } catch (Exception error) {
            if (running) {
                errorListener.onError(error);
            }
        }
    }

    private void announceSafely() {
        try {
            JSONObject payload = device.toAnnouncement(port);
            byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
            DatagramPacket packet = new DatagramPacket(data, data.length, InetAddress.getByName(MULTICAST_ADDRESS), DISCOVERY_PORT);
            MulticastSocket announceSocket = socket;
            if (announceSocket != null && !announceSocket.isClosed()) {
                announceSocket.send(packet);
                notifyAnnounced();
                return;
            }
            try (MulticastSocket temporary = new MulticastSocket()) {
                temporary.setTimeToLive(1);
                temporary.send(packet);
                notifyAnnounced();
            }
        } catch (Exception error) {
            errorListener.onError(error);
        }
    }

    private void handleMessage(DatagramPacket packet) {
        try {
            JSONObject payload = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
            if (!APP_ID.equals(payload.optString("app")) || payload.optInt("protocolVersion") != PROTOCOL_VERSION) {
                return;
            }
            if (!"announce".equals(payload.optString("type"))) {
                return;
            }
            String deviceId = payload.optString("deviceId", "");
            if (deviceId.isEmpty() || deviceId.equals(device.deviceId)) {
                return;
            }
            String encryptionPublicKey = payload.optString("encryptionPublicKey", "");
            String signingPublicKey = payload.optString("signingPublicKey", "");
            int transferPort = payload.optInt("port");
            String fingerprint = payload.optString("fingerprint", "");
            if (encryptionPublicKey.isEmpty() || signingPublicKey.isEmpty() || transferPort <= 0) {
                return;
            }
            if (!deviceId.equals(CryptoUtil.deviceIdFor(signingPublicKey)) || !fingerprint.equals(CryptoUtil.fingerprintFor(signingPublicKey))) {
                return;
            }

            PeerDevice peer = new PeerDevice(
                deviceId,
                payload.optString("deviceName", "Unknown"),
                packet.getAddress().getHostAddress(),
                transferPort,
                signingPublicKey,
                encryptionPublicKey,
                fingerprint,
                System.currentTimeMillis()
            );
            peers.put(peer.deviceId, peer);
            notifyStatus("发现设备：" + peer.deviceName + " " + peer.host + ":" + peer.port);
            peerListener.onPeers(listPeers());
        } catch (Exception ignored) {
            // Ignore malformed or unrelated multicast packets on the LAN.
        }
    }

    private void prunePeers() {
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (Map.Entry<String, PeerDevice> entry : peers.entrySet()) {
            if (now - entry.getValue().lastSeen > PEER_TTL_MS) {
                peers.remove(entry.getKey());
                changed = true;
            }
        }
        if (changed) {
            peerListener.onPeers(listPeers());
        }
    }

    private void notifyStatus(String message) {
        if (statusListener != null) {
            statusListener.onStatus(message);
        }
    }

    private void notifyAnnounced() {
        if (!announcedOnce) {
            announcedOnce = true;
            notifyStatus("已广播本机发现信息");
        }
    }
}
