package io.github.nearbytransfer.android.core.data

import androidx.room.withTransaction
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.data.local.TransferJobEntity
import io.github.nearbytransfer.android.core.publication.PublicationFileSpec
import io.github.nearbytransfer.android.core.publication.PublicationPlan
import io.github.nearbytransfer.android.core.publication.PublicationRecord
import io.github.nearbytransfer.android.core.publication.RoomPublicationJournal
import org.json.JSONObject

/**
 * Transactional Room repository for public protocol-v2 transfer state.
 *
 * This repository intentionally has no API for session keys, plaintext, local
 * file paths, nonces or authentication tags.
 */
class RoomTransferJobRepository(
    private val database: NearbyTransferDatabase,
) {
    private val dao = database.transferJobDao()

    suspend fun createOutgoing(
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = create(
        taskId = taskId,
        peerId = peerId,
        direction = TransferDirection.OUTGOING,
        initialState = TransferJobState.QUEUED,
        manifestJson = manifestJson,
        recoverable = recoverable,
        nowEpochMillis = nowEpochMillis,
    )

    suspend fun createIncoming(
        taskId: String,
        peerId: String,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob = create(
        taskId = taskId,
        peerId = peerId,
        direction = TransferDirection.INCOMING,
        initialState = TransferJobState.AWAITING_APPROVAL,
        manifestJson = manifestJson,
        recoverable = recoverable,
        nowEpochMillis = nowEpochMillis,
    )

    suspend fun find(taskId: String): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        return database.withTransaction {
            dao.findActive(taskId)?.let { mapOrQuarantine(it) }
        }
    }

    suspend fun listAll(): List<TransferJob> = database.withTransaction {
        dao.listActive().mapNotNull { mapOrQuarantine(it) }
    }

    /** Returns valid non-terminal transport jobs after process restart. */
    suspend fun loadUnfinished(): List<TransferJob> = database.withTransaction {
        dao.listUnfinished().mapNotNull { mapOrQuarantine(it) }
    }

    /** Returns transport, publication, reconciliation, and staging-cleanup recovery work. */
    suspend fun loadRecoveryWork(): List<TransferJob> = database.withTransaction {
        dao.listRecoveryWork().mapNotNull { mapOrQuarantine(it) }
    }

    suspend fun transition(
        taskId: String,
        newState: TransferJobState,
        nowEpochMillis: Long,
        failureReason: String? = null,
        recoverable: Boolean? = null,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val current = loadCurrent(taskId) ?: return@withTransaction null
            require(newState in ALLOWED_TRANSITIONS.getValue(current.state)) {
                "Illegal transfer state transition: ${current.state} -> $newState."
            }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            if (newState == TransferJobState.COMPLETED) {
                require(current.direction == TransferDirection.OUTGOING) {
                    "Incoming transfers must complete through finalizePublication."
                }
                require(current.transferredBytes == current.totalBytes) {
                    "A transfer cannot complete before all bytes are persisted."
                }
            }
            if (newState == TransferJobState.CANCELLED) {
                require(canFinishCancellation(current)) {
                    "Active publication must be cancelled and cleaned through the publication coordinator first."
                }
            }
            val normalizedFailure = normalizeFailureReason(newState, failureReason)
            val nextRecoverable = when (newState) {
                TransferJobState.COMPLETED, TransferJobState.CANCELLED -> false
                else -> recoverable ?: current.recoverable
            }
            val changed = dao.updateStateByRevision(
                taskId = taskId,
                expectedState = current.state.name,
                expectedRevision = current.revision,
                newState = newState.name,
                recoverable = nextRecoverable,
                failureReason = normalizedFailure,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(loadCurrent(taskId))
        }
    }

    /** Progress-only updates are intentionally limited to outgoing jobs. */
    suspend fun updateProgress(
        taskId: String,
        transferredBytes: Long,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val current = loadCurrent(taskId) ?: return@withTransaction null
            require(current.direction == TransferDirection.OUTGOING) {
                "Incoming progress must be updated with a canonical receive checkpoint."
            }
            require(current.state == TransferJobState.TRANSFERRING) {
                "Progress can only be updated while a transfer is active."
            }
            require(transferredBytes >= current.transferredBytes) { "Transfer progress cannot move backwards." }
            require(transferredBytes <= current.totalBytes) { "Transfer progress cannot exceed totalBytes." }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            val changed = dao.updateProgressByRevision(
                taskId = taskId,
                expectedState = current.state.name,
                expectedRevision = current.revision,
                expectedTransferredBytes = current.transferredBytes,
                transferredBytes = transferredBytes,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(loadCurrent(taskId))
        }
    }

    suspend fun updateReceiveCheckpoint(
        taskId: String,
        candidateCheckpointJson: String,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val current = loadCurrent(taskId) ?: return@withTransaction null
            require(current.direction == TransferDirection.INCOMING) {
                "Receive checkpoints are only valid for incoming transfers."
            }
            require(current.state == TransferJobState.TRANSFERRING) {
                "Receive checkpoints can only advance while a transfer is active."
            }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            val previous = requireNotNull(current.checkpointJson) {
                "This legacy receive job requires reconciliation before checkpoint updates."
            }
            val checkpoint = ReceiveCheckpointCodec.advance(
                manifestJson = current.manifestJson,
                previousCheckpointJson = previous,
                candidateCheckpointJson = candidateCheckpointJson,
            )
            val changed = dao.updateCheckpointByRevision(
                taskId = taskId,
                expectedRevision = current.revision,
                checkpointJson = checkpoint.json,
                transferredBytes = checkpoint.transferredBytes,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(loadCurrent(taskId))
        }
    }

    suspend fun preparePublication(
        taskId: String,
        publicationId: String,
        publicationBackend: PublicationBackend,
        publicationRootToken: String,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        val normalizedPublicationId = normalizePublicationId(publicationId)
        val normalizedRootToken = normalizeRootToken(publicationRootToken)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        val current = database.withTransaction {
            val job = loadCurrent(taskId) ?: return@withTransaction null
            require(job.direction == TransferDirection.INCOMING) {
                "Only incoming transfers can be published."
            }
            require(job.state == TransferJobState.TRANSFERRING) {
                "Publication can only be prepared for an active incoming transfer."
            }
            require(job.transferredBytes == job.totalBytes) {
                "Publication cannot start before all bytes are durably received."
            }
            require(nowEpochMillis >= job.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            job
        } ?: return null

        val plan = publicationPlan(current, normalizedPublicationId, publicationBackend)
        val journal = RoomPublicationJournal(database, normalizedRootToken) { nowEpochMillis }
        if (!journal.create(PublicationRecord(plan))) {
            val existing = requireNotNull(journal.load(normalizedPublicationId)) {
                "Existing publication journal disappeared."
            }
            require(existing.plan == plan) {
                "Publication ID is already bound to a different plan."
            }
        }
        return find(taskId)
    }

    /** Clears the staging-cleanup obligation after cleanup has durably succeeded. */
    internal suspend fun markCleanupComplete(
        taskId: String,
        publicationId: String,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        val normalizedPublicationId = normalizePublicationId(publicationId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val current = loadCurrent(taskId) ?: return@withTransaction null
            requirePublicationIdentity(current, normalizedPublicationId)
            require(current.cleanupPending && hasTerminalPublicationCleanup(current)) {
                "Staging cleanup is not pending for a terminal publication outcome."
            }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            val changed = dao.markCleanupCompleteByRevision(
                taskId = taskId,
                publicationId = normalizedPublicationId,
                expectedRevision = current.revision,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(loadCurrent(taskId))
        }
    }

    /** Completes an incoming job only after publication and staging cleanup are both durable. */
    suspend fun finalizePublication(
        taskId: String,
        publicationId: String,
        nowEpochMillis: Long,
    ): TransferJob? {
        TransferManifestCodec.validateTaskId(taskId)
        val normalizedPublicationId = normalizePublicationId(publicationId)
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        return database.withTransaction {
            val current = loadCurrent(taskId) ?: return@withTransaction null
            requirePublicationIdentity(current, normalizedPublicationId)
            require(current.state == TransferJobState.TRANSFERRING) {
                "Only an active incoming transfer can be finalized."
            }
            require(current.transferredBytes == current.totalBytes) {
                "An incoming transfer cannot complete before all bytes are persisted."
            }
            require(current.publicationState == PublicationState.PUBLISHED) {
                "Publication must be durably published before the transfer can complete."
            }
            require(!current.cleanupPending) {
                "Staging cleanup must complete before the transfer can complete."
            }
            require(current.publicationError == null) {
                "Publication errors must be reconciled before completion."
            }
            require(nowEpochMillis >= current.updatedAtEpochMillis) {
                "updatedAtEpochMillis cannot move backwards."
            }
            val changed = dao.updateStateByRevision(
                taskId = taskId,
                expectedState = current.state.name,
                expectedRevision = current.revision,
                newState = TransferJobState.COMPLETED.name,
                recoverable = false,
                failureReason = null,
                updatedAtEpochMillis = nowEpochMillis,
            )
            check(changed == 1) { "Transfer job changed concurrently." }
            requireNotNull(loadCurrent(taskId))
        }
    }

    private fun publicationPlan(
        job: TransferJob,
        publicationId: String,
        backend: PublicationBackend,
    ): PublicationPlan {
        val entries = JSONObject(job.manifestJson).getJSONArray("entries")
        val files = buildList {
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
        return PublicationPlan(publicationId, job.taskId, backend.name, files)
    }

    private suspend fun create(
        taskId: String,
        peerId: String,
        direction: TransferDirection,
        initialState: TransferJobState,
        manifestJson: String,
        recoverable: Boolean,
        nowEpochMillis: Long,
    ): TransferJob {
        TransferManifestCodec.validateTaskId(taskId)
        require(PEER_ID.matches(peerId)) { "Peer ID must be 16 lowercase hexadecimal characters." }
        requireTimestamp(nowEpochMillis, "nowEpochMillis")
        val manifest = TransferManifestCodec.normalize(manifestJson)
        require(manifest.taskId == taskId) { "Transfer manifest taskId does not match the job taskId." }
        val checkpoint = if (direction == TransferDirection.INCOMING) {
            ReceiveCheckpointCodec.createInitial(manifest.json).json
        } else {
            null
        }
        val entity = TransferJobEntity(
            taskId = taskId,
            peerId = peerId,
            direction = direction.name,
            state = initialState.name,
            manifestJson = manifest.json,
            totalBytes = manifest.totalBytes,
            transferredBytes = 0L,
            createdAtEpochMillis = nowEpochMillis,
            updatedAtEpochMillis = nowEpochMillis,
            recoverable = recoverable,
            failureReason = null,
            checkpointJson = checkpoint,
            publicationState = PublicationState.NONE.name,
            publicationId = null,
            publicationBackend = null,
            publicationRootToken = null,
            publicationError = null,
            cleanupPending = false,
            revision = 0L,
        )
        database.withTransaction { dao.insert(entity) }
        return mapStrict(entity)
    }

    private suspend fun loadCurrent(taskId: String): TransferJob? =
        dao.findActive(taskId)?.let { mapOrQuarantine(it) }

    private suspend fun mapOrQuarantine(entity: TransferJobEntity): TransferJob? = try {
        mapStrict(entity)
    } catch (_: RuntimeException) {
        val quarantineTime = maxOf(1L, System.currentTimeMillis(), entity.updatedAtEpochMillis)
        dao.quarantine(entity.taskId, CORRUPT_ROW_REASON, quarantineTime)
        null
    }

    private fun mapStrict(entity: TransferJobEntity): TransferJob {
        TransferManifestCodec.validateTaskId(entity.taskId)
        require(PEER_ID.matches(entity.peerId)) { "Persisted peer ID is invalid." }
        val direction = parseEnum<TransferDirection>(entity.direction, "Persisted transfer direction is invalid.")
        val state = parseEnum<TransferJobState>(entity.state, "Persisted transfer state is invalid.")
        val publicationState = parseEnum<PublicationState>(
            entity.publicationState,
            "Persisted publication state is invalid.",
        )
        val publicationBackend = entity.publicationBackend?.let {
            parseEnum<PublicationBackend>(it, "Persisted publication backend is invalid.")
        }
        val manifest = TransferManifestCodec.normalize(entity.manifestJson)
        require(manifest.json == entity.manifestJson) { "Persisted transfer manifest is not canonical." }
        require(manifest.taskId == entity.taskId && manifest.totalBytes == entity.totalBytes) {
            "Persisted transfer manifest does not match indexed metadata."
        }
        require(entity.transferredBytes in 0..entity.totalBytes) { "Persisted transfer progress is invalid." }
        requireTimestamp(entity.createdAtEpochMillis, "createdAtEpochMillis")
        require(entity.updatedAtEpochMillis in entity.createdAtEpochMillis..MAX_SAFE_INTEGER) {
            "Persisted transfer update time is invalid."
        }
        require(entity.revision in 0..MAX_SAFE_INTEGER) { "Persisted transfer revision is invalid." }
        require(state !in TERMINAL_STATES || !entity.recoverable) {
            "Terminal transfer jobs cannot be recoverable."
        }
        require(state != TransferJobState.COMPLETED || entity.transferredBytes == entity.totalBytes) {
            "Completed transfer progress is inconsistent."
        }
        normalizeFailureReason(state, entity.failureReason)

        val checkpointJson = validateCheckpoint(direction, manifest.json, entity)
        validatePublicationFields(
            direction = direction,
            state = state,
            publicationState = publicationState,
            publicationId = entity.publicationId,
            publicationBackend = publicationBackend,
            publicationRootToken = entity.publicationRootToken,
            publicationError = entity.publicationError,
            publicationCancelRequested = entity.publicationCancelRequested,
            cleanupPending = entity.cleanupPending,
            transferredBytes = entity.transferredBytes,
            totalBytes = entity.totalBytes,
        )

        return TransferJob(
            taskId = entity.taskId,
            peerId = entity.peerId,
            direction = direction,
            state = state,
            manifestJson = entity.manifestJson,
            totalBytes = entity.totalBytes,
            transferredBytes = entity.transferredBytes,
            createdAtEpochMillis = entity.createdAtEpochMillis,
            updatedAtEpochMillis = entity.updatedAtEpochMillis,
            recoverable = entity.recoverable,
            failureReason = entity.failureReason,
            checkpointJson = checkpointJson,
            publicationState = publicationState,
            publicationId = entity.publicationId,
            publicationBackend = publicationBackend,
            publicationRootToken = entity.publicationRootToken,
            publicationError = entity.publicationError,
            publicationCancelRequested = entity.publicationCancelRequested,
            cleanupPending = entity.cleanupPending,
            revision = entity.revision,
        )
    }

    private fun validateCheckpoint(
        direction: TransferDirection,
        manifestJson: String,
        entity: TransferJobEntity,
    ): String? {
        if (direction == TransferDirection.OUTGOING) {
            require(entity.checkpointJson == null) { "Outgoing jobs cannot contain receive checkpoints." }
            return null
        }
        val checkpointJson = entity.checkpointJson
        if (checkpointJson == null) {
            require(
                entity.transferredBytes == 0L ||
                    entity.publicationState == PublicationState.RECONCILE_REQUIRED.name ||
                    entity.publicationState == PublicationState.LEGACY_UNVERIFIED.name,
            ) { "Incoming progress requires a canonical receive checkpoint." }
            return null
        }
        val checkpoint = ReceiveCheckpointCodec.normalize(manifestJson, checkpointJson)
        require(checkpoint.json == checkpointJson) { "Persisted receive checkpoint is not canonical." }
        require(checkpoint.transferredBytes == entity.transferredBytes) {
            "Persisted receive checkpoint does not match transfer progress."
        }
        return checkpoint.json
    }

    private fun validatePublicationFields(
        direction: TransferDirection,
        state: TransferJobState,
        publicationState: PublicationState,
        publicationId: String?,
        publicationBackend: PublicationBackend?,
        publicationRootToken: String?,
        publicationError: String?,
        publicationCancelRequested: Boolean,
        cleanupPending: Boolean,
        transferredBytes: Long,
        totalBytes: Long,
    ) {
        if (direction == TransferDirection.OUTGOING) {
            require(publicationState == PublicationState.NONE) { "Outgoing jobs cannot have publication state." }
            require(publicationId == null && publicationBackend == null && publicationRootToken == null) {
                "Outgoing jobs cannot contain publication identity."
            }
            require(publicationError == null && !publicationCancelRequested && !cleanupPending) {
                "Outgoing jobs cannot contain publication recovery state."
            }
            return
        }

        val hasIdentity = publicationId != null || publicationBackend != null || publicationRootToken != null
        if (hasIdentity) {
            require(publicationId != null && publicationBackend != null && publicationRootToken != null) {
                "Persisted publication identity is incomplete."
            }
            normalizePublicationId(publicationId)
            normalizeRootToken(publicationRootToken)
        }
        when (publicationState) {
            PublicationState.NONE, PublicationState.LEGACY_UNVERIFIED -> require(!hasIdentity) {
                "This publication state cannot contain publication identity."
            }
            PublicationState.RECONCILE_REQUIRED -> Unit // Legacy rows may lack an identity.
            PublicationState.PREPARED,
            PublicationState.PUBLISHING,
            PublicationState.PARTIAL,
            PublicationState.PUBLISHED,
            PublicationState.CANCEL_PENDING,
            PublicationState.CANCELLED,
            -> require(hasIdentity) { "Active publication state requires publication identity." }
        }
        if (publicationState in FULLY_RECEIVED_PUBLICATION_STATES) {
            require(transferredBytes == totalBytes) { "Publication state requires a fully received transfer." }
        }
        if (publicationState == PublicationState.LEGACY_UNVERIFIED) {
            require(state == TransferJobState.COMPLETED) {
                "Legacy-unverified publication state is only valid for migrated completed jobs."
            }
        }
        if (publicationCancelRequested) {
            require(publicationState in setOf(
                PublicationState.CANCEL_PENDING,
                PublicationState.PARTIAL,
                PublicationState.CANCELLED,
            )) { "Cancellation intent requires a cancellation publication state." }
        }
        if (cleanupPending) {
            require(
                publicationState == PublicationState.PUBLISHED ||
                    (publicationCancelRequested && publicationState in setOf(
                        PublicationState.PARTIAL,
                        PublicationState.CANCELLED,
                    )),
            ) {
                "Staging cleanup can only be pending after publication has reached a terminal outcome."
            }
        }
        val normalizedError = normalizePublicationError(publicationState, publicationError)
        require(normalizedError == publicationError) { "Persisted publication error is not normalized." }
        if (state == TransferJobState.COMPLETED) {
            require(
                publicationState == PublicationState.LEGACY_UNVERIFIED ||
                    (publicationState == PublicationState.PUBLISHED && !cleanupPending),
            ) { "Completed incoming jobs require finalized publication." }
        }
    }

    private fun canFinishCancellation(job: TransferJob): Boolean = when (job.publicationState) {
        PublicationState.NONE,
        PublicationState.RECONCILE_REQUIRED,
        PublicationState.LEGACY_UNVERIFIED,
        -> true

        PublicationState.CANCELLED -> job.publicationCancelRequested && !job.cleanupPending
        PublicationState.PARTIAL -> job.publicationCancelRequested && !job.cleanupPending
        PublicationState.PREPARED,
        PublicationState.PUBLISHING,
        PublicationState.PUBLISHED,
        PublicationState.CANCEL_PENDING,
        -> false
    }

    private fun hasTerminalPublicationCleanup(job: TransferJob): Boolean = when (job.publicationState) {
        PublicationState.PUBLISHED,
        PublicationState.CANCELLED,
        -> true

        PublicationState.PARTIAL -> job.publicationCancelRequested
        else -> false
    }

    private fun requirePublicationIdentity(job: TransferJob, publicationId: String) {
        require(job.direction == TransferDirection.INCOMING) { "Only incoming transfers can be published." }
        require(job.publicationId == publicationId) { "publicationId does not match the transfer job." }
        require(job.publicationBackend != null && job.publicationRootToken != null) {
            "Publication identity is incomplete."
        }
    }

    private fun normalizeFailureReason(state: TransferJobState, value: String?): String? {
        if (state != TransferJobState.FAILED) {
            require(value == null) { "failureReason is only valid for failed transfers." }
            return null
        }
        val normalized = value?.trim()
        require(!normalized.isNullOrEmpty() && normalized.length <= MAX_FAILURE_REASON_LENGTH) {
            "Failed transfers require a bounded failureReason."
        }
        requireSafeText(normalized, "failureReason")
        return normalized
    }

    private fun normalizePublicationError(state: PublicationState, value: String?): String? {
        if (value == null) return null
        require(state in ERROR_PUBLICATION_STATES) {
            "publicationError is only valid while publication requires recovery."
        }
        val normalized = value.trim()
        require(normalized.isNotEmpty() && normalized.length <= MAX_PUBLICATION_ERROR_LENGTH) {
            "publicationError must be non-empty and bounded."
        }
        requireSafeText(normalized, "publicationError")
        return normalized
    }

    private fun normalizePublicationId(value: String): String {
        require(PUBLICATION_ID.matches(value)) {
            "publicationId must be a bounded portable identifier."
        }
        return value
    }

    private fun normalizeRootToken(value: String): String {
        require(value == value.trim() && value.isNotEmpty() && value.length <= MAX_ROOT_TOKEN_LENGTH) {
            "publicationRootToken must be non-empty and bounded."
        }
        requireSafeText(value, "publicationRootToken")
        return value
    }

    private fun requireSafeText(value: String, label: String) {
        require(value.none { it == '\u0000' || (it.code < 0x20 && it != '\n' && it != '\r' && it != '\t') }) {
            "$label contains unsupported control characters."
        }
    }

    private inline fun <reified T : Enum<T>> parseEnum(value: String, message: String): T = try {
        enumValueOf<T>(value)
    } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException(message)
    }

    private fun requireTimestamp(value: Long, label: String) {
        require(value in 1..MAX_SAFE_INTEGER) { "$label must be a positive safe integer." }
    }

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private const val MAX_FAILURE_REASON_LENGTH = 1_024
        private const val MAX_PUBLICATION_ERROR_LENGTH = 2_048
        private const val MAX_ROOT_TOKEN_LENGTH = 4_096
        private const val CORRUPT_ROW_REASON = "Stored transfer record is invalid."
        private val PEER_ID = Regex("^[a-f0-9]{16}$")
        private val PUBLICATION_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
        private val TERMINAL_STATES = setOf(TransferJobState.COMPLETED, TransferJobState.CANCELLED)
        private val FULLY_RECEIVED_PUBLICATION_STATES = setOf(
            PublicationState.PREPARED,
            PublicationState.PUBLISHING,
            PublicationState.PARTIAL,
            PublicationState.PUBLISHED,
            PublicationState.CANCEL_PENDING,
            PublicationState.CANCELLED,
        )
        private val ERROR_PUBLICATION_STATES = setOf(
            PublicationState.PUBLISHING,
            PublicationState.RECONCILE_REQUIRED,
            PublicationState.PARTIAL,
            PublicationState.CANCEL_PENDING,
        )
        private val ALLOWED_TRANSITIONS = mapOf(
            TransferJobState.QUEUED to setOf(
                TransferJobState.TRANSFERRING,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.AWAITING_APPROVAL to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.TRANSFERRING to setOf(
                TransferJobState.PAUSED,
                TransferJobState.FAILED,
                TransferJobState.COMPLETED,
                TransferJobState.CANCELLED,
            ),
            TransferJobState.PAUSED to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
                TransferJobState.FAILED,
            ),
            TransferJobState.FAILED to setOf(
                TransferJobState.QUEUED,
                TransferJobState.CANCELLED,
            ),
            TransferJobState.COMPLETED to emptySet(),
            TransferJobState.CANCELLED to emptySet(),
        )
    }
}
