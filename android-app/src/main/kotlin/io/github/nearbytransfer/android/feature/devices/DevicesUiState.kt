package io.github.nearbytransfer.android.feature.devices

import io.github.nearbytransfer.android.core.model.TrustedPeer

data class PairingActionState(
    val sessionId: String,
    val peerName: String,
    val peerDeviceId: String,
    val sixDigitCode: String,
    val isLocalConfirmationRequired: Boolean = true,
    val isRemoteConfirmed: Boolean = false,
)

data class NearbyDeviceItem(
    val deviceId: String,
    val displayName: String,
    val fingerprint: String,
    val isPaired: Boolean,
    val host: String = "",
    val port: Int = 0,
)

data class DevicesUiState(
    val nearbyDevices: List<NearbyDeviceItem> = emptyList(),
    val trustedPeers: List<TrustedPeer> = emptyList(),
    val isDiscoveryEnabled: Boolean = true,
    val selectedDeviceId: String? = null,
    val pendingPairing: PairingActionState? = null,
    val message: String? = null,
)