package io.github.nearbytransfer.android.core.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustedPeerTest {
    private val trustedTransferPeer = TrustedPeer(
        deviceId = "device-1",
        displayName = "Test device",
        fingerprint = "fingerprint",
        permissions = setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
        trustStatus = TrustStatus.TRUSTED,
        pairedAtEpochMillis = 1L,
        updatedAtEpochMillis = 1L,
    )

    @Test
    fun trustedPeerOnlyGrantsDeclaredPermissions() {
        assertTrue(trustedTransferPeer.canTransfer())
        assertTrue(trustedTransferPeer.canReadLibrary())
        assertFalse(trustedTransferPeer.canUploadToLibrary())
    }

    @Test
    fun revokedPeerCannotUseAnyGrantedPermission() {
        val revokedPeer = trustedTransferPeer.copy(trustStatus = TrustStatus.REVOKED)

        assertFalse(revokedPeer.canTransfer())
        assertFalse(revokedPeer.canReadLibrary())
        assertFalse(revokedPeer.canUploadToLibrary())
    }
}