package io.github.nearbytransfer.android.feature.devices

import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustedPeer
import io.github.nearbytransfer.android.core.model.TrustStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesUiStateTest {
    @Test
    fun defaultDevicesUiStateHasExpectedDefaults() {
        val state = DevicesUiState()
        assertTrue(state.nearbyDevices.isEmpty())
        assertTrue(state.trustedPeers.isEmpty())
        assertTrue(state.isDiscoveryEnabled)
        assertNull(state.selectedDeviceId)
        assertNull(state.pendingPairing)
    }

    @Test
    fun pairingActionStateHoldsAllRequiredFields() {
        val pairing = PairingActionState(
            sessionId = "session-123",
            peerName = "Desktop Peer",
            peerDeviceId = "0123456789abcdef",
            sixDigitCode = "123456",
            isLocalConfirmationRequired = true,
            isRemoteConfirmed = false,
        )

        assertEquals("session-123", pairing.sessionId)
        assertEquals("Desktop Peer", pairing.peerName)
        assertEquals("123456", pairing.sixDigitCode)
        assertTrue(pairing.isLocalConfirmationRequired)
    }

    @Test
    fun trustedPeerStateExposesCorrectPermissions() {
        val peer = TrustedPeer(
            deviceId = "0123456789abcdef",
            displayName = "My PC",
            fingerprint = "0123456789abcdef0123456789abcdef",
            signingPublicKey = "dummy-sign-key",
            encryptionPublicKey = "dummy-enc-key",
            permissions = setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
            trustStatus = TrustStatus.TRUSTED,
            pairedAtEpochMillis = 1000L,
            updatedAtEpochMillis = 1000L,
        )

        assertTrue(peer.canTransfer())
        assertTrue(peer.canReadLibrary())
        assertEquals("My PC", peer.displayName)
    }
}
