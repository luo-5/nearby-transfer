package io.github.nearbytransfer.android.core.data.local

import android.database.sqlite.SQLiteConstraintException
import androidx.room.Room
import androidx.room.migration.AutoMigrationSpec
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.runBlocking
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NearbyTransferDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        NearbyTransferDatabase::class.java,
        emptyList<AutoMigrationSpec>(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    @Test
    fun migrationThreeToFourPreservesJobsAndAssignsSafePublicationStates() {
        helper.createDatabase(TEST_DATABASE, 3).use { database ->
            insertV3Job(database, "outgoing", "OUTGOING", "COMPLETED", 10, 10, false)
            insertV3Job(database, "incoming-complete", "INCOMING", "COMPLETED", 10, 10, false)
            insertV3Job(database, "incoming-partial", "INCOMING", "TRANSFERRING", 10, 4, false)
            insertV3Job(database, "incoming-empty", "INCOMING", "PAUSED", 10, 0, true)
            insertV3Job(database, "incoming-cancelled", "INCOMING", "CANCELLED", 10, 4, false)
        }

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            4,
            true,
            NearbyTransferDatabase.MIGRATION_3_4,
        ).use { database ->
            assertJobPublication(database, "outgoing", "NONE", false)
            assertJobPublication(database, "incoming-complete", "LEGACY_UNVERIFIED", false)
            assertJobPublication(database, "incoming-partial", "RECONCILE_REQUIRED", true)
            assertJobPublication(database, "incoming-empty", "NONE", true)
            assertJobPublication(database, "incoming-cancelled", "NONE", false)

            database.query(
                "SELECT checkpoint_json, publication_id, publication_backend, publication_root_token, " +
                    "publication_error, publication_cancel_requested, cleanup_pending, revision " +
                    "FROM transfer_jobs WHERE task_id = ?",
                arrayOf("incoming-partial"),
            ).use { cursor ->
                cursor.moveToFirst()
                assertNull(cursor.getString(0))
                assertNull(cursor.getString(1))
                assertNull(cursor.getString(2))
                assertNull(cursor.getString(3))
                assertNull(cursor.getString(4))
                assertEquals(0, cursor.getInt(5))
                assertEquals(0, cursor.getInt(6))
                assertEquals(0L, cursor.getLong(7))
            }
        }
    }

    @Test
    fun migratedReceiptTableEnforcesCascadeAndUniqueObjectUris() {
        helper.createDatabase(TEST_DATABASE, 3).use { database ->
            insertV3Job(database, "parent-a", "INCOMING", "TRANSFERRING", 10, 10, true)
            insertV3Job(database, "parent-b", "INCOMING", "TRANSFERRING", 10, 10, true)
        }

        helper.runMigrationsAndValidate(
            TEST_DATABASE,
            4,
            true,
            NearbyTransferDatabase.MIGRATION_3_4,
        ).use { database ->
            database.execSQL("PRAGMA foreign_keys = ON")
            insertReceipt(database, "parent-a", 0, "publication-a", "content://provider/object/1")

            assertThrows(SQLiteConstraintException::class.java) {
                insertReceipt(database, "parent-b", 0, "publication-b", "content://provider/object/1")
            }

            database.execSQL("DELETE FROM transfer_jobs WHERE task_id = ?", arrayOf("parent-a"))
            database.query(
                "SELECT COUNT(*) FROM transfer_publication_files WHERE task_id = ?",
                arrayOf("parent-a"),
            ).use { cursor ->
                cursor.moveToFirst()
                assertEquals(0, cursor.getInt(0))
            }

            database.execSQL(
                "UPDATE transfer_jobs SET publication_id = ? WHERE task_id = ?",
                arrayOf("shared-publication", "parent-b"),
            )
            insertV3CompatibleV4Job(database, "parent-c")
            assertThrows(SQLiteConstraintException::class.java) {
                database.execSQL(
                    "UPDATE transfer_jobs SET publication_id = ? WHERE task_id = ?",
                    arrayOf("shared-publication", "parent-c"),
                )
            }
        }
    }

    @Test
    fun revisionCasAndQuarantineScrubPublicationCapabilitiesAndReceipts() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        try {
            val jobs = database.transferJobDao()
            val receipts = database.transferPublicationDao()
            jobs.insert(
                TransferJobEntity(
                    taskId = "quarantine-task",
                    peerId = "0123456789abcdef",
                    direction = "INCOMING",
                    state = "TRANSFERRING",
                    manifestJson = "{}",
                    totalBytes = 10,
                    transferredBytes = 10,
                    createdAtEpochMillis = 1,
                    updatedAtEpochMillis = 1,
                    recoverable = true,
                    failureReason = null,
                    checkpointJson = "{\"nextSequence\":1}",
                    publicationState = "PUBLISHING",
                    publicationId = "publication-id",
                    publicationBackend = "SAF_TREE",
                    publicationRootToken = "content://provider/tree/root",
                    publicationCancelRequested = true,
                    cleanupPending = true,
                ),
            )
            receipts.insert(
                TransferPublicationFileEntity(
                    taskId = "quarantine-task",
                    fileIndex = 0,
                    publicationId = "publication-id",
                    state = "ALLOCATED",
                    targetToken = "target",
                    temporaryMarker = "marker",
                    requestedName = "file.bin",
                    actualName = "file.bin",
                    objectUri = "content://provider/object/quarantine",
                    expectedSize = 10,
                    expectedSha256 = "00".repeat(32),
                    observedSize = null,
                    observedSha256 = null,
                    updatedAtEpochMillis = 1,
                    revision = 0,
                    failureReason = null,
                ),
            )

            assertEquals(
                1,
                jobs.updateStateByRevision(
                    taskId = "quarantine-task",
                    expectedState = "TRANSFERRING",
                    expectedRevision = 0,
                    newState = "PAUSED",
                    recoverable = true,
                    failureReason = null,
                    updatedAtEpochMillis = 1,
                ),
            )
            assertEquals(
                0,
                jobs.updateStateByRevision(
                    taskId = "quarantine-task",
                    expectedState = "PAUSED",
                    expectedRevision = 0,
                    newState = "QUEUED",
                    recoverable = true,
                    failureReason = null,
                    updatedAtEpochMillis = 1,
                ),
            )

            assertEquals(1, jobs.quarantine("quarantine-task", "invalid record", 2))
            val quarantined = requireNotNull(jobs.findRaw("quarantine-task"))
            assertEquals("QUARANTINED", quarantined.state)
            assertEquals("{}", quarantined.manifestJson)
            assertNull(quarantined.checkpointJson)
            assertEquals("NONE", quarantined.publicationState)
            assertNull(quarantined.publicationId)
            assertNull(quarantined.publicationBackend)
            assertNull(quarantined.publicationRootToken)
            assertEquals("invalid record", quarantined.publicationError)
            assertEquals(false, quarantined.publicationCancelRequested)
            assertEquals(false, quarantined.cleanupPending)
            assertEquals(2L, quarantined.revision)
            assertEquals(0, receipts.countForTask("quarantine-task"))
        } finally {
            database.close()
        }
    }

    private fun insertV3Job(
        database: SupportSQLiteDatabase,
        taskId: String,
        direction: String,
        state: String,
        totalBytes: Long,
        transferredBytes: Long,
        recoverable: Boolean,
    ) {
        database.execSQL(
            "INSERT INTO transfer_jobs (task_id, peer_id, direction, state, manifest_json, total_bytes, " +
                "transferred_bytes, created_at_epoch_millis, updated_at_epoch_millis, recoverable, failure_reason) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
            arrayOf(
                taskId,
                "0123456789abcdef",
                direction,
                state,
                "{}",
                totalBytes,
                transferredBytes,
                1L,
                1L,
                if (recoverable) 1 else 0,
            ),
        )
    }

    private fun insertV3CompatibleV4Job(database: SupportSQLiteDatabase, taskId: String) {
        database.execSQL(
            "INSERT INTO transfer_jobs (task_id, peer_id, direction, state, manifest_json, total_bytes, " +
                "transferred_bytes, created_at_epoch_millis, updated_at_epoch_millis, recoverable, failure_reason) " +
                "VALUES (?, '0123456789abcdef', 'INCOMING', 'TRANSFERRING', '{}', 0, 0, 1, 1, 1, NULL)",
            arrayOf(taskId),
        )
    }

    private fun assertJobPublication(
        database: SupportSQLiteDatabase,
        taskId: String,
        expectedPublicationState: String,
        expectedRecoverable: Boolean,
    ) {
        database.query(
            "SELECT publication_state, recoverable FROM transfer_jobs WHERE task_id = ?",
            arrayOf(taskId),
        ).use { cursor ->
            cursor.moveToFirst()
            assertEquals(expectedPublicationState, cursor.getString(0))
            assertEquals(if (expectedRecoverable) 1 else 0, cursor.getInt(1))
        }
    }

    private fun insertReceipt(
        database: SupportSQLiteDatabase,
        taskId: String,
        fileIndex: Int,
        publicationId: String,
        objectUri: String,
    ) {
        database.execSQL(
            "INSERT INTO transfer_publication_files (task_id, file_index, publication_id, state, " +
                "target_token, temporary_marker, requested_name, actual_name, object_uri, expected_size, " +
                "expected_sha256, observed_size, observed_sha256, updated_at_epoch_millis, revision, failure_reason) " +
                "VALUES (?, ?, ?, 'ALLOCATED', 'root', 'marker', 'file.bin', 'file.bin', ?, 10, ?, NULL, NULL, 1, 0, NULL)",
            arrayOf(taskId, fileIndex, publicationId, objectUri, "00".repeat(32)),
        )
    }

    companion object {
        private const val TEST_DATABASE = "publication-migration-test"
    }
}
