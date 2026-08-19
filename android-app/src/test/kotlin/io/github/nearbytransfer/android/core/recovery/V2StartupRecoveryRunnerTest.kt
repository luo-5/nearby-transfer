package io.github.nearbytransfer.android.core.recovery

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.github.nearbytransfer.android.V2StagingLayout
import io.github.nearbytransfer.android.core.data.PublicationBackend
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJob
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.publication.BackendInspection
import io.github.nearbytransfer.android.core.publication.BackendObjectState
import io.github.nearbytransfer.android.core.publication.MediaStorePublicationBackend
import io.github.nearbytransfer.android.core.publication.PublicationBackend as RuntimePublicationBackend
import io.github.nearbytransfer.android.core.publication.PublicationFileKey
import io.github.nearbytransfer.android.core.publication.PublicationSource
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
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2StartupRecoveryRunnerTest {
    private lateinit var database: NearbyTransferDatabase
    private lateinit var repository: RoomTransferJobRepository
    private lateinit var stagingRoot: Path

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NearbyTransferDatabase::class.java,
        ).allowMainThreadQueries().build()
        repository = RoomTransferJobRepository(database)
        stagingRoot = Files.createTempDirectory("nearby-transfer-startup-recovery")
    }

    @After
    fun tearDown() {
        database.close()
        stagingRoot.toFile().deleteRecursively()
    }

    @Test
    fun resumesPreparedPublicationCleansStagingAndFinalizesIncomingTransfer() = runBlocking {
        val taskId = createReadyIncoming(seed = 21, bytes = ByteArray(0))
        repository.preparePublication(
            taskId = taskId,
            publicationId = "publication-21",
            publicationBackend = PublicationBackend.MEDIA_STORE,
            publicationRootToken = "content://downloads/root",
            nowEpochMillis = 5,
        )
        seedStaging(taskId, 0, ByteArray(0))
        val backend = InMemoryPublicationBackend(MediaStorePublicationBackend.BACKEND_ID)

        val summary = runner(backend).runOnce()

        assertEquals(1, summary.scanned)
        assertEquals(1, summary.recovered)
        assertEquals(1, summary.cleaned)
        assertEquals(1, summary.finalized)
        assertEquals(0, summary.failed)
        assertTrue(summary.failures.isEmpty())
        val job = requireNotNull(repository.find(taskId))
        assertEquals(TransferJobState.COMPLETED, job.state)
        assertFalse(job.cleanupPending)
        assertTrue(Files.notExists(V2StagingLayout.resolveTaskDirectory(stagingRoot, taskId)))
        assertEquals(1, backend.publishCalls)
    }

    @Test
    fun skipsUnsupportedPublicationBackendsWithoutFailingTheSweep() = runBlocking {
        val taskId = createReadyIncoming(seed = 22, bytes = ByteArray(0))
        repository.preparePublication(
            taskId = taskId,
            publicationId = "publication-22",
            publicationBackend = PublicationBackend.FILESYSTEM,
            publicationRootToken = "filesystem-root",
            nowEpochMillis = 5,
        )

        val summary = runner(backend = null).runOnce()

        assertEquals(1, summary.scanned)
        assertEquals(1, summary.skipped)
        assertEquals(0, summary.recovered)
        assertEquals(0, summary.failed)
        assertEquals(TransferJobState.TRANSFERRING, repository.find(taskId)?.state)
    }

    @Test
    fun recordsFailureWhenSourceProviderCannotBeCreated() = runBlocking {
        val summary = V2StartupRecoveryRunner(
            context = ApplicationProvider.getApplicationContext<Context>(),
            databaseProvider = { database },
            ownsDatabase = false,
            stagingRootProvider = { stagingRoot },
            backendResolver = V2PublicationBackendResolver { null },
            sourceProviderFactory = { throw SecurityException("root unavailable") },
            cleanerFactory = { throw AssertionError("cleaner should not be created") },
            clock = { 100L },
        ).runOnce()

        assertEquals(0, summary.scanned)
        assertEquals(1, summary.failed)
        assertTrue(summary.failures.single().contains("root unavailable"))
        assertNull(repository.find(taskId(99)))
    }

    @Test
    fun propagatesCancellationInsteadOfRecordingItAsFailure() = runBlocking {
        assertThrows(CancellationException::class.java) {
            runBlocking {
                V2StartupRecoveryRunner(
                    context = ApplicationProvider.getApplicationContext<Context>(),
                    databaseProvider = { database },
                    ownsDatabase = false,
                    stagingRootProvider = { stagingRoot },
                    backendResolver = V2PublicationBackendResolver { null },
                    sourceProviderFactory = { throw CancellationException("cancelled") },
                    clock = { 100L },
                ).runOnce()
            }
        }
        Unit
    }

    @Test
    fun cancellationAfterRecoveryDoesNotCleanStagingOrFinalizeTheJob() = runBlocking {
        val taskId = createReadyIncoming(seed = 23, bytes = ByteArray(0))
        repository.preparePublication(
            taskId = taskId,
            publicationId = "publication-23",
            publicationBackend = PublicationBackend.MEDIA_STORE,
            publicationRootToken = "content://downloads/root",
            nowEpochMillis = 5,
        )
        seedStaging(taskId, 0, ByteArray(0))
        val backend = BlockingPublishBackend(MediaStorePublicationBackend.BACKEND_ID)
        val recovery = runner(backend)

        val job = requireNotNull(recovery.startAsync())
        assertTrue(backend.publishCompleted.await(5, TimeUnit.SECONDS))
        job.cancel()
        backend.allowRecoveryToReturn.countDown()
        job.join()

        assertTrue(job.isCancelled)
        assertTrue(Files.exists(V2StagingLayout.resolveTaskDirectory(stagingRoot, taskId)))
        assertEquals(TransferJobState.TRANSFERRING, repository.find(taskId)?.state)
    }

    @Test
    fun backgroundStartRunsAtMostOnce() = runBlocking {
        val backend = InMemoryPublicationBackend(MediaStorePublicationBackend.BACKEND_ID)
        val runner = runner(backend)

        val first = runner.startAsync()
        val second = runner.startAsync()

        first?.join()
        assertNull(second)
    }

    private fun runner(backend: RuntimePublicationBackend?): V2StartupRecoveryRunner = V2StartupRecoveryRunner(
        context = ApplicationProvider.getApplicationContext<Context>(),
        databaseProvider = { database },
        ownsDatabase = false,
        stagingRootProvider = { stagingRoot },
        backendResolver = V2PublicationBackendResolver { job: TransferJob ->
            if (job.publicationBackend == PublicationBackend.MEDIA_STORE) backend else null
        },
        clock = { 100L },
    )

    private suspend fun createReadyIncoming(seed: Int, bytes: ByteArray): String {
        val taskId = taskId(seed)
        repository.createIncoming(taskId, "0123456789abcdef", manifest(taskId, bytes), true, 1)
        repository.transition(taskId, TransferJobState.QUEUED, 2)
        repository.transition(taskId, TransferJobState.TRANSFERRING, 3)
        if (bytes.isNotEmpty()) {
            val initial = requireNotNull(repository.find(taskId)?.checkpointJson)
            val completed = initial
                .replace("\"committedOffset\":0", "\"committedOffset\":${bytes.size}")
                .replace("\"completed\":false", "\"completed\":true")
                .replace("\"nextSequence\":0", "\"nextSequence\":1")
                .replace("\"transferredBytes\":0", "\"transferredBytes\":${bytes.size}")
            repository.updateReceiveCheckpoint(taskId, completed, 4)
        }
        return taskId
    }

    private fun seedStaging(taskId: String, fileIndex: Int, bytes: ByteArray) {
        Files.createDirectories(V2StagingLayout.resolveTaskDirectory(stagingRoot, taskId))
        Files.write(V2StagingLayout.resolveFile(stagingRoot, taskId, fileIndex), bytes)
    }

    private fun taskId(seed: Int): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(16) { seed.toByte() })

    private fun manifest(taskId: String, bytes: ByteArray): String =
        "{\"type\":\"transfer-manifest\",\"totalFiles\":1,\"entries\":[{" +
            "\"sha256\":\"${sha256(bytes)}\",\"size\":${bytes.size},\"path\":\"file.bin\",\"kind\":\"file\"}]," +
            "\"conflictStrategy\":\"auto-rename\",\"taskId\":\"$taskId\",\"protocolVersion\":2," +
            "\"totalBytes\":${bytes.size},\"app\":\"nearby-transfer\"}"

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private class InMemoryPublicationBackend(override val backendId: String) : RuntimePublicationBackend {
        private fun sha256Bytes(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
        private val states = mutableMapOf<PublicationFileKey, BackendInspection>()
        var publishCalls = 0
            private set

        override fun inspect(key: PublicationFileKey): BackendInspection = states[key] ?: BackendInspection.absent()

        override fun allocate(
            key: PublicationFileKey,
            relativePath: String,
            expectedSize: Long,
            expectedSha256: String,
        ): BackendInspection = BackendInspection(
            state = BackendObjectState.ALLOCATED,
            targetToken = "token-${key.fileIndex}",
            size = expectedSize,
            sha256 = expectedSha256,
        ).also { states[key] = it }

        override fun write(
            key: PublicationFileKey,
            targetToken: String,
            source: PublicationSource,
        ): BackendInspection {
            val bytes = source.open().use { it.readBytes() }
            return BackendInspection(
                state = BackendObjectState.WRITTEN,
                targetToken = targetToken,
                size = bytes.size.toLong(),
                sha256 = sha256Bytes(bytes),
            ).also { states[key] = it }
        }

        override fun publish(key: PublicationFileKey, targetToken: String): BackendInspection {
            publishCalls += 1
            val current = states.getValue(key)
            return current.copy(state = BackendObjectState.PUBLISHED).also { states[key] = it }
        }

        override fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection =
            BackendInspection.absent().also { states[key] = it }
    }

    private class BlockingPublishBackend(override val backendId: String) : RuntimePublicationBackend {
        private val delegate = InMemoryPublicationBackend(backendId)
        val publishCompleted = CountDownLatch(1)
        val allowRecoveryToReturn = CountDownLatch(1)

        override fun inspect(key: PublicationFileKey): BackendInspection = delegate.inspect(key)

        override fun allocate(
            key: PublicationFileKey,
            relativePath: String,
            expectedSize: Long,
            expectedSha256: String,
        ): BackendInspection = delegate.allocate(key, relativePath, expectedSize, expectedSha256)

        override fun write(
            key: PublicationFileKey,
            targetToken: String,
            source: PublicationSource,
        ): BackendInspection = delegate.write(key, targetToken, source)

        override fun publish(key: PublicationFileKey, targetToken: String): BackendInspection {
            val published = delegate.publish(key, targetToken)
            publishCompleted.countDown()
            awaitIgnoringInterrupt(allowRecoveryToReturn)
            return published
        }

        override fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection =
            delegate.abort(key, targetToken)
    }

    private companion object {
        fun awaitIgnoringInterrupt(latch: CountDownLatch) {
            var interrupted = false
            while (true) {
                try {
                    latch.await()
                    break
                } catch (_: InterruptedException) {
                    interrupted = true
                }
            }
            if (interrupted) Thread.currentThread().interrupt()
        }

        const val TASK_ID = "ABEiM0RVZneImaq7zN3u_w"
    }
}
