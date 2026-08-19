package io.github.nearbytransfer.android.core.publication

import androidx.room.withTransaction
import io.github.nearbytransfer.android.core.data.PublicationFileState as StoredPublicationFileState
import io.github.nearbytransfer.android.core.data.PublicationState as StoredPublicationState
import io.github.nearbytransfer.android.core.data.TransferManifestCodec
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.data.local.TransferJobEntity
import io.github.nearbytransfer.android.core.data.local.TransferPublicationFileEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * Room-backed durable publication journal.
 *
 * This API is intentionally synchronous to match [PublicationJournal]. Every call dispatches its
 * Room transaction to [Dispatchers.IO]; callers must still never invoke it from the Android main
 * thread because waiting synchronously there can stall the UI.
 *
 * The job revision is the single global CAS token. Receipt rows are replaced in the same
 * transaction only after the immutable plan and publication/task bindings have been revalidated.
 */
class RoomPublicationJournal(
    private val database: NearbyTransferDatabase,
    private val publicationRootToken: String,
    private val clock: () -> Long = System::currentTimeMillis,
) : PublicationJournal {
    override fun create(record: PublicationRecord): Boolean = blocking {
        require(publicationRootToken.isNotBlank()) { "publicationRootToken is required" }
        database.withTransaction {
            validateInitialRecord(record)
            val plan = record.plan
            val jobs = database.transferJobDao()
            val receipts = database.transferPublicationDao()

            val existingPublication = jobs.findByPublicationId(plan.publicationId)
            if (existingPublication != null) {
                require(existingPublication.taskId == plan.taskId) {
                    "Publication ID is already bound to another task"
                }
                require(
                    PublicationBackendIdCodec.backendIdsMatch(
                        existingPublication.publicationBackend,
                        plan.backendId,
                        existingPublication.publicationRootToken,
                    ),
                ) {
                    "Publication ID is already bound to another backend"
                }
                require(existingPublication.publicationRootToken == publicationRootToken) {
                    "Publication ID is already bound to another publication root"
                }
                require(loadInTransaction(plan.publicationId)?.plan == plan) {
                    "Publication ID is already bound to another plan"
                }
                return@withTransaction false
            }

            val job = jobs.findRaw(plan.taskId)
                ?: throw IllegalArgumentException("Publication task does not exist")
            validateJobAndPlan(job, plan)
            require(job.publicationId == null) { "Transfer job already has a publication" }
            require(job.publicationState == StoredPublicationState.NONE.name) {
                "Transfer job is not ready to prepare a new publication"
            }

            val now = now()
            val preparedRevision = Math.addExact(job.revision, 1L)
            val changed = jobs.preparePublicationByRevision(
                taskId = plan.taskId,
                expectedRevision = job.revision,
                publicationId = plan.publicationId,
                publicationBackend = plan.backendId,
                publicationRootToken = publicationRootToken,
                updatedAtEpochMillis = now,
            )
            if (changed != 1) return@withTransaction false

            receipts.insertAll(
                record.files.map { file ->
                    TransferPublicationFileEntity(
                        taskId = plan.taskId,
                        fileIndex = file.spec.index,
                        publicationId = plan.publicationId,
                        state = storedFileState(file.state).name,
                        targetToken = file.targetToken,
                        temporaryMarker = null,
                        requestedName = file.spec.relativePath,
                        actualName = null,
                        objectUri = null,
                        expectedSize = file.spec.size,
                        expectedSha256 = file.spec.sha256,
                        observedSize = file.observedSize,
                        observedSha256 = file.observedSha256,
                        updatedAtEpochMillis = now,
                        revision = preparedRevision,
                        failureReason = file.lastError,
                    )
                },
            )
            true
        }
    }

    override fun load(publicationId: String): PublicationRecord? = blocking {
        require(publicationId.isNotBlank()) { "publicationId is required" }
        database.withTransaction { loadInTransaction(publicationId) }
    }

    override fun compareAndSet(
        publicationId: String,
        expectedRevision: Long,
        updated: PublicationRecord,
    ): Boolean = blocking {
        require(publicationId.isNotBlank()) { "publicationId is required" }
        require(expectedRevision >= 0L) { "expectedRevision must be non-negative" }
        require(updated.plan.publicationId == publicationId) {
            "Updated record belongs to another publication"
        }
        database.withTransaction {
            val current = loadInTransaction(publicationId) ?: return@withTransaction false
            if (current.revision != expectedRevision) return@withTransaction false

            require(updated.plan.publicationId == publicationId) {
                "Updated record belongs to another publication"
            }
            require(updated.plan.taskId == current.plan.taskId) {
                "Updated record belongs to another task"
            }
            require(updated.plan == current.plan) { "Publication plan is immutable" }
            require(updated.files.map { it.spec } == current.plan.files) {
                "Publication file plan is immutable"
            }
            require(updated.revision == Math.addExact(expectedRevision, 1L)) {
                "Updated revision must advance exactly once"
            }
            validateCoordinatorRecord(updated)
            validateCoordinatorTransition(current, updated)

            val now = now()
            val jobs = database.transferJobDao()
            val receipts = database.transferPublicationDao()
            val changed = jobs.replacePublicationSnapshotByRevision(
                taskId = current.plan.taskId,
                publicationId = publicationId,
                expectedRevision = expectedRevision,
                newRevision = updated.revision,
                publicationState = storedPublicationState(updated.state).name,
                cancelRequested = updated.cancelRequested,
                stagingCleanupRequired = requiresStagingCleanup(updated),
                publicationError = updated.files.firstNotNullOfOrNull { it.lastError },
                updatedAtEpochMillis = now,
            )
            if (changed != 1) return@withTransaction false

            updated.files.forEach { file ->
                check(
                    receipts.replaceCoordinatorSnapshot(
                        taskId = current.plan.taskId,
                        fileIndex = file.spec.index,
                        publicationId = publicationId,
                        state = storedFileState(file.state).name,
                        targetToken = file.targetToken,
                        observedSize = file.observedSize,
                        observedSha256 = file.observedSha256,
                        failureReason = file.lastError,
                        updatedAtEpochMillis = now,
                        newRevision = updated.revision,
                    ) == 1,
                ) { "Publication receipt set changed during CAS" }
            }
            true
        }
    }

    private suspend fun loadInTransaction(publicationId: String): PublicationRecord? {
        val job = database.transferJobDao().findByPublicationId(publicationId) ?: return null
        require(job.publicationId == publicationId) { "Publication binding is corrupt" }
        val backendId = PublicationBackendIdCodec.canonicalBackendId(
            job.publicationBackend ?: throw IllegalStateException("Publication backend is missing"),
            job.publicationRootToken,
        ) ?: throw IllegalStateException("Publication backend is missing")
        val rows = database.transferPublicationDao().listForTask(job.taskId)
        require(rows.isNotEmpty()) { "Publication receipt set is empty" }
        require(rows.all { it.taskId == job.taskId && it.publicationId == publicationId }) {
            "Publication receipt binding is corrupt"
        }

        val files = rows.mapIndexed { expectedIndex, row ->
            require(row.fileIndex == expectedIndex) { "Publication receipt order is corrupt" }
            require(row.revision <= job.revision) { "Publication receipt revision is ahead of its job" }
            require(row.targetToken == null || row.targetToken.isNotBlank()) {
                "Empty target token is not a valid persisted value"
            }
            require(row.temporaryMarker == null || row.temporaryMarker.isNotBlank()) {
                "Empty temporary marker is not a valid persisted value"
            }
            val spec = PublicationFileSpec(
                index = row.fileIndex,
                relativePath = row.requestedName,
                size = row.expectedSize,
                sha256 = row.expectedSha256,
            )
            PublicationFileRecord(
                spec = spec,
                state = coordinatorFileState(row.state),
                targetToken = row.targetToken,
                observedSize = row.observedSize,
                observedSha256 = row.observedSha256,
                lastError = row.failureReason,
            )
        }
        val plan = PublicationPlan(
            publicationId = publicationId,
            taskId = job.taskId,
            backendId = backendId,
            files = files.map { it.spec },
        )
        validateJobAndPlan(job, plan)
        val cancelRequested = job.publicationCancelRequested
        val providerCleanupPending = cancelRequested && files.any {
            it.state != PublicationFileState.PUBLISHED && it.state != PublicationFileState.ABORTED
        }
        return PublicationRecord(
            plan = plan,
            files = files,
            state = coordinatorPublicationState(job.publicationState),
            cancelRequested = cancelRequested,
            cleanupPending = providerCleanupPending,
            revision = job.revision,
        ).also(::validateCoordinatorRecord)
    }

    private fun requiresStagingCleanup(record: PublicationRecord): Boolean =
        !record.cleanupPending && when (record.state) {
            PublicationState.PUBLISHED, PublicationState.CANCELLED -> true
            PublicationState.PARTIAL -> record.cancelRequested
            else -> false
        }

    private fun validateInitialRecord(record: PublicationRecord) {
        require(record.revision == 0L) { "New publication record must start at revision zero" }
        require(record.state == PublicationState.PREPARED) { "New publication must be prepared" }
        require(!record.cancelRequested && !record.cleanupPending) {
            "New publication cannot already be cancelled or awaiting cleanup"
        }
        require(record.files.all { it.state == PublicationFileState.PLANNED }) {
            "New publication files must be planned"
        }
        validateCoordinatorRecord(record)
    }

    private fun validateCoordinatorRecord(record: PublicationRecord) {
        require(record.files.map { it.spec } == record.plan.files) { "Publication plan changed" }
        record.files.forEach { file ->
            require(file.targetToken == null || file.targetToken.isNotBlank()) {
                "targetToken must be null or non-blank"
            }
            require(file.observedSize == null || file.observedSize >= 0L) {
                "observedSize must be non-negative"
            }
            require(file.observedSha256 == null || SHA256.matches(file.observedSha256)) {
                "observedSha256 must be lowercase hexadecimal"
            }
            file.lastError?.let { error ->
                require(error == error.trim() && error.isNotEmpty() && error.length <= MAX_ERROR_LENGTH) {
                    "lastError must be non-empty, trimmed, and bounded"
                }
                require(error.none { it == '\u0000' || (it.code < 0x20 && it != '\n' && it != '\r' && it != '\t') }) {
                    "lastError contains unsupported control characters"
                }
            }
            when (file.state) {
                PublicationFileState.PLANNED,
                PublicationFileState.ALLOCATING,
                PublicationFileState.ABORTED,
                -> require(file.targetToken == null && file.observedSize == null && file.observedSha256 == null) {
                    "${file.state} files cannot retain provider evidence"
                }

                PublicationFileState.ALLOCATED,
                PublicationFileState.WRITING,
                PublicationFileState.ABORTING,
                -> require(!file.targetToken.isNullOrBlank()) {
                    "${file.state} files require a provider token"
                }

                PublicationFileState.WRITTEN,
                PublicationFileState.PUBLISHING,
                PublicationFileState.PUBLISHED,
                -> {
                    require(!file.targetToken.isNullOrBlank()) {
                        "${file.state} files require a provider token"
                    }
                    require(file.observedSize == file.spec.size && file.observedSha256 == file.spec.sha256) {
                        "${file.state} files require exact content evidence"
                    }
                }
            }
        }

        val published = record.files.count { it.state == PublicationFileState.PUBLISHED }
        val allPublished = published == record.files.size
        val expectedCleanupPending = record.cancelRequested && record.files.any {
            it.state != PublicationFileState.PUBLISHED && it.state != PublicationFileState.ABORTED
        }
        require(record.cleanupPending == expectedCleanupPending) {
            "cleanupPending does not match provider cleanup work"
        }
        val expectedState = when {
            allPublished -> PublicationState.PUBLISHED
            record.cancelRequested && expectedCleanupPending -> PublicationState.CANCEL_PENDING
            record.cancelRequested && published > 0 -> PublicationState.PARTIAL
            record.cancelRequested -> PublicationState.CANCELLED
            published > 0 -> PublicationState.PARTIAL
            record.files.all { it.state == PublicationFileState.PLANNED } -> PublicationState.PREPARED
            else -> PublicationState.PUBLISHING
        }
        require(record.state == expectedState) {
            "Publication aggregate state does not match its file receipts"
        }
        if (record.state == PublicationState.PUBLISHED) {
            require(!record.cancelRequested) { "Published publication cannot retain cancellation intent" }
        }
    }

    private fun validateCoordinatorTransition(current: PublicationRecord, updated: PublicationRecord) {
        if (current.cancelRequested && !updated.cancelRequested) {
            require(updated.state == PublicationState.PUBLISHED &&
                updated.files.all { it.state == PublicationFileState.PUBLISHED }) {
                "Cancellation intent cannot be cleared before publication wins the final side-effect race"
            }
        }
        if (current.state == PublicationState.PUBLISHED || current.state == PublicationState.CANCELLED) {
            require(updated.state == current.state) { "Terminal publication state cannot regress" }
        }
        current.files.zip(updated.files).forEach { (before, after) ->
            if (before.state == PublicationFileState.PUBLISHED || before.state == PublicationFileState.ABORTED) {
                require(after == before) { "Terminal publication file receipt cannot regress or change" }
            }
        }
    }

    private fun validateJobAndPlan(job: TransferJobEntity, plan: PublicationPlan) {
        require(job.direction == "INCOMING") { "Only incoming jobs can be published" }
        require(job.state != "QUARANTINED" && job.state != "CANCELLED") {
            "Terminally rejected jobs cannot be published"
        }
        require(job.transferredBytes == job.totalBytes) { "Incoming transfer is incomplete" }

        val normalized = TransferManifestCodec.normalize(job.manifestJson)
        require(normalized.taskId == job.taskId && plan.taskId == job.taskId) {
            "Manifest, plan, and job task IDs must match"
        }
        require(normalized.totalBytes == job.totalBytes) { "Stored transfer total does not match manifest" }
        val entries = JSONObject(normalized.json).getJSONArray("entries")
        val manifestFiles = buildList {
            repeat(entries.length()) { index ->
                val entry = entries.getJSONObject(index)
                if (entry.getString("kind") == "file") {
                    add(
                        PublicationFileSpec(
                            index = size,
                            relativePath = entry.getString("path"),
                            size = entry.getLong("size"),
                            sha256 = entry.getString("sha256"),
                        ),
                    )
                }
            }
        }
        require(manifestFiles == plan.files) {
            "Publication plan must exactly match manifest file order, path, size, and hash"
        }
    }

    private fun storedPublicationState(state: PublicationState): StoredPublicationState =
        StoredPublicationState.valueOf(state.name)

    private fun coordinatorPublicationState(state: String): PublicationState {
        StoredPublicationState.valueOf(state)
        return try {
            PublicationState.valueOf(state)
        } catch (error: IllegalArgumentException) {
            throw IllegalStateException("Publication $state is not a coordinator state", error)
        }
    }

    private fun storedFileState(state: PublicationFileState): StoredPublicationFileState =
        StoredPublicationFileState.valueOf(state.name)

    private fun coordinatorFileState(state: String): PublicationFileState {
        StoredPublicationFileState.valueOf(state)
        return try {
            PublicationFileState.valueOf(state)
        } catch (error: IllegalArgumentException) {
            throw IllegalStateException("Publication file $state is not a coordinator state", error)
        }
    }

    private fun now(): Long = clock().also { require(it >= 0L) { "Clock returned a negative timestamp" } }

    private fun <T> blocking(block: suspend () -> T): T = runBlocking(Dispatchers.IO) { block() }

    private companion object {
        const val MAX_ERROR_LENGTH = 2_048
        val SHA256 = Regex("[0-9a-f]{64}")
    }
}
