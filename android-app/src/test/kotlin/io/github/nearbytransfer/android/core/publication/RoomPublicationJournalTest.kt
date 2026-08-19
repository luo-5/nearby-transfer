package io.github.nearbytransfer.android.core.publication

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.data.local.TransferJobEntity
import kotlinx.coroutines.Dispatchers
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
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomPublicationJournalTest {
    private lateinit var database: NearbyTransferDatabase
    private val time = AtomicLong(1_000L)

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun createAndRoundTripPersistCompletePlanAndNullableTokens() {
        insertCompleteIncomingJob(database)
        val journal = journal(database, rootToken = "content://tree/root")
        val initial = PublicationRecord(plan())

        assertTrue(journal.create(initial))
        assertFalse(journal.create(initial))

        val restored = requireNotNull(journal.load(PUBLICATION_ID))
        assertEquals(initial.plan, restored.plan)
        assertEquals(PublicationState.PREPARED, restored.state)
        assertEquals(1L, restored.revision)
        assertFalse(restored.cancelRequested)
        assertFalse(restored.cleanupPending)
        assertEquals(listOf(null, null), restored.files.map { it.targetToken })

        io {
            val job = requireNotNull(database.transferJobDao().findByPublicationId(PUBLICATION_ID))
            assertEquals("content://tree/root", job.publicationRootToken)
            assertFalse(job.publicationCancelRequested)
            val rows = database.transferPublicationDao().listForTask(TASK_ID)
            assertEquals(2, rows.size)
            assertTrue(rows.all { it.targetToken == null })
            assertTrue(rows.all { it.temporaryMarker == null })
        }
    }

    @Test
    fun globalCasRejectsContentionAndPersistsCancellation() {
        insertCompleteIncomingJob(database)
        val firstJournal = journal(database)
        val secondJournal = journal(database)
        assertTrue(firstJournal.create(PublicationRecord(plan())))

        val first = requireNotNull(firstJournal.load(PUBLICATION_ID))
        val competing = requireNotNull(secondJournal.load(PUBLICATION_ID))
        val publishing = first.copy(
            files = first.files.mapIndexed { index, file ->
                if (index == 0) {
                    file.copy(
                        state = PublicationFileState.WRITTEN,
                        targetToken = "object-0",
                        observedSize = file.spec.size,
                        observedSha256 = file.spec.sha256,
                    )
                } else {
                    file
                }
            },
            state = PublicationState.PUBLISHING,
            revision = first.revision + 1L,
        )
        assertTrue(firstJournal.compareAndSet(PUBLICATION_ID, first.revision, publishing))

        val stale = competing.copy(
            state = PublicationState.CANCEL_PENDING,
            cancelRequested = true,
            cleanupPending = true,
            revision = competing.revision + 1L,
        )
        assertFalse(secondJournal.compareAndSet(PUBLICATION_ID, competing.revision, stale))

        val latest = requireNotNull(secondJournal.load(PUBLICATION_ID))
        val cancelled = latest.copy(
            state = PublicationState.CANCEL_PENDING,
            cancelRequested = true,
            cleanupPending = true,
            revision = latest.revision + 1L,
        )
        assertTrue(secondJournal.compareAndSet(PUBLICATION_ID, latest.revision, cancelled))

        val restored = requireNotNull(firstJournal.load(PUBLICATION_ID))
        assertEquals(PublicationState.CANCEL_PENDING, restored.state)
        assertTrue(restored.cancelRequested)
        assertTrue(restored.cleanupPending)
        assertEquals("object-0", restored.files[0].targetToken)
        io {
            val job = requireNotNull(database.transferJobDao().findByPublicationId(PUBLICATION_ID))
            assertTrue(job.publicationCancelRequested)
            assertFalse(job.cleanupPending)
        }
    }

    @Test
    fun publishedSnapshotAtomicallyCreatesStagingCleanupObligation() {
        insertCompleteIncomingJob(database)
        val journal = journal(database)
        assertTrue(journal.create(PublicationRecord(plan())))
        val current = requireNotNull(journal.load(PUBLICATION_ID))
        val published = current.copy(
            files = current.files.map { file ->
                file.copy(
                    state = PublicationFileState.PUBLISHED,
                    targetToken = "object-${file.spec.index}",
                    observedSize = file.spec.size,
                    observedSha256 = file.spec.sha256,
                )
            },
            state = PublicationState.PUBLISHED,
            revision = current.revision + 1L,
        )

        assertTrue(journal.compareAndSet(PUBLICATION_ID, current.revision, published))
        val restored = requireNotNull(journal.load(PUBLICATION_ID))
        assertEquals(PublicationState.PUBLISHED, restored.state)
        assertFalse(restored.cleanupPending)
        io {
            val job = requireNotNull(database.transferJobDao().findByPublicationId(PUBLICATION_ID))
            assertTrue(job.cleanupPending)
        }
    }

    @Test
    fun createRejectsIncompleteOrMismatchedPlans() {
        insertCompleteIncomingJob(database, transferredBytes = TOTAL_BYTES - 1L)
        val journal = journal(database)
        assertThrows(IllegalArgumentException::class.java) {
            journal.create(PublicationRecord(plan()))
        }

        database.close()
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).build()
        insertCompleteIncomingJob(database)
        val mismatched = plan().copy(
            files = listOf(
                PublicationFileSpec(0, "b.bin", 4L, HASH_B),
                PublicationFileSpec(1, "a.bin", 3L, HASH_A),
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            journal(database).create(PublicationRecord(mismatched))
        }
    }

    @Test
    fun compareAndSetRejectsPlanMutationAndCrossPublicationWrites() {
        insertCompleteIncomingJob(database)
        val journal = journal(database)
        assertTrue(journal.create(PublicationRecord(plan())))
        val current = requireNotNull(journal.load(PUBLICATION_ID))
        val changedPlan = PublicationPlan(
            publicationId = PUBLICATION_ID,
            taskId = TASK_ID,
            backendId = "different-backend",
            files = current.plan.files,
        )
        val changedRecord = PublicationRecord(
            plan = changedPlan,
            files = current.files,
            state = current.state,
            revision = current.revision + 1L,
        )
        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet(PUBLICATION_ID, current.revision, changedRecord)
        }

        val crossPublication = current.copy(revision = current.revision + 1L)
        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet("another-publication", current.revision, crossPublication)
        }
    }

    @Test
    fun lateCancellationCanBeSupersededOnlyAfterEveryFileIsPublished() {
        insertCompleteIncomingJob(database)
        val journal = journal(database)
        assertTrue(journal.create(PublicationRecord(plan())))
        val initial = requireNotNull(journal.load(PUBLICATION_ID))
        val inFlight = initial.copy(
            files = listOf(
                initial.files[0].copy(
                    state = PublicationFileState.PUBLISHED,
                    targetToken = "object-0",
                    observedSize = initial.files[0].spec.size,
                    observedSha256 = initial.files[0].spec.sha256,
                ),
                initial.files[1].copy(
                    state = PublicationFileState.PUBLISHING,
                    targetToken = "object-1",
                    observedSize = initial.files[1].spec.size,
                    observedSha256 = initial.files[1].spec.sha256,
                ),
            ),
            state = PublicationState.PARTIAL,
            revision = initial.revision + 1L,
        )
        assertTrue(journal.compareAndSet(PUBLICATION_ID, initial.revision, inFlight))

        val cancelling = inFlight.copy(
            state = PublicationState.CANCEL_PENDING,
            cancelRequested = true,
            cleanupPending = true,
            revision = inFlight.revision + 1L,
        )
        assertTrue(journal.compareAndSet(PUBLICATION_ID, inFlight.revision, cancelling))

        val published = cancelling.copy(
            files = cancelling.files.map { file -> file.copy(state = PublicationFileState.PUBLISHED) },
            state = PublicationState.PUBLISHED,
            cancelRequested = false,
            cleanupPending = false,
            revision = cancelling.revision + 1L,
        )
        assertTrue(journal.compareAndSet(PUBLICATION_ID, cancelling.revision, published))
        val restored = requireNotNull(journal.load(PUBLICATION_ID))
        assertEquals(PublicationState.PUBLISHED, restored.state)
        assertFalse(restored.cancelRequested)
        io {
            assertTrue(requireNotNull(database.transferJobDao().findByPublicationId(PUBLICATION_ID)).cleanupPending)
        }
    }

    @Test
    fun idempotentCreateRejectsDifferentRootBackendAndPlanBindings() {
        insertCompleteIncomingJob(database)
        val original = journal(database, rootToken = "content://tree/original")
        assertTrue(original.create(PublicationRecord(plan())))
        assertFalse(original.create(PublicationRecord(plan())))

        assertThrows(IllegalArgumentException::class.java) {
            journal(database, rootToken = "content://tree/other").create(PublicationRecord(plan()))
        }
        assertThrows(IllegalArgumentException::class.java) {
            original.create(PublicationRecord(plan().copy(backendId = "other-backend")))
        }
    }

    @Test
    fun compareAndSetRejectsImpossibleAggregateAndMissingPublishedEvidence() {
        insertCompleteIncomingJob(database)
        val journal = journal(database)
        assertTrue(journal.create(PublicationRecord(plan())))
        val current = requireNotNull(journal.load(PUBLICATION_ID))

        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet(
                PUBLICATION_ID,
                current.revision,
                current.copy(state = PublicationState.PUBLISHED, revision = current.revision + 1L),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet(
                PUBLICATION_ID,
                current.revision,
                current.copy(
                    files = current.files.map { it.copy(state = PublicationFileState.ABORTED) },
                    state = PublicationState.CANCELLED,
                    revision = current.revision + 1L,
                ),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet(
                PUBLICATION_ID,
                current.revision,
                current.copy(
                    files = current.files.mapIndexed { index, file ->
                        if (index == 0) {
                            file.copy(
                                state = PublicationFileState.PUBLISHED,
                                observedSize = file.spec.size,
                                observedSha256 = file.spec.sha256,
                            )
                        } else {
                            file
                        }
                    },
                    state = PublicationState.PARTIAL,
                    revision = current.revision + 1L,
                ),
            )
        }
    }

    @Test
    fun compareAndSetRejectsTerminalPublicationRegression() {
        insertCompleteIncomingJob(database)
        val journal = journal(database)
        assertTrue(journal.create(PublicationRecord(plan())))
        val current = requireNotNull(journal.load(PUBLICATION_ID))
        val published = current.copy(
            files = current.files.map { file ->
                file.copy(
                    state = PublicationFileState.PUBLISHED,
                    targetToken = "object-${file.spec.index}",
                    observedSize = file.spec.size,
                    observedSha256 = file.spec.sha256,
                )
            },
            state = PublicationState.PUBLISHED,
            revision = current.revision + 1L,
        )
        assertTrue(journal.compareAndSet(PUBLICATION_ID, current.revision, published))

        val terminal = requireNotNull(journal.load(PUBLICATION_ID))
        val regressed = terminal.copy(
            files = terminal.files.mapIndexed { index, file ->
                if (index == 0) file.copy(state = PublicationFileState.WRITTEN) else file
            },
            state = PublicationState.PARTIAL,
            revision = terminal.revision + 1L,
        )
        assertThrows(IllegalArgumentException::class.java) {
            journal.compareAndSet(PUBLICATION_ID, terminal.revision, regressed)
        }
    }

    @Test
    fun restartRestoresPublishedAndPendingFileRecords() {
        database.close()
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.deleteDatabase(RESTART_DATABASE)
        var disk = Room.databaseBuilder(
            context,
            NearbyTransferDatabase::class.java,
            RESTART_DATABASE,
        ).build()
        try {
            insertCompleteIncomingJob(disk)
            var journal = journal(disk)
            assertTrue(journal.create(PublicationRecord(plan())))
            val current = requireNotNull(journal.load(PUBLICATION_ID))
            val durable = current.copy(
                files = listOf(
                    current.files[0].copy(
                        state = PublicationFileState.PUBLISHED,
                        targetToken = "published-0",
                        observedSize = 3L,
                        observedSha256 = HASH_A,
                    ),
                    current.files[1].copy(
                        state = PublicationFileState.ALLOCATING,
                        lastError = "retry allocation",
                    ),
                ),
                state = PublicationState.PARTIAL,
                revision = current.revision + 1L,
            )
            assertTrue(journal.compareAndSet(PUBLICATION_ID, current.revision, durable))
            disk.close()

            disk = Room.databaseBuilder(
                context,
                NearbyTransferDatabase::class.java,
                RESTART_DATABASE,
            ).build()
            journal = RoomPublicationJournal(disk, publicationRootToken = "ignored-on-load") { 9_000L }
            val restored = requireNotNull(journal.load(PUBLICATION_ID))
            assertEquals(PublicationState.PARTIAL, restored.state)
            assertEquals(PublicationFileState.PUBLISHED, restored.files[0].state)
            assertEquals("published-0", restored.files[0].targetToken)
            assertEquals(PublicationFileState.ALLOCATING, restored.files[1].state)
            assertEquals("retry allocation", restored.files[1].lastError)
            io {
                assertNull(databaseOr(disk).transferJobDao().findByPublicationId("missing"))
            }
        } finally {
            disk.close()
            context.deleteDatabase(RESTART_DATABASE)
            database = Room.inMemoryDatabaseBuilder(context, NearbyTransferDatabase::class.java).build()
        }
    }

    private fun journal(
        target: NearbyTransferDatabase,
        rootToken: String = "content://test/root",
    ): RoomPublicationJournal = RoomPublicationJournal(target, rootToken) { time.getAndIncrement() }

    private fun insertCompleteIncomingJob(
        target: NearbyTransferDatabase,
        transferredBytes: Long = TOTAL_BYTES,
    ) = io {
        target.transferJobDao().insert(
            TransferJobEntity(
                taskId = TASK_ID,
                peerId = "0123456789abcdef",
                direction = "INCOMING",
                state = "TRANSFERRING",
                manifestJson = manifestJson(),
                totalBytes = TOTAL_BYTES,
                transferredBytes = transferredBytes,
                createdAtEpochMillis = 1L,
                updatedAtEpochMillis = 1L,
                recoverable = true,
                failureReason = null,
            ),
        )
    }

    private fun plan(): PublicationPlan = PublicationPlan(
        publicationId = PUBLICATION_ID,
        taskId = TASK_ID,
        backendId = "test-backend",
        files = listOf(
            PublicationFileSpec(0, "a.bin", 3L, HASH_A),
            PublicationFileSpec(1, "b.bin", 4L, HASH_B),
        ),
    )

    private fun manifestJson(): String =
        """{"app":"nearby-transfer","protocolVersion":2,"type":"transfer-manifest","taskId":"$TASK_ID","conflictStrategy":"auto-rename","entries":[{"kind":"file","path":"a.bin","size":3,"sha256":"$HASH_A"},{"kind":"file","path":"b.bin","size":4,"sha256":"$HASH_B"}],"totalFiles":2,"totalBytes":7}"""

    private fun <T> io(block: suspend () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private fun databaseOr(value: NearbyTransferDatabase): NearbyTransferDatabase = value

    private companion object {
        const val TASK_ID = "AQIDBAUGBwgJCgsMDQ4PEA"
        const val PUBLICATION_ID = "publication-1"
        const val TOTAL_BYTES = 7L
        const val HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const val RESTART_DATABASE = "room-publication-journal-restart"
    }
}
