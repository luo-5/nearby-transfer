package io.github.nearbytransfer.android.core.publication

import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * Crash-recoverable, per-file publication coordinator.
 *
 * The journal order is always: durable intent -> backend side effect -> durable receipt. If the
 * process dies between the last two steps, recovery inspects the backend before attempting the
 * action again. Completed files may become visible before later files; PARTIAL is therefore a
 * first-class truthful state, not an error hidden behind a pretend batch transaction.
 */
class V2PublicationCoordinator(
    private val journal: PublicationJournal,
    private val backend: PublicationBackend,
    private val sources: PublicationSourceProvider,
) {
    fun prepare(plan: PublicationPlan): PublicationRecord {
        require(plan.backendId == backend.backendId) {
            "Publication plan backend ${plan.backendId} does not match ${backend.backendId}"
        }
        val initial = PublicationRecord(plan = plan)
        if (journal.create(initial)) return initial
        val existing = requireRecord(plan.publicationId)
        if (existing.plan != plan) {
            throw PublicationConflictException("Publication id already belongs to a different plan")
        }
        return existing
    }

    fun requestCancellation(publicationId: String): PublicationRecord = mutate(publicationId) { current ->
        if (current.state == PublicationState.PUBLISHED || current.state == PublicationState.CANCELLED) {
            current
        } else {
            current.copy(cancelRequested = true)
        }
    }

    fun recover(publicationId: String): PublicationRunResult {
        var record = requireRecord(publicationId)
        require(record.plan.backendId == backend.backendId) { "Wrong publication backend" }
        if (record.state == PublicationState.PUBLISHED) return result(record)
        if (record.cancelRequested) return recoverCancellation(publicationId)

        for (file in record.plan.files) {
            record = requireRecord(publicationId)
            if (record.cancelRequested) return recoverCancellation(publicationId)

            record = reconcile(publicationId, file, cancelling = false)
            var fileRecord = record.file(file.index)
            if (fileRecord.state == PublicationFileState.PUBLISHED) continue

            if (fileRecord.state == PublicationFileState.PLANNED) {
                record = persistFileIntent(publicationId, file.index, PublicationFileState.ALLOCATING)
                if (record.cancelRequested) return recoverCancellation(publicationId)
                val allocated = backend.allocate(
                    key = file.key(record.plan),
                    relativePath = file.relativePath,
                    expectedSize = file.size,
                    expectedSha256 = file.sha256,
                )
                requireBackendState(file, allocated, BackendObjectState.ALLOCATED)
                record = persistObservation(publicationId, file.index, allocated)
                fileRecord = record.file(file.index)
            }

            if (fileRecord.state == PublicationFileState.ALLOCATED) {
                val token = requireNotNull(fileRecord.targetToken) { "Allocated file has no target token" }
                record = persistFileIntent(publicationId, file.index, PublicationFileState.WRITING)
                if (record.cancelRequested) return recoverCancellation(publicationId)

                val source = sources.sourceFor(record.plan, file)
                require(source.relativePath == file.relativePath) { "Publication source path changed" }
                require(source.size == file.size) { "Publication source size changed" }
                val guarded = GuardedPublicationSource(source, file.sha256)
                val written = try {
                    backend.write(file.key(record.plan), token, guarded)
                } catch (error: Throwable) {
                    guarded.closeLeakedStream(error)
                    throw error
                }
                guarded.assertFullyConsumedAndClosed()
                requireBackendState(file, written, BackendObjectState.WRITTEN)
                record = persistObservation(publicationId, file.index, written)
                fileRecord = record.file(file.index)
            }

            if (fileRecord.state == PublicationFileState.WRITTEN) {
                val token = requireNotNull(fileRecord.targetToken) { "Written file has no target token" }
                record = persistFileIntent(publicationId, file.index, PublicationFileState.PUBLISHING)
                if (record.cancelRequested) return recoverCancellation(publicationId)
                val published = backend.publish(file.key(record.plan), token)
                requireBackendState(file, published, BackendObjectState.PUBLISHED)
                persistObservation(publicationId, file.index, published)
            }
        }

        record = requireRecord(publicationId)
        check(record.state == PublicationState.PUBLISHED) { "Publication did not reach a terminal state" }
        return result(record)
    }

    private fun recoverCancellation(publicationId: String): PublicationRunResult {
        var record = requireRecord(publicationId)
        check(record.cancelRequested) { "Cancellation was not requested" }

        for (file in record.plan.files) {
            record = reconcile(publicationId, file, cancelling = true)
            val fileRecord = record.file(file.index)
            when (fileRecord.state) {
                PublicationFileState.PUBLISHED,
                PublicationFileState.ABORTED,
                -> Unit

                PublicationFileState.ALLOCATED,
                PublicationFileState.WRITTEN,
                -> {
                    record = persistFileIntent(publicationId, file.index, PublicationFileState.ABORTING)
                    val current = record.file(file.index)
                    val aborted = backend.abort(file.key(record.plan), current.targetToken)
                    requireBackendState(file, aborted, BackendObjectState.ABSENT)
                    persistFile(
                        publicationId,
                        file.index,
                        PublicationFileState.ABORTED,
                        targetToken = null,
                        observedSize = null,
                        observedSha256 = null,
                    )
                }

                PublicationFileState.PLANNED -> persistFile(
                    publicationId,
                    file.index,
                    PublicationFileState.ABORTED,
                    targetToken = null,
                    observedSize = null,
                    observedSha256 = null,
                )

                PublicationFileState.ALLOCATING,
                PublicationFileState.WRITING,
                PublicationFileState.PUBLISHING,
                PublicationFileState.ABORTING,
                -> error("Inspection left an unresolved intent for file ${file.index}")
            }
        }

        record = requireRecord(publicationId)
        check(!record.cleanupPending) { "Cancellation cleanup is still pending" }
        return result(record)
    }

    /** Reconciliation never trusts a journal receipt without checking the provider. */
    private fun reconcile(
        publicationId: String,
        file: PublicationFileSpec,
        cancelling: Boolean,
    ): PublicationRecord {
        val record = requireRecord(publicationId)
        val inspection = backend.inspect(file.key(record.plan))
        if (inspection.state == BackendObjectState.CONFLICT) {
            throw PublicationConflictException("Destination conflict for ${file.relativePath}")
        }
        if (record.file(file.index).state == PublicationFileState.PUBLISHED &&
            inspection.state != BackendObjectState.PUBLISHED
        ) {
            throw PublicationIntegrityException("Published destination disappeared: ${file.relativePath}")
        }

        return when (inspection.state) {
            BackendObjectState.ABSENT -> persistFile(
                record.plan.publicationId,
                file.index,
                if (cancelling) PublicationFileState.ABORTED else PublicationFileState.PLANNED,
                targetToken = null,
                observedSize = null,
                observedSha256 = null,
            )

            BackendObjectState.ALLOCATED -> {
                requireToken(file, inspection)
                persistObservation(record.plan.publicationId, file.index, inspection)
            }

            BackendObjectState.WRITTEN,
            BackendObjectState.PUBLISHED,
            -> {
                requireToken(file, inspection)
                requireContent(file, inspection)
                persistObservation(record.plan.publicationId, file.index, inspection)
            }

            BackendObjectState.CONFLICT -> error("Handled above")
        }
    }

    private fun PublicationFileSpec.key(plan: PublicationPlan) =
        PublicationFileKey(plan.publicationId, index)

    private fun requireBackendState(
        file: PublicationFileSpec,
        inspection: BackendInspection,
        expected: BackendObjectState,
    ) {
        if (inspection.state != expected) {
            throw PublicationIntegrityException(
                "Backend returned ${inspection.state} after $expected operation for ${file.relativePath}",
            )
        }
        if (expected != BackendObjectState.ABSENT) {
            requireToken(file, inspection)
        }
        if (expected == BackendObjectState.WRITTEN || expected == BackendObjectState.PUBLISHED) {
            requireContent(file, inspection)
        }
    }

    private fun requireToken(file: PublicationFileSpec, inspection: BackendInspection) {
        if (inspection.targetToken.isNullOrBlank()) {
            throw PublicationIntegrityException("Backend omitted target token for ${file.relativePath}")
        }
    }

    private fun requireContent(file: PublicationFileSpec, inspection: BackendInspection) {
        if (inspection.size != file.size || inspection.sha256 != file.sha256) {
            throw PublicationIntegrityException("Published content does not match ${file.relativePath}")
        }
    }

    private fun persistObservation(
        publicationId: String,
        fileIndex: Int,
        inspection: BackendInspection,
    ): PublicationRecord {
        val state = when (inspection.state) {
            BackendObjectState.ALLOCATED -> PublicationFileState.ALLOCATED
            BackendObjectState.WRITTEN -> PublicationFileState.WRITTEN
            BackendObjectState.PUBLISHED -> PublicationFileState.PUBLISHED
            BackendObjectState.ABSENT -> PublicationFileState.PLANNED
            BackendObjectState.CONFLICT -> throw PublicationConflictException("Destination conflict")
        }
        return persistFile(
            publicationId,
            fileIndex,
            state,
            inspection.targetToken,
            inspection.size,
            inspection.sha256,
        )
    }

    private fun persistFileIntent(
        publicationId: String,
        fileIndex: Int,
        state: PublicationFileState,
    ): PublicationRecord = mutate(publicationId) { record ->
        record.replaceFile(fileIndex) { it.copy(state = state, lastError = null) }
    }

    private fun persistFile(
        publicationId: String,
        fileIndex: Int,
        state: PublicationFileState,
        targetToken: String?,
        observedSize: Long?,
        observedSha256: String?,
    ): PublicationRecord = mutate(publicationId) { record ->
        record.replaceFile(fileIndex) {
            it.copy(
                state = state,
                targetToken = targetToken,
                observedSize = observedSize,
                observedSha256 = observedSha256,
                lastError = null,
            )
        }
    }

    private fun mutate(
        publicationId: String,
        transform: (PublicationRecord) -> PublicationRecord,
    ): PublicationRecord {
        repeat(MAX_CAS_ATTEMPTS) {
            val current = requireRecord(publicationId)
            val transformed = summarize(transform(current))
            if (transformed == current) return current
            val updated = transformed.copy(revision = current.revision + 1L)
            if (journal.compareAndSet(publicationId, current.revision, updated)) return updated
        }
        throw IllegalStateException("Publication journal remained contended")
    }

    private fun summarize(record: PublicationRecord): PublicationRecord {
        val published = record.files.count { it.state == PublicationFileState.PUBLISHED }
        val allPublished = published == record.files.size
        if (allPublished) {
            // A cancellation arriving after the final provider side effect is too late to undo the
            // visible result. Supersede that stale intent so the durable receipt remains truthful.
            return record.copy(
                state = PublicationState.PUBLISHED,
                cancelRequested = false,
                cleanupPending = false,
            )
        }

        val cleanupPending = record.cancelRequested && record.files.any {
            it.state != PublicationFileState.PUBLISHED && it.state != PublicationFileState.ABORTED
        }
        val state = if (record.cancelRequested) {
            when {
                cleanupPending -> PublicationState.CANCEL_PENDING
                published > 0 -> PublicationState.PARTIAL
                else -> PublicationState.CANCELLED
            }
        } else {
            when {
                published > 0 -> PublicationState.PARTIAL
                record.files.all { it.state == PublicationFileState.PLANNED } -> PublicationState.PREPARED
                else -> PublicationState.PUBLISHING
            }
        }
        return record.copy(state = state, cleanupPending = cleanupPending)
    }

    private fun PublicationRecord.replaceFile(
        fileIndex: Int,
        transform: (PublicationFileRecord) -> PublicationFileRecord,
    ): PublicationRecord = copy(files = files.map { if (it.spec.index == fileIndex) transform(it) else it })

    private fun PublicationRecord.file(index: Int): PublicationFileRecord =
        files.firstOrNull { it.spec.index == index }
            ?: throw IllegalArgumentException("Unknown file index $index")

    private fun requireRecord(publicationId: String): PublicationRecord =
        journal.load(publicationId) ?: throw IllegalArgumentException("Unknown publication $publicationId")

    private fun result(record: PublicationRecord): PublicationRunResult {
        val published = record.files.count { it.state == PublicationFileState.PUBLISHED }
        return PublicationRunResult(
            publicationId = record.plan.publicationId,
            state = record.state,
            publishedFiles = published,
            pendingFiles = record.files.size - published,
            cleanupPending = record.cleanupPending,
        )
    }

    /** Adds coordinator-side enforcement even when a backend accidentally ignores the source. */
    private class GuardedPublicationSource(
        private val delegate: PublicationSource,
        private val expectedSha256: String,
    ) : PublicationSource {
        override val relativePath: String get() = delegate.relativePath
        override val size: Long get() = delegate.size

        private var openAttempted = false
        private var stream: TrackingInputStream? = null

        override fun open(): InputStream {
            check(!openAttempted) { "Publication source may be opened only once" }
            openAttempted = true
            return TrackingInputStream(delegate.open()).also { stream = it }
        }

        fun assertFullyConsumedAndClosed() {
            val current = stream ?: throw PublicationIntegrityException("Backend did not open publication source")
            if (!current.closed || current.closeFailure != null || !current.eofObserved || current.byteCount != size) {
                val error = PublicationIntegrityException("Backend must fully consume and close publication source")
                current.closeFailure?.let(error::addSuppressed)
                closeLeakedStream(error)
                throw error
            }
            if (current.sha256() != expectedSha256) {
                throw PublicationIntegrityException("Sealed publication source hash changed")
            }
        }

        fun closeLeakedStream(owner: Throwable) {
            val current = stream ?: return
            if (current.closed && current.closeFailure == null) return
            try {
                current.close()
            } catch (closeError: Throwable) {
                owner.addSuppressed(closeError)
            }
        }
    }

    private class TrackingInputStream(input: InputStream) : FilterInputStream(input) {
        private val digest = MessageDigest.getInstance("SHA-256")
        var byteCount: Long = 0L
            private set
        var eofObserved: Boolean = false
            private set
        var closed: Boolean = false
            private set
        var closeFailure: Throwable? = null
            private set
        private var finalSha256: String? = null

        override fun read(): Int {
            val value = super.read()
            if (value < 0) {
                eofObserved = true
            } else {
                digest.update(value.toByte())
                byteCount++
            }
            return value
        }

        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            val count = super.read(bytes, offset, length)
            if (count < 0) {
                eofObserved = true
            } else if (count > 0) {
                digest.update(bytes, offset, count)
                byteCount += count.toLong()
            }
            return count
        }

        override fun close() {
            if (closed) {
                closeFailure?.let { throw it }
                return
            }
            closed = true
            try {
                super.close()
            } catch (error: Throwable) {
                closeFailure = error
                throw error
            }
        }

        fun sha256(): String {
            if (finalSha256 == null) {
                finalSha256 = digest.digest().joinToString("") { "%02x".format(it) }
            }
            return requireNotNull(finalSha256)
        }
    }

    private companion object {
        const val MAX_CAS_ATTEMPTS = 100
    }
}



