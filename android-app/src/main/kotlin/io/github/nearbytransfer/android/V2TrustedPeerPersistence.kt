package io.github.nearbytransfer.android

import android.content.Context
import android.os.Looper
import androidx.room.Room
import io.github.nearbytransfer.android.core.data.RoomTrustedPeerRepository
import io.github.nearbytransfer.android.core.data.TrustedPeerRepository
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.runBlocking

/**
 * Java-callable persistence boundary for a completed protocol-v2 pairing.
 * Only public identity material is accepted and stored; callers must run it off the main thread.
 */
object V2TrustedPeerPersistence {
    data class TrustedPeerSummary(
        val deviceId: String,
        val displayName: String,
        val fingerprint: String,
        val pairedAtEpochMillis: Long,
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
        check(Looper.getMainLooper().thread !== Thread.currentThread()) {
            "V2 trusted-peer persistence must run on a background thread."
        }
        require(nowEpochMillis >= 0L) { "nowEpochMillis must be non-negative." }
        val identity = completedPairingIdentity as? V2Identity
            ?: throw IllegalArgumentException("completedPairingIdentity must be a V2Identity.")
        val applicationContext = context.applicationContext
            ?: throw IllegalArgumentException("An application Context is required.")
        val database = Room.databaseBuilder(
            applicationContext,
            NearbyTransferDatabase::class.java,
            NearbyTransferDatabase.DATABASE_NAME,
        ).addMigrations(NearbyTransferDatabase.MIGRATION_1_2).build()
        try {
            val repository = RoomTrustedPeerRepository(database.trustedPeerDao())
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
            runBlocking { repository.upsert(peer) }
            return TrustedPeerSummary(peer.deviceId, peer.displayName, peer.fingerprint, peer.pairedAtEpochMillis)
        } finally {
            database.close()
        }
    }
}
