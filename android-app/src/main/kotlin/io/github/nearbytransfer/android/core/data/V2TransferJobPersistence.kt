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
    fun transition(
        context: Context,
        taskId: String,
        newState: String,
        nowEpochMillis: Long,
        failureReason: String?,
        recoverable: Boolean?,
    ): TransferJob? {
        val state = try {
            TransferJobState.valueOf(newState)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("Unknown transfer state.", error)
        }
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
