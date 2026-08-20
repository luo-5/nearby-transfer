package io.github.nearbytransfer.android.core.data

import android.content.Context
import android.os.Looper
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Transport-only access to the public keys of a peer authorized for transfers.
 *
 * UI code must continue to use the key-free trusted-peer summaries. This
 * boundary releases key material only after the current Room record passes the
 * trust and transfer-permission checks.
 */
object V2TransferPeerAccess {
    private val canonicalDeviceId = Regex("^[0-9a-f]{16}$")

    /** Immutable public identity material required by the transfer transport. */
    class AuthorizedPeer internal constructor(
        val deviceId: String,
        val signingPublicKey: String,
        val encryptionPublicKey: String,
    )

    /**
     * Returns transport credentials only for a currently trusted peer with the
     * TRANSFER grant. Missing, revoked, and permission-denied peers return null.
     */
    @JvmStatic
    fun findAuthorizedPeer(context: Context, deviceId: String): AuthorizedPeer? {
        check(Looper.getMainLooper().thread !== Thread.currentThread()) {
            "V2 transfer peer access must run on a background thread."
        }
        require(canonicalDeviceId.matches(deviceId)) {
            "deviceId must be exactly 16 lowercase hexadecimal characters."
        }
        val applicationContext = context.applicationContext
            ?: throw IllegalArgumentException("An application Context is required.")

        return runBlocking(Dispatchers.IO) {
            val database = NearbyTransferDatabase.build(applicationContext)
            try {
                val peer = RoomTrustedPeerRepository(database.trustedPeerDao())
                    .findByDeviceId(deviceId)
                    ?: return@runBlocking null
                if (!peer.canTransfer()) return@runBlocking null
                if (peer.signingPublicKey.isBlank() || peer.encryptionPublicKey.isBlank()) {
                    return@runBlocking null
                }
                AuthorizedPeer(
                    deviceId = peer.deviceId,
                    signingPublicKey = peer.signingPublicKey,
                    encryptionPublicKey = peer.encryptionPublicKey,
                )
            } finally {
                database.close()
            }
        }
    }
}
