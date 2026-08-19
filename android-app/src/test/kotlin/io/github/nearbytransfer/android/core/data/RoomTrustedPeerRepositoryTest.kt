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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
    fun upsertObserveListFindAndDeleteRoundTrip() = runBlocking {
        val zulu = trustedPeer(deviceId = "peer-z", displayName = "Zulu phone")
        val alpha = trustedPeer(deviceId = "peer-a", displayName = "Alpha phone")
        repository.upsert(zulu)
        repository.upsert(alpha)

        assertEquals(listOf(alpha, zulu), repository.observePeers().first())
        assertEquals(listOf(alpha, zulu), repository.listPeers())
        assertEquals(alpha, repository.findByDeviceId("peer-a"))

        repository.delete("peer-a")
        assertNull(repository.findByDeviceId("peer-a"))
        assertEquals(listOf(zulu), repository.listPeers())
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
    fun identityMaterialCannotChangeForAnExistingDeviceId() = runBlocking {
        val original = trustedPeer()
        repository.upsert(original)

        val conflicts = listOf(
            original.copy(fingerprint = "ed25519:changed", updatedAtEpochMillis = 11L),
            original.copy(signingPublicKey = "changed-signing-key", updatedAtEpochMillis = 11L),
            original.copy(encryptionPublicKey = "changed-encryption-key", updatedAtEpochMillis = 11L),
        )
        conflicts.forEach { conflict ->
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { repository.upsert(conflict) }
            }
            assertEquals(original, repository.findByDeviceId(original.deviceId))
        }

        val timestampRegressions = listOf(
            original.copy(pairedAtEpochMillis = 9L, updatedAtEpochMillis = 11L),
            original.copy(updatedAtEpochMillis = 9L),
        )
        timestampRegressions.forEach { regression ->
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { repository.upsert(regression) }
            }
            assertEquals(original, repository.findByDeviceId(original.deviceId))
        }

        val renamed = original.copy(displayName = "Renamed phone", updatedAtEpochMillis = 12L)
        repository.upsert(renamed)
        assertEquals(renamed, repository.findByDeviceId(original.deviceId))
    }

    @Test
    fun concurrentFirstWritesAtomicallyRejectOneConflictingIdentity() = runBlocking {
        val first = trustedPeer(signingPublicKey = "first-signing", encryptionPublicKey = "first-encryption")
        val second = trustedPeer(signingPublicKey = "second-signing", encryptionPublicKey = "second-encryption")
        val start = CompletableDeferred<Unit>()
        val outcomes = listOf(first, second).map { candidate ->
            async(Dispatchers.Default) {
                start.await()
                runCatching { repository.upsert(candidate) }
            }
        }
        start.complete(Unit)

        val completed = outcomes.awaitAll()
        assertEquals(1, completed.count { it.isSuccess })
        assertEquals(1, completed.count { it.exceptionOrNull() is IllegalArgumentException })
        val stored = requireNotNull(repository.findByDeviceId(first.deviceId))
        assertTrue(stored == first || stored == second)
    }

    @Test
    fun revocationIsIdempotentAndNeverMovesUpdatedTimeBackwards() = runBlocking {
        val original = trustedPeer()
        repository.upsert(original)

        val negativeClockRepository = RoomTrustedPeerRepository(database.trustedPeerDao()) { -1L }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { negativeClockRepository.setTrustStatus(original.deviceId, TrustStatus.REVOKED) }
        }
        assertEquals(original, repository.findByDeviceId(original.deviceId))

        val staleClockRepository = RoomTrustedPeerRepository(database.trustedPeerDao()) { 5L }
        assertTrue(staleClockRepository.setTrustStatus(original.deviceId, TrustStatus.REVOKED))
        val revoked = requireNotNull(repository.findByDeviceId(original.deviceId))
        assertEquals(TrustStatus.REVOKED, revoked.trustStatus)
        assertEquals(original.updatedAtEpochMillis, revoked.updatedAtEpochMillis)

        assertFalse(repository.setTrustStatus(original.deviceId, TrustStatus.REVOKED))
        assertEquals(revoked, repository.findByDeviceId(original.deviceId))
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
        ).addMigrations(*NearbyTransferDatabase.ALL_MIGRATIONS)
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
    fun revokedPeerLosesPermissionsAndRequiresDeletionBeforePairingAgain() = runBlocking {
        val original = trustedPeer()
        repository.upsert(original)
        assertTrue(repository.setTrustStatus("peer-1", TrustStatus.REVOKED))
        assertFalse(repository.setTrustStatus("peer-1", TrustStatus.REVOKED))
        assertFalse(repository.setTrustStatus("missing-peer", TrustStatus.REVOKED))

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
            runBlocking { repository.upsert(original.copy(updatedAtEpochMillis = 100L)) }
        }
        assertEquals(revoked, repository.findByDeviceId("peer-1"))

        repository.delete("peer-1")
        val repaired = original.copy(pairedAtEpochMillis = 101L, updatedAtEpochMillis = 101L)
        repository.upsert(repaired)
        assertEquals(repaired, repository.findByDeviceId("peer-1"))
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
        deviceId: String = "peer-1",
        displayName: String = "Alice phone",
        updatedAtEpochMillis: Long = 10L,
        signingPublicKey: String = "ed25519-public-key",
        encryptionPublicKey: String = "x25519-public-key",
    ) = TrustedPeer(
        deviceId = deviceId,
        displayName = displayName,
        fingerprint = "ed25519:example",
        signingPublicKey = signingPublicKey,
        encryptionPublicKey = encryptionPublicKey,
        permissions = setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
        trustStatus = TrustStatus.TRUSTED,
        pairedAtEpochMillis = 10L,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )
}
