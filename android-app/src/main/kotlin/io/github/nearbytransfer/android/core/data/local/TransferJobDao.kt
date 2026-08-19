package io.github.nearbytransfer.android.core.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface TransferJobDao {
    @Query("SELECT * FROM transfer_jobs WHERE task_id = :taskId AND state != 'QUARANTINED' LIMIT 1")
    suspend fun findActive(taskId: String): TransferJobEntity?

    @Query("SELECT * FROM transfer_jobs WHERE task_id = :taskId LIMIT 1")
    suspend fun findRaw(taskId: String): TransferJobEntity?

    @Query("SELECT * FROM transfer_jobs WHERE state != 'QUARANTINED' ORDER BY created_at_epoch_millis ASC, task_id ASC")
    suspend fun listActive(): List<TransferJobEntity>

    @Query(
        "SELECT * FROM transfer_jobs " +
            "WHERE state NOT IN ('COMPLETED', 'CANCELLED', 'QUARANTINED') " +
            "ORDER BY updated_at_epoch_millis ASC, task_id ASC",
    )
    suspend fun listUnfinished(): List<TransferJobEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(job: TransferJobEntity)

    @Query(
        "UPDATE transfer_jobs SET state = :newState, recoverable = :recoverable, " +
            "failure_reason = :failureReason, updated_at_epoch_millis = :updatedAtEpochMillis " +
            "WHERE task_id = :taskId AND state = :expectedState " +
            "AND updated_at_epoch_millis = :expectedUpdatedAtEpochMillis",
    )
    suspend fun updateState(
        taskId: String,
        expectedState: String,
        expectedUpdatedAtEpochMillis: Long,
        newState: String,
        recoverable: Boolean,
        failureReason: String?,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET transferred_bytes = :transferredBytes, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis " +
            "WHERE task_id = :taskId AND state = :expectedState " +
            "AND updated_at_epoch_millis = :expectedUpdatedAtEpochMillis " +
            "AND transferred_bytes = :expectedTransferredBytes",
    )
    suspend fun updateProgress(
        taskId: String,
        expectedState: String,
        expectedUpdatedAtEpochMillis: Long,
        expectedTransferredBytes: Long,
        transferredBytes: Long,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_jobs SET state = 'QUARANTINED', recoverable = 0, " +
            "manifest_json = '{}', failure_reason = :reason, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis WHERE task_id = :taskId",
    )
    suspend fun quarantine(taskId: String, reason: String, updatedAtEpochMillis: Long): Int
}
