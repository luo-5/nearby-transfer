package io.github.nearbytransfer.android.feature.devices

import io.github.nearbytransfer.android.core.model.TrustedPeer

/** UI-only state. Repository data and pairing session state will be mapped here later. */
data class DevicesUiState(
    val nearbyDevices: List<NearbyDeviceItem> = emptyList(),
    val trustedPeers: List<TrustedPeer> = emptyList(),
    val isDiscoveryEnabled: Boolean = false,
    val message: String? = null,
)

data class NearbyDeviceItem(
    val deviceId: String,
    val displayName: String,
    val fingerprint: String,
    val isPaired: Boolean,
)