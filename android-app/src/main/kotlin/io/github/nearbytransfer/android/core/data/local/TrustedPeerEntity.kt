package io.github.nearbytransfer.android.core.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Persistent representation of a paired peer.
 *
 * This table deliberately stores only protocol-v2 public identity metadata and
 * user-controlled grants. Private identity keys, pairing nonces, and transfer
 * session secrets must never be added to this entity.
 */
@Entity(tableName = "trusted_peers")
data class TrustedPeerEntity(
    @PrimaryKey
    @ColumnInfo(name = "device_id")
    val deviceId: String,
    @ColumnInfo(name = "display_name")
    val displayName: String,
    val fingerprint: String,
    @ColumnInfo(name = "signing_public_key")
    val signingPublicKey: String,
    @ColumnInfo(name = "encryption_public_key")
    val encryptionPublicKey: String,
    @ColumnInfo(name = "permissions")
    val encodedPermissions: String,
    @ColumnInfo(name = "trust_status")
    val trustStatus: String,
    @ColumnInfo(name = "paired_at_epoch_millis")
    val pairedAtEpochMillis: Long,
    @ColumnInfo(name = "updated_at_epoch_millis")
    val updatedAtEpochMillis: Long,
)
