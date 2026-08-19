package io.github.nearbytransfer.android.core.data

enum class TransferDirection {
    INCOMING,
    OUTGOING,
}

enum class TransferJobState {
    QUEUED,
    AWAITING_APPROVAL,
    TRANSFERRING,
    PAUSED,
    FAILED,
    COMPLETED,
    CANCELLED,
}

/** Public transfer state safe to expose to Java/UI callers. */
data class TransferJob(
    val taskId: String,
    val peerId: String,
    val direction: TransferDirection,
    val state: TransferJobState,
    val manifestJson: String,
    val totalBytes: Long,
    val transferredBytes: Long,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
    val recoverable: Boolean,
    val failureReason: String?,
)
