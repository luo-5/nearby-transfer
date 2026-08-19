package io.github.nearbytransfer.android.core.data

import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.flow.Flow

/**
 * Domain-facing trusted-peer boundary.
 *
 * The first production implementation will be Room-backed in core/data/local. Keeping
 * the rest of the app behind this contract prevents UI and transfer code from coupling
 * to SQL, DAO annotations, or Android storage details.
 */
interface TrustedPeerRepository {
    fun observePeers(): Flow<List<TrustedPeer>>

    suspend fun findByDeviceId(deviceId: String): TrustedPeer?

    suspend fun upsert(peer: TrustedPeer)

    suspend fun setTrustStatus(deviceId: String, status: TrustStatus)

    suspend fun delete(deviceId: String)
}