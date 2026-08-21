package io.github.nearbytransfer.android.core.publication

import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Looper
import io.github.nearbytransfer.android.core.data.PublicationBackend as StoredPublicationBackend
import io.github.nearbytransfer.android.core.data.PublicationState as StoredPublicationState
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.recovery.AppPrivatePublicationSourceProvider
import io.github.nearbytransfer.android.core.recovery.AppPrivateStagingCleaner
import io.github.nearbytransfer.android.core.recovery.V2RecoveryPaths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.Closeable
import java.nio.file.Path
import java.security.SecureRandom
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Java-friendly facade for publishing received transfer staging files into
 * user-visible storage (MediaStore or SAF tree) and finalizing the Room transfer job.
 */
class V2PublicationRuntime(
    private val context: Context,
    private val database: NearbyTransferDatabase,
    private val ownsDatabase: Boolean = true,
) : Closeable, AutoCloseable {

    private val repository = RoomTransferJobRepository(database)
    private val lock = ReentrantLock()
    private val stagingRoot: Path = V2RecoveryPaths.stagingRoot(context.applicationContext)
    private val sourceProvider = AppPrivatePublicationSourceProvider(stagingRoot)
    private val stagingCleaner = AppPrivateStagingCleaner(stagingRoot)
    private val secureRandom = SecureRandom()
    private var closed = false

    constructor(context: Context) : this(
        context = context,
        database = NearbyTransferDatabase.build(
            context.applicationContext
                ?: throw IllegalArgumentException("An application Context is required."),
        ),
        ownsDatabase = true,
    )

    /**
     * Publishes a fully-received incoming transfer task to the destination, cleans staging,
     * and finalizes the Room transfer job to COMPLETED state.
     *
     * @param taskId the 22-character transfer task ID
     * @param customTreeUri optional custom SAF tree URI string; if null/blank, defaults to MediaStore
     * @param nowEpochMillis current timestamp
     * @return true if publication and finalization succeeded
     */
    fun publish(
        taskId: String,
        customTreeUri: String? = null,
        nowEpochMillis: Long = System::currentTimeMillis.invoke(),
    ): Boolean = lock.withLock {
        assertNotClosed()
        runBlocking(Dispatchers.IO) {
            val job = repository.find(taskId)
                ?: throw IllegalArgumentException("Transfer job $taskId does not exist.")
            require(job.state == TransferJobState.TRANSFERRING) {
                "Transfer job must be in TRANSFERRING state to publish (current: ${job.state})."
            }
            require(job.transferredBytes == job.totalBytes) {
                "Cannot publish before all bytes are received (${job.transferredBytes}/${job.totalBytes})."
            }

            val (backendType, rootToken, runtimeBackend) = resolveBackend(customTreeUri)
            val publicationId = job.publicationId ?: generatePublicationId()

            // 1. Prepare publication in repository & journal
            repository.preparePublication(
                taskId = taskId,
                publicationId = publicationId,
                publicationBackend = backendType,
                publicationRootToken = rootToken,
                nowEpochMillis = nowEpochMillis,
            )

            // 2. Drive publication coordinator
            val journal = RoomPublicationJournal(database, rootToken) { nowEpochMillis }
            val coordinator = V2PublicationCoordinator(journal, runtimeBackend, sourceProvider)
            coordinator.recover(publicationId)

            val updatedJob = repository.find(taskId)
                ?: throw IllegalStateException("Transfer job $taskId disappeared during publication.")

            // 3. Clean staging and finalize
            if (updatedJob.publicationState == StoredPublicationState.PUBLISHED) {
                val record = journal.load(publicationId)
                    ?: throw IllegalStateException("Publication journal disappeared for $publicationId.")
                stagingCleaner.cleanup(record.plan)
                repository.markCleanupComplete(taskId, publicationId, nowEpochMillis)
                repository.finalizePublication(taskId, publicationId, nowEpochMillis)
                true
            } else {
                false
            }
        }
    }

    override fun close() {
        lock.withLock {
            if (closed) return
            closed = true
            if (ownsDatabase) {
                database.close()
            }
        }
    }

    private fun assertNotClosed() {
        check(!closed) { "V2PublicationRuntime is closed." }
    }

    private fun resolveBackend(customTreeUri: String?): Triple<StoredPublicationBackend, String, PublicationBackend> {
        val trimmedUri = customTreeUri?.trim()
        return if (!trimmedUri.isNullOrEmpty()) {
            val treeUri = Uri.parse(trimmedUri)
            val backend = SafTreePublicationBackend(context.applicationContext, treeUri)
            Triple(StoredPublicationBackend.SAF_TREE, trimmedUri, backend)
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val backend = MediaStorePublicationBackend(context.applicationContext)
                Triple(StoredPublicationBackend.MEDIA_STORE, DEFAULT_MEDIA_STORE_ROOT_TOKEN, backend)
            } else {
                throw UnsupportedOperationException("MediaStore publication requires Android 10 (API 29)+.")
            }
        }
    }

    private fun generatePublicationId(): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        val bytes = ByteArray(22)
        secureRandom.nextBytes(bytes)
        val chars = CharArray(22)
        for (i in 0 until 22) {
            chars[i] = alphabet[(bytes[i].toInt() and 0xFF) % alphabet.length]
        }
        return String(chars)
    }

    companion object {
        const val DEFAULT_MEDIA_STORE_ROOT_TOKEN = "media-store:downloads/Nearby Transfer"

        @JvmStatic
        fun create(context: Context): V2PublicationRuntime = V2PublicationRuntime(context)
    }
}
