package io.github.nearbytransfer.android.core.data

import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.flow.Flow

/**
 * Domain-facing trusted-peer boundary.
 *
 * Room is the single production source of truth for trusted-peer state. UI,
 * pairing, and transfer code depend on this contract instead of SQL or DAO
 * details.
 */
interface TrustedPeerRepository {
    fun observePeers(): Flow<List<TrustedPeer>>

    suspend fun listPeers(): List<TrustedPeer>

    suspend fun findByDeviceId(deviceId: String): TrustedPeer?

    suspend fun upsert(peer: TrustedPeer)

    suspend fun setTrustStatus(deviceId: String, status: TrustStatus): Boolean

    suspend fun delete(deviceId: String)
}
