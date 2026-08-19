package io.github.nearbytransfer.android.core.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index

/**
 * Durable per-file publication receipt.
 *
 * The row records intent before provider side effects and evidence after them;
 * it deliberately does not imply atomic publication across multiple files.
 */
@Entity(
    tableName = "transfer_publication_files",
    primaryKeys = ["task_id", "file_index"],
    foreignKeys = [
        ForeignKey(
            entity = TransferJobEntity::class,
            parentColumns = ["task_id"],
            childColumns = ["task_id"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index(value = ["publication_id"]),
        Index(value = ["state"]),
        Index(value = ["object_uri"], unique = true),
    ],
)
data class TransferPublicationFileEntity(
    @ColumnInfo(name = "task_id")
    val taskId: String,
    @ColumnInfo(name = "file_index")
    val fileIndex: Int,
    @ColumnInfo(name = "publication_id")
    val publicationId: String,
    val state: String,
    @ColumnInfo(name = "target_token")
    val targetToken: String?,
    @ColumnInfo(name = "temporary_marker")
    val temporaryMarker: String?,
    @ColumnInfo(name = "requested_name")
    val requestedName: String,
    @ColumnInfo(name = "actual_name")
    val actualName: String?,
    @ColumnInfo(name = "object_uri")
    val objectUri: String?,
    @ColumnInfo(name = "expected_size")
    val expectedSize: Long,
    @ColumnInfo(name = "expected_sha256")
    val expectedSha256: String,
    @ColumnInfo(name = "observed_size")
    val observedSize: Long?,
    @ColumnInfo(name = "observed_sha256")
    val observedSha256: String?,
    @ColumnInfo(name = "updated_at_epoch_millis")
    val updatedAtEpochMillis: Long,
    val revision: Long,
    @ColumnInfo(name = "failure_reason")
    val failureReason: String?,
)

