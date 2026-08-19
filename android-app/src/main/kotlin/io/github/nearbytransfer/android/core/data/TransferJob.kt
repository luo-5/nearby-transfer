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
    val checkpointJson: String? = null,
    val publicationState: PublicationState = PublicationState.NONE,
    val publicationId: String? = null,
    val publicationBackend: PublicationBackend? = null,
    val publicationRootToken: String? = null,
    val publicationError: String? = null,
    val publicationCancelRequested: Boolean = false,
    val cleanupPending: Boolean = false,
    val revision: Long = 0,
)
