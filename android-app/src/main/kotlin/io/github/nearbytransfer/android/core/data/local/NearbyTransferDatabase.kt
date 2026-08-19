package io.github.nearbytransfer.android.core.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Device-local database for public trusted-peer records only.
 *
 * Version 2 persists the signing and encryption public keys required to bind a
 * v2 trusted peer to its identity. Version-1 rows cannot be safely rebound,
 * so migration revokes them and clears their grants instead of treating a
 * fingerprint-only record as trusted.
 */
@Database(
    entities = [TrustedPeerEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class NearbyTransferDatabase : RoomDatabase() {
    abstract fun trustedPeerDao(): TrustedPeerDao

    companion object {
        const val DATABASE_NAME = "nearby-transfer-v2.db"

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "ALTER TABLE trusted_peers ADD COLUMN signing_public_key TEXT NOT NULL DEFAULT ''",
                )
                database.execSQL(
                    "ALTER TABLE trusted_peers ADD COLUMN encryption_public_key TEXT NOT NULL DEFAULT ''",
                )
                database.execSQL(
                    "UPDATE trusted_peers " +
                        "SET trust_status = 'REVOKED', permissions = '' " +
                        "WHERE trust_status = 'TRUSTED'",
                )
            }
        }
    }
}
