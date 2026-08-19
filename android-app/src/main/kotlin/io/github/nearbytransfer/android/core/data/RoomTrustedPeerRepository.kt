package io.github.nearbytransfer.android.core.data

import io.github.nearbytransfer.android.core.data.local.TrustedPeerDao
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Room-backed implementation of the domain trusted-peer repository.
 *
 * Revocation clears all stored grants and cannot be reversed in-place. Deleting
 * the row followed by a new verified pairing is the only route to trust an
 * identity again.
 */
class RoomTrustedPeerRepository(
    private val dao: TrustedPeerDao,
    private val nowEpochMillis: () -> Long = System::currentTimeMillis,
) : TrustedPeerRepository {
    override fun observePeers(): Flow<List<TrustedPeer>> = dao.observeAll().map { peers ->
        peers.map { it.toDomain() }
    }

    override suspend fun findByDeviceId(deviceId: String): TrustedPeer? = dao.findByDeviceId(deviceId)?.toDomain()

    override suspend fun upsert(peer: TrustedPeer) {
        validatePeer(peer)
        check(dao.insertUnlessPreviouslyRevoked(peer.toEntity())) {
            "A revoked peer must be deleted and paired again before it can be trusted."
        }
    }

    override suspend fun setTrustStatus(deviceId: String, status: TrustStatus) {
        require(status == TrustStatus.REVOKED) {
            "Trust can only be granted by a new verified pairing, not by changing a stored status."
        }
        dao.revoke(deviceId, nowEpochMillis())
    }

    override suspend fun delete(deviceId: String) {
        dao.delete(deviceId)
    }

    private fun validatePeer(peer: TrustedPeer) {
        require(peer.deviceId.isNotBlank()) { "deviceId is required." }
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
