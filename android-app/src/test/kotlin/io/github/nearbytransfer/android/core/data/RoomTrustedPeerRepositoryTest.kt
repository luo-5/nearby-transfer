package io.github.nearbytransfer.android.core.data

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

    private fun trustedPeer(updatedAtEpochMillis: Long = 10L) = TrustedPeer(
        deviceId = "peer-1",
        displayName = "Alice phone",
        fingerprint = "ed25519:example",
        permissions = setOf(PeerPermission.TRANSFER, PeerPermission.LIBRARY_READ),
        trustStatus = TrustStatus.TRUSTED,
        pairedAtEpochMillis = 10L,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )
}