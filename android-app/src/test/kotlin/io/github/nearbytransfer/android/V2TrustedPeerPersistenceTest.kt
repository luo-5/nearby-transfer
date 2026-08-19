package io.github.nearbytransfer.android

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.model.TrustStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.lang.reflect.Modifier
import java.security.KeyPair

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2TrustedPeerPersistenceTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before
    fun setUp() {
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
    }

    @After
    fun cleanUp() {
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
    }

    @Test
    fun storesOnlyVerifiedPublicPeerIdentityWithTransferPermission() {
        val identity = createIdentity("Trusted phone")
        val pairedAt = 1_725_000_123_456L

        val summary = onBackground {
            V2TrustedPeerPersistence.persistCompletedPairing(context, identity, pairedAt)
        }
        val stored = readStoredPeer(identity.deviceId)

        assertEquals(identity.deviceId, summary.deviceId)
        assertEquals(identity.fingerprint, summary.fingerprint)
        assertEquals(TrustStatus.TRUSTED, summary.trustStatus)
        assertTrue(summary.canTransfer)
        assertEquals(identity.deviceName, stored.displayName)
        assertEquals(identity.signingPublicKey, stored.signingPublicKey)
        assertEquals(identity.encryptionPublicKey, stored.encryptionPublicKey)
        assertEquals("TRANSFER", stored.encodedPermissions)
        assertEquals(TrustStatus.TRUSTED.name, stored.trustStatus)
        assertEquals(pairedAt, stored.pairedAtEpochMillis)
        assertEquals(pairedAt, stored.updatedAtEpochMillis)
    }

    @Test
    fun javaCallableListFindAndRevokeUseRoomAndExposeNoPublicKeys() {
        val zulu = createIdentity("Zulu phone")
        val alpha = createIdentity("Alpha tablet")
        onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, zulu, 10L) }
        onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, alpha, 20L) }

        val summaries = onBackground { V2TrustedPeerPersistence.listTrustedPeers(context) }
        assertEquals(listOf("Alpha tablet", "Zulu phone"), summaries.map { it.displayName })
        assertEquals(alpha.deviceId, onBackground {
            V2TrustedPeerPersistence.findTrustedPeer(context, alpha.deviceId)
        }?.deviceId)
        assertNull(onBackground { V2TrustedPeerPersistence.findTrustedPeer(context, "missing-peer") })

        assertTrue(onBackground {
            V2TrustedPeerPersistence.revokeTrustedPeer(context, alpha.deviceId, 99L)
        })
        assertFalse(onBackground {
            V2TrustedPeerPersistence.revokeTrustedPeer(context, alpha.deviceId, 100L)
        })
        assertFalse(onBackground {
            V2TrustedPeerPersistence.revokeTrustedPeer(context, "missing-peer", 100L)
        })
        val revoked = onBackground {
            V2TrustedPeerPersistence.findTrustedPeer(context, alpha.deviceId)
        }
        assertNotNull(revoked)
        requireNotNull(revoked)
        assertEquals(TrustStatus.REVOKED, revoked.trustStatus)
        assertFalse(revoked.canTransfer)
        assertEquals(99L, revoked.updatedAtEpochMillis)

        val publicFieldNames = V2TrustedPeerPersistence.TrustedPeerSummary::class.java.declaredFields
            .map { it.name.lowercase() }
        assertTrue(publicFieldNames.none { it.contains("signing") || it.contains("encryption") || it.contains("publickey") })
        assertFalse(revoked.toString().contains(alpha.signingPublicKey))
        assertFalse(revoked.toString().contains(alpha.encryptionPublicKey))

        val persistenceClass = V2TrustedPeerPersistence::class.java
        val staticMethods = persistenceClass.methods
            .filter { Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .toSet()
        assertTrue(staticMethods.contains("listTrustedPeers"))
        assertTrue(staticMethods.contains("findTrustedPeer"))
        assertTrue(staticMethods.contains("revokeTrustedPeer"))
        assertEquals(
            List::class.java,
            persistenceClass.getMethod("listTrustedPeers", Context::class.java).returnType,
        )
        assertEquals(
            V2TrustedPeerPersistence.TrustedPeerSummary::class.java,
            persistenceClass.getMethod("findTrustedPeer", Context::class.java, String::class.java).returnType,
        )
        assertEquals(
            java.lang.Boolean.TYPE,
            persistenceClass.getMethod("revokeTrustedPeer", Context::class.java, String::class.java).returnType,
        )
        assertEquals(
            java.lang.Boolean.TYPE,
            persistenceClass.getMethod(
                "revokeTrustedPeer",
                Context::class.java,
                String::class.java,
                java.lang.Long.TYPE,
            ).returnType,
        )
        val publicSummaryMethodNames = V2TrustedPeerPersistence.TrustedPeerSummary::class.java.methods
            .map { it.name.lowercase() }
        assertTrue(
            publicSummaryMethodNames.none {
                it.contains("signing") || it.contains("encryption") || it.contains("publickey")
            },
        )
    }

    @Test
    fun completedPairingRejectsIdentityChangesAndPreservesOriginalRecord() {
        val original = createIdentity("Original phone")
        onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, original, 10L) }
        val originalStored = readStoredPeer(original.deviceId)

        val replacementEncryption = CryptoUtil.toPublicPem(CryptoUtil.generateX25519KeyPair().public)
        val changedEncryption = V2Identity.create(
            original.deviceId,
            "Changed encryption",
            original.fingerprint,
            original.signingPublicKey,
            replacementEncryption,
        )
        val other = createIdentity("Other identity")
        val changedSigning = rawIdentity(
            original.deviceId,
            "Changed signing",
            original.fingerprint,
            other.signingPublicKey,
            original.encryptionPublicKey,
        )
        val changedFingerprint = rawIdentity(
            original.deviceId,
            "Changed fingerprint",
            other.fingerprint,
            original.signingPublicKey,
            original.encryptionPublicKey,
        )

        listOf(changedEncryption, changedSigning, changedFingerprint).forEachIndexed { index, changed ->
            assertThrows(IllegalArgumentException::class.java) {
                onBackground {
                    V2TrustedPeerPersistence.persistCompletedPairing(context, changed, 20L + index)
                }
            }
            assertEquals(originalStored, readStoredPeer(original.deviceId))
        }
    }

    @Test
    fun revokedPeerCannotBePairedAgainWithoutDeletion() {
        val identity = createIdentity("Revoked phone")
        onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, identity, 10L) }
        assertTrue(onBackground {
            V2TrustedPeerPersistence.revokeTrustedPeer(context, identity.deviceId, 20L)
        })

        assertThrows(IllegalStateException::class.java) {
            onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, identity, 30L) }
        }
        val summary = onBackground {
            V2TrustedPeerPersistence.findTrustedPeer(context, identity.deviceId)
        }
        assertNotNull(summary)
        requireNotNull(summary)
        assertEquals(TrustStatus.REVOKED, summary.trustStatus)
        assertEquals(10L, summary.pairedAtEpochMillis)
        assertEquals(20L, summary.updatedAtEpochMillis)
    }

    @Test
    fun rejectsCallsFromAndroidMainThread() {
        val identity = createIdentity("Main-thread phone")
        assertThrows(IllegalStateException::class.java) {
            V2TrustedPeerPersistence.persistCompletedPairing(context, identity, 10L)
        }
        assertThrows(IllegalStateException::class.java) {
            V2TrustedPeerPersistence.listTrustedPeers(context)
        }
        assertThrows(IllegalStateException::class.java) {
            V2TrustedPeerPersistence.findTrustedPeer(context, identity.deviceId)
        }
        assertThrows(IllegalStateException::class.java) {
            V2TrustedPeerPersistence.revokeTrustedPeer(context, identity.deviceId, 11L)
        }
    }

    @Test
    fun eachJavaBoundaryOperationClosesItsRoomConnection() {
        val identity = createIdentity("Close-check phone")
        onBackground { V2TrustedPeerPersistence.persistCompletedPairing(context, identity, 10L) }
        repeat(3) {
            onBackground { V2TrustedPeerPersistence.listTrustedPeers(context) }
            onBackground { V2TrustedPeerPersistence.findTrustedPeer(context, identity.deviceId) }
        }
        onBackground { V2TrustedPeerPersistence.revokeTrustedPeer(context, identity.deviceId, 20L) }

        assertTrue(context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME))
    }

    private fun readStoredPeer(deviceId: String) = runBlocking(Dispatchers.IO) {
        val database = Room.databaseBuilder(
            context,
            NearbyTransferDatabase::class.java,
            NearbyTransferDatabase.DATABASE_NAME,
        ).addMigrations(*NearbyTransferDatabase.ALL_MIGRATIONS).build()
        try {
            requireNotNull(database.trustedPeerDao().findByDeviceId(deviceId))
        } finally {
            database.close()
        }
    }

    private fun <T> onBackground(block: () -> T): T = runBlocking {
        withContext(Dispatchers.Default) { block() }
    }

    private fun createIdentity(name: String): V2Identity {
        val signing: KeyPair = CryptoUtil.generateEd25519KeyPair()
        val encryption: KeyPair = CryptoUtil.generateX25519KeyPair()
        val signingPublicKey = CryptoUtil.toPublicPem(signing.public)
        val identity = V2Identity.create(
            CryptoUtil.deviceIdFor(signingPublicKey),
            name,
            CryptoUtil.fingerprintFor(signingPublicKey),
            signingPublicKey,
            CryptoUtil.toPublicPem(encryption.public),
        )
        assertTrue(identity.deviceId.isNotBlank())
        return identity
    }

    private fun rawIdentity(
        deviceId: String,
        deviceName: String,
        fingerprint: String,
        signingPublicKey: String,
        encryptionPublicKey: String,
    ): V2Identity {
        val constructor = V2Identity::class.java.getDeclaredConstructor(
            String::class.java,
            String::class.java,
            String::class.java,
            String::class.java,
            String::class.java,
        )
        constructor.isAccessible = true
        return constructor.newInstance(
            deviceId,
            deviceName,
            fingerprint,
            signingPublicKey,
            encryptionPublicKey,
        )
    }
}
