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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

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

    interface ManagedSocket {
        void receive(DatagramPacket packet) throws Exception;

        void send(DatagramPacket packet) throws Exception;

        void close();
    }

    interface HeldMulticastLock {
        void release();
    }

    interface ResourceFactory {
        HeldMulticastLock acquireMulticastLock() throws Exception;

        ManagedSocket openReceiver() throws Exception;

        ManagedSocket openSender() throws Exception;
    }

    interface PeriodicScheduler {
        void scheduleAtFixedRate(Runnable task, long initialDelay, long period, TimeUnit unit);

        void shutdownNow();
    }

    interface SchedulerFactory {
        PeriodicScheduler create();
    }

    private static final String MULTICAST_ADDRESS = "239.255.77.77";
    private static final int DISCOVERY_PORT = 47777;
    private static final long PEER_TTL_MS = 10000;

    private final DeviceConfig device;
    private final int port;
    private final PeerListener peerListener;
    private final ErrorListener errorListener;
    private final StatusListener statusListener;
    private final ResourceFactory resourceFactory;
    private final SchedulerFactory schedulerFactory;
    private final ThreadFactory receiverThreadFactory;
    private final Map<String, PeerDevice> peers = new ConcurrentHashMap<>();
    private final Object lifecycleLock = new Object();
    private final AtomicBoolean announcedOnce = new AtomicBoolean();

    private Session activeSession;
    private boolean restartRequested;

    DiscoveryService(Context context, DeviceConfig device, int port, PeerListener peerListener, ErrorListener errorListener, StatusListener statusListener) {
        this(
            device,
            port,
            peerListener,
            errorListener,
            statusListener,
            new AndroidResourceFactory(context.getApplicationContext()),
            ExecutorPeriodicScheduler::new,
            runnable -> {
                Thread thread = new Thread(runnable, "nearby-transfer-discovery-receiver");
                thread.setDaemon(true);
                return thread;
            }
        );
    }

    DiscoveryService(
        DeviceConfig device,
        int port,
        PeerListener peerListener,
        ErrorListener errorListener,
        StatusListener statusListener,
        ResourceFactory resourceFactory,
        SchedulerFactory schedulerFactory,
        ThreadFactory receiverThreadFactory
    ) {
        this.device = device;
        this.port = port;
        this.peerListener = peerListener;
        this.errorListener = errorListener;
        this.statusListener = statusListener;
        this.resourceFactory = resourceFactory;
        this.schedulerFactory = schedulerFactory;
        this.receiverThreadFactory = receiverThreadFactory;
    }

    void start() {
        Session session;
        boolean peersChanged;
        synchronized (lifecycleLock) {
            if (activeSession != null) {
                if (activeSession.isTerminating()) {
                    restartRequested = true;
                }
                return;
            }

            restartRequested = false;
            peersChanged = resetSessionState();
            session = new Session(schedulerFactory.create());
            Thread receiverThread = receiverThreadFactory.newThread(() -> receiveLoop(session));
            session.setReceiverThread(receiverThread);
            activeSession = session;
        }

        notifyPeersChanged(peersChanged);
        notifyStatus("发现服务启动，UDP 端口 " + DISCOVERY_PORT);
        try {
            session.scheduler.scheduleAtFixedRate(() -> announceSafely(session), 0, 2, TimeUnit.SECONDS);
            session.scheduler.scheduleAtFixedRate(() -> prunePeers(session), 2, 2, TimeUnit.SECONDS);
            session.receiverThread.start();
        } catch (RuntimeException error) {
            session.markTerminating();
            notifyError(error, session);
            session.cancel();
            finishSession(session);
        }
    }

    void stop() {
        Session session;
        boolean peersChanged;
        synchronized (lifecycleLock) {
            restartRequested = false;
            session = activeSession;
            if (session != null) {
                session.markTerminating();
            }
            peersChanged = resetSessionState();
        }
        notifyPeersChanged(peersChanged);
        if (session != null) {
            session.cancel();
        }
    }

    void announce() {
        Session session;
        synchronized (lifecycleLock) {
            session = activeSession;
        }
        if (session != null) {
            announceSafely(session);
        }
    }

    List<PeerDevice> listPeers() {
        List<PeerDevice> result = new ArrayList<>(peers.values());
        Collections.sort(result, (a, b) -> a.deviceName.compareToIgnoreCase(b.deviceName));
        return result;
    }

    private void receiveLoop(Session session) {
        try {
            if (!session.isOperational()) {
                return;
            }

            try {
                HeldMulticastLock candidateLock = resourceFactory.acquireMulticastLock();
                if (candidateLock != null) {
                    if (!session.installMulticastLock(candidateLock)) {
                        candidateLock.release();
                        return;
                    }
                    notifyStatus("已获取 Wi-Fi 多播锁");
                }
            } catch (SecurityException error) {
                notifyError(error, session);
            }

            if (!session.isOperational()) {
                return;
            }

            ManagedSocket candidateSocket = resourceFactory.openReceiver();
            if (!session.installReceiverSocket(candidateSocket)) {
                candidateSocket.close();
                return;
            }
            notifyStatus("已加入发现组播 " + MULTICAST_ADDRESS + ":" + DISCOVERY_PORT);

            byte[] buffer = new byte[DiscoveryAnnouncement.MAX_BYTES + 1];
            while (session.isOperational()) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                candidateSocket.receive(packet);
                if (session.isOperational()) {
                    handleMessage(packet, session);
                }
            }
        } catch (Exception error) {
            if (!session.isCancelled()) {
                session.markTerminating();
                notifyError(error, session);
            }
        } finally {
            session.markTerminating();
            finishSession(session);
        }
    }

    private void finishSession(Session session) {
        session.closeResources();
        session.shutdownScheduler();

        boolean shouldRestart = false;
        synchronized (lifecycleLock) {
            if (activeSession == session) {
                activeSession = null;
                shouldRestart = restartRequested;
                restartRequested = false;
            }
        }
        if (shouldRestart) {
            start();
        }
    }

    private void announceSafely(Session session) {
        if (!session.isOperational()) {
            return;
        }

        ManagedSocket temporary = null;
        try {
            JSONObject payload = device.toAnnouncement(port);
            byte[] data = payload.toString().getBytes(StandardCharsets.UTF_8);
            DatagramPacket packet = new DatagramPacket(data, data.length, InetAddress.getByName(MULTICAST_ADDRESS), DISCOVERY_PORT);
            ManagedSocket announceSocket = session.receiverSocket();
            if (announceSocket != null) {
                announceSocket.send(packet);
                notifyAnnounced();
                return;
            }

            temporary = resourceFactory.openSender();
            if (!session.registerTemporarySocket(temporary)) {
                temporary.close();
                temporary = null;
                return;
            }
            temporary.send(packet);
            notifyAnnounced();
        } catch (Exception error) {
            notifyError(error, session);
        } finally {
            if (temporary != null) {
                session.unregisterTemporarySocket(temporary);
                temporary.close();
            }
        }
    }

    private void handleMessage(DatagramPacket packet, Session session) {
        PeerDevice peer = DiscoveryAnnouncement.parse(
            packet.getData(),
            packet.getOffset(),
            packet.getLength(),
            packet.getAddress().getHostAddress(),
            device.deviceId,
            System.currentTimeMillis()
        );
        if (peer == null || !session.isOperational()) {
            return;
        }

        boolean isNewPeer = !peers.containsKey(peer.deviceId);
        peers.put(peer.deviceId, peer);
        if (!session.isOperational()) {
            peers.remove(peer.deviceId);
            return;
        }
        if (isNewPeer) {
            notifyStatus("发现设备：" + peer.deviceName + " " + peer.host + ":" + peer.port);
        }
        peerListener.onPeers(listPeers());
    }

    private void prunePeers(Session session) {
        if (!session.isOperational()) {
            return;
        }

        long now = System.currentTimeMillis();
        boolean changed = false;
        List<PeerDevice> expired = new ArrayList<>();
        for (Map.Entry<String, PeerDevice> entry : peers.entrySet()) {
            if (now - entry.getValue().lastSeen > PEER_TTL_MS) {
                peers.remove(entry.getKey());
                expired.add(entry.getValue());
                changed = true;
            }
        }
        for (PeerDevice peer : expired) {
            notifyStatus("设备离线：" + peer.deviceName);
        }
        if (changed) {
            peerListener.onPeers(listPeers());
        }
    }


    private boolean resetSessionState() {
        announcedOnce.set(false);
        boolean peersChanged = !peers.isEmpty();
        if (peersChanged) {
            peers.clear();
        }
        return peersChanged;
    }

    private void notifyPeersChanged(boolean changed) {
        if (changed && peerListener != null) {
            peerListener.onPeers(listPeers());
        }
    }

    private void notifyError(Exception error, Session session) {
        if (!session.isCancelled() && errorListener != null) {
            errorListener.onError(error);
        }
    }

    private void notifyStatus(String message) {
        if (statusListener != null) {
            statusListener.onStatus(message);
        }
    }

    private void notifyAnnounced() {
        if (announcedOnce.compareAndSet(false, true)) {
            notifyStatus("已广播本机发现信息");
        }
    }

    private static final class Session {
        private final Object resourceLock = new Object();
        final PeriodicScheduler scheduler;
        Thread receiverThread;
        private ManagedSocket receiverSocket;
        private HeldMulticastLock multicastLock;
        private final Set<ManagedSocket> temporarySockets = new HashSet<>();
        private volatile boolean cancelled;
        private volatile boolean terminating;
        private final AtomicBoolean schedulerShutdown = new AtomicBoolean();

        Session(PeriodicScheduler scheduler) {
            this.scheduler = scheduler;
        }

        void setReceiverThread(Thread receiverThread) {
            this.receiverThread = receiverThread;
        }

        boolean isOperational() {
            return !cancelled && !terminating;
        }

        boolean isCancelled() {
            return cancelled;
        }

        boolean isTerminating() {
            return terminating;
        }

        void markTerminating() {
            terminating = true;
        }

        boolean installMulticastLock(HeldMulticastLock candidate) {
            synchronized (resourceLock) {
                if (!isOperational() || multicastLock != null) {
                    return false;
                }
                multicastLock = candidate;
                return true;
            }
        }

        boolean installReceiverSocket(ManagedSocket candidate) {
            synchronized (resourceLock) {
                if (!isOperational() || receiverSocket != null) {
                    return false;
                }
                receiverSocket = candidate;
                return true;
            }
        }

        ManagedSocket receiverSocket() {
            synchronized (resourceLock) {
                return isOperational() ? receiverSocket : null;
            }
        }

        boolean registerTemporarySocket(ManagedSocket socket) {
            synchronized (resourceLock) {
                if (!isOperational()) {
                    return false;
                }
                temporarySockets.add(socket);
                return true;
            }
        }

        void unregisterTemporarySocket(ManagedSocket socket) {
            synchronized (resourceLock) {
                temporarySockets.remove(socket);
            }
        }

        void cancel() {
            cancelled = true;
            closeResources();
            shutdownScheduler();
            Thread thread = receiverThread;
            if (thread != null) {
                thread.interrupt();
            }
        }

        void shutdownScheduler() {
            if (schedulerShutdown.compareAndSet(false, true)) {
                scheduler.shutdownNow();
            }
        }

        void closeResources() {
            ManagedSocket socketToClose;
            HeldMulticastLock lockToRelease;
            List<ManagedSocket> temporaryToClose;
            synchronized (resourceLock) {
                socketToClose = receiverSocket;
                receiverSocket = null;
                lockToRelease = multicastLock;
                multicastLock = null;
                temporaryToClose = new ArrayList<>(temporarySockets);
                temporarySockets.clear();
            }

            if (socketToClose != null) {
                socketToClose.close();
            }
            for (ManagedSocket socket : temporaryToClose) {
                socket.close();
            }
            if (lockToRelease != null) {
                lockToRelease.release();
            }
        }
    }

    private static final class ExecutorPeriodicScheduler implements PeriodicScheduler {
        private final ScheduledExecutorService delegate = Executors.newScheduledThreadPool(2);

        @Override
        public void scheduleAtFixedRate(Runnable task, long initialDelay, long period, TimeUnit unit) {
            delegate.scheduleAtFixedRate(task, initialDelay, period, unit);
        }

        @Override
        public void shutdownNow() {
            delegate.shutdownNow();
        }
    }

    private static final class AndroidResourceFactory implements ResourceFactory {
        private final Context context;

        AndroidResourceFactory(Context context) {
            this.context = context;
        }

        @Override
        public HeldMulticastLock acquireMulticastLock() {
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                return null;
            }

            WifiManager.MulticastLock lock = wifiManager.createMulticastLock("nearby-transfer-discovery");
            lock.setReferenceCounted(false);
            lock.acquire();
            return () -> {
                if (lock.isHeld()) {
                    lock.release();
                }
            };
        }

        @Override
        public ManagedSocket openReceiver() throws Exception {
            InetAddress group = InetAddress.getByName(MULTICAST_ADDRESS);
            MulticastSocket socket = new MulticastSocket(null);
            boolean opened = false;
            try {
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                socket.setTimeToLive(1);
                socket.joinGroup(group);
                opened = true;
                return new AndroidManagedSocket(socket);
            } finally {
                if (!opened) {
                    socket.close();
                }
            }
        }

        @Override
        public ManagedSocket openSender() throws Exception {
            MulticastSocket socket = new MulticastSocket();
            boolean opened = false;
            try {
                socket.setTimeToLive(1);
                opened = true;
                return new AndroidManagedSocket(socket);
            } finally {
                if (!opened) {
                    socket.close();
                }
            }
        }
    }

    private static final class AndroidManagedSocket implements ManagedSocket {
        private final MulticastSocket socket;
        private final AtomicBoolean closed = new AtomicBoolean();

        AndroidManagedSocket(MulticastSocket socket) {
            this.socket = socket;
        }

        @Override
        public void receive(DatagramPacket packet) throws Exception {
            socket.receive(packet);
        }

        @Override
        public void send(DatagramPacket packet) throws Exception {
            socket.send(packet);
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                socket.close();
            }
        }
    }
}
