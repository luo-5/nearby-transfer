package io.github.nearbytransfer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import io.github.nearbytransfer.android.core.data.V2TransferPeerAccess;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class V2IncomingTransferCoordinatorTest {
    private static final long NOW = 1_760_000_001_000L;
    private static final String TASK_ID = "AQIDBAUGBwgJCgsMDQ4PEA";
    private static final String SECOND_TASK_ID = "AgMEBQYHCAkKCwwNDg8QEQ";
    private static final String SESSION_ID = "EBESExQVFhcYGRobHB0eHw";
    private static final String SENDER_ID = "696d52f50efd19bf";
    private static final String RECEIVER_ID = "428997b2c1f7c6ec";
    private static final String OTHER_ID = "8fa1d28f6686c3eb";

    private String senderPrivateKey;
    private String senderPublicKey;
    private String receiverPrivateKey;
    private String receiverPublicKey;
    private String otherPrivateKey;
    private V2TransferPeerAccess.AuthorizedPeer authorizedPeer;

    @Before public void setUp() throws Exception {
        KeyPair sender = CryptoUtil.generateEd25519KeyPair();
        KeyPair receiver = CryptoUtil.generateEd25519KeyPair();
        KeyPair other = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        senderPrivateKey = CryptoUtil.toPrivatePem(sender.getPrivate());
        senderPublicKey = CryptoUtil.toPublicPem(sender.getPublic());
        receiverPrivateKey = CryptoUtil.toPrivatePem(receiver.getPrivate());
        receiverPublicKey = CryptoUtil.toPublicPem(receiver.getPublic());
        otherPrivateKey = CryptoUtil.toPrivatePem(other.getPrivate());
        authorizedPeer = new V2TransferPeerAccess.AuthorizedPeer(
            SENDER_ID,
            senderPublicKey,
            CryptoUtil.toPublicPem(encryption.getPublic())
        );
    }

    @Test public void authorizedAcceptancePersistsThenDetachesAndHandsOff() throws Exception {
        FakeJobs jobs = new FakeJobs();
        AtomicReference<V2IncomingTransferCoordinator.PendingRequest> prompted = new AtomicReference<>();
        AtomicReference<Socket> handedSocket = new AtomicReference<>();
        AtomicReference<V2TransferBootstrap.VerifiedManifest> handedManifest = new AtomicReference<>();
        AtomicReference<V2TransferPeerAccess.AuthorizedPeer> handedPeer = new AtomicReference<>();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> {
                prompted.set(request);
                return CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT);
            },
            (socket, manifest, peer) -> {
                handedSocket.set(socket);
                handedManifest.set(manifest);
                handedPeer.set(peer);
            },
            1_000L
        );

        try {
            coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

            V2IncomingTransferCoordinator.PendingRequest request = prompted.get();
            assertNotNull(request);
            assertEquals(TASK_ID, request.taskId());
            assertEquals(SENDER_ID, request.senderDeviceId());
            assertEquals(1, request.totalEntries());
            assertEquals(1, request.totalFiles());
            assertEquals(12L, request.totalBytes());
            assertEquals(Collections.singletonList("file: hello.txt"), request.entrySummaries());
            try {
                request.entrySummaries().add("secret");
                fail("Pending request summaries must be immutable");
            } catch (UnsupportedOperationException expected) { }

            assertEquals(Arrays.asList("CREATE", "QUEUED", "TRANSFERRING"), jobs.events);
            assertEquals("accepted", decision(connection, TASK_ID).decision);
            assertEquals(1, connection.detachCount.get());
            assertSame(connection.socket, handedSocket.get());
            assertEquals(TASK_ID, handedManifest.get().taskId);
            assertSame(authorizedPeer, handedPeer.get());
            assertFalse(connection.socket.isClosed());
        } finally {
            connection.socket.close();
            coordinator.close();
        }
    }

    @Test public void explicitRejectionCancelsPersistedJobWithoutHandoff() throws Exception {
        FakeJobs jobs = new FakeJobs();
        AtomicInteger runtimeCalls = new AtomicInteger();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.REJECT),
            (socket, manifest, peer) -> runtimeCalls.incrementAndGet(),
            1_000L
        );

        coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

        assertEquals(Arrays.asList("CREATE", "CANCELLED"), jobs.events);
        assertEquals("rejected", decision(connection, TASK_ID).decision);
        assertEquals(0, connection.detachCount.get());
        assertEquals(0, runtimeCalls.get());
        coordinator.close();
    }

    @Test public void untrustedOrRevokedPeerIsDeniedWithoutPromptOrResponse() throws Exception {
        for (int attempt = 0; attempt < 2; attempt += 1) {
            FakeJobs jobs = new FakeJobs();
            AtomicInteger prompts = new AtomicInteger();
            FakeConnection connection = new FakeConnection();
            V2IncomingTransferCoordinator coordinator = coordinator(
                deviceId -> null,
                jobs,
                request -> {
                    prompts.incrementAndGet();
                    return CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT);
                },
                (socket, manifest, peer) -> fail("Untrusted peer reached the runtime"),
                1_000L
            );

            coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

            assertEquals(0, prompts.get());
            assertTrue(jobs.events.isEmpty());
            assertTrue(connection.decisions.isEmpty());
            assertEquals(0, connection.detachCount.get());
            coordinator.close();
        }
    }

    @Test public void secondConcurrentRequestGetsBusyAndDoesNotPrompt() throws Exception {
        FakeJobs jobs = new FakeJobs();
        CompletableFuture<V2IncomingTransferCoordinator.Approval> firstDecision = new CompletableFuture<>();
        CountDownLatch prompted = new CountDownLatch(1);
        AtomicInteger prompts = new AtomicInteger();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> {
                prompts.incrementAndGet();
                prompted.countDown();
                return firstDecision;
            },
            (socket, manifest, peer) -> { },
            2_000L
        );
        FakeConnection first = new FakeConnection();
        FakeConnection second = new FakeConnection();
        Thread worker = new Thread(() -> coordinator.handleManifestFrame(
            uncheckedManifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), first
        ));
        worker.start();
        assertTrue(prompted.await(2, TimeUnit.SECONDS));

        coordinator.handleManifestFrame(
            manifestFrame(SECOND_TASK_ID, RECEIVER_ID, senderPrivateKey), second
        );
        assertEquals("busy", decision(second, SECOND_TASK_ID).decision);
        assertEquals(1, prompts.get());
        assertEquals(Collections.singletonList("CREATE"), new ArrayList<>(jobs.events));

        firstDecision.complete(V2IncomingTransferCoordinator.Approval.REJECT);
        worker.join(2_000L);
        assertFalse(worker.isAlive());
        assertEquals(Arrays.asList("CREATE", "CANCELLED"), jobs.events);
        coordinator.close();
    }

    @Test public void approvalTimeoutFailsPersistedJobAndRejects() throws Exception {
        FakeJobs jobs = new FakeJobs();
        CompletableFuture<V2IncomingTransferCoordinator.Approval> approval = new CompletableFuture<>();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> approval,
            (socket, manifest, peer) -> fail("Timed out approval reached runtime"),
            25L
        );

        coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

        assertTrue(approval.isCancelled());
        assertEquals(Arrays.asList("CREATE", "FAILED"), jobs.events);
        assertEquals("Incoming transfer approval timed out.", jobs.failureReasons.get(0));
        assertEquals("rejected", decision(connection, TASK_ID).decision);
        coordinator.close();
    }

    @Test public void duplicateTaskGetsBusyWithoutCreatingOrPrompting() throws Exception {
        FakeJobs jobs = new FakeJobs();
        jobs.existing.add(TASK_ID);
        AtomicInteger prompts = new AtomicInteger();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> {
                prompts.incrementAndGet();
                return CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT);
            },
            (socket, manifest, peer) -> fail("Duplicate transfer reached runtime"),
            1_000L
        );

        coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

        assertEquals(0, prompts.get());
        assertTrue(jobs.events.isEmpty());
        assertEquals("busy", decision(connection, TASK_ID).decision);
        coordinator.close();
    }

    @Test public void invalidSignatureOrRouteFailsClosedWithoutPrompt() throws Exception {
        FakeJobs jobs = new FakeJobs();
        AtomicInteger prompts = new AtomicInteger();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> {
                prompts.incrementAndGet();
                return CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT);
            },
            (socket, manifest, peer) -> fail("Invalid manifest reached runtime"),
            1_000L
        );

        FakeConnection badSignature = new FakeConnection();
        coordinator.handleManifestFrame(
            manifestFrame(TASK_ID, RECEIVER_ID, otherPrivateKey), badSignature
        );
        FakeConnection badRoute = new FakeConnection();
        coordinator.handleManifestFrame(
            manifestFrame(TASK_ID, OTHER_ID, senderPrivateKey), badRoute
        );

        assertEquals(0, prompts.get());
        assertTrue(jobs.events.isEmpty());
        assertTrue(badSignature.decisions.isEmpty());
        assertTrue(badRoute.decisions.isEmpty());
        coordinator.close();
    }

    @Test public void runtimeHandoffFailureClosesSocketAndMarksJobFailed() throws Exception {
        FakeJobs jobs = new FakeJobs();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT),
            (socket, manifest, peer) -> { throw new IllegalStateException("runtime unavailable"); },
            1_000L
        );

        coordinator.handleManifestFrame(manifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection);

        assertEquals(Arrays.asList("CREATE", "QUEUED", "TRANSFERRING", "FAILED"), jobs.events);
        assertEquals("Incoming transfer runtime handoff failed.", jobs.failureReasons.get(0));
        assertEquals("accepted", decision(connection, TASK_ID).decision);
        assertEquals(1, connection.detachCount.get());
        assertTrue(connection.socket.isClosed());
        coordinator.close();
    }

    @Test public void rechecksAuthorizationAfterApprovalBeforeAccepting() throws Exception {
        FakeJobs jobs = new FakeJobs();
        AtomicReference<V2TransferPeerAccess.AuthorizedPeer> currentPeer =
            new AtomicReference<>(authorizedPeer);
        CompletableFuture<V2IncomingTransferCoordinator.Approval> approval = new CompletableFuture<>();
        CountDownLatch prompted = new CountDownLatch(1);
        AtomicInteger runtimeCalls = new AtomicInteger();
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            deviceId -> currentPeer.get(),
            jobs,
            request -> {
                prompted.countDown();
                return approval;
            },
            (socket, manifest, peer) -> runtimeCalls.incrementAndGet(),
            2_000L
        );
        Thread worker = new Thread(() -> coordinator.handleManifestFrame(
            uncheckedManifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection
        ));
        worker.start();
        assertTrue(prompted.await(2, TimeUnit.SECONDS));

        currentPeer.set(null);
        approval.complete(V2IncomingTransferCoordinator.Approval.ACCEPT);
        worker.join(2_000L);

        assertFalse(worker.isAlive());
        assertEquals(Arrays.asList("CREATE", "CANCELLED"), jobs.events);
        assertEquals("unauthorized", decision(connection, TASK_ID).decision);
        assertEquals(0, connection.detachCount.get());
        assertEquals(0, runtimeCalls.get());
        coordinator.close();
    }

    @Test public void closeWaitsForAnAlreadyClaimedRuntimeHandoff() throws Exception {
        FakeJobs jobs = new FakeJobs();
        CountDownLatch runtimeEntered = new CountDownLatch(1);
        CountDownLatch releaseRuntime = new CountDownLatch(1);
        FakeConnection connection = new FakeConnection();
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT),
            (socket, manifest, peer) -> {
                runtimeEntered.countDown();
                if (!releaseRuntime.await(2, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test runtime release timed out");
                }
            },
            2_000L
        );
        Thread worker = new Thread(() -> coordinator.handleManifestFrame(
            uncheckedManifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), connection
        ));
        worker.start();
        assertTrue(runtimeEntered.await(2, TimeUnit.SECONDS));

        Thread closer = new Thread(coordinator::close);
        closer.start();
        Thread.sleep(50L);
        assertTrue("close must wait for the claimed handoff", closer.isAlive());

        releaseRuntime.countDown();
        worker.join(2_000L);
        closer.join(2_000L);
        assertFalse(worker.isAlive());
        assertFalse(closer.isAlive());
        assertEquals(1, connection.detachCount.get());
        assertEquals(Arrays.asList("CREATE", "QUEUED", "TRANSFERRING"), jobs.events);
        connection.socket.close();
    }

    @Test public void closeCancelsPendingApprovalAndPreventsNewWork() throws Exception {
        FakeJobs jobs = new FakeJobs();
        CompletableFuture<V2IncomingTransferCoordinator.Approval> approval = new CompletableFuture<>();
        CountDownLatch prompted = new CountDownLatch(1);
        V2IncomingTransferCoordinator coordinator = coordinator(
            jobs,
            request -> {
                prompted.countDown();
                return approval;
            },
            (socket, manifest, peer) -> fail("Closed coordinator reached runtime"),
            2_000L
        );
        FakeConnection first = new FakeConnection();
        Thread worker = new Thread(() -> coordinator.handleManifestFrame(
            uncheckedManifestFrame(TASK_ID, RECEIVER_ID, senderPrivateKey), first
        ));
        worker.start();
        assertTrue(prompted.await(2, TimeUnit.SECONDS));

        coordinator.close();
        worker.join(2_000L);

        assertTrue(approval.isCancelled());
        assertFalse(worker.isAlive());
        assertEquals(Arrays.asList("CREATE", "CANCELLED"), jobs.events);
        FakeConnection afterClose = new FakeConnection();
        coordinator.handleManifestFrame(
            manifestFrame(SECOND_TASK_ID, RECEIVER_ID, senderPrivateKey), afterClose
        );
        assertTrue(afterClose.decisions.isEmpty());
        assertEquals(Arrays.asList("CREATE", "CANCELLED"), jobs.events);
    }

    @FunctionalInterface
    interface LegacyRuntimeHandler {
        void start(Socket socket, V2TransferBootstrap.VerifiedManifest manifest,
                   V2TransferPeerAccess.AuthorizedPeer peer) throws Exception;
    }

    private V2IncomingTransferCoordinator coordinator(
        FakeJobs jobs,
        V2IncomingTransferCoordinator.ApprovalHandler approvals,
        LegacyRuntimeHandler runtime,
        long timeoutMs
    ) {
        return coordinator(deviceId -> authorizedPeer, jobs, approvals, runtime, timeoutMs);
    }

    private V2IncomingTransferCoordinator coordinator(
        V2IncomingTransferCoordinator.PeerLookup peers,
        FakeJobs jobs,
        V2IncomingTransferCoordinator.ApprovalHandler approvals,
        LegacyRuntimeHandler runtime,
        long timeoutMs
    ) {
        return new V2IncomingTransferCoordinator(
            RECEIVER_ID,
            receiverPrivateKey,
            peers,
            jobs,
            approvals,
            (manifest, peer) -> new V2IncomingTransferCoordinator.PreparedRuntime() {
                @Override public V2WireFrame.Frame createResumeFrame() { return null; }
                @Override public void start(Socket socket) throws Exception {
                    runtime.start(socket, manifest, peer);
                }
            },
            () -> NOW,
            timeoutMs
        );
    }

    private V2WireFrame.Frame manifestFrame(String taskId, String receiverId, String signingKey) throws Exception {
        JSONObject file = new JSONObject();
        file.put("kind", "file");
        file.put("path", "hello.txt");
        file.put("size", 12);
        file.put("sha256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        JSONObject manifest = new JSONObject();
        manifest.put("app", ProtocolV2.APP_ID);
        manifest.put("protocolVersion", ProtocolV2.VERSION);
        manifest.put("type", V2TransferMessage.TYPE_MANIFEST);
        manifest.put("taskId", taskId);
        manifest.put("conflictStrategy", "auto-rename");
        manifest.put("entries", new JSONArray().put(file));
        manifest.put("totalFiles", 1);
        manifest.put("totalBytes", 12);

        byte[] ephemeralKey = new byte[32];
        Arrays.fill(ephemeralKey, (byte) 7);
        JSONObject envelope = new JSONObject();
        envelope.put("app", ProtocolV2.APP_ID);
        envelope.put("protocolVersion", ProtocolV2.VERSION);
        envelope.put("type", V2TransferMessage.TYPE_MANIFEST);
        envelope.put("manifest", manifest);
        envelope.put("sessionId", SESSION_ID);
        envelope.put("senderDeviceId", SENDER_ID);
        envelope.put("receiverDeviceId", receiverId);
        envelope.put(
            "senderEphemeralPublicKey",
            Base64.getUrlEncoder().withoutPadding().encodeToString(ephemeralKey)
        );
        envelope.put("issuedAt", NOW);
        envelope.put("expiresAt", NOW + 120_000L);
        JSONObject signed = V2TransferMessageAuth.signedCopy(
            V2TransferMessage.TYPE_MANIFEST, envelope, signingKey
        );
        JSONObject header = new JSONObject();
        header.put("app", ProtocolV2.APP_ID);
        header.put("protocolVersion", ProtocolV2.VERSION);
        header.put("type", V2TransferMessage.TYPE_MANIFEST);
        return new V2WireFrame.Frame(
            header,
            ProtocolV2.canonicalJson(signed).getBytes(StandardCharsets.UTF_8)
        );
    }

    private V2WireFrame.Frame uncheckedManifestFrame(String taskId, String receiverId, String signingKey) {
        try {
            return manifestFrame(taskId, receiverId, signingKey);
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private V2TransferMessage.Decision decision(FakeConnection connection, String taskId) throws Exception {
        assertEquals(1, connection.decisions.size());
        return V2TransferBootstrap.verifyDecisionFrame(
            V2WireFrame.encode(connection.decisions.get(0)),
            receiverPublicKey,
            RECEIVER_ID,
            SENDER_ID,
            taskId,
            SESSION_ID,
            NOW
        );
    }

    private static final class FakeConnection implements V2IncomingTransferCoordinator.ConnectionHandle {
        final List<V2WireFrame.Frame> decisions = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger detachCount = new AtomicInteger();
        final Socket socket = new Socket();

        @Override public void sendDecisionFrame(V2WireFrame.Frame frame) {
            decisions.add(frame);
        }

        @Override public Socket detachForTransfer() {
            detachCount.incrementAndGet();
            return socket;
        }
    }

    private static final class FakeJobs implements V2IncomingTransferCoordinator.JobStore {
        final Set<String> existing = Collections.synchronizedSet(new HashSet<>());
        final List<String> events = Collections.synchronizedList(new ArrayList<>());
        final List<String> failureReasons = Collections.synchronizedList(new ArrayList<>());

        @Override public boolean exists(String taskId) {
            return existing.contains(taskId);
        }

        @Override public void createIncoming(String taskId, String peerId, String manifestJson,
                                             boolean recoverable, long nowEpochMillis) {
            if (!existing.add(taskId)) throw new IllegalStateException("duplicate");
            assertEquals(SENDER_ID, peerId);
            assertTrue(recoverable);
            assertEquals(NOW, nowEpochMillis);
            assertTrue(manifestJson.contains("\"taskId\":\"" + taskId + "\""));
            events.add("CREATE");
        }

        @Override public void transition(String taskId, String state, long nowEpochMillis,
                                         String failureReason, Boolean recoverable) {
            assertTrue(existing.contains(taskId));
            assertEquals(NOW, nowEpochMillis);
            events.add(state);
            if (failureReason != null) failureReasons.add(failureReason);
        }
    }
}
