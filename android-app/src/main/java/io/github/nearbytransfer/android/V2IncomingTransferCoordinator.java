package io.github.nearbytransfer.android;

import android.content.Context;

import io.github.nearbytransfer.android.core.data.V2TransferJobPersistence;
import io.github.nearbytransfer.android.core.data.V2TransferPeerAccess;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.Closeable;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Authenticates, persists, and obtains explicit approval for one incoming transfer at a time. */
final class V2IncomingTransferCoordinator implements V2LanService.TransferHandler, Closeable {
    static final long DEFAULT_APPROVAL_TIMEOUT_MS = 60_000L;
    static final long MAX_APPROVAL_TIMEOUT_MS = 5 * 60_000L;
    private static final int MAX_ENTRY_SUMMARIES = 3;
    private static final int MAX_SUMMARY_CODE_POINTS = 80;

    enum Approval {
        ACCEPT,
        REJECT,
    }

    /** Key-free, bounded data that may be handed to an Activity or notification. */
    static final class PendingRequest {
        private final String taskId;
        private final String senderDeviceId;
        private final int totalEntries;
        private final int totalFiles;
        private final long totalBytes;
        private final List<String> entrySummaries;

        private PendingRequest(V2TransferBootstrap.VerifiedManifest verified) throws Exception {
            JSONObject manifest = verified.message.manifest;
            JSONArray entries = manifest.getJSONArray("entries");
            ArrayList<String> summaries = new ArrayList<>();
            for (int index = 0; index < entries.length() && summaries.size() < MAX_ENTRY_SUMMARIES; index += 1) {
                JSONObject entry = entries.getJSONObject(index);
                String kind = entry.getString("kind");
                String path = entry.getString("path");
                int slash = path.lastIndexOf('/');
                String name = slash < 0 ? path : path.substring(slash + 1);
                summaries.add(("file".equals(kind) ? "file: " : "folder: ") + displaySafe(name));
            }
            this.taskId = verified.taskId;
            this.senderDeviceId = verified.message.senderDeviceId;
            this.totalEntries = entries.length();
            this.totalFiles = manifest.getInt("totalFiles");
            this.totalBytes = manifest.getLong("totalBytes");
            this.entrySummaries = Collections.unmodifiableList(summaries);
        }

        String taskId() { return taskId; }
        String senderDeviceId() { return senderDeviceId; }
        int totalEntries() { return totalEntries; }
        int totalFiles() { return totalFiles; }
        long totalBytes() { return totalBytes; }
        List<String> entrySummaries() { return entrySummaries; }

        private static String displaySafe(String value) {
            StringBuilder result = new StringBuilder();
            int accepted = 0;
            for (int offset = 0; offset < value.length() && accepted < MAX_SUMMARY_CODE_POINTS;) {
                int codePoint = value.codePointAt(offset);
                offset += Character.charCount(codePoint);
                int type = Character.getType(codePoint);
                if (Character.isISOControl(codePoint) || type == Character.FORMAT
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) {
                    result.append('\uFFFD');
                } else {
                    result.appendCodePoint(codePoint);
                }
                accepted += 1;
            }
            if (value.codePointCount(0, value.length()) > MAX_SUMMARY_CODE_POINTS) result.append("...");
            return result.toString();
        }
    }

    interface ApprovalHandler {
        CompletionStage<Approval> requestApproval(PendingRequest request);
    }

    interface PreparedRuntime extends AutoCloseable {
        V2WireFrame.Frame createResumeFrame() throws Exception;
        void start(Socket socket) throws Exception;
        @Override default void close() throws Exception {}
    }

    @FunctionalInterface
    interface RuntimeHandler {
        PreparedRuntime prepare(V2TransferBootstrap.VerifiedManifest manifest,
                                V2TransferPeerAccess.AuthorizedPeer peer) throws Exception;
    }

    interface PeerLookup {
        V2TransferPeerAccess.AuthorizedPeer findAuthorizedPeer(String deviceId) throws Exception;
    }

    interface JobStore {
        boolean exists(String taskId) throws Exception;
        void createIncoming(String taskId, String peerId, String manifestJson,
                            boolean recoverable, long nowEpochMillis) throws Exception;
        void transition(String taskId, String state, long nowEpochMillis,
                        String failureReason, Boolean recoverable) throws Exception;
    }

    interface Clock {
        long nowEpochMillis();
    }

    interface ConnectionHandle {
        void sendDecisionFrame(V2WireFrame.Frame frame) throws Exception;
        Socket detachForTransfer() throws Exception;
    }

    private static final class PendingApproval {
        final String taskId;
        CompletableFuture<Approval> future;

        PendingApproval(String taskId) {
            this.taskId = taskId;
        }
    }

    private final String localDeviceId;
    private final String localSigningPrivateKey;
    private final PeerLookup peerLookup;
    private final JobStore jobs;
    private final ApprovalHandler approvalHandler;
    private final RuntimeHandler runtimeHandler;
    private final Clock clock;
    private final long approvalTimeoutMs;
    private final Object stateLock = new Object();
    private PendingApproval pending;
    private boolean closed;
    private boolean handoffInProgress;
    private Thread handoffThread;

    static V2IncomingTransferCoordinator create(
        Context context,
        DeviceConfig localDevice,
        ApprovalHandler approvalHandler,
        RuntimeHandler runtimeHandler
    ) {
        Objects.requireNonNull(context, "context");
        Objects.requireNonNull(localDevice, "localDevice");
        Context applicationContext = Objects.requireNonNull(
            context.getApplicationContext(), "An application Context is required"
        );
        return new V2IncomingTransferCoordinator(
            localDevice.deviceId,
            localDevice.signingPrivateKey,
            deviceId -> V2TransferPeerAccess.findAuthorizedPeer(applicationContext, deviceId),
            new JobStore() {
                @Override public boolean exists(String taskId) {
                    return V2TransferJobPersistence.find(applicationContext, taskId) != null;
                }

                @Override public void createIncoming(String taskId, String peerId, String manifestJson,
                                                     boolean recoverable, long nowEpochMillis) {
                    V2TransferJobPersistence.createIncoming(
                        applicationContext, taskId, peerId, manifestJson, recoverable, nowEpochMillis
                    );
                }

                @Override public void transition(String taskId, String state, long nowEpochMillis,
                                                 String failureReason, Boolean recoverable) {
                    if (V2TransferJobPersistence.transition(
                        applicationContext, taskId, state, nowEpochMillis, failureReason, recoverable
                    ) == null) {
                        throw new IllegalStateException("Incoming transfer job no longer exists");
                    }
                }
            },
            approvalHandler,
            runtimeHandler,
            System::currentTimeMillis,
            DEFAULT_APPROVAL_TIMEOUT_MS
        );
    }

    V2IncomingTransferCoordinator(
        String localDeviceId,
        String localSigningPrivateKey,
        PeerLookup peerLookup,
        JobStore jobs,
        ApprovalHandler approvalHandler,
        RuntimeHandler runtimeHandler,
        Clock clock,
        long approvalTimeoutMs
    ) {
        if (localDeviceId == null || !localDeviceId.matches("^[a-f0-9]{16}$")) {
            throw new IllegalArgumentException("Local device ID must be 16 lowercase hexadecimal characters");
        }
        if (localSigningPrivateKey == null || localSigningPrivateKey.isBlank()) {
            throw new IllegalArgumentException("Local signing private key is required");
        }
        if (approvalTimeoutMs <= 0 || approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS) {
            throw new IllegalArgumentException("Approval timeout is outside the accepted bounds");
        }
        this.localDeviceId = localDeviceId;
        this.localSigningPrivateKey = localSigningPrivateKey;
        this.peerLookup = Objects.requireNonNull(peerLookup, "peerLookup");
        this.jobs = Objects.requireNonNull(jobs, "jobs");
        this.approvalHandler = Objects.requireNonNull(approvalHandler, "approvalHandler");
        this.runtimeHandler = Objects.requireNonNull(runtimeHandler, "runtimeHandler");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.approvalTimeoutMs = approvalTimeoutMs;
    }

    @Override public void onManifestFrame(V2WireFrame.Frame frame, V2LanService.Connection connection) {
        Objects.requireNonNull(connection, "connection");
        handleManifestFrame(frame, new ConnectionHandle() {
            @Override public void sendDecisionFrame(V2WireFrame.Frame decision) throws Exception {
                connection.sendTransferDecisionFrame(decision);
            }

            @Override public Socket detachForTransfer() throws Exception {
                return connection.detachForTransfer();
            }
        });
    }

    void handleManifestFrame(V2WireFrame.Frame frame, ConnectionHandle connection) {
        Objects.requireNonNull(connection, "connection");
        if (isClosed()) return;

        long receivedAt = clock.nowEpochMillis();
        V2TransferMessage.ManifestEnvelope decoded;
        try {
            if (frame == null || !V2TransferMessage.TYPE_MANIFEST.equals(frame.header.opt("type"))) return;
            V2TransferMessage.Message candidate = V2TransferMessage.decode(
                V2TransferMessage.TYPE_MANIFEST, frame.payload, receivedAt
            );
            if (!(candidate instanceof V2TransferMessage.ManifestEnvelope)) return;
            decoded = (V2TransferMessage.ManifestEnvelope) candidate;
        } catch (Exception ignored) {
            return;
        }

        V2TransferPeerAccess.AuthorizedPeer peer;
        try {
            peer = peerLookup.findAuthorizedPeer(decoded.senderDeviceId);
        } catch (Exception ignored) {
            return;
        }
        if (peer == null || !decoded.senderDeviceId.equals(peer.getDeviceId())) return;

        V2TransferBootstrap.VerifiedManifest verified;
        try {
            verified = V2TransferBootstrap.verifyIncomingManifestFrame(
                frame,
                peer.getSigningPublicKey(),
                localDeviceId,
                peer.getDeviceId(),
                receivedAt
            );
        } catch (Exception ignored) {
            return;
        }

        PendingApproval slot = claim(verified.taskId);
        if (slot == null) {
            sendDecision(connection, verified, "busy");
            return;
        }

        boolean persisted = false;
        boolean acceptedDecisionStarted = false;
        try {
            if (isClosed()) return;
            if (jobs.exists(verified.taskId)) {
                sendDecision(connection, verified, "busy");
                return;
            }

            String manifestJson = ProtocolV2.canonicalJson(verified.message.manifest);
            jobs.createIncoming(
                verified.taskId,
                peer.getDeviceId(),
                manifestJson,
                true,
                clock.nowEpochMillis()
            );
            persisted = true;

            if (isClosed()) {
                transitionQuietly(verified.taskId, "CANCELLED", null, false);
                return;
            }

            PendingRequest request = new PendingRequest(verified);
            CompletionStage<Approval> stage = approvalHandler.requestApproval(request);
            if (stage == null) throw new IllegalStateException("Approval handler returned no decision stage");
            CompletableFuture<Approval> future = stage.toCompletableFuture();
            boolean unavailable;
            synchronized (stateLock) {
                unavailable = closed || pending != slot;
                if (!unavailable) slot.future = future;
            }
            if (unavailable) {
                future.cancel(true);
                transitionQuietly(verified.taskId, "CANCELLED", null, false);
                return;
            }

            Approval approval;
            try {
                approval = future.get(approvalTimeoutMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException error) {
                future.cancel(true);
                transitionQuietly(
                    verified.taskId, "FAILED", "Incoming transfer approval timed out.", false
                );
                if (!isClosed()) sendDecision(connection, verified, "rejected");
                return;
            } catch (CancellationException error) {
                transitionQuietly(verified.taskId, "CANCELLED", null, false);
                return;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                transitionQuietly(verified.taskId, "FAILED", "Incoming transfer approval was interrupted.", false);
                if (!isClosed()) sendDecision(connection, verified, "rejected");
                return;
            } catch (ExecutionException | CompletionException error) {
                transitionQuietly(verified.taskId, "FAILED", "Incoming transfer approval failed.", false);
                if (!isClosed()) sendDecision(connection, verified, "rejected");
                return;
            }

            if (isClosed()) {
                transitionQuietly(verified.taskId, "CANCELLED", null, false);
                return;
            }
            if (approval != Approval.ACCEPT) {
                jobs.transition(verified.taskId, "CANCELLED", clock.nowEpochMillis(), null, false);
                sendDecision(connection, verified, "rejected");
                return;
            }

            V2TransferPeerAccess.AuthorizedPeer currentPeer;
            try {
                currentPeer = peerLookup.findAuthorizedPeer(verified.message.senderDeviceId);
            } catch (Exception ignored) {
                currentPeer = null;
            }
            if (!sameAuthorization(peer, currentPeer)) {
                jobs.transition(verified.taskId, "CANCELLED", clock.nowEpochMillis(), null, false);
                sendDecision(connection, verified, "unauthorized");
                return;
            }
            if (!beginHandoff(slot)) {
                transitionQuietly(verified.taskId, "CANCELLED", null, false);
                return;
            }

            PreparedRuntime runtime = null;
            try {
                runtime = runtimeHandler.prepare(verified, currentPeer);
            } catch (Exception error) {
                jobs.transition(verified.taskId, "FAILED", clock.nowEpochMillis(), "Runtime preparation failed", false);
                sendDecision(connection, verified, "rejected");
                return;
            }

            try {
                jobs.transition(verified.taskId, "QUEUED", clock.nowEpochMillis(), null, true);
                jobs.transition(verified.taskId, "TRANSFERRING", clock.nowEpochMillis(), null, true);
                acceptedDecisionStarted = true;
                connection.sendDecisionFrame(V2TransferBootstrap.createDecisionFrame(
                    verified, "accepted", localSigningPrivateKey, clock.nowEpochMillis()
                ));
                V2WireFrame.Frame resumeFrame = runtime.createResumeFrame();
                if (resumeFrame != null) {
                    connection.sendDecisionFrame(resumeFrame);
                }

                Socket socket = null;
                try {
                    socket = connection.detachForTransfer();
                    runtime.start(socket);
                    socket = null;
                    runtime = null;
                } catch (Exception error) {
                    closeQuietly(socket);
                    transitionQuietly(
                        verified.taskId, "FAILED", "Incoming transfer runtime handoff failed.", true
                    );
                }
            } finally {
                if (runtime != null) {
                    try { runtime.close(); } catch (Exception ignored) {}
                }
                finishHandoff();
            }
        } catch (Exception error) {
            if (persisted) {
                transitionQuietly(verified.taskId, "FAILED", "Incoming transfer approval coordination failed.", false);
                if (!acceptedDecisionStarted && !isClosed()) sendDecision(connection, verified, "rejected");
            } else if (!isClosed()) {
                sendDecision(connection, verified, "busy");
            }
        } finally {
            release(slot);
        }
    }

    @Override public void close() {
        CompletableFuture<Approval> future = null;
        synchronized (stateLock) {
            if (!closed) {
                closed = true;
                if (pending != null) future = pending.future;
            }
        }
        if (future != null) future.cancel(true);
        waitForHandoffToFinish();
    }

    private PendingApproval claim(String taskId) {
        synchronized (stateLock) {
            if (closed || pending != null) return null;
            pending = new PendingApproval(taskId);
            return pending;
        }
    }

    private void release(PendingApproval slot) {
        synchronized (stateLock) {
            if (pending == slot) pending = null;
        }
    }

    private boolean isClosed() {
        synchronized (stateLock) {
            return closed;
        }
    }

    private boolean beginHandoff(PendingApproval slot) {
        synchronized (stateLock) {
            if (closed || pending != slot || handoffInProgress) return false;
            handoffInProgress = true;
            handoffThread = Thread.currentThread();
            return true;
        }
    }

    private void finishHandoff() {
        synchronized (stateLock) {
            handoffInProgress = false;
            handoffThread = null;
            stateLock.notifyAll();
        }
    }

    private void waitForHandoffToFinish() {
        boolean interrupted = false;
        synchronized (stateLock) {
            while (handoffInProgress && handoffThread != Thread.currentThread()) {
                try {
                    stateLock.wait();
                } catch (InterruptedException ignored) {
                    interrupted = true;
                }
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static boolean sameAuthorization(
        V2TransferPeerAccess.AuthorizedPeer expected,
        V2TransferPeerAccess.AuthorizedPeer current
    ) {
        return expected != null && current != null
            && expected.getDeviceId().equals(current.getDeviceId())
            && expected.getSigningPublicKey().equals(current.getSigningPublicKey())
            && expected.getEncryptionPublicKey().equals(current.getEncryptionPublicKey());
    }

    private void sendDecision(ConnectionHandle connection, V2TransferBootstrap.VerifiedManifest manifest,
                              String decision) {
        try {
            connection.sendDecisionFrame(V2TransferBootstrap.createDecisionFrame(
                manifest, decision, localSigningPrivateKey, clock.nowEpochMillis()
            ));
        } catch (Exception ignored) { }
    }

    private void transitionQuietly(String taskId, String state, String failureReason, boolean recoverable) {
        try {
            jobs.transition(taskId, state, clock.nowEpochMillis(), failureReason, recoverable);
        } catch (Exception ignored) { }
    }

    private static void closeQuietly(Socket socket) {
        if (socket == null) return;
        try { socket.close(); } catch (Exception ignored) { }
    }
}
