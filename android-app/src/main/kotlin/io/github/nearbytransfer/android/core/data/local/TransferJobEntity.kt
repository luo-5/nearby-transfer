package io.github.nearbytransfer.android.core.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Public transfer metadata and app-private recovery capabilities for a protocol-v2 transfer.
 *
 * Session keys, plaintext, arbitrary local source/destination paths, nonces and
 * authentication material must never be added. A bounded opaque publication
 * scope token may be stored only because it is required to resume publication;
 * it must not be logged or sent over the network and is scrubbed on quarantine.
 */
@Entity(
    tableName = "transfer_jobs",
    indices = [
        Index(value = ["peer_id"]),
        Index(value = ["state"]),
        Index(value = ["updated_at_epoch_millis"]),
        Index(value = ["publication_id"], unique = true),
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
    @ColumnInfo(name = "checkpoint_json")
    val checkpointJson: String? = null,
    @ColumnInfo(name = "publication_state", defaultValue = "'NONE'")
    val publicationState: String = "NONE",
    @ColumnInfo(name = "publication_id")
    val publicationId: String? = null,
    @ColumnInfo(name = "publication_backend")
    val publicationBackend: String? = null,
    @ColumnInfo(name = "publication_root_token")
    val publicationRootToken: String? = null,
    @ColumnInfo(name = "publication_error")
    val publicationError: String? = null,
    @ColumnInfo(name = "publication_cancel_requested", defaultValue = "0")
    val publicationCancelRequested: Boolean = false,
    @ColumnInfo(name = "cleanup_pending", defaultValue = "0")
    val cleanupPending: Boolean = false,
    @ColumnInfo(defaultValue = "0")
    val revision: Long = 0,
)
