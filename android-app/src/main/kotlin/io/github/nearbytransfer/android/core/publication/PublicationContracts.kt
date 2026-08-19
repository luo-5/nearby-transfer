package io.github.nearbytransfer.android.core.publication

import java.io.InputStream

/**
 * Durable journal boundary. compareAndSet must atomically replace exactly one revision.
 * Implementations are expected to persist every intent before a provider side effect.
 */
interface PublicationJournal {
    fun create(record: PublicationRecord): Boolean
    fun load(publicationId: String): PublicationRecord?
    fun compareAndSet(publicationId: String, expectedRevision: Long, updated: PublicationRecord): Boolean
}

/**
 * A fresh, one-shot sealed source. This mirrors V2EncryptedChunkWriter.VerifiedSource semantics:
 * open once, consume to EOF, and close before the backend returns from write.
 */
interface PublicationSource {
    val relativePath: String
    val size: Long
    fun open(): InputStream
}

/** Reopens app-private sealed staging data after process restart. */
fun interface PublicationSourceProvider {
    fun sourceFor(plan: PublicationPlan, file: PublicationFileSpec): PublicationSource
}

enum class BackendObjectState {
    ABSENT,
    ALLOCATED,
    WRITTEN,
    PUBLISHED,
    CONFLICT,
}

/** What the backend can currently prove about one idempotency key. */
data class BackendInspection(
    val state: BackendObjectState,
    val targetToken: String? = null,
    val size: Long? = null,
    val sha256: String? = null,
) {
    companion object {
        fun absent(): BackendInspection = BackendInspection(BackendObjectState.ABSENT)
    }
}

/**
 * Per-file backend. Mutating calls must be idempotent for PublicationFileKey and must never replace
 * an unrelated destination. No method may assume or advertise multi-file atomic publication.
 */
interface PublicationBackend {
    val backendId: String

    fun inspect(key: PublicationFileKey): BackendInspection

    fun allocate(
        key: PublicationFileKey,
        relativePath: String,
        expectedSize: Long,
        expectedSha256: String,
    ): BackendInspection

    fun write(
        key: PublicationFileKey,
        targetToken: String,
        source: PublicationSource,
    ): BackendInspection

    fun publish(key: PublicationFileKey, targetToken: String): BackendInspection

    fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection
}

open class PublicationException(message: String, cause: Throwable? = null) : Exception(message, cause)

class PublicationConflictException(message: String) : PublicationException(message)
class PublicationIntegrityException(message: String) : PublicationException(message)
