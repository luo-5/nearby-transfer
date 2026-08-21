package io.github.nearbytransfer.android.feature.settings

data class SettingsUiState(
    val deviceId: String = "",
    val deviceName: String = "",
    val fingerprint: String = "",
    val storageDirectory: String = "",
    val storageTreeUri: String? = null,
    val logEntries: List<String> = emptyList(),
    val isLogFollowing: Boolean = true,
    val isStorageDetailsExpanded: Boolean = false,
    val message: String? = null,
)
