package io.github.nearbytransfer.android.core.data.local

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.AutoMigrationSpec
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Device-local database for trusted-peer and protocol-v2 transfer recovery records.
 *
 * Version 2 persists public identity keys. Version 3 adds resumable transfer
 * metadata. Version 4 adds canonical receive checkpoints and a durable,
 * per-file publication journal without claiming atomicity from MediaStore/SAF.
 */
@Database(
    entities = [
        TrustedPeerEntity::class,
        TransferJobEntity::class,
        TransferPublicationFileEntity::class,
    ],
    version = 4,
    autoMigrations = [
        AutoMigration(from = 3, to = 4, spec = NearbyTransferDatabase.Migration3To4Spec::class),
    ],
    exportSchema = true,
)
abstract class NearbyTransferDatabase : RoomDatabase() {
    class Migration3To4Spec : AutoMigrationSpec {
        override fun onPostMigrate(db: SupportSQLiteDatabase) {
            assignLegacyPublicationStates(db)
        }
    }

    abstract fun trustedPeerDao(): TrustedPeerDao

    abstract fun transferJobDao(): TransferJobDao

    abstract fun transferPublicationDao(): TransferPublicationDao

    companion object {
        const val DATABASE_NAME = "nearby-transfer-v2.db"

        @Volatile
        private var INSTANCE: NearbyTransferDatabase? = null

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

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN checkpoint_json TEXT")
                database.execSQL(
                    "ALTER TABLE transfer_jobs ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'NONE'",
                )
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN publication_id TEXT")
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN publication_backend TEXT")
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN publication_root_token TEXT")
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN publication_error TEXT")
                database.execSQL(
                    "ALTER TABLE transfer_jobs ADD COLUMN publication_cancel_requested INTEGER NOT NULL DEFAULT 0",
                )
                database.execSQL(
                    "ALTER TABLE transfer_jobs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0",
                )
                database.execSQL("ALTER TABLE transfer_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")

                database.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS index_transfer_jobs_publication_id " +
                        "ON transfer_jobs(publication_id)",
                )

                database.execSQL(
                    "CREATE TABLE IF NOT EXISTS transfer_publication_files (" +
                        "task_id TEXT NOT NULL, " +
                        "file_index INTEGER NOT NULL, " +
                        "publication_id TEXT NOT NULL, " +
                        "state TEXT NOT NULL, " +
                        "target_token TEXT, " +
                        "temporary_marker TEXT, " +
                        "requested_name TEXT NOT NULL, " +
                        "actual_name TEXT, " +
                        "object_uri TEXT, " +
                        "expected_size INTEGER NOT NULL, " +
                        "expected_sha256 TEXT NOT NULL, " +
                        "observed_size INTEGER, " +
                        "observed_sha256 TEXT, " +
                        "updated_at_epoch_millis INTEGER NOT NULL, " +
                        "revision INTEGER NOT NULL, " +
                        "failure_reason TEXT, " +
                        "PRIMARY KEY(task_id, file_index), " +
                        "FOREIGN KEY(task_id) REFERENCES transfer_jobs(task_id) " +
                        "ON UPDATE NO ACTION ON DELETE CASCADE)",
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_transfer_publication_files_publication_id " +
                        "ON transfer_publication_files(publication_id)",
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_transfer_publication_files_state " +
                        "ON transfer_publication_files(state)",
                )
                database.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS index_transfer_publication_files_object_uri " +
                        "ON transfer_publication_files(object_uri)",
                )

                assignLegacyPublicationStates(database)
            }
        }

        private fun assignLegacyPublicationStates(database: SupportSQLiteDatabase) {
            database.execSQL(
                "UPDATE transfer_jobs SET publication_state = 'LEGACY_UNVERIFIED' " +
                    "WHERE direction = 'INCOMING' AND state = 'COMPLETED'",
            )
            database.execSQL(
                "UPDATE transfer_jobs SET publication_state = 'RECONCILE_REQUIRED', recoverable = 1 " +
                    "WHERE direction = 'INCOMING' AND transferred_bytes > 0 " +
                    "AND state NOT IN ('COMPLETED', 'CANCELLED', 'QUARANTINED')",
            )
        }

        @JvmField
        val ALL_MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)

        /**
         * Returns the Application-scoped singleton database instance, creating it on first access.
         * Callers must not close the returned instance; it is managed by the process lifetime.
         */
        @JvmStatic
        fun getInstance(context: Context): NearbyTransferDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: build(context).also { INSTANCE = it }
            }
        }

        /** Preferred builder so every caller uses the complete migration chain. */
        @JvmStatic
        fun build(context: Context): NearbyTransferDatabase = Room.databaseBuilder(
            context.applicationContext,
            NearbyTransferDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(*ALL_MIGRATIONS).build()
    }
}
