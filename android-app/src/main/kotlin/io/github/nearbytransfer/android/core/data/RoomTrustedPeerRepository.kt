package io.github.nearbytransfer.android.core.data

import io.github.nearbytransfer.android.core.data.local.TrustedPeerDao
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Room-backed implementation of the domain trusted-peer repository.
 *
 * Identity material is immutable for a device ID. Revocation clears all stored
 * grants and cannot be reversed in-place. Deleting the row followed by a new
 * verified pairing is the only route to trust an identity again.
 */
class RoomTrustedPeerRepository(
    private val dao: TrustedPeerDao,
    private val nowEpochMillis: () -> Long = System::currentTimeMillis,
) : TrustedPeerRepository {
    override fun observePeers(): Flow<List<TrustedPeer>> = dao.observeAll().map { peers ->
        peers.map { it.toDomain() }
    }

    override suspend fun listPeers(): List<TrustedPeer> = dao.listAll().map { it.toDomain() }

    override suspend fun findByDeviceId(deviceId: String): TrustedPeer? {
        requireDeviceId(deviceId)
        return dao.findByDeviceId(deviceId)?.toDomain()
    }

    override suspend fun upsert(peer: TrustedPeer) {
        validatePeer(peer)
        dao.insertUnlessIdentityConflict(peer.toEntity())
    }

    override suspend fun setTrustStatus(deviceId: String, status: TrustStatus): Boolean {
        requireDeviceId(deviceId)
        require(status == TrustStatus.REVOKED) {
            "Trust can only be granted by a new verified pairing, not by changing a stored status."
        }
        val revokedAtEpochMillis = nowEpochMillis()
        require(revokedAtEpochMillis >= 0L) { "nowEpochMillis must be non-negative." }
        return dao.revoke(deviceId, revokedAtEpochMillis) > 0
    }

    override suspend fun delete(deviceId: String) {
        requireDeviceId(deviceId)
        dao.delete(deviceId)
    }

    private fun requireDeviceId(deviceId: String) {
        require(deviceId.isNotBlank()) { "deviceId is required." }
    }

    private fun validatePeer(peer: TrustedPeer) {
        requireDeviceId(peer.deviceId)
        require(peer.displayName.isNotBlank()) { "displayName is required." }
        require(peer.fingerprint.isNotBlank()) { "fingerprint is required." }
        if (peer.trustStatus == TrustStatus.TRUSTED) {
            require(peer.signingPublicKey.isNotBlank()) { "signingPublicKey is required for a trusted peer." }
            require(peer.encryptionPublicKey.isNotBlank()) { "encryptionPublicKey is required for a trusted peer." }
        }
        require(peer.pairedAtEpochMillis >= 0) { "pairedAtEpochMillis must be non-negative." }
        require(peer.updatedAtEpochMillis >= peer.pairedAtEpochMillis) {
            "updatedAtEpochMillis must not predate pairedAtEpochMillis."
        }
    }
}
