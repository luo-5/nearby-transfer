package io.github.nearbytransfer.android;

import org.junit.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class HttpTransferServerLifecycleTest {
    @Test
    public void concurrentStartsShareOneRuntimeAndServerCanRestartAfterStop() throws Exception {
        TrackingRuntimeFactory runtime = new TrackingRuntimeFactory();
        HttpTransferServer server = newServer(runtime);
        ExecutorService callers = Executors.newFixedThreadPool(8);
        CountDownLatch ready = new CountDownLatch(8);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        try {
            for (int i = 0; i < 8; i += 1) {
                results.add(callers.submit(() -> {
                    ready.countDown();
                    assertTrue(ready.await(5, TimeUnit.SECONDS));
                    assertTrue(start.await(5, TimeUnit.SECONDS));
                    return server.start(0);
                }));
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();

            int firstPort = results.get(0).get(5, TimeUnit.SECONDS);
            assertTrue(firstPort > 0);
            for (Future<Integer> result : results) {
                assertEquals(firstPort, (int) result.get(5, TimeUnit.SECONDS));
            }
            assertEquals(1, runtime.sockets.size());
            assertEquals(1, runtime.workers.size());
            assertEquals(1, runtime.cleanups.size());

            ServerSocket firstSocket = runtime.sockets.get(0);
            server.stop();
            server.stop();
            assertTrue(firstSocket.isClosed());
            assertTrue(runtime.workers.get(0).isShutdown());
            assertTrue(runtime.cleanups.get(0).isShutdown());

            int restartedPort = server.start(0);
            assertTrue(restartedPort > 0);
            assertEquals(2, runtime.sockets.size());
            assertNotEquals(firstSocket, runtime.sockets.get(1));
        } finally {
            start.countDown();
            server.stop();
            callers.shutdownNow();
        }
    }

    @Test
    public void activeConnectionsAreBoundAndStopClosesTrackedSockets() throws Exception {
        HttpTransferServer server = newServer(HttpTransferServer.RuntimeFactory.DEFAULT, 1);
        Socket first = null;
        Socket second = null;
        try {
            int port = server.start(0);
            first = new Socket("127.0.0.1", port);
            first.getOutputStream().write("GET /health HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII));
            first.getOutputStream().flush();
            awaitActiveSocketCount(server, 1);

            second = new Socket("127.0.0.1", port);
            assertPeerClosed(second);
            assertEquals(1, activeSocketCount(server));

            server.stop();
            assertPeerClosed(first);
            awaitActiveSocketCount(server, 0);
        } finally {
            close(first);
            close(second);
            server.stop();
        }
    }

    @Test
    public void rejectedClientWorkerReleasesSocketAndConnectionPermit() throws Exception {
        RejectClientWorkerRuntimeFactory runtime = new RejectClientWorkerRuntimeFactory();
        HttpTransferServer server = newServer(runtime, 1);
        Socket client = null;
        try {
            int port = server.start(0);
            client = new Socket("127.0.0.1", port);
            assertPeerClosed(client);
            awaitActiveSocketCount(server, 0);

            server.stop();
            int restartedPort = server.start(0);
            close(client);
            client = new Socket("127.0.0.1", restartedPort);
            client.getOutputStream().write("GET /missing HTTP/1.1\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            client.getOutputStream().flush();
            assertTrue(readUntil(client, "404 Error"));
        } finally {
            close(client);
            server.stop();
        }
    }

    @Test
    public void cleanupFactoryFailureClosesSocketAndStopsWorkerExecutor() throws Exception {
        TrackingRuntimeFactory runtime = new TrackingRuntimeFactory() {
            @Override
            public ScheduledThreadPoolExecutor newCleanupExecutor() {
                throw new IllegalStateException("cleanup factory failed");
            }
        };
        HttpTransferServer server = newServer(runtime);

        try {
            server.start(0);
            fail("Expected cleanup factory to fail");
        } catch (IllegalStateException expected) {
            assertEquals("cleanup factory failed", expected.getMessage());
        }

        assertEquals(1, runtime.sockets.size());
        assertTrue(runtime.sockets.get(0).isClosed());
        assertEquals(1, runtime.workers.size());
        assertTrue(runtime.workers.get(0).isShutdown());
        assertTrue(runtime.cleanups.isEmpty());
        assertFalse(readBoolean(server, "running"));
    }

    @Test
    public void workerSubmissionFailureRollsBackSocketAndCleanupExecutor() throws Exception {
        TrackingRuntimeFactory runtime = new TrackingRuntimeFactory() {
            @Override
            public ExecutorService newWorkerExecutor() {
                ExecutorService executor = Executors.newSingleThreadExecutor();
                executor.shutdown();
                workers.add(executor);
                return executor;
            }
        };
        HttpTransferServer server = newServer(runtime);

        try {
            server.start(0);
            fail("Expected worker submission to fail");
        } catch (RejectedExecutionException expected) {
            assertNotNull(expected.getMessage());
        }

        assertEquals(1, runtime.sockets.size());
        assertTrue(runtime.sockets.get(0).isClosed());
        assertTrue(runtime.workers.get(0).isShutdown());
        assertTrue(runtime.cleanups.get(0).isShutdown());
        assertFalse(readBoolean(server, "running"));
    }

    @Test
    public void cleanupSchedulingFailureRollsBackEveryCreatedResource() throws Exception {
        TrackingRuntimeFactory runtime = new TrackingRuntimeFactory() {
            @Override
            public ScheduledThreadPoolExecutor newCleanupExecutor() {
                ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1) {
                    @Override
                    public ScheduledFuture<?> scheduleAtFixedRate(
                        Runnable command,
                        long initialDelay,
                        long period,
                        TimeUnit unit
                    ) {
                        throw new RejectedExecutionException("cleanup rejected");
                    }
                };
                cleanups.add(executor);
                return executor;
            }
        };
        HttpTransferServer server = newServer(runtime);

        try {
            server.start(0);
            fail("Expected cleanup scheduling to fail");
        } catch (RejectedExecutionException expected) {
            assertEquals("cleanup rejected", expected.getMessage());
        }

        assertEquals(1, runtime.sockets.size());
        assertTrue(runtime.sockets.get(0).isClosed());
        assertTrue(runtime.workers.get(0).isShutdown());
        assertTrue(runtime.cleanups.get(0).isShutdown());
        assertFalse(readBoolean(server, "running"));
        assertNull(readField(server, "serverSocket"));
        assertNull(readField(server, "workers"));
        assertNull(readField(server, "cleanup"));
        assertEquals(0, readInt(server, "port"));

        server.stop();
    }

    @Test
    public void stopWaitsForInFlightStartThenTearsDownThePublishedRuntime() throws Exception {
        BlockingCleanupRuntimeFactory runtime = new BlockingCleanupRuntimeFactory();
        HttpTransferServer server = newServer(runtime);
        ExecutorService callers = Executors.newFixedThreadPool(2);
        CountDownLatch stopInvoked = new CountDownLatch(1);
        try {
            Future<Integer> starting = callers.submit(() -> server.start(0));
            assertTrue(runtime.scheduleEntered.await(5, TimeUnit.SECONDS));

            Future<?> stopping = callers.submit(() -> {
                stopInvoked.countDown();
                server.stop();
            });
            assertTrue(stopInvoked.await(5, TimeUnit.SECONDS));
            Thread.sleep(100);
            assertFalse("stop must not tear down a half-published start", stopping.isDone());

            runtime.releaseSchedule.countDown();
            assertTrue(starting.get(5, TimeUnit.SECONDS) > 0);
            stopping.get(5, TimeUnit.SECONDS);

            assertNotNull(runtime.socket);
            assertTrue(runtime.socket.isClosed());
            assertTrue(runtime.worker.isShutdown());
            assertTrue(runtime.cleanup.isShutdown());
            assertFalse(readBoolean(server, "running"));
        } finally {
            runtime.releaseSchedule.countDown();
            server.stop();
            callers.shutdownNow();
        }
    }

    @Test
    public void stopClaimsAndAbortsEveryPendingSaveExactlyOnce() throws Exception {
        HttpTransferServer server = newServer(HttpTransferServer.RuntimeFactory.DEFAULT);
        AtomicInteger firstAborts = new AtomicInteger();
        AtomicInteger failingAborts = new AtomicInteger();
        AtomicInteger lastAborts = new AtomicInteger();

        putPending(server, "first", pendingSave(firstAborts, false), System.currentTimeMillis());
        putPending(server, "failing", pendingSave(failingAborts, true), System.currentTimeMillis());
        putPending(server, "last", pendingSave(lastAborts, false), System.currentTimeMillis());

        server.stop();
        server.stop();

        assertEquals(1, firstAborts.get());
        assertEquals(1, failingAborts.get());
        assertEquals(1, lastAborts.get());
        assertTrue(pendingMap(server).isEmpty());
    }

    @Test
    public void stopAndExpiryCleanupRaceAbortPendingSaveOnlyOnce() throws Exception {
        for (int attempt = 0; attempt < 50; attempt += 1) {
            HttpTransferServer server = newServer(HttpTransferServer.RuntimeFactory.DEFAULT);
            AtomicInteger aborts = new AtomicInteger();
            putPending(server, "race", pendingSave(aborts, false), 0L);
            writeBoolean(server, "running", true);

            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch race = new CountDownLatch(1);
            ExecutorService callers = Executors.newFixedThreadPool(2);
            try {
                Future<?> cleanup = callers.submit(() -> {
                    ready.countDown();
                    await(race);
                    invokeCleanup(server);
                });
                Future<?> stop = callers.submit(() -> {
                    ready.countDown();
                    await(race);
                    server.stop();
                });
                assertTrue(ready.await(5, TimeUnit.SECONDS));
                race.countDown();
                cleanup.get(5, TimeUnit.SECONDS);
                stop.get(5, TimeUnit.SECONDS);
            } finally {
                race.countDown();
                callers.shutdownNow();
                server.stop();
            }

            assertEquals("attempt " + attempt, 1, aborts.get());
            assertTrue(pendingMap(server).isEmpty());
        }
    }

    @Test
    public void alreadyQueuedCleanupTaskBecomesNoOpAfterStop() throws Exception {
        CapturingCleanupRuntimeFactory runtime = new CapturingCleanupRuntimeFactory();
        HttpTransferServer server = newServer(runtime);
        server.start(0);
        assertNotNull(runtime.cleanupTask);
        server.stop();

        AtomicInteger aborts = new AtomicInteger();
        putPending(server, "late", pendingSave(aborts, false), 0L);
        runtime.cleanupTask.run();

        assertEquals(0, aborts.get());
        assertEquals(1, pendingMap(server).size());

        server.stop();
        assertEquals(1, aborts.get());
        assertTrue(pendingMap(server).isEmpty());
    }

    private static HttpTransferServer newServer(HttpTransferServer.RuntimeFactory runtimeFactory) {
        return newServer(runtimeFactory, 16);
    }

    private static HttpTransferServer newServer(HttpTransferServer.RuntimeFactory runtimeFactory, int maxActiveConnections) {
        SaveTarget saveTarget = new SaveTarget() {
            @Override
            public String displayName() {
                return "test";
            }

            @Override
            public String displayPathFor(String fileName) {
                return fileName;
            }

            @Override
            public PendingSave prepare(String fileName) {
                throw new AssertionError("No transfer request expected");
            }
        };
        if (maxActiveConnections == 16) {
            return new HttpTransferServer(null, saveTarget, incoming -> false, event -> { }, runtimeFactory);
        }
        return new HttpTransferServer(null, saveTarget, incoming -> false, event -> { }, runtimeFactory, maxActiveConnections);
    }

    @SuppressWarnings("unchecked")
    private static int activeSocketCount(HttpTransferServer server) throws Exception {
        return ((java.util.Set<Socket>) readField(server, "activeSockets")).size();
    }

    private static void awaitActiveSocketCount(HttpTransferServer server, int expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (activeSocketCount(server) == expected) {
                return;
            }
            Thread.sleep(10);
        }
        assertEquals(expected, activeSocketCount(server));
    }

    private static void assertPeerClosed(Socket socket) throws IOException {
        socket.setSoTimeout(1000);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            try {
                if (socket.getInputStream().read() == -1) {
                    return;
                }
            } catch (SocketTimeoutException ignored) {
            } catch (SocketException expected) {
                return;
            }
        }
        fail("Socket was not closed by the server");
    }

    private static boolean readUntil(Socket socket, String expected) throws IOException {
        socket.setSoTimeout(2000);
        byte[] buffer = new byte[4096];
        int total = 0;
        while (total < buffer.length) {
            int read = socket.getInputStream().read(buffer, total, buffer.length - total);
            if (read == -1) {
                break;
            }
            total += read;
            if (new String(buffer, 0, total, StandardCharsets.US_ASCII).contains(expected)) {
                return true;
            }
        }
        return false;
    }

    private static void close(Socket socket) {
        if (socket == null) {
            return;
        }
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    private static SaveTarget.PendingSave pendingSave(AtomicInteger aborts, boolean failOnAbort) {
        return new SaveTarget.PendingSave() {
            @Override
            public String displayPath() {
                return "test";
            }

            @Override
            public OutputStream openOutputStream() {
                throw new AssertionError("Output must not be opened");
            }

            @Override
            public void commit() {
                throw new AssertionError("Save must not be committed");
            }

            @Override
            public void abort() {
                aborts.incrementAndGet();
                if (failOnAbort) {
                    throw new IllegalStateException("provider abort failed");
                }
            }
        };
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void putPending(HttpTransferServer server, String transferId, SaveTarget.PendingSave pendingSave, long createdAt) throws Exception {
        Class<?> type = Class.forName(HttpTransferServer.class.getName() + "$PendingTransfer");
        Constructor<?> constructor = type.getDeclaredConstructor(
            long.class,
            byte[].class,
            PeerDevice.class,
            String.class,
            long.class,
            String.class,
            SaveTarget.PendingSave.class
        );
        constructor.setAccessible(true);
        Object transfer = constructor.newInstance(createdAt, new byte[0], null, transferId + ".bin", 0L, "", pendingSave);
        ((Map) pendingMap(server)).put(transferId, transfer);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> pendingMap(HttpTransferServer server) throws Exception {
        return (Map<String, Object>) readField(server, "pending");
    }

    private static void invokeCleanup(HttpTransferServer server) {
        try {
            Method method = HttpTransferServer.class.getDeclaredMethod("cleanupPending");
            method.setAccessible(true);
            method.invoke(server);
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
    }

    private static Object readField(HttpTransferServer server, String name) throws Exception {
        Field field = HttpTransferServer.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(server);
    }

    private static boolean readBoolean(HttpTransferServer server, String name) throws Exception {
        return (boolean) readField(server, name);
    }

    private static int readInt(HttpTransferServer server, String name) throws Exception {
        return (int) readField(server, name);
    }

    private static void writeBoolean(HttpTransferServer server, String name, boolean value) throws Exception {
        Field field = HttpTransferServer.class.getDeclaredField(name);
        field.setAccessible(true);
        field.setBoolean(server, value);
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(5, TimeUnit.SECONDS));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private static final class RejectClientWorkerRuntimeFactory implements HttpTransferServer.RuntimeFactory {
        final List<ServerSocket> sockets = Collections.synchronizedList(new ArrayList<>());
        final List<ExecutorService> workers = Collections.synchronizedList(new ArrayList<>());
        final List<ScheduledThreadPoolExecutor> cleanups = Collections.synchronizedList(new ArrayList<>());

        @Override
        public ServerSocket openServerSocket(int requestedPort) throws IOException {
            ServerSocket socket = new ServerSocket(requestedPort);
            sockets.add(socket);
            return socket;
        }

        @Override
        public ExecutorService newWorkerExecutor() {
            if (!workers.isEmpty()) {
                ExecutorService executor = Executors.newCachedThreadPool();
                workers.add(executor);
                return executor;
            }
            ExecutorService executor = new ThreadPoolExecutor(
                0,
                Integer.MAX_VALUE,
                60L,
                TimeUnit.SECONDS,
                new SynchronousQueue<Runnable>()
            ) {
                private final AtomicInteger submissions = new AtomicInteger();

                @Override
                public void execute(Runnable command) {
                    if (submissions.incrementAndGet() > 1) {
                        throw new RejectedExecutionException("client worker rejected");
                    }
                    super.execute(command);
                }
            };
            workers.add(executor);
            return executor;
        }

        @Override
        public ScheduledThreadPoolExecutor newCleanupExecutor() {
            ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1);
            cleanups.add(executor);
            return executor;
        }
    }

    private static class TrackingRuntimeFactory implements HttpTransferServer.RuntimeFactory {
        final List<ServerSocket> sockets = Collections.synchronizedList(new ArrayList<>());
        final List<ExecutorService> workers = Collections.synchronizedList(new ArrayList<>());
        final List<ScheduledThreadPoolExecutor> cleanups = Collections.synchronizedList(new ArrayList<>());

        @Override
        public ServerSocket openServerSocket(int requestedPort) throws IOException {
            ServerSocket socket = new ServerSocket(requestedPort);
            sockets.add(socket);
            return socket;
        }

        @Override
        public ExecutorService newWorkerExecutor() {
            ExecutorService executor = Executors.newCachedThreadPool();
            workers.add(executor);
            return executor;
        }

        @Override
        public ScheduledThreadPoolExecutor newCleanupExecutor() {
            ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1);
            cleanups.add(executor);
            return executor;
        }
    }

    private static final class BlockingCleanupRuntimeFactory implements HttpTransferServer.RuntimeFactory {
        final CountDownLatch scheduleEntered = new CountDownLatch(1);
        final CountDownLatch releaseSchedule = new CountDownLatch(1);
        ServerSocket socket;
        ExecutorService worker;
        ScheduledThreadPoolExecutor cleanup;

        @Override
        public ServerSocket openServerSocket(int requestedPort) throws IOException {
            socket = new ServerSocket(requestedPort);
            return socket;
        }

        @Override
        public ExecutorService newWorkerExecutor() {
            worker = Executors.newCachedThreadPool();
            return worker;
        }

        @Override
        public ScheduledThreadPoolExecutor newCleanupExecutor() {
            cleanup = new ScheduledThreadPoolExecutor(1) {
                @Override
                public ScheduledFuture<?> scheduleAtFixedRate(
                    Runnable command,
                    long initialDelay,
                    long period,
                    TimeUnit unit
                ) {
                    scheduleEntered.countDown();
                    await(releaseSchedule);
                    return super.scheduleAtFixedRate(command, initialDelay, period, unit);
                }
            };
            return cleanup;
        }
    }

    private static final class CapturingCleanupRuntimeFactory extends TrackingRuntimeFactory {
        volatile Runnable cleanupTask;

        @Override
        public ScheduledThreadPoolExecutor newCleanupExecutor() {
            ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1) {
                @Override
                public ScheduledFuture<?> scheduleAtFixedRate(
                    Runnable command,
                    long initialDelay,
                    long period,
                    TimeUnit unit
                ) {
                    cleanupTask = command;
                    return super.scheduleAtFixedRate(command, initialDelay, period, unit);
                }
            };
            cleanups.add(executor);
            return executor;
        }
    }
}
