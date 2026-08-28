package io.github.nearbytransfer.android;

import android.content.Context;
import android.net.Uri;
import android.os.Build;

import io.github.nearbytransfer.android.core.data.V2TransferPeerAccess;
import io.github.nearbytransfer.android.core.publication.V2PublicationRuntime;
import io.github.nearbytransfer.android.core.recovery.V2RecoveryPaths;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.IOException;
import java.net.Socket;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Android receiver runtime owning socket detachment, X25519 session key derivation,
 * Room checkpoint persistence, stop-and-wait chunk acknowledgements, and publication.
 */
public final class V2IncomingTransferRuntime implements Closeable, AutoCloseable {

    public interface TransferEventListener {
        void onTransferProgress(String taskId, long bytesTransferred, long totalBytes);
        void onTransferCompleted(String taskId);
        void onTransferFailed(String taskId, String reason);
    }

    private final Context context;
    private final DeviceConfig localDevice;
    private final V2TransferBootstrap.VerifiedManifest verified;
    private final V2TransferPeerAccess.AuthorizedPeer peer;
    private final String customTreeUri;
    private final TransferEventListener listener;
    private final V2ReceiveRuntimePersistence persistence;
    private final V2PublicationRuntime publicationRuntime;
    private final V2EncryptedChunkWriter.Manifest writerManifest;
    private final V2EncryptedChunkWriter.ReceivePlan receivePlan;
    private final V2EncryptedChunkWriter.LocalStagingStore stagingStore;
    private final V2EncryptedChunkWriter.Progress initialProgress;
    private final V2TransferAcknowledgementCodec ackCodec;
    private final V2SignedStreamControl.Codec controlCodec;
    private final V2EncryptedChunkWriter chunkWriter;
    private final byte[] sessionKey;
    private final ExecutorService executor;
    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Object lifecycleLock = new Object();

    private Socket socket;
    private V2TransferStreamSession streamSession;

    public static V2IncomingTransferRuntime prepare(
        Context context,
        DeviceConfig localDevice,
        V2TransferBootstrap.VerifiedManifest verified,
        V2TransferPeerAccess.AuthorizedPeer peer,
        String customTreeUri,
        TransferEventListener listener
    ) throws Exception {
        return new V2IncomingTransferRuntime(
            context, localDevice, verified, peer, customTreeUri, listener
        );
    }

    private V2IncomingTransferRuntime(
        Context context,
        DeviceConfig localDevice,
        V2TransferBootstrap.VerifiedManifest verified,
        V2TransferPeerAccess.AuthorizedPeer peer,
        String customTreeUri,
        TransferEventListener listener
    ) throws Exception {
        this.context = Objects.requireNonNull(context, "context").getApplicationContext();
        this.localDevice = Objects.requireNonNull(localDevice, "localDevice");
        this.verified = Objects.requireNonNull(verified, "verified");
        this.peer = Objects.requireNonNull(peer, "peer");
        this.customTreeUri = customTreeUri;
        this.listener = listener;

        V2ReceiveRuntimePersistence candidatePersistence = null;
        V2PublicationRuntime candidatePublication = null;
        V2EncryptedChunkWriter.LocalStagingStore candidateStaging = null;
        byte[] derivedKey = null;

        try {
            candidatePersistence = V2ReceiveRuntimePersistence.create(this.context);
            candidatePublication = V2PublicationRuntime.create(this.context);

            Path stagingRoot = V2RecoveryPaths.INSTANCE.stagingRoot(this.context);
            candidateStaging = new V2EncryptedChunkWriter.LocalStagingStore(stagingRoot);

            JSONObject manifestJson = verified.message.manifest;
            JSONArray entries = manifestJson.getJSONArray("entries");
            List<V2EncryptedChunkWriter.FileSpec> fileSpecs = new ArrayList<>();
            List<V2EncryptedChunkWriter.ReceiveTarget> targets = new ArrayList<>();

            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                if ("file".equals(entry.getString("kind"))) {
                    String path = entry.getString("path");
                    long size = entry.getLong("size");
                    String sha256 = entry.getString("sha256");
                    fileSpecs.add(new V2EncryptedChunkWriter.FileSpec(path, size, sha256));
                    targets.add(new V2EncryptedChunkWriter.ReceiveTarget(path, "target-" + i));
                }
            }

            this.writerManifest = new V2EncryptedChunkWriter.Manifest(verified.taskId, fileSpecs);
            this.receivePlan = new V2EncryptedChunkWriter.ReceivePlan(verified.taskId, targets);
            this.initialProgress = candidatePersistence.loadCheckpoint(verified.taskId);

            String canonicalManifest = ProtocolV2.canonicalJson(manifestJson);
            String manifestSha256 = CryptoUtil.sha256Hex(
                new java.io.ByteArrayInputStream(canonicalManifest.getBytes(java.nio.charset.StandardCharsets.UTF_8))
            );

            String senderEphemeralKeyPem = V2TransferCrypto.decodeSenderEphemeralPublicKey(
                verified.message.senderEphemeralPublicKey
            );
            derivedKey = V2TransferCrypto.deriveSessionKey(
                localDevice.encryptionPrivateKey,
                senderEphemeralKeyPem,
                verified.message.senderDeviceId,
                verified.message.receiverDeviceId,
                verified.taskId,
                manifestSha256
            );

            this.ackCodec = new V2TransferAcknowledgementCodec(
                verified.taskId,
                verified.sessionId,
                verified.message.receiverDeviceId,
                verified.message.senderDeviceId,
                manifestSha256,
                this.writerManifest,
                localDevice.signingPrivateKey,
                System::currentTimeMillis
            );

            this.controlCodec = new V2SignedStreamControl.Codec(
                verified.message.receiverDeviceId,
                localDevice.signingPrivateKey,
                verified.message.senderDeviceId,
                peer.getSigningPublicKey(),
                verified.taskId,
                verified.sessionId,
                System::currentTimeMillis
            );

            V2EncryptedChunkWriter.ProgressStore progressStore = candidatePersistence.asProgressStore(
                verified.taskId,
                System::currentTimeMillis
            );

            this.chunkWriter = V2EncryptedChunkWriter.create(
                this.writerManifest,
                this.receivePlan,
                derivedKey,
                this.initialProgress,
                candidateStaging,
                progressStore
            );

            this.persistence = candidatePersistence;
            this.publicationRuntime = candidatePublication;
            this.stagingStore = candidateStaging;
            this.sessionKey = derivedKey;
            this.executor = Executors.newSingleThreadExecutor(new ThreadFactory() {
                @Override public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "v2-rx-runtime-" + verified.taskId);
                    t.setDaemon(true);
                    return t;
                }
            });
        } catch (Exception error) {
            if (derivedKey != null) Arrays.fill(derivedKey, (byte) 0);
            closeQuietly(candidateStaging);
            closeQuietly(candidatePublication);
            closeQuietly(candidatePersistence);
            throw error;
        }
    }

    /** Creates the initial signed transfer-resume wire frame sent right after an accepted decision. */
    public V2WireFrame.Frame createResumeFrame() throws Exception {
        return ackCodec.createResumeFrame(initialProgress);
    }

    /** Takes ownership of the detached socket and begins stream session reception in background. */
    public void start(Socket detachedSocket) throws Exception {
        Objects.requireNonNull(detachedSocket, "detachedSocket");
        if (!started.compareAndSet(false, true)) {
            throw new IllegalStateException("V2 incoming transfer runtime has already started.");
        }

        synchronized (lifecycleLock) {
            if (closed.get()) {
                detachedSocket.close();
                throw new IllegalStateException("V2 incoming transfer runtime is closed.");
            }
            this.socket = detachedSocket;
        }

        V2TransferStreamSession.ChunkWriter streamChunkWriter = new V2TransferStreamSession.ChunkWriter() {
            @Override
            public byte[] writeChunk(V2TransferChunkFrame.Frame encryptedFrame) throws Exception {
                V2EncryptedChunkWriter.Progress progress = chunkWriter.accept(encryptedFrame);
                byte[] ackPayload = ackCodec.encodeDurableProgress(progress);
                if (listener != null) {
                    long transferred = calculateTransferredBytes(progress);
                    listener.onTransferProgress(verified.taskId, transferred, verified.message.manifest.getLong("totalBytes"));
                }
                return ackPayload;
            }

            @Override
            public boolean complete() throws Exception {
                chunkWriter.sealForPublication();
                boolean published = publicationRuntime.publish(
                    verified.taskId, customTreeUri, System.currentTimeMillis()
                );
                if (published && listener != null) {
                    listener.onTransferCompleted(verified.taskId);
                }
                return published;
            }

            @Override
            public void cancel() throws Exception {
                chunkWriter.cancel();
                persistence.transition(
                    verified.taskId, "CANCELLED", System.currentTimeMillis(), null, false
                );
            }
        };

        this.streamSession = new V2TransferStreamSession(
            detachedSocket,
            controlCodec,
            streamChunkWriter,
            verified.taskId,
            verified.message.receiverDeviceId,
            verified.message.senderDeviceId
        );

        executor.execute(this::runStreamSession);
    }

    private void runStreamSession() {
        android.util.Log.i("V2RxRuntime", "runStreamSession starting for task " + verified.taskId);
        try {
            streamSession.run();
            android.util.Log.i("V2RxRuntime", "runStreamSession completed cleanly for task " + verified.taskId);
        } catch (CancellationException cancelled) {
            android.util.Log.w("V2RxRuntime", "runStreamSession cancelled", cancelled);
            if (listener != null) {
                listener.onTransferFailed(verified.taskId, "Transfer was cancelled.");
            }
        } catch (Throwable error) {
            android.util.Log.e("V2RxRuntime", "runStreamSession error for task " + verified.taskId, error);
            String message = error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName();
            try {
                persistence.transition(
                    verified.taskId, "FAILED", System.currentTimeMillis(), message, true
                );
            } catch (Exception ignored) {}
            if (listener != null) {
                listener.onTransferFailed(verified.taskId, message);
            }
        } finally {
            close();
        }
    }

    private static long calculateTransferredBytes(V2EncryptedChunkWriter.Progress progress) {
        long total = 0;
        for (V2EncryptedChunkWriter.FileProgress fp : progress.files) {
            total += fp.committedOffset;
        }
        return total;
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;

        synchronized (lifecycleLock) {
            if (streamSession != null) {
                streamSession.close();
            }
            if (chunkWriter != null) {
                try {
                    chunkWriter.close();
                } catch (Exception ignored) {}
            }
            if (sessionKey != null) {
                Arrays.fill(sessionKey, (byte) 0);
            }
            closeQuietly(socket);
            closeQuietly(stagingStore);
            closeQuietly(publicationRuntime);
            closeQuietly(persistence);
        }
        executor.shutdownNow();
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable != null) {
            try {
                closeable.close();
            } catch (Exception ignored) {}
        }
    }
}
