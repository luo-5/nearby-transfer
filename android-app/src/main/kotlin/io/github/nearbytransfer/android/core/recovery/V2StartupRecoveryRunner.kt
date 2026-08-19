package io.github.nearbytransfer.android.core.recovery

import android.content.Context
import android.net.Uri
import android.os.Build
import io.github.nearbytransfer.android.core.data.PublicationBackend as StoredPublicationBackend
import io.github.nearbytransfer.android.core.data.PublicationState as StoredPublicationState
import io.github.nearbytransfer.android.core.data.RoomTransferJobRepository
import io.github.nearbytransfer.android.core.data.TransferJob
import io.github.nearbytransfer.android.core.data.TransferJobState
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.publication.MediaStorePublicationBackend
import io.github.nearbytransfer.android.core.publication.PublicationBackend as RuntimePublicationBackend
import io.github.nearbytransfer.android.core.publication.PublicationRecord
import io.github.nearbytransfer.android.core.publication.PublicationSourceProvider
import io.github.nearbytransfer.android.core.publication.RoomPublicationJournal
import io.github.nearbytransfer.android.core.publication.SafTreePublicationBackend
import io.github.nearbytransfer.android.core.publication.V2PublicationCoordinator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.coroutineContext
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/** Resolves the runtime publication backend for one persisted transfer job. */
fun interface V2PublicationBackendResolver {
    fun backendFor(job: TransferJob): RuntimePublicationBackend?
}

/** Result of one startup recovery sweep. */
data class V2StartupRecoverySummary(
    val scanned: Int = 0,
    val recovered: Int = 0,
    val finalized: Int = 0,
    val cancelled: Int = 0,
    val cleaned: Int = 0,
    val skipped: Int = 0,
    val failed: Int = 0,
    val failures: List<String> = emptyList(),
) {
    operator fun plus(other: V2StartupRecoverySummary): V2StartupRecoverySummary = V2StartupRecoverySummary(
        scanned = scanned + other.scanned,
        recovered = recovered + other.recovered,
        finalized = finalized + other.finalized,
        cancelled = cancelled + other.cancelled,
        cleaned = cleaned + other.cleaned,
        skipped = skipped + other.skipped,
        failed = failed + other.failed,
        failures = failures + other.failures,
    )
}

/**
 * Non-blocking startup sweep for protocol-v2 publication recovery.
 *
 * Transfer data is first written to app-private staging, while final user-visible publication is
 * driven by a durable journal. If the app process dies after the transfer completes but before
 * publication or staging cleanup finishes, this runner resumes only the journaled work and then
 * finalizes the public transfer row. Legacy or reconcile-required rows are deliberately skipped so
 * startup never guesses about data it cannot prove safe to publish.
 */
class V2StartupRecoveryRunner(
    context: Context,
    private val databaseProvider: () -> NearbyTransferDatabase = {
        NearbyTransferDatabase.build(context.applicationContext)
    },
    private val ownsDatabase: Boolean = true,
    private val stagingRootProvider: () -> Path = { V2RecoveryPaths.stagingRoot(context.applicationContext) },
    private val backendResolver: V2PublicationBackendResolver = AndroidPublicationBackendResolver(context),
    private val sourceProviderFactory: (Path) -> PublicationSourceProvider = ::AppPrivatePublicationSourceProvider,
    private val cleanerFactory: (Path) -> AppPrivateStagingCleaner = ::AppPrivateStagingCleaner,
    private val clock: () -> Long = System::currentTimeMillis,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val started = AtomicBoolean(false)

    /** Starts at most one background sweep and returns immediately to the caller. */
    fun startAsync(onComplete: ((V2StartupRecoverySummary) -> Unit)? = null): Job? {
        if (!started.compareAndSet(false, true)) return null
        return scope.launch {
            val summary = runOnce()
            onComplete?.invoke(summary)
        }
    }

    /** Runs one complete sweep. Tests can call this directly for deterministic assertions. */
    suspend fun runOnce(): V2StartupRecoverySummary {
        coroutineContext.ensureActive()
        val database = databaseProvider()
        return try {
            val repository = RoomTransferJobRepository(database)
            coroutineContext.ensureActive()
            val stagingRoot = stagingRootProvider()
            coroutineContext.ensureActive()
            val sourceProvider = sourceProviderFactory(stagingRoot)
            coroutineContext.ensureActive()
            val cleaner = cleanerFactory(stagingRoot)
            coroutineContext.ensureActive()
            repository.loadRecoveryWork().fold(V2StartupRecoverySummary()) { summary, job ->
                coroutineContext.ensureActive()
                summary + recoverJob(database, repository, sourceProvider, cleaner, job)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            V2StartupRecoverySummary(
                failed = 1,
                failures = listOf("startup recovery sweep failed: ${error.javaClass.simpleName}: ${error.message.orEmpty().take(240)}"),
            )
        } finally {
            if (ownsDatabase) database.close()
        }
    }

    private suspend fun recoverJob(
        database: NearbyTransferDatabase,
        repository: RoomTransferJobRepository,
        sourceProvider: PublicationSourceProvider,
        cleaner: AppPrivateStagingCleaner,
        job: TransferJob,
    ): V2StartupRecoverySummary {
        return try {
            coroutineContext.ensureActive()
            recoverJobStrict(database, repository, sourceProvider, cleaner, job)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            V2StartupRecoverySummary(
                scanned = 1,
                failed = 1,
                failures = listOf("${job.taskId}: ${error.javaClass.simpleName}: ${error.message.orEmpty().take(240)}"),
            )
        }
    }

    private suspend fun recoverJobStrict(
        database: NearbyTransferDatabase,
        repository: RoomTransferJobRepository,
        sourceProvider: PublicationSourceProvider,
        cleaner: AppPrivateStagingCleaner,
        job: TransferJob,
    ): V2StartupRecoverySummary {
        val publicationId = job.publicationId
        val rootToken = job.publicationRootToken
        if (publicationId.isNullOrBlank() || rootToken.isNullOrBlank()) {
            return V2StartupRecoverySummary(scanned = 1, skipped = 1)
        }

        coroutineContext.ensureActive()
        val journal = RoomPublicationJournal(database, rootToken) { nowAtLeast(job.updatedAtEpochMillis) }
        var recovered = 0
        if (job.publicationState in RECOVERABLE_PUBLICATION_STATES) {
            coroutineContext.ensureActive()
            val backend = backendResolver.backendFor(job)
                ?: return V2StartupRecoverySummary(scanned = 1, skipped = 1)
            coroutineContext.ensureActive()
            V2PublicationCoordinator(journal, backend, sourceProvider).recover(publicationId)
            coroutineContext.ensureActive()
            recovered = 1
        } else if (job.publicationState in MANUAL_PUBLICATION_STATES) {
            return V2StartupRecoverySummary(scanned = 1, skipped = 1)
        }

        coroutineContext.ensureActive()
        val afterRecovery = repository.find(job.taskId)
            ?: return V2StartupRecoverySummary(scanned = 1, recovered = recovered, skipped = 1)
        coroutineContext.ensureActive()
        val cleaned = cleanupIfPending(repository, cleaner, journal, afterRecovery)
        coroutineContext.ensureActive()
        val afterCleanup = repository.find(job.taskId) ?: afterRecovery
        coroutineContext.ensureActive()
        val terminal = finalizeOrCancelIfReady(repository, afterCleanup)

        return V2StartupRecoverySummary(
            scanned = 1,
            recovered = recovered,
            finalized = if (terminal == TerminalAction.FINALIZED) 1 else 0,
            cancelled = if (terminal == TerminalAction.CANCELLED) 1 else 0,
            cleaned = if (cleaned) 1 else 0,
            skipped = if (recovered == 0 && !cleaned && terminal == TerminalAction.NONE) 1 else 0,
        )
    }

    private suspend fun cleanupIfPending(
        repository: RoomTransferJobRepository,
        cleaner: AppPrivateStagingCleaner,
        journal: RoomPublicationJournal,
        job: TransferJob,
    ): Boolean {
        if (!job.cleanupPending || job.publicationId.isNullOrBlank()) return false
        if (job.publicationState !in CLEANABLE_PUBLICATION_STATES) return false
        coroutineContext.ensureActive()
        val record: PublicationRecord = journal.load(job.publicationId)
            ?: throw IllegalStateException("Publication journal is missing during cleanup")
        coroutineContext.ensureActive()
        cleaner.cleanup(record.plan)
        coroutineContext.ensureActive()
        repository.markCleanupComplete(job.taskId, job.publicationId, nowAtLeast(job.updatedAtEpochMillis))
        return true
    }

    private suspend fun finalizeOrCancelIfReady(
        repository: RoomTransferJobRepository,
        job: TransferJob,
    ): TerminalAction {
        if (job.cleanupPending || job.state != TransferJobState.TRANSFERRING) return TerminalAction.NONE
        if (job.publicationState == StoredPublicationState.PUBLISHED &&
            job.transferredBytes == job.totalBytes &&
            !job.publicationId.isNullOrBlank()
        ) {
            coroutineContext.ensureActive()
            repository.finalizePublication(job.taskId, job.publicationId, nowAtLeast(job.updatedAtEpochMillis))
            return TerminalAction.FINALIZED
        }
        if (job.publicationCancelRequested &&
            job.publicationState in CANCELLATION_TERMINAL_STATES
        ) {
            coroutineContext.ensureActive()
            repository.transition(job.taskId, TransferJobState.CANCELLED, nowAtLeast(job.updatedAtEpochMillis))
            return TerminalAction.CANCELLED
        }
        return TerminalAction.NONE
    }

    private fun nowAtLeast(previous: Long): Long = maxOf(1L, previous, clock())

    private enum class TerminalAction { NONE, FINALIZED, CANCELLED }

    private class AndroidPublicationBackendResolver(context: Context) : V2PublicationBackendResolver {
        private val appContext = context.applicationContext

        override fun backendFor(job: TransferJob): RuntimePublicationBackend? = when (job.publicationBackend) {
            StoredPublicationBackend.MEDIA_STORE -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStorePublicationBackend(appContext)
            } else {
                null
            }

            StoredPublicationBackend.SAF_TREE -> job.publicationRootToken
                ?.takeIf { it.isNotBlank() }
                ?.let { SafTreePublicationBackend(appContext, Uri.parse(it)) }

            StoredPublicationBackend.FILESYSTEM,
            null,
            -> null
        }
    }

    private companion object {
        val RECOVERABLE_PUBLICATION_STATES = setOf(
            StoredPublicationState.PREPARED,
            StoredPublicationState.PUBLISHING,
            StoredPublicationState.PARTIAL,
            StoredPublicationState.CANCEL_PENDING,
        )
        val CLEANABLE_PUBLICATION_STATES = setOf(
            StoredPublicationState.PUBLISHED,
            StoredPublicationState.CANCELLED,
            StoredPublicationState.PARTIAL,
        )
        val CANCELLATION_TERMINAL_STATES = setOf(
            StoredPublicationState.CANCELLED,
            StoredPublicationState.PARTIAL,
        )
        val MANUAL_PUBLICATION_STATES = setOf(
            StoredPublicationState.RECONCILE_REQUIRED,
            StoredPublicationState.LEGACY_UNVERIFIED,
        )
    }
}
