package io.github.nearbytransfer.android.core.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.data.local.PeerPermissionCodec
import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomTrustedPeerRepositoryTest {
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTrustedPeerRepository

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = RoomTrustedPeerRepository(database.trustedPeerDao(), nowEpochMillis = { 99L })
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun permissionEncodingIsCanonicalAndRejectsMalformedRows() {
        assertEquals(
            "LIBRARY_READ,TRANSFER",
            PeerPermissionCodec.encode(setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ)),
        )
        assertEquals(
            setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
            PeerPermissionCodec.decode("LIBRARY_READ,TRANSFER"),
        )
        assertThrows(IllegalArgumentException::class.java) {
            PeerPermissionCodec.decode("TRANSFER,LIBRARY_READ")
        }
        assertThrows(IllegalArgumentException::class.java) {
            PeerPermissionCodec.decode("TRANSFER,TRANSFER")
        }
    }

    @Test
    fun upsertObserveFindAndDeleteRoundTrip() = runBlocking {
        repository.upsert(trustedPeer())

        val observed = repository.observePeers().first()
        assertEquals(listOf(trustedPeer()), observed)
        assertEquals(trustedPeer(), repository.findByDeviceId("peer-1"))

        repository.delete("peer-1")
        assertNull(repository.findByDeviceId("peer-1"))
        assertTrue(repository.observePeers().first().isEmpty())
    }

    @Test
    fun publicKeysRoundTripWithoutNormalizationOrLoss() = runBlocking {
        val peer = trustedPeer(
            signingPublicKey = "-----BEGIN PUBLIC KEY-----\nED25519\n-----END PUBLIC KEY-----\n",
            encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nX25519\n-----END PUBLIC KEY-----\n",
        )

        repository.upsert(peer)

        val storedEntity = requireNotNull(database.trustedPeerDao().findByDeviceId(peer.deviceId))
        assertEquals(peer.signingPublicKey, storedEntity.signingPublicKey)
        assertEquals(peer.encryptionPublicKey, storedEntity.encryptionPublicKey)
        assertEquals(peer, repository.findByDeviceId(peer.deviceId))
    }

    @Test
    fun trustedPeersRequireBothPublicKeys() = runBlocking {
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.upsert(trustedPeer(signingPublicKey = "")) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.upsert(trustedPeer(encryptionPublicKey = "")) }
        }
        Unit
    }

    @Test
    fun migrationFromVersionOneRevokesRowsThatCannotBeBoundToPublicKeys() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "trusted-peer-v1-${System.nanoTime()}.db"
        createVersionOneDatabase(context, databaseName)

        val migratedDatabase = Room.databaseBuilder(
            context,
            NearbyTransferDatabase::class.java,
            databaseName,
        ).addMigrations(NearbyTransferDatabase.MIGRATION_1_2)
            .allowMainThreadQueries()
            .build()

        try {
            val migratedEntity = requireNotNull(migratedDatabase.trustedPeerDao().findByDeviceId("legacy-peer"))
            assertEquals(TrustStatus.REVOKED.name, migratedEntity.trustStatus)
            assertEquals("", migratedEntity.encodedPermissions)
            assertEquals("", migratedEntity.signingPublicKey)
            assertEquals("", migratedEntity.encryptionPublicKey)

            val migratedRepository = RoomTrustedPeerRepository(migratedDatabase.trustedPeerDao())
            val migratedPeer = requireNotNull(migratedRepository.findByDeviceId("legacy-peer"))
            assertEquals(TrustStatus.REVOKED, migratedPeer.trustStatus)
            assertTrue(migratedPeer.permissions.isEmpty())
            assertEquals("", migratedPeer.signingPublicKey)
            assertEquals("", migratedPeer.encryptionPublicKey)
        } finally {
            migratedDatabase.close()
            context.deleteDatabase(databaseName)
        }
    }

    @Test
    fun revokedPeerLosesPermissionsAndCannotBeRegrantedInPlace() = runBlocking {
        repository.upsert(trustedPeer())
        repository.setTrustStatus("peer-1", TrustStatus.REVOKED)

        val revoked = requireNotNull(repository.findByDeviceId("peer-1"))
        assertEquals(TrustStatus.REVOKED, revoked.trustStatus)
        assertTrue(revoked.permissions.isEmpty())
        assertFalse(revoked.canTransfer())
        assertFalse(revoked.canReadLibrary())
        assertFalse(revoked.canUploadToLibrary())
        assertEquals(99L, revoked.updatedAtEpochMillis)

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.setTrustStatus("peer-1", TrustStatus.TRUSTED) }
        }
        assertThrows(IllegalStateException::class.java) {
            runBlocking { repository.upsert(trustedPeer(updatedAtEpochMillis = 100L)) }
        }
        Unit
    }

    private fun createVersionOneDatabase(context: Context, databaseName: String) {
        val legacyDatabase = SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(databaseName), null)
        try {
            legacyDatabase.execSQL(
                "CREATE TABLE trusted_peers (" +
                    "device_id TEXT NOT NULL, " +
                    "display_name TEXT NOT NULL, " +
                    "fingerprint TEXT NOT NULL, " +
                    "permissions TEXT NOT NULL, " +
                    "trust_status TEXT NOT NULL, " +
                    "paired_at_epoch_millis INTEGER NOT NULL, " +
                    "updated_at_epoch_millis INTEGER NOT NULL, " +
                    "PRIMARY KEY(device_id))",
            )
            legacyDatabase.execSQL(
                "INSERT INTO trusted_peers " +
                    "(device_id, display_name, fingerprint, permissions, trust_status, paired_at_epoch_millis, updated_at_epoch_millis) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                arrayOf("legacy-peer", "Legacy phone", "ed25519:legacy", "TRANSFER", "TRUSTED", 1L, 1L),
            )
            legacyDatabase.version = 1
        } finally {
            legacyDatabase.close()
        }
    }

    private fun trustedPeer(
        updatedAtEpochMillis: Long = 10L,
        signingPublicKey: String = "ed25519-public-key",
        encryptionPublicKey: String = "x25519-public-key",
    ) = TrustedPeer(
        deviceId = "peer-1",
        displayName = "Alice phone",
        fingerprint = "ed25519:example",
        signingPublicKey = signingPublicKey,
        encryptionPublicKey = encryptionPublicKey,
        permissions = setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
        trustStatus = TrustStatus.TRUSTED,
        pairedAtEpochMillis = 10L,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )
}
