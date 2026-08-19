package io.github.nearbytransfer.android.core.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

/**
 * Device-local database for public trusted-peer records only.
 *
 * Version 1 intentionally has a narrow schema. New public fields require an
 * explicit migration; no key material or transient pairing state belongs here.
 */
@Database(
    entities = [TrustedPeerEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class NearbyTransferDatabase : RoomDatabase() {
    abstract fun trustedPeerDao(): TrustedPeerDao

    companion object {
        const val DATABASE_NAME = "nearby-transfer-v2.db"
    }
}