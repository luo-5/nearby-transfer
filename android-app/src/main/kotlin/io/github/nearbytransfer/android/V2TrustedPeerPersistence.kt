package io.github.nearbytransfer.android

import android.content.Context
import android.os.Looper
import io.github.nearbytransfer.android.core.data.RoomTrustedPeerRepository
import io.github.nearbytransfer.android.core.data.TrustedPeerRepository
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Java-callable boundary over the app's single Room trusted-peer data source.
 * Only public identity material is persisted; public summaries intentionally do
 * not expose signing or encryption public keys.
 */
object V2TrustedPeerPersistence {
    data class TrustedPeerSummary(
        val deviceId: String,
        val displayName: String,
        val fingerprint: String,
        val trustStatus: TrustStatus,
        val canTransfer: Boolean,
        val pairedAtEpochMillis: Long,
        val updatedAtEpochMillis: Long,
    )

    @JvmStatic
    fun persistCompletedPairing(context: Context, completedPairingIdentity: Any): TrustedPeerSummary =
        persistCompletedPairing(context, completedPairingIdentity, System.currentTimeMillis())

    /**
     * Persists a mutually confirmed v2 identity. `Any` keeps the public Kotlin ABI valid
     * while the package-private Java V2Identity remains an implementation detail.
     */
    @JvmStatic
    fun persistCompletedPairing(
        context: Context,
        completedPairingIdentity: Any,
        nowEpochMillis: Long,
    ): TrustedPeerSummary {
        require(nowEpochMillis >= 0L) { "nowEpochMillis must be non-negative." }
        val identity = completedPairingIdentity as? V2Identity
            ?: throw IllegalArgumentException("completedPairingIdentity must be a V2Identity.")
        return withRepository(context) { repository ->
            val peer = TrustedPeer(
                deviceId = identity.deviceId,
                displayName = identity.deviceName,
                fingerprint = identity.fingerprint,
                signingPublicKey = identity.signingPublicKey,
                encryptionPublicKey = identity.encryptionPublicKey,
                permissions = setOf(PeerPermission.TRANSFER),
                trustStatus = TrustStatus.TRUSTED,
                pairedAtEpochMillis = nowEpochMillis,
                updatedAtEpochMillis = nowEpochMillis,
            )
            repository.upsert(peer)
            peer.toPublicSummary()
        }
    }

    @JvmStatic
    fun listTrustedPeers(context: Context): List<TrustedPeerSummary> =
        withRepository(context) { repository ->
            repository.listPeers().map { it.toPublicSummary() }
        }

    @JvmStatic
    fun findTrustedPeer(context: Context, deviceId: String): TrustedPeerSummary? =
        withRepository(context) { repository ->
            repository.findByDeviceId(deviceId)?.toPublicSummary()
        }

    @JvmStatic
    fun revokeTrustedPeer(context: Context, deviceId: String): Boolean =
        revokeTrustedPeer(context, deviceId, System.currentTimeMillis())

    @JvmStatic
    fun revokeTrustedPeer(context: Context, deviceId: String, nowEpochMillis: Long): Boolean {
        require(nowEpochMillis >= 0L) { "nowEpochMillis must be non-negative." }
        return withRepository(context, nowEpochMillis = { nowEpochMillis }) { repository ->
            repository.setTrustStatus(deviceId, TrustStatus.REVOKED)
        }
    }

    private fun TrustedPeer.toPublicSummary() = TrustedPeerSummary(
        deviceId = deviceId,
        displayName = displayName,
        fingerprint = fingerprint,
        trustStatus = trustStatus,
        canTransfer = canTransfer(),
        pairedAtEpochMillis = pairedAtEpochMillis,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )

    private fun <T> withRepository(
        context: Context,
        nowEpochMillis: () -> Long = System::currentTimeMillis,
        operation: suspend (TrustedPeerRepository) -> T,
    ): T {
        check(Looper.getMainLooper().thread !== Thread.currentThread()) {
            "V2 trusted-peer persistence must run on a background thread."
        }
        val applicationContext = context.applicationContext
            ?: throw IllegalArgumentException("An application Context is required.")
        return runBlocking(Dispatchers.IO) {
            val database = NearbyTransferDatabase.build(applicationContext)
            try {
                operation(RoomTrustedPeerRepository(database.trustedPeerDao(), nowEpochMillis))
            } finally {
                database.close()
            }
        }
    }
}
