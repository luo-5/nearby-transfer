package io.github.nearbytransfer.android.feature.libraries

data class LibraryShare(
    val id: String,
    val name: String,
    val isReadOnly: Boolean = true,
)

data class LibraryItem(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val sizeBytes: Long = 0L,
    val lastModified: String = "",
) {
    val formattedSize: String
        get() = if (isDirectory) "" else io.github.nearbytransfer.android.feature.transfers.SelectedFileItem.formatBytes(sizeBytes)
}

data class LibrariesUiState(
    val connectedPeerName: String? = null,
    val shares: List<LibraryShare> = emptyList(),
    val selectedShareId: String? = null,
    val currentPath: String = "/",
    val items: List<LibraryItem> = emptyList(),
    val isBusy: Boolean = false,
    val isUploadPermitted: Boolean = false,
    val message: String? = null,
) {
    val currentShare: LibraryShare?
        get() = shares.find { it.id == selectedShareId }
}
