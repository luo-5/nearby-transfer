package io.github.nearbytransfer.android;

import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.net.DatagramPacket;
import java.security.KeyPair;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class DiscoveryServiceLifecycleTest {
    private DiscoveryService service;

    @After
    public void tearDown() throws Exception {
        if (service != null) {
            service.stop();
        }
    }

    @Test
    public void stopBeforeMulticastLockIsEstablishedReleasesLateLockAndSkipsSocket() throws Exception {
        BlockingLockFactory resources = new BlockingLockFactory();
        RecordingErrors errors = new RecordingErrors();
        service = createService(resources, errors);

        service.start();
        assertTrue(resources.lockAcquireEntered.await(2, TimeUnit.SECONDS));

        service.stop();
        resources.allowLockAcquire.countDown();

        assertTrue(resources.lockReleased.await(2, TimeUnit.SECONDS));
        assertEquals(1, resources.lock.releaseCount.get());
        assertEquals(0, resources.receiverOpenCount.get());
        assertEquals(0, errors.count.get());
    }

    @Test
    public void stopWhileReceiverIsOpeningClosesLateSocketWithoutReceiving() throws Exception {
        BlockingReceiverFactory resources = new BlockingReceiverFactory();
        RecordingErrors errors = new RecordingErrors();
        service = createService(resources, errors);

        service.start();
        assertTrue(resources.receiverOpenEntered.await(2, TimeUnit.SECONDS));

        service.stop();
        resources.allowReceiverOpen.countDown();

        assertTrue(resources.socket.closed.await(2, TimeUnit.SECONDS));
        assertEquals(1, resources.socket.closeCount.get());
        assertEquals(0, resources.socket.receiveCount.get());
        assertEquals(1, resources.lock.releaseCount.get());
        assertEquals(0, errors.count.get());
    }

    @Test
    public void receiveFailureReleasesResourcesAndCanBeStartedAgain() throws Exception {
        QueueResourceFactory resources = new QueueResourceFactory();
        ThrowingSocket failedSocket = new ThrowingSocket();
        BlockingSocket restartedSocket = new BlockingSocket();
        resources.sockets.add(failedSocket);
        resources.sockets.add(restartedSocket);
        RecordingErrors errors = new RecordingErrors();
        service = createService(resources, errors);

        service.start();
        assertTrue(failedSocket.closed.await(2, TimeUnit.SECONDS));
        assertEquals(1, errors.count.get());
        awaitValue(resources.activeLocks, 0);
        awaitValue(resources.activeSockets, 0);

        service.start();
        assertTrue(restartedSocket.receiveEntered.await(2, TimeUnit.SECONDS));
        service.start();

        assertEquals(2, resources.receiverOpenCount.get());
        assertEquals(1, resources.activeLocks.get());
        assertEquals(1, resources.activeSockets.get());
        assertEquals(1, resources.maxActiveLocks.get());
        assertEquals(1, resources.maxActiveSockets.get());

        service.stop();
        assertTrue(restartedSocket.closed.await(2, TimeUnit.SECONDS));
        awaitValue(resources.activeLocks, 0);
        awaitValue(resources.activeSockets, 0);
        assertEquals(1, restartedSocket.closeCount.get());
    }

    @Test
    public void immediateRestartAfterStopWaitsForPreviousSessionCleanup() throws Exception {
        QueueResourceFactory resources = new QueueResourceFactory();
        BlockingSocket firstSocket = new BlockingSocket();
        BlockingSocket secondSocket = new BlockingSocket();
        resources.sockets.add(firstSocket);
        resources.sockets.add(secondSocket);
        service = createService(resources, new RecordingErrors());

        service.start();
        assertTrue(firstSocket.receiveEntered.await(2, TimeUnit.SECONDS));

        service.stop();
        service.start();

        assertTrue(secondSocket.receiveEntered.await(2, TimeUnit.SECONDS));
        assertEquals(2, resources.receiverOpenCount.get());
        assertEquals(1, resources.maxActiveLocks.get());
        assertEquals(1, resources.maxActiveSockets.get());
        assertEquals(1, firstSocket.closeCount.get());

        service.stop();
        assertTrue(secondSocket.closed.await(2, TimeUnit.SECONDS));
        awaitValue(resources.activeLocks, 0);
        awaitValue(resources.activeSockets, 0);
    }


    @Test
    public void stopClearsPeersAndRestartCanAnnounceStatusAgain() throws Exception {
        QueueResourceFactory resources = new QueueResourceFactory();
        BlockingSocket firstSocket = new BlockingSocket();
        BlockingSocket secondSocket = new BlockingSocket();
        resources.sockets.add(firstSocket);
        resources.sockets.add(secondSocket);
        RecordingErrors errors = new RecordingErrors();
        RecordingPeers peerEvents = new RecordingPeers();
        RecordingStatuses statuses = new RecordingStatuses();
        service = createService(resources, errors, peerEvents::record, statuses::record, newTestDevice());

        service.start();
        assertTrue(firstSocket.receiveEntered.await(2, TimeUnit.SECONDS));
        addSyntheticPeer(service, "bbbbbbbbbbbbbbbb");
        assertEquals(1, service.listPeers().size());

        service.announce();
        service.announce();
        assertEquals(1, statuses.announcedCount.get());

        service.stop();
        assertTrue(firstSocket.closed.await(2, TimeUnit.SECONDS));
        awaitValue(resources.activeLocks, 0);
        awaitValue(resources.activeSockets, 0);
        assertTrue(service.listPeers().isEmpty());
        assertEquals(1, peerEvents.emptyCount.get());

        service.start();
        assertTrue(secondSocket.receiveEntered.await(2, TimeUnit.SECONDS));
        service.announce();

        assertTrue(service.listPeers().isEmpty());
        assertEquals(2, statuses.announcedCount.get());
        assertEquals(0, errors.count.get());
    }

    private static DiscoveryService createService(DiscoveryService.ResourceFactory resources, RecordingErrors errors) {
        return createService(resources, errors, peers -> { }, status -> { }, null);
    }

    private static DiscoveryService createService(
        DiscoveryService.ResourceFactory resources,
        RecordingErrors errors,
        DiscoveryService.PeerListener peerListener,
        DiscoveryService.StatusListener statusListener,
        DeviceConfig device
    ) {
        return new DiscoveryService(
            device,
            47778,
            peerListener,
            errors::record,
            statusListener,
            resources,
            NoOpScheduler::new,
            runnable -> new Thread(runnable, "discovery-lifecycle-test")
        );
    }

    @SuppressWarnings("unchecked")
    private static void addSyntheticPeer(DiscoveryService service, String deviceId) throws Exception {
        Field peersField = DiscoveryService.class.getDeclaredField("peers");
        peersField.setAccessible(true);
        Map<String, PeerDevice> peers = (Map<String, PeerDevice>) peersField.get(service);
        peers.put(
            deviceId,
            new PeerDevice(
                deviceId,
                "Stale Peer",
                "192.0.2.10",
                47778,
                "signing-public-key",
                "encryption-public-key",
                "fingerprint",
                System.currentTimeMillis()
            )
        );
    }

    private static DeviceConfig newTestDevice() throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());
        return new DeviceConfig(
            CryptoUtil.deviceIdFor(signingPublicKey),
            "Local Device",
            CryptoUtil.fingerprintFor(signingPublicKey),
            signingPublicKey,
            CryptoUtil.toPrivatePem(signing.getPrivate()),
            CryptoUtil.toPublicPem(encryption.getPublic()),
            CryptoUtil.toPrivatePem(encryption.getPrivate())
        );
    }

    private static void awaitValue(AtomicInteger value, int expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (value.get() != expected && System.nanoTime() < deadline) {
            Thread.sleep(10L);
        }
        assertEquals(expected, value.get());
    }

    private static final class NoOpScheduler implements DiscoveryService.PeriodicScheduler {
        private final AtomicBoolean shutdown = new AtomicBoolean();

        @Override
        public void scheduleAtFixedRate(Runnable task, long initialDelay, long period, TimeUnit unit) {
            if (shutdown.get()) {
                throw new IllegalStateException("scheduler is shut down");
            }
        }

        @Override
        public void shutdownNow() {
            shutdown.set(true);
        }
    }

    private static final class RecordingErrors {
        final AtomicInteger count = new AtomicInteger();

        void record(Exception ignored) {
            count.incrementAndGet();
        }
    }


    private static final class RecordingPeers {
        final AtomicInteger emptyCount = new AtomicInteger();

        void record(List<PeerDevice> peers) {
            if (peers.isEmpty()) {
                emptyCount.incrementAndGet();
            }
        }
    }

    private static final class RecordingStatuses {
        final AtomicInteger announcedCount = new AtomicInteger();

        void record(String message) {
            if ("已广播本机发现信息".equals(message)) {
                announcedCount.incrementAndGet();
            }
        }
    }

    private static final class CountingLock implements DiscoveryService.HeldMulticastLock {
        final AtomicInteger releaseCount = new AtomicInteger();
        private final AtomicInteger active;

        CountingLock(AtomicInteger active) {
            this.active = active;
            active.incrementAndGet();
        }

        @Override
        public void release() {
            if (releaseCount.compareAndSet(0, 1)) {
                active.decrementAndGet();
            }
        }
    }

    private abstract static class CountingSocket implements DiscoveryService.ManagedSocket {
        final AtomicInteger receiveCount = new AtomicInteger();
        final AtomicInteger closeCount = new AtomicInteger();
        final CountDownLatch closed = new CountDownLatch(1);
        private AtomicInteger active;

        void markOpened(AtomicInteger active) {
            this.active = active;
            active.incrementAndGet();
        }

        @Override
        public void send(DatagramPacket packet) {
        }

        @Override
        public void close() {
            if (closeCount.compareAndSet(0, 1)) {
                if (active != null) {
                    active.decrementAndGet();
                }
                closed.countDown();
            }
        }
    }

    private static final class BlockingSocket extends CountingSocket {
        final CountDownLatch receiveEntered = new CountDownLatch(1);

        @Override
        public void receive(DatagramPacket packet) throws Exception {
            receiveCount.incrementAndGet();
            receiveEntered.countDown();
            closed.await();
            throw new IOException("socket closed");
        }
    }

    private static final class ThrowingSocket extends CountingSocket {
        @Override
        public void receive(DatagramPacket packet) throws Exception {
            receiveCount.incrementAndGet();
            throw new IOException("synthetic receive failure");
        }
    }

    private static class QueueResourceFactory implements DiscoveryService.ResourceFactory {
        final Queue<CountingSocket> sockets = new ArrayDeque<>();
        final AtomicInteger receiverOpenCount = new AtomicInteger();
        final AtomicInteger activeLocks = new AtomicInteger();
        final AtomicInteger activeSockets = new AtomicInteger();
        final AtomicInteger maxActiveLocks = new AtomicInteger();
        final AtomicInteger maxActiveSockets = new AtomicInteger();

        @Override
        public DiscoveryService.HeldMulticastLock acquireMulticastLock() {
            CountingLock lock = new CountingLock(activeLocks);
            updateMaximum(maxActiveLocks, activeLocks.get());
            return lock;
        }

        @Override
        public DiscoveryService.ManagedSocket openReceiver() {
            receiverOpenCount.incrementAndGet();
            CountingSocket socket = sockets.remove();
            socket.markOpened(activeSockets);
            updateMaximum(maxActiveSockets, activeSockets.get());
            return socket;
        }

        @Override
        public DiscoveryService.ManagedSocket openSender() {
            throw new AssertionError("Periodic announcements must not run in lifecycle tests");
        }

        private static void updateMaximum(AtomicInteger maximum, int candidate) {
            maximum.accumulateAndGet(candidate, Math::max);
        }
    }

    private static final class BlockingLockFactory implements DiscoveryService.ResourceFactory {
        final CountDownLatch lockAcquireEntered = new CountDownLatch(1);
        final CountDownLatch allowLockAcquire = new CountDownLatch(1);
        final CountDownLatch lockReleased = new CountDownLatch(1);
        final AtomicInteger receiverOpenCount = new AtomicInteger();
        final CountingLock lock = new CountingLock(new AtomicInteger());

        @Override
        public DiscoveryService.HeldMulticastLock acquireMulticastLock() {
            lockAcquireEntered.countDown();
            awaitIgnoringInterrupt(allowLockAcquire);
            return () -> {
                lock.release();
                lockReleased.countDown();
            };
        }

        @Override
        public DiscoveryService.ManagedSocket openReceiver() {
            receiverOpenCount.incrementAndGet();
            throw new AssertionError("Receiver must not open after cancellation");
        }

        @Override
        public DiscoveryService.ManagedSocket openSender() {
            throw new AssertionError("Sender must not open");
        }
    }

    private static final class BlockingReceiverFactory implements DiscoveryService.ResourceFactory {
        final CountDownLatch receiverOpenEntered = new CountDownLatch(1);
        final CountDownLatch allowReceiverOpen = new CountDownLatch(1);
        final AtomicInteger activeLocks = new AtomicInteger();
        final CountingLock lock = new CountingLock(activeLocks);
        final CountingSocket socket = new BlockingSocket();

        @Override
        public DiscoveryService.HeldMulticastLock acquireMulticastLock() {
            return lock;
        }

        @Override
        public DiscoveryService.ManagedSocket openReceiver() {
            receiverOpenEntered.countDown();
            awaitIgnoringInterrupt(allowReceiverOpen);
            return socket;
        }

        @Override
        public DiscoveryService.ManagedSocket openSender() {
            throw new AssertionError("Sender must not open");
        }
    }

    private static void awaitIgnoringInterrupt(CountDownLatch latch) {
        boolean interrupted = false;
        while (true) {
            try {
                latch.await();
                break;
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
