package io.github.nearbytransfer.android.core.data

import android.content.Context
import android.os.Looper
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/** Java-callable facade for public transfer-job persistence. */
object V2TransferJobPersistence {
    @JvmStatic
    fun createOutgoing(
        context: Context,
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = withRepository(context) {
        it.createOutgoing(taskId, peerId, manifestJson, recoverable, nowEpochMillis)
    }

    @JvmStatic
    fun createIncoming(
        context: Context,
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = withRepository(context) {
        it.createIncoming(taskId, peerId, manifestJson, recoverable, nowEpochMillis)
    }

    @JvmStatic
    fun find(context: Context, taskId: String): TransferJob? = withRepository(context) {
        it.find(taskId)
    }

    @JvmStatic
    fun listUnfinished(context: Context): List<TransferJob> = withRepository(context) {
        it.loadUnfinished()
    }

    @JvmStatic
    fun listRecoveryWork(context: Context): List<TransferJob> = withRepository(context) {
        it.loadRecoveryWork()
    }

    @JvmStatic
    fun transition(
        context: Context,
        taskId: String,
        newState: String,
        nowEpochMillis: Long,
        failureReason: String?,
        recoverable: Boolean?,
    ): TransferJob? {
        val state = parseEnum<TransferJobState>(newState, "Unknown transfer state.")
        return withRepository(context) {
            it.transition(taskId, state, nowEpochMillis, failureReason, recoverable)
        }
    }

    @JvmStatic
    fun updateProgress(
        context: Context,
        taskId: String,
        transferredBytes: Long,
        nowEpochMillis: Long,
    ): TransferJob? = withRepository(context) {
        it.updateProgress(taskId, transferredBytes, nowEpochMillis)
    }

    @JvmStatic
    fun updateReceiveCheckpoint(
        context: Context,
        taskId: String,
        candidateCheckpointJson: String,
        nowEpochMillis: Long,
    ): TransferJob? = withRepository(context) {
        it.updateReceiveCheckpoint(taskId, candidateCheckpointJson, nowEpochMillis)
    }

    @JvmStatic
    fun preparePublication(
        context: Context,
        taskId: String,
        publicationId: String,
        publicationBackend: String,
        publicationRootToken: String,
        nowEpochMillis: Long,
    ): TransferJob? {
        val backend = parseEnum<PublicationBackend>(publicationBackend, "Unknown publication backend.")
        return withRepository(context) {
            it.preparePublication(
                taskId,
                publicationId,
                backend,
                publicationRootToken,
                nowEpochMillis,
            )
        }
    }

    @JvmStatic
    fun finalizePublication(
        context: Context,
        taskId: String,
        publicationId: String,
        nowEpochMillis: Long,
    ): TransferJob? = withRepository(context) {
        it.finalizePublication(taskId, publicationId, nowEpochMillis)
    }

    private inline fun <reified T : Enum<T>> parseEnum(value: String, message: String): T = try {
        enumValueOf<T>(value)
    } catch (error: IllegalArgumentException) {
        throw IllegalArgumentException(message, error)
    }

    private fun <T> withRepository(
        context: Context,
        operation: suspend (RoomTransferJobRepository) -> T,
    ): T {
        check(Looper.getMainLooper().thread !== Thread.currentThread()) {
            "V2 transfer-job persistence must run on a background thread."
        }
        val applicationContext = context.applicationContext
            ?: throw IllegalArgumentException("An application Context is required.")
        return runBlocking(Dispatchers.IO) {
            val database = NearbyTransferDatabase.build(applicationContext)
            try {
                operation(RoomTransferJobRepository(database))
            } finally {
                database.close()
            }
        }
    }
}
