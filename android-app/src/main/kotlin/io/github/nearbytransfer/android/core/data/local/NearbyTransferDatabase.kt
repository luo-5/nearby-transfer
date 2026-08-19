package io.github.nearbytransfer.android.core.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Device-local database for public trusted-peer and transfer-job records only.
 *
 * Version 2 persists the public identity keys needed to bind trusted peers.
 * Version 3 adds resumable protocol-v2 transfer metadata. Neither schema stores
 * private keys, transfer session keys, plaintext, or local file-system paths.
 */
@Database(
    entities = [TrustedPeerEntity::class, TransferJobEntity::class],
    version = 3,
    exportSchema = false,
)
abstract class NearbyTransferDatabase : RoomDatabase() {
    abstract fun trustedPeerDao(): TrustedPeerDao

    abstract fun transferJobDao(): TransferJobDao

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

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "CREATE TABLE IF NOT EXISTS transfer_jobs (" +
                        "task_id TEXT NOT NULL, " +
                        "peer_id TEXT NOT NULL, " +
                        "direction TEXT NOT NULL, " +
                        "state TEXT NOT NULL, " +
                        "manifest_json TEXT NOT NULL, " +
                        "total_bytes INTEGER NOT NULL, " +
                        "transferred_bytes INTEGER NOT NULL, " +
                        "created_at_epoch_millis INTEGER NOT NULL, " +
                        "updated_at_epoch_millis INTEGER NOT NULL, " +
                        "recoverable INTEGER NOT NULL, " +
                        "failure_reason TEXT, " +
                        "PRIMARY KEY(task_id))",
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_transfer_jobs_peer_id ON transfer_jobs(peer_id)",
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_transfer_jobs_state ON transfer_jobs(state)",
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_transfer_jobs_updated_at_epoch_millis " +
                        "ON transfer_jobs(updated_at_epoch_millis)",
                )
            }
        }

        @JvmField
        val ALL_MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3)

        /** Preferred builder so every caller uses the complete migration chain. */
        @JvmStatic
        fun build(context: Context): NearbyTransferDatabase = Room.databaseBuilder(
            context.applicationContext,
            NearbyTransferDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(*ALL_MIGRATIONS).build()
    }
}
