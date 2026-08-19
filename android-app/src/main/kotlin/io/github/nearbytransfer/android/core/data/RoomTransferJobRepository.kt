package io.github.nearbytransfer.android.core.data

import androidx.room.withTransaction
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.data.local.TransferJobEntity

/**
 * Transactional Room repository for public protocol-v2 transfer state.
 *
 * This repository intentionally has no API for session keys, plaintext, local
 * file paths, nonces or authentication tags.
 */
class RoomTransferJobRepository(
    private val database: NearbyTransferDatabase,
) {
    private val dao = database.transferJobDao()

    suspend fun createOutgoing(
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = create(
        taskId = taskId,
        peerId = peerId,
        direction = TransferDirection.OUTGOING,
        initialState = TransferJobState.QUEUED,
        manifestJson = manifestJson,
        recoverable = recoverable,
        nowEpochMillis = nowEpochMillis,
    )

    suspend fun createIncoming(
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = create(
        taskId = taskId,
        peerId = peerId,
        direction = TransferDirection.INCOMING,
        initialState = TransferJobState.AWAITING_APPROVAL,
        manifestJson = manifestJson,
        recoverable = recoverable,
        nowEpochMillis = nowEpochMillis,
    )

    suspend fun find(taskId: String): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        return database.withTransaction {
            dao.findActive(taskId)?.let { mapOrQuarantine(it) }
        }
    }

    suspend fun listAll(): List<TransferJob> = database.withTransaction {
        dao.listActive().mapNotNull { mapOrQuarantine(it) }
    }

    /** Returns valid non-terminal jobs that can be considered after process restart. */
    suspend fun loadUnfinished(): List<TransferJob> = database.withTransaction {
        dao.listUnfinished().mapNotNull { mapOrQuarantine(it) }
    }

    suspend fun transition(
        taskId: String,
        newState: TransferJobState,
        nowEpochMillis: Long,
        failureReason: String? = null,
        recoverable: Boolean? = null,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val currentEntity = dao.findActive(taskId) ?: return@withTransaction null
            val current = mapOrQuarantine(currentEntity) ?: return@withTransaction null
            require(newState in ALLOWED_TRANSITIONS.getValue(current.state)) {
                "Illegal transfer state transition: ${current.state} -> $newState."
            }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            if (newState == TransferJobState.COMPLETED) {
                require(current.transferredBytes == current.totalBytes) {
                    "A transfer cannot complete before all bytes are persisted."
                }
            }
            val normalizedFailure = normalizeFailureReason(newState, failureReason)
            val nextRecoverable = when (newState) {
                TransferJobState.COMPLETED, TransferJobState.CANCELLED -> false
                else -> recoverable ?: current.recoverable
            }
            val changed = dao.updateState(
                taskId = taskId,
                expectedState = current.state.name,
                expectedUpdatedAtEpochMillis = current.updatedAtEpochMillis,
                newState = newState.name,
                recoverable = nextRecoverable,
                failureReason = normalizedFailure,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(mapOrQuarantine(requireNotNull(dao.findActive(taskId))))
        }
    }

    suspend fun updateProgress(
        taskId: String,
        transferredBytes: Long,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val currentEntity = dao.findActive(taskId) ?: return@withTransaction null
            val current = mapOrQuarantine(currentEntity) ?: return@withTransaction null
            require(current.state == TransferJobState.TRANSFERRING) {
                "Progress can only be updated while a transfer is active."
            }
            require(transferredBytes >= current.transferredBytes) { "Transfer progress cannot move backwards." }
            require(transferredBytes <= current.totalBytes) { "Transfer progress cannot exceed totalBytes." }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            val changed = dao.updateProgress(
                taskId = taskId,
                expectedState = current.state.name,
                expectedUpdatedAtEpochMillis = current.updatedAtEpochMillis,
                expectedTransferredBytes = current.transferredBytes,
                transferredBytes = transferredBytes,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(mapOrQuarantine(requireNotNull(dao.findActive(taskId))))
        }
    }

    private suspend fun create(
        taskId: String,
        peerId: String,
        direction: TransferDirection,
        initialState: TransferJobState,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob {
        TransferManifestCodec.validateTaskId(taskId)
        require(PEER_ID.matches(peerId)) { "Peer ID must be 16 lowercase hexadecimal characters." }
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        val manifest = TransferManifestCodec.normalize(manifestJson)
        require(manifest.taskId == taskId) { "Transfer manifest taskId does not match the job taskId." }
        val entity = TransferJobEntity(
            taskId = taskId,
            peerId = peerId,
            direction = direction.name,
            state = initialState.name,
            manifestJson = manifest.json,
            totalBytes = manifest.totalBytes,
            transferredBytes = 0L,
            createdAtEpochMillis = nowEpochMillis,
            updatedAtEpochMillis = nowEpochMillis,
            recoverable = recoverable,
            failureReason = null,
        )
        database.withTransaction { dao.insert(entity) }
        return mapStrict(entity)
    }

    private suspend fun mapOrQuarantine(entity: TransferJobEntity): TransferJob? = try {
        mapStrict(entity)
    } catch (_: RuntimeException) {
        val quarantineTime = maxOf(1L, System.currentTimeMillis(), entity.updatedAtEpochMillis)
        dao.quarantine(entity.taskId, CORRUPT_ROW_REASON, quarantineTime)
        null
    }

    private fun mapStrict(entity: TransferJobEntity): TransferJob {
        TransferManifestCodec.validateTaskId(entity.taskId)
        require(PEER_ID.matches(entity.peerId)) { "Persisted peer ID is invalid." }
        val direction = parseEnum<TransferDirection>(entity.direction, "Persisted transfer direction is invalid.")
        val state = parseEnum<TransferJobState>(entity.state, "Persisted transfer state is invalid.")
        val manifest = TransferManifestCodec.normalize(entity.manifestJson)
        require(manifest.json == entity.manifestJson) { "Persisted transfer manifest is not canonical." }
        require(manifest.taskId == entity.taskId && manifest.totalBytes == entity.totalBytes) {
            "Persisted transfer manifest does not match indexed metadata."
        }
        require(entity.transferredBytes in 0..entity.totalBytes) { "Persisted transfer progress is invalid." }
        requireTimestamp(entity.createdAtEpochMillis, "createdAtEpochMillis")
        require(entity.updatedAtEpochMillis >= entity.createdAtEpochMillis) {
            "Persisted transfer update time predates creation."
        }
        require(state !in TERMINAL_STATES || !entity.recoverable) {
            "Terminal transfer jobs cannot be recoverable."
        }
        require(state != TransferJobState.COMPLETED || entity.transferredBytes == entity.totalBytes) {
            "Completed transfer progress is inconsistent."
        }
        normalizeFailureReason(state, entity.failureReason)
        return TransferJob(
            taskId = entity.taskId,
            peerId = entity.peerId,
            direction = direction,
            state = state,
            manifestJson = entity.manifestJson,
            totalBytes = entity.totalBytes,
            transferredBytes = entity.transferredBytes,
            createdAtEpochMillis = entity.createdAtEpochMillis,
            updatedAtEpochMillis = entity.updatedAtEpochMillis,
            recoverable = entity.recoverable,
            failureReason = entity.failureReason,
        )
    }

    private fun normalizeFailureReason(state: TransferJobState, value: String?): String? {
        if (state != TransferJobState.FAILED) {
            require(value == null) { "failureReason is only valid for failed transfers." }
            return null
        }
        val normalized = value?.trim()
        require(!normalized.isNullOrEmpty() && normalized.length <= MAX_FAILURE_REASON_LENGTH) {
            "Failed transfers require a bounded failureReason."
        }
        require(normalized.none { it == '\u0000' || (it.code < 0x20 && it != '\n' && it != '\r' && it != '\t') }) {
            "failureReason contains unsupported control characters."
        }
        return normalized
    }

    private inline fun <reified T : Enum<T>> parseEnum(value: String, message: String): T = try {
        enumValueOf<T>(value)
    } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException(message)
    }
    private fun requireTimestamp(value: Long, label: String) {
        require(value in 1..MAX_SAFE_INTEGER) { "$label must be a positive safe integer." }
    }

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private const val MAX_FAILURE_REASON_LENGTH = 1_024
        private const val CORRUPT_ROW_REASON = "Stored transfer record is invalid."
        private val PEER_ID = Regex("^[a-f0-9]{16}$")
        private val TERMINAL_STATES = setOf(TransferJobState.COMPLETED, TransferJobState.CANCELLED)
        private val ALLOWED_TRANSITIONS = mapOf(
            TransferJobState.QUEUED to setOf(
                TransferJobState.TRANSFERRING,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.AWAITING_APPROVAL to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.TRANSFERRING to setOf(
                TransferJobState.PAUSED,
                TransferJobState.FAILED,
                TransferJobState.COMPLETED,
                TransferJobState.CANCELLED,
            ),
            TransferJobState.PAUSED to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.FAILED to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
            ),
            TransferJobState.COMPLETED to emptySet(),
            TransferJobState.CANCELLED to emptySet(),
        )
    }
}
