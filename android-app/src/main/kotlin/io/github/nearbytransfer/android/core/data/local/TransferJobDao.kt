package io.github.nearbytransfer.android.core.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Dao
interface TransferJobDao {
    @Query("SELECT * FROM transfer_jobs WHERE task_id = :taskId AND state != 'QUARANTINED' LIMIT 1")
    suspend fun findActive(taskId: String): TransferJobEntity?

    @Query("SELECT * FROM transfer_jobs WHERE task_id = :taskId LIMIT 1")
    suspend fun findRaw(taskId: String): TransferJobEntity?

    @Query("SELECT * FROM transfer_jobs WHERE publication_id = :publicationId LIMIT 1")
    suspend fun findByPublicationId(publicationId: String): TransferJobEntity?

    @Query("SELECT * FROM transfer_jobs WHERE state != 'QUARANTINED' ORDER BY created_at_epoch_millis ASC, task_id ASC")
    suspend fun listActive(): List<TransferJobEntity>

    @Query(
        "SELECT * FROM transfer_jobs " +
            "WHERE state NOT IN ('COMPLETED', 'CANCELLED', 'QUARANTINED') " +
            "ORDER BY updated_at_epoch_millis ASC, task_id ASC",
    )
    suspend fun listUnfinished(): List<TransferJobEntity>

    @Query(
        "SELECT * FROM transfer_jobs WHERE state != 'QUARANTINED' AND (" +
            "state NOT IN ('COMPLETED', 'CANCELLED') " +
            "OR publication_state IN ('PREPARED', 'PUBLISHING', 'RECONCILE_REQUIRED', 'PARTIAL', " +
            "'CANCEL_PENDING', 'LEGACY_UNVERIFIED') " +
            "OR cleanup_pending = 1) " +
            "ORDER BY updated_at_epoch_millis ASC, task_id ASC",
    )
    suspend fun listRecoveryWork(): List<TransferJobEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(job: TransferJobEntity)

    /**
     * Compatibility entry point used by the existing repository.
     *
     * The timestamp remains a precondition for source compatibility, while the
     * actual write is serialized with the durable revision CAS below.
     */
    @Transaction
    suspend fun updateState(
        taskId: String,
        expectedState: String,
        expectedUpdatedAtEpochMillis: Long,
        newState: String,
        recoverable: Boolean,
        failureReason: String?,
        updatedAtEpochMillis: Long,
    ): Int {
        val current = findRaw(taskId) ?: return 0
        if (current.state != expectedState || current.updatedAtEpochMillis != expectedUpdatedAtEpochMillis) return 0
        return updateStateByRevision(
            taskId = taskId,
            expectedState = expectedState,
            expectedRevision = current.revision,
            newState = newState,
            recoverable = recoverable,
            failureReason = failureReason,
            updatedAtEpochMillis = updatedAtEpochMillis,
        )
    }

    @Query(
        "UPDATE transfer_jobs SET state = :newState, recoverable = :recoverable, " +
            "failure_reason = :failureReason, updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = revision + 1 " +
            "WHERE task_id = :taskId AND state = :expectedState AND revision = :expectedRevision",
    )
    suspend fun updateStateByRevision(
        taskId: String,
        expectedState: String,
        expectedRevision: Long,
        newState: String,
        recoverable: Boolean,
        failureReason: String?,
        updatedAtEpochMillis: Long,
    ): Int

    /** Timestamp-compatible wrapper over revision-based progress CAS. */
    @Transaction
    suspend fun updateProgress(
        taskId: String,
        expectedState: String,
        expectedUpdatedAtEpochMillis: Long,
        expectedTransferredBytes: Long,
        transferredBytes: Long,
        updatedAtEpochMillis: Long,
    ): Int {
        val current = findRaw(taskId) ?: return 0
        if (
            current.state != expectedState ||
            current.updatedAtEpochMillis != expectedUpdatedAtEpochMillis ||
            current.transferredBytes != expectedTransferredBytes
        ) return 0
        return updateProgressByRevision(
            taskId = taskId,
            expectedState = expectedState,
            expectedRevision = current.revision,
            expectedTransferredBytes = expectedTransferredBytes,
            transferredBytes = transferredBytes,
            updatedAtEpochMillis = updatedAtEpochMillis,
        )
    }

    @Query(
        "UPDATE transfer_jobs SET transferred_bytes = :transferredBytes, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, revision = revision + 1 " +
            "WHERE task_id = :taskId AND state = :expectedState " +
            "AND revision = :expectedRevision " +
            "AND transferred_bytes = :expectedTransferredBytes",
    )
    suspend fun updateProgressByRevision(
        taskId: String,
        expectedState: String,
        expectedRevision: Long,
        expectedTransferredBytes: Long,
        transferredBytes: Long,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET checkpoint_json = :checkpointJson, " +
            "transferred_bytes = :transferredBytes, updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = revision + 1 WHERE task_id = :taskId AND revision = :expectedRevision " +
            "AND transferred_bytes <= :transferredBytes",
    )
    suspend fun updateCheckpointByRevision(
        taskId: String,
        expectedRevision: Long,
        checkpointJson: String,
        transferredBytes: Long,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET publication_state = 'PREPARED', publication_id = :publicationId, " +
            "publication_backend = :publicationBackend, publication_root_token = :publicationRootToken, " +
            "publication_error = NULL, publication_cancel_requested = 0, cleanup_pending = 0, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = revision + 1 WHERE task_id = :taskId AND direction = 'INCOMING' " +
            "AND revision = :expectedRevision AND publication_id IS NULL",
    )
    suspend fun preparePublicationByRevision(
        taskId: String,
        expectedRevision: Long,
        publicationId: String,
        publicationBackend: String,
        publicationRootToken: String?,
        updatedAtEpochMillis: Long,
    ): Int

    /** Global CAS used by RoomPublicationJournal for one complete coordinator snapshot. */
    @Query(
        "UPDATE transfer_jobs SET publication_state = :publicationState, " +
            "publication_cancel_requested = :cancelRequested, " +
            "cleanup_pending = CASE WHEN :stagingCleanupRequired THEN 1 ELSE cleanup_pending END, " +
            "publication_error = :publicationError, updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = :newRevision WHERE task_id = :taskId AND publication_id = :publicationId " +
            "AND revision = :expectedRevision",
    )
    suspend fun replacePublicationSnapshotByRevision(
        taskId: String,
        publicationId: String,
        expectedRevision: Long,
        newRevision: Long,
        publicationState: String,
        cancelRequested: Boolean,
        stagingCleanupRequired: Boolean,
        publicationError: String?,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET cleanup_pending = 0, updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = revision + 1 WHERE task_id = :taskId AND publication_id = :publicationId " +
            "AND cleanup_pending = 1 AND (publication_state = 'PUBLISHED' " +
            "OR publication_state = 'CANCELLED' " +
            "OR (publication_state = 'PARTIAL' AND publication_cancel_requested = 1)) " +
            "AND revision = :expectedRevision",
    )
    suspend fun markCleanupCompleteByRevision(
        taskId: String,
        publicationId: String,
        expectedRevision: Long,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET state = 'QUARANTINED', recoverable = 0, manifest_json = '{}', " +
            "checkpoint_json = NULL, publication_state = 'NONE', publication_id = NULL, " +
            "publication_backend = NULL, publication_root_token = NULL, publication_error = :reason, " +
            "publication_cancel_requested = 0, cleanup_pending = 0, failure_reason = :reason, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = revision + 1 WHERE task_id = :taskId",
    )
    suspend fun quarantineJob(taskId: String, reason: String, updatedAtEpochMillis: Long): Int

    @Query("DELETE FROM transfer_publication_files WHERE task_id = :taskId")
    suspend fun deletePublicationReceipts(taskId: String): Int

    /** Scrubs capability-bearing publication data and its child receipts atomically. */
    @Transaction
    suspend fun quarantine(taskId: String, reason: String, updatedAtEpochMillis: Long): Int {
        val changed = quarantineJob(taskId, reason, updatedAtEpochMillis)
        if (changed == 1) deletePublicationReceipts(taskId)
        return changed
    }
}
