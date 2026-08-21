package io.github.nearbytransfer.android.feature.transfers

enum class TransferUiStatus {
    IDLE,
    AWAITING_APPROVAL,
    QUEUED,
    TRANSFERRING,
    PAUSED,
    COMPLETED,
    FAILED,
    CANCELLED,
}

data class SelectedFileItem(
    val name: String,
    val sizeBytes: Long,
    val mimeType: String? = null,
    val uriString: String? = null,
) {
    val formattedSize: String
        get() = formatBytes(sizeBytes)

    companion object {
        fun formatBytes(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            val kb = bytes / 1024.0
            if (kb < 1024) return String.format(java.util.Locale.ROOT, "%.1f KB", kb)
            val mb = kb / 1024.0
            if (mb < 1024) return String.format(java.util.Locale.ROOT, "%.1f MB", mb)
            val gb = mb / 1024.0
            return String.format(java.util.Locale.ROOT, "%.2f GB", gb)
        }
    }
}

data class ActiveTransferItem(
    val taskId: String,
    val title: String,
    val peerName: String,
    val currentBytes: Long,
    val totalBytes: Long,
    val status: TransferUiStatus,
    val speedBytesPerSec: Long = 0L,
    val isIncoming: Boolean = false,
    val errorMessage: String? = null,
) {
    val progressFraction: Float
        get() = if (totalBytes > 0) (currentBytes.toFloat() / totalBytes.toFloat()).coerceIn(0f, 1f) else 0f

    val percentage: Int
        get() = (progressFraction * 100).toInt()

    val formattedProgress: String
        get() = "${SelectedFileItem.formatBytes(currentBytes)} / ${SelectedFileItem.formatBytes(totalBytes)}"
}

data class TransfersUiState(
    val selectedFile: SelectedFileItem? = null,
    val activeTransfer: ActiveTransferItem? = null,
    val transferHistory: List<ActiveTransferItem> = emptyList(),
    val isTransferring: Boolean = false,
    val message: String? = null,
)
