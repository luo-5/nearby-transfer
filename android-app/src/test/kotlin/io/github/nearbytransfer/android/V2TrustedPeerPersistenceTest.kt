package io.github.nearbytransfer.android

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.model.PeerPermission
import io.github.nearbytransfer.android.core.model.TrustStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyPair

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2TrustedPeerPersistenceTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @After
    fun cleanUp() {
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
    }

    @Test
    fun storesOnlyVerifiedPublicPeerIdentityWithTransferPermission() = runBlocking {
        context.deleteDatabase(NearbyTransferDatabase.DATABASE_NAME)
        val identity = createIdentity("Trusted phone")
        val pairedAt = 1_725_000_123_456L

        val summary = withContext(Dispatchers.Default) {
            V2TrustedPeerPersistence.persistCompletedPairing(context, identity, pairedAt)
        }
        val database = Room.databaseBuilder(
            context,
            NearbyTransferDatabase::class.java,
            NearbyTransferDatabase.DATABASE_NAME,
        ).addMigrations(NearbyTransferDatabase.MIGRATION_1_2).build()
        try {
            val stored = withContext(Dispatchers.IO) {
                database.trustedPeerDao().findByDeviceId(identity.deviceId)
            }
            requireNotNull(stored)
            assertEquals(identity.deviceId, summary.deviceId)
            assertEquals(identity.fingerprint, summary.fingerprint)
            assertEquals(identity.deviceName, stored.displayName)
            assertEquals(identity.signingPublicKey, stored.signingPublicKey)
            assertEquals(identity.encryptionPublicKey, stored.encryptionPublicKey)
            assertEquals("TRANSFER", stored.encodedPermissions)
            assertEquals(TrustStatus.TRUSTED.name, stored.trustStatus)
            assertEquals(pairedAt, stored.pairedAtEpochMillis)
            assertEquals(pairedAt, stored.updatedAtEpochMillis)
        } finally {
            database.close()
        }
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
}
