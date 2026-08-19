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

    @Query("SELECT * FROM trusted_peers WHERE device_id = :deviceId LIMIT 1")
    suspend fun findByDeviceId(deviceId: String): TrustedPeerEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertOrReplace(peer: TrustedPeerEntity)

    /**
     * Revocation is terminal for this row. Callers must delete and establish a
     * fresh pairing before a previously revoked identity can become trusted.
     */
    @Transaction
    suspend fun insertUnlessPreviouslyRevoked(peer: TrustedPeerEntity): Boolean {
        val existing = findByDeviceId(peer.deviceId)
        if (existing?.trustStatus == "REVOKED" && peer.trustStatus == "TRUSTED") {
            return false
        }
        insertOrReplace(peer)
        return true
    }

    @Query(
        "UPDATE trusted_peers " +
            "SET trust_status = 'REVOKED', permissions = '', updated_at_epoch_millis = :updatedAtEpochMillis " +
            "WHERE device_id = :deviceId",
    )
    suspend fun revoke(deviceId: String, updatedAtEpochMillis: Long): Int

    @Query("DELETE FROM trusted_peers WHERE device_id = :deviceId")
    suspend fun delete(deviceId: String): Int
}