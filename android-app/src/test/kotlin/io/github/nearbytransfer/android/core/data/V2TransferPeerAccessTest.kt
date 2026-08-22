package io.github.nearbytransfer.android.core.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.lang.reflect.Modifier

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2TransferPeerAccessTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before
    fun setUp() {
        NearbyTransferDatabase.resetInstance()
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
    }

    @After
    fun tearDown() {
        NearbyTransferDatabase.resetInstance()
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
    }

    @Test
    fun returnsOnlyTransportIdentityForAuthorizedPeer() {
        val peer = peer()
        store(peer)

        val authorized = requireNotNull(onBackground {
            V2TransferPeerAccess.findAuthorizedPeer(context, peer.deviceId)
        })

        assertEquals(peer.deviceId, authorized.deviceId)
        assertEquals(peer.signingPublicKey, authorized.signingPublicKey)
        assertEquals(peer.encryptionPublicKey, authorized.encryptionPublicKey)
        assertEquals(
            setOf("deviceId", "signingPublicKey", "encryptionPublicKey"),
            V2TransferPeerAccess.AuthorizedPeer::class.java.declaredFields
                .filterNot { it.isSynthetic || Modifier.isStatic(it.modifiers) }
                .mapTo(linkedSetOf()) { it.name },
        )
    }

    @Test
    fun returnsNullForRevokedMissingAndPermissionDeniedPeers() {
        val revoked = peer(
            deviceId = "0000000000000001",
            trustStatus = TrustStatus.REVOKED,
            permissions = emptySet(),
        )
        val permissionDenied = peer(
            deviceId = "0000000000000002",
            permissions = setOf(PeerPermission.LIBRARY_READ),
        )
        store(revoked)
        store(permissionDenied)

        assertNull(onBackground {
            V2TransferPeerAccess.findAuthorizedPeer(context, revoked.deviceId)
        })
        assertNull(onBackground {
            V2TransferPeerAccess.findAuthorizedPeer(context, permissionDenied.deviceId)
        })
        assertNull(onBackground {
            V2TransferPeerAccess.findAuthorizedPeer(context, "0000000000000003")
        })
    }

    @Test
    fun rejectsNonCanonicalDeviceIdsBeforeOpeningRoom() {
        listOf(
            "",
            "0123456789abcde",
            "0123456789abcdef0",
            "0123456789abcdeF",
            "0123456789abcdeg",
            " 0123456789abcdef",
        ).forEach { malformed ->
            assertThrows(IllegalArgumentException::class.java) {
                onBackground {
                    V2TransferPeerAccess.findAuthorizedPeer(context, malformed)
                }
            }
        }
        assertTrue(context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME).not())
    }

    @Test
    fun rejectsMainThreadAccess() {
        assertThrows(IllegalStateException::class.java) {
            V2TransferPeerAccess.findAuthorizedPeer(context, "0123456789abcdef")
        }
    }

    @Test
    fun reusesSingletonDatabaseAcrossLookups() {
        val peer = peer()
        store(peer)

        repeat(3) {
            requireNotNull(onBackground {
                V2TransferPeerAccess.findAuthorizedPeer(context, peer.deviceId)
            })
        }
        assertTrue(NearbyTransferDatabase.getInstance(context).isOpen)
    }

    private fun store(peer: TrustedPeer) = runBlocking(Dispatchers.IO) {
        val database = NearbyTransferDatabase.build(context)
        try {
            RoomTrustedPeerRepository(database.trustedPeerDao()).upsert(peer)
        } finally {
            database.close()
        }
    }

    private fun <T> onBackground(block: () -> T): T = runBlocking {
        withContext(Dispatchers.Default) { block() }
    }

    private fun peer(
        deviceId: String = "0123456789abcdef",
        permissions: Set<PeerPermission> = setOf(PeerPermission.TRANSFER),
        trustStatus: TrustStatus = TrustStatus.TRUSTED,
    ) = TrustedPeer(
        deviceId = deviceId,
        displayName = "Authorized peer",
        fingerprint = "ed25519:test",
        signingPublicKey = "ed25519-public-key",
        encryptionPublicKey = "x25519-public-key",
        permissions = permissions,
        trustStatus = trustStatus,
        pairedAtEpochMillis = 10L,
        updatedAtEpochMillis = 10L,
    )
}
