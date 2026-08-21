package io.github.nearbytransfer.android

import android.content.Context
import io.github.nearbytransfer.android.core.data.ReceiveCheckpointCodec
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJob
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import java.io.Closeable
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Thread-safe Room persistence facade for Android receiver transfer runtime.
 * Maintains an open Room DB connection across chunk commits for a session.
 */
internal class V2ReceiveRuntimePersistence(
    private val database: NearbyTransferDatabase,
    private val ownsDatabase: Boolean = true,
) : Closeable, AutoCloseable {

    private val repository = RoomTransferJobRepository(database)
    private val lock = ReentrantLock()
    private var closed = false

    constructor(context: Context) : this(
        database = NearbyTransferDatabase.build(
            context.applicationContext
                ?: throw IllegalArgumentException("An application Context is required."),
        ),
        ownsDatabase = true,
    )

    fun loadCheckpoint(taskId: String): V2EncryptedChunkWriter.Progress = lock.withLock {
        assertNotClosed()
        runBlocking(Dispatchers.IO) {
            val job = repository.find(taskId)
                ?: throw IllegalArgumentException("Transfer job $taskId does not exist.")
            val checkpointJson = job.checkpointJson
            if (checkpointJson != null) {
                val normalized = ReceiveCheckpointCodec.normalize(job.manifestJson, checkpointJson)
                V2EncryptedChunkWriter.Progress(
                    normalized.nextSequence,
                    normalized.files.map {
                        V2EncryptedChunkWriter.FileProgress(it.path, it.committedOffset, it.completed)
                    },
                )
            } else {
                val initial = ReceiveCheckpointCodec.createInitial(job.manifestJson)
                V2EncryptedChunkWriter.Progress(
                    initial.nextSequence,
                    initial.files.map {
                        V2EncryptedChunkWriter.FileProgress(it.path, it.committedOffset, it.completed)
                    },
                )
            }
        }
    }

    fun commitCheckpoint(
        taskId: String,
        progress: V2EncryptedChunkWriter.Progress,
        nowEpochMillis: Long,
    ): Unit = lock.withLock {
        assertNotClosed()
        runBlocking(Dispatchers.IO) {
            val job = repository.find(taskId)
                ?: throw IllegalArgumentException("Transfer job $taskId does not exist.")
            val candidateCheckpoint = ReceiveCheckpointCodec.fromProgress(
                manifestJson = job.manifestJson,
                files = progress.files.map {
                    ReceiveCheckpointCodec.FileCheckpoint(it.path, it.committedOffset, it.completed)
                },
                nextSequence = progress.nextSequence,
            )
            repository.updateReceiveCheckpoint(taskId, candidateCheckpoint.json, nowEpochMillis)
        }
    }

    fun transition(
        taskId: String,
        stateName: String,
        nowEpochMillis: Long,
        failureReason: String? = null,
        recoverable: Boolean? = null,
    ): TransferJob? = lock.withLock {
        assertNotClosed()
        runBlocking(Dispatchers.IO) {
            val state = TransferJobState.valueOf(stateName)
            repository.transition(taskId, state, nowEpochMillis, failureReason, recoverable)
        }
    }

    fun find(taskId: String): TransferJob? = lock.withLock {
        assertNotClosed()
        runBlocking(Dispatchers.IO) {
            repository.find(taskId)
        }
    }

    fun asProgressStore(
        taskId: String,
        clock: () -> Long = System::currentTimeMillis,
    ): V2EncryptedChunkWriter.ProgressStore {
        return V2EncryptedChunkWriter.ProgressStore { progress ->
            commitCheckpoint(taskId, progress, clock())
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
        check(!closed) { "V2ReceiveRuntimePersistence is closed." }
    }

    companion object {
        @JvmStatic
        fun create(context: Context): V2ReceiveRuntimePersistence = V2ReceiveRuntimePersistence(context)
    }
}
