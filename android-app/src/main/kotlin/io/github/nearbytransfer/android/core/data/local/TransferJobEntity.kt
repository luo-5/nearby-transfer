package io.github.nearbytransfer.android.core.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Public, non-secret persisted state for a protocol-v2 transfer.
 *
 * Session keys, plaintext, local source paths, destination paths, nonces and
 * authentication material must never be added to this entity.
 */
@Entity(
    tableName = "transfer_jobs",
    indices = [
        Index(value = ["peer_id"]),
        Index(value = ["state"]),
        Index(value = ["updated_at_epoch_millis"]),
    ],
)
data class TransferJobEntity(
    @PrimaryKey
    @ColumnInfo(name = "task_id")
    val taskId: String,
    @ColumnInfo(name = "peer_id")
    val peerId: String,
    val direction: String,
    val state: String,
    @ColumnInfo(name = "manifest_json")
    val manifestJson: String,
    @ColumnInfo(name = "total_bytes")
    val totalBytes: Long,
    @ColumnInfo(name = "transferred_bytes")
    val transferredBytes: Long,
    @ColumnInfo(name = "created_at_epoch_millis")
    val createdAtEpochMillis: Long,
    @ColumnInfo(name = "updated_at_epoch_millis")
    val updatedAtEpochMillis: Long,
    val recoverable: Boolean,
    @ColumnInfo(name = "failure_reason")
    val failureReason: String?,
)
