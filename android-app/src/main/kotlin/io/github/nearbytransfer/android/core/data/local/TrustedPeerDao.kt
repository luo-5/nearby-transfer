package io.github.nearbytransfer.android.core.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface TrustedPeerDao {
    @Query("SELECT * FROM trusted_peers ORDER BY display_name COLLATE NOCASE ASC, device_id ASC")
    fun observeAll(): Flow<List<TrustedPeerEntity>>

    @Query("SELECT * FROM trusted_peers ORDER BY display_name COLLATE NOCASE ASC, device_id ASC")
    suspend fun listAll(): List<TrustedPeerEntity>

    @Query("SELECT * FROM trusted_peers WHERE device_id = :deviceId LIMIT 1")
    suspend fun findByDeviceId(deviceId: String): TrustedPeerEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertOrReplace(peer: TrustedPeerEntity)

    /**
     * Serializes the read-before-write identity check with the replacement.
     * Identity material is immutable for an existing device ID, and a revoked
     * row is terminal until it is explicitly deleted.
     */
    @Transaction
    suspend fun insertUnlessIdentityConflict(peer: TrustedPeerEntity) {
        val existing = findByDeviceId(peer.deviceId)
        if (existing != null) {
            require(
                existing.fingerprint == peer.fingerprint &&
                    existing.signingPublicKey == peer.signingPublicKey &&
                    existing.encryptionPublicKey == peer.encryptionPublicKey,
            ) {
                "Trusted identity material cannot change for an existing deviceId."
            }
            check(existing.trustStatus != "REVOKED" || peer.trustStatus != "TRUSTED") {
                "A revoked peer must be deleted and paired again before it can be trusted."
            }
            require(peer.pairedAtEpochMillis >= existing.pairedAtEpochMillis) {
                "pairedAtEpochMillis cannot move backwards for an existing deviceId."
            }
            require(peer.updatedAtEpochMillis >= existing.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards for an existing deviceId."
            }
        }
        insertOrReplace(peer)
    }

    @Query(
        "UPDATE trusted_peers " +
            "SET trust_status = 'REVOKED', permissions = '', " +
            "updated_at_epoch_millis = MAX(updated_at_epoch_millis, paired_at_epoch_millis, :updatedAtEpochMillis) " +
            "WHERE device_id = :deviceId AND trust_status != 'REVOKED'",
    )
    suspend fun revoke(deviceId: String, updatedAtEpochMillis: Long): Int

    @Query("DELETE FROM trusted_peers WHERE device_id = :deviceId")
    suspend fun delete(deviceId: String): Int
}
