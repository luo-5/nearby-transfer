package io.github.nearbytransfer.android.core.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface TransferPublicationDao {
    @Query(
        "SELECT * FROM transfer_publication_files WHERE task_id = :taskId " +
            "ORDER BY file_index ASC",
    )
    suspend fun listForTask(taskId: String): List<TransferPublicationFileEntity>

    @Query(
        "SELECT * FROM transfer_publication_files WHERE publication_id = :publicationId " +
            "ORDER BY file_index ASC",
    )
    suspend fun listForPublication(publicationId: String): List<TransferPublicationFileEntity>

    @Query(
        "SELECT * FROM transfer_publication_files WHERE task_id = :taskId " +
            "AND file_index = :fileIndex LIMIT 1",
    )
    suspend fun find(taskId: String, fileIndex: Int): TransferPublicationFileEntity?

    @Query("SELECT COUNT(*) FROM transfer_publication_files WHERE task_id = :taskId")
    suspend fun countForTask(taskId: String): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(receipt: TransferPublicationFileEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertAll(receipts: List<TransferPublicationFileEntity>)

    @Query(
        "UPDATE transfer_publication_files SET state = :newState, failure_reason = :failureReason, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, revision = revision + 1 " +
            "WHERE task_id = :taskId AND file_index = :fileIndex " +
            "AND publication_id = :publicationId AND state = :expectedState " +
            "AND revision = :expectedRevision",
    )
    suspend fun updateStateByRevision(
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        expectedState: String,
        expectedRevision: Long,
        newState: String,
        failureReason: String?,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_publication_files SET state = 'ALLOCATED', actual_name = :actualName, " +
            "object_uri = :objectUri, failure_reason = NULL, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, revision = revision + 1 " +
            "WHERE task_id = :taskId AND file_index = :fileIndex " +
            "AND publication_id = :publicationId AND state = 'ALLOCATING' " +
            "AND object_uri IS NULL AND revision = :expectedRevision",
    )
    suspend fun recordAllocatedObjectByRevision(
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        expectedRevision: Long,
        actualName: String,
        objectUri: String,
        updatedAtEpochMillis: Long,
    ): Int

    @Query(
        "UPDATE transfer_publication_files SET state = :newState, observed_size = :observedSize, " +
            "observed_sha256 = :observedSha256, failure_reason = NULL, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, revision = revision + 1 " +
            "WHERE task_id = :taskId AND file_index = :fileIndex " +
            "AND publication_id = :publicationId AND state = :expectedState " +
            "AND revision = :expectedRevision",
    )
    suspend fun recordObservedObjectByRevision(
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        expectedState: String,
        expectedRevision: Long,
        newState: String,
        observedSize: Long,
        observedSha256: String,
        updatedAtEpochMillis: Long,
    ): Int

    /** Dedicated primitive for providers whose rename operation returns a new URI. */
    @Query(
        "UPDATE transfer_publication_files SET object_uri = :newObjectUri, actual_name = :actualName, " +
            "updated_at_epoch_millis = :updatedAtEpochMillis, revision = revision + 1 " +
            "WHERE task_id = :taskId AND file_index = :fileIndex " +
            "AND publication_id = :publicationId AND object_uri = :expectedObjectUri " +
            "AND revision = :expectedRevision",
    )
    suspend fun replaceObjectAfterRenameByRevision(
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        expectedObjectUri: String,
        expectedRevision: Long,
        newObjectUri: String,
        actualName: String,
        updatedAtEpochMillis: Long,
    ): Int

    /**
     * Replaces the coordinator-owned portion of a receipt snapshot.
     * Provider-specific fields not represented by PublicationFileRecord remain untouched.
     */
    @Query(
        "UPDATE transfer_publication_files SET state = :state, target_token = :targetToken, " +
            "observed_size = :observedSize, observed_sha256 = :observedSha256, " +
            "failure_reason = :failureReason, updated_at_epoch_millis = :updatedAtEpochMillis, " +
            "revision = :newRevision WHERE task_id = :taskId AND file_index = :fileIndex " +
            "AND publication_id = :publicationId",
    )
    suspend fun replaceCoordinatorSnapshot(
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        state: String,
        targetToken: String?,
        observedSize: Long?,
        observedSha256: String?,
        failureReason: String?,
        updatedAtEpochMillis: Long,
        newRevision: Long,
    ): Int

    @Query("DELETE FROM transfer_publication_files WHERE task_id = :taskId")
    suspend fun deleteForTask(taskId: String): Int
}
