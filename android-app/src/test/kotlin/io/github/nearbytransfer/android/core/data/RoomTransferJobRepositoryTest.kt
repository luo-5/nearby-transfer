package io.github.nearbytransfer.android.core.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
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
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomTransferJobRepositoryTest {
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTransferJobRepository

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = RoomTransferJobRepository(database)
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun createsCanonicalPublicJobsAndEnforcesStateAndProgressInvariants() = runBlocking {
        val taskId = taskId(1)
        val created = repository.createOutgoing(
            taskId = taskId,
            peerId = "0123456789abcdef",
            manifestJson = manifest(taskId, 10),
            recoverable = true,
            nowEpochMillis = 1,
        )
        assertEquals(TransferJobState.QUEUED, created.state)
        assertEquals(0L, created.transferredBytes)
        assertFalse(created.manifestJson.contains("sessionKey"))

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.transition(taskId, TransferJobState.COMPLETED, 2) }
        }
        val active = requireNotNull(repository.transition(taskId, TransferJobState.TRANSFERRING, 2))
        assertEquals(TransferJobState.TRANSFERRING, active.state)
        assertEquals(5L, repository.updateProgress(taskId, 5, 3)?.transferredBytes)
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.updateProgress(taskId, 4, 4) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.updateProgress(taskId, 11, 4) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.transition(taskId, TransferJobState.COMPLETED, 4) }
        }

        repository.updateProgress(taskId, 10, 5)
        val completed = requireNotNull(repository.transition(taskId, TransferJobState.COMPLETED, 6))
        assertEquals(TransferJobState.COMPLETED, completed.state)
        assertFalse(completed.recoverable)
        assertNull(completed.failureReason)
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.transition(taskId, TransferJobState.QUEUED, 7) }
        }
        Unit
    }

    @Test
    fun failedJobsRequireBoundedReasonAndCanBeRecoveredToQueue() = runBlocking {
        val taskId = taskId(2)
        repository.createOutgoing(taskId, "0123456789abcdef", manifest(taskId, 10), true, 10)
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.transition(taskId, TransferJobState.FAILED, 11) }
        }
        val failed = requireNotNull(
            repository.transition(taskId, TransferJobState.FAILED, 11, "network interrupted", true),
        )
        assertEquals("network interrupted", failed.failureReason)
        assertTrue(failed.recoverable)
        val queued = requireNotNull(repository.transition(taskId, TransferJobState.QUEUED, 12))
        assertNull(queued.failureReason)
        assertEquals(TransferJobState.QUEUED, queued.state)
    }

    @Test
    fun concurrentProgressUpdatesRemainAtomicAndNeverRegress() = runBlocking {
        val taskId = taskId(3)
        repository.createOutgoing(taskId, "0123456789abcdef", manifest(taskId, 100), true, 10)
        repository.transition(taskId, TransferJobState.TRANSFERRING, 11)

        listOf(40L, 80L).map { progress ->
            async {
                runCatching { repository.updateProgress(taskId, progress, 20) }
            }
        }.awaitAll()

        val stored = requireNotNull(repository.find(taskId))
        assertEquals(80L, stored.transferredBytes)
        assertEquals(20L, stored.updatedAtEpochMillis)
    }

    @Test
    fun unfinishedJobsLoadAfterDatabaseRestart() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "transfer-restart-${System.nanoTime()}.db"
        val first = Room.databaseBuilder(context, NearbyTransferDatabase::class.java, name)
            .addMigrations(*NearbyTransferDatabase.ALL_MIGRATIONS)
            .allowMainThreadQueries()
            .build()
        val taskId = taskId(4)
        try {
            val firstRepository = RoomTransferJobRepository(first)
            firstRepository.createIncoming(taskId, "0123456789abcdef", manifest(taskId, 10), true, 10)
        } finally {
            first.close()
        }

        val reopened = Room.databaseBuilder(context, NearbyTransferDatabase::class.java, name)
            .addMigrations(*NearbyTransferDatabase.ALL_MIGRATIONS)
            .allowMainThreadQueries()
            .build()
        try {
            val unfinished = RoomTransferJobRepository(reopened).loadUnfinished()
            assertEquals(1, unfinished.size)
            assertEquals(taskId, unfinished.single().taskId)
            assertEquals(TransferJobState.AWAITING_APPROVAL, unfinished.single().state)
            assertTrue(unfinished.single().recoverable)
        } finally {
            reopened.close()
            context.deleteDatabase(name)
        }
    }

    @Test
    fun corruptRowsAreScrubbedAndQuarantinedWithoutCrashingLists() = runBlocking {
        val taskId = taskId(5)
        database.openHelper.writableDatabase.execSQL(
            "INSERT INTO transfer_jobs (task_id, peer_id, direction, state, manifest_json, total_bytes, " +
                "transferred_bytes, created_at_epoch_millis, updated_at_epoch_millis, recoverable, failure_reason) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            arrayOf(
                taskId,
                "0123456789abcdef",
                "OUTGOING",
                "TRANSFERRING",
                "{\"sessionKey\":\"must-be-scrubbed\"}",
                10L,
                20L,
                1L,
                1L,
                1,
                null,
            ),
        )

        assertTrue(repository.listAll().isEmpty())
        assertNull(repository.find(taskId))
        val quarantined = requireNotNull(database.transferJobDao().findRaw(taskId))
        assertEquals("QUARANTINED", quarantined.state)
        assertEquals("{}", quarantined.manifestJson)
        assertFalse(quarantined.recoverable)
        assertEquals("Stored transfer record is invalid.", quarantined.failureReason)
    }

    @Test
    fun migrationFromTwoToThreePreservesTrustedPeersAndCreatesTransferJobs() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "transfer-v2-${System.nanoTime()}.db"
        createVersionTwoDatabase(context, name)

        val migrated = Room.databaseBuilder(context, NearbyTransferDatabase::class.java, name)
            .addMigrations(NearbyTransferDatabase.MIGRATION_2_3)
            .allowMainThreadQueries()
            .build()
        try {
            assertNotNull(migrated.trustedPeerDao().findByDeviceId("legacy-peer"))
            val taskId = taskId(6)
            val created = RoomTransferJobRepository(migrated).createOutgoing(
                taskId,
                "0123456789abcdef",
                manifest(taskId, 0),
                false,
                10,
            )
            assertEquals(0L, created.totalBytes)
            assertNotNull(migrated.transferJobDao().findRaw(taskId))
        } finally {
            migrated.close()
            context.deleteDatabase(name)
        }
    }

    @Test
    fun rejectsInvalidIdentifiersManifestSecretsAndTimestamps() = runBlocking {
        val taskId = taskId(7)
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.createOutgoing("bad", "0123456789abcdef", manifest(taskId, 1), true, 1) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.createOutgoing(taskId, "BAD", manifest(taskId, 1), true, 1) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                repository.createOutgoing(
                    taskId,
                    "0123456789abcdef",
                    "{\"app\":\"nearby-transfer\",\"sessionKey\":\"secret\"}",
                    true,
                    1,
                )
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { repository.createOutgoing(taskId, "0123456789abcdef", manifest(taskId, 1), true, 0) }
        }
        Unit
    }

    private fun createVersionTwoDatabase(context: Context, name: String) {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        val legacy = SQLiteDatabase.openOrCreateDatabase(path, null)
        try {
            legacy.execSQL(
                "CREATE TABLE trusted_peers (" +
                    "device_id TEXT NOT NULL, display_name TEXT NOT NULL, fingerprint TEXT NOT NULL, " +
                    "signing_public_key TEXT NOT NULL, encryption_public_key TEXT NOT NULL, " +
                    "permissions TEXT NOT NULL, trust_status TEXT NOT NULL, " +
                    "paired_at_epoch_millis INTEGER NOT NULL, updated_at_epoch_millis INTEGER NOT NULL, " +
                    "PRIMARY KEY(device_id))",
            )
            legacy.execSQL(
                "INSERT INTO trusted_peers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf("legacy-peer", "Legacy", "fingerprint", "signing", "encryption", "TRANSFER", "TRUSTED", 1L, 1L),
            )
            legacy.version = 2
        } finally {
            legacy.close()
        }
    }

    private fun taskId(seed: Int): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(16) { seed.toByte() })

    private fun manifest(taskId: String, size: Long): String =
        "{\"type\":\"transfer-manifest\",\"totalFiles\":1,\"entries\":[{" +
            "\"sha256\":\"${"00".repeat(32)}\",\"size\":$size,\"path\":\"file.bin\",\"kind\":\"file\"}]," +
            "\"conflictStrategy\":\"auto-rename\",\"taskId\":\"$taskId\",\"protocolVersion\":2," +
            "\"totalBytes\":$size,\"app\":\"nearby-transfer\"}"
}
