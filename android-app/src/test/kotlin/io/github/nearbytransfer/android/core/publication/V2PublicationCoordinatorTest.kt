package io.github.nearbytransfer.android.core.publication

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class V2PublicationCoordinatorTest {
    @Test
    fun allocateAfterSideEffectCrashIsRecoveredByInspection() {
        val fixture = fixture("alpha")
        fixture.backend.crashAfter(Operation.ALLOCATE, 0)

        assertThrows(SimulatedCrash::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }
        assertEquals(PublicationFileState.ALLOCATING, fixture.record().files[0].state)
        assertEquals(BackendObjectState.ALLOCATED, fixture.backend.inspect(key(0)).state)

        val result = fixture.coordinator.recover(PUBLICATION_ID)

        assertEquals(PublicationState.PUBLISHED, result.state)
        assertEquals(1, fixture.backend.calls(Operation.ALLOCATE, 0))
        assertEquals(1, fixture.backend.calls(Operation.WRITE, 0))
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
        assertTrue(fixture.backend.inspectCalls(0) >= 2)
    }

    @Test
    fun writeAfterSideEffectBeforeReceiptCrashDoesNotRewrite() {
        val fixture = fixture("bravo")
        fixture.backend.crashAfter(Operation.WRITE, 0)

        assertThrows(SimulatedCrash::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }
        assertEquals(PublicationFileState.WRITING, fixture.record().files[0].state)
        assertEquals(BackendObjectState.WRITTEN, fixture.backend.inspect(key(0)).state)

        assertEquals(PublicationState.PUBLISHED, fixture.coordinator.recover(PUBLICATION_ID).state)
        assertEquals(1, fixture.backend.calls(Operation.WRITE, 0))
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
    }

    @Test
    fun publishAfterSideEffectBeforeReceiptCrashDoesNotRepublish() {
        val fixture = fixture("charlie")
        fixture.backend.crashAfter(Operation.PUBLISH, 0)

        assertThrows(SimulatedCrash::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }
        assertEquals(PublicationFileState.PUBLISHING, fixture.record().files[0].state)
        assertEquals(BackendObjectState.PUBLISHED, fixture.backend.inspect(key(0)).state)

        assertEquals(PublicationState.PUBLISHED, fixture.coordinator.recover(PUBLICATION_ID).state)
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
        assertArrayEquals("charlie".toByteArray(), fixture.backend.visibleBytes(0))
    }

    @Test
    fun cancellationAfterFinalPublishSideEffectStillCommitsPublishedReceipt() {
        val fixture = fixture("already-published", "late-cancellation")
        fixture.backend.afterSideEffect(Operation.PUBLISH, 1) {
            fixture.coordinator.requestCancellation(PUBLICATION_ID)
        }

        val result = fixture.coordinator.recover(PUBLICATION_ID)
        val record = fixture.record()

        assertEquals(PublicationState.PUBLISHED, result.state)
        assertEquals(PublicationState.PUBLISHED, record.state)
        assertFalse(record.cancelRequested)
        assertFalse(record.cleanupPending)
        assertTrue(record.files.all { it.state == PublicationFileState.PUBLISHED })
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 1))
        assertArrayEquals("already-published".toByteArray(), fixture.backend.visibleBytes(0))
        assertArrayEquals("late-cancellation".toByteArray(), fixture.backend.visibleBytes(1))

        assertEquals(PublicationState.PUBLISHED, fixture.coordinator.recover(PUBLICATION_ID).state)
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 1))
    }

    @Test
    fun completedRecoveryIsRepeatableAndSideEffectFree() {
        val fixture = fixture("delta")
        fixture.coordinator.recover(PUBLICATION_ID)
        val calls = fixture.backend.mutationCalls()
        val revision = fixture.record().revision

        repeat(5) {
            val result = fixture.coordinator.recover(PUBLICATION_ID)
            assertEquals(PublicationState.PUBLISHED, result.state)
        }

        assertEquals(calls, fixture.backend.mutationCalls())
        assertEquals(revision, fixture.record().revision)
    }

    @Test
    fun reportsPartialVisibilityAndResumesOnlyMissingFile() {
        val fixture = fixture("echo", "foxtrot")
        fixture.backend.failBefore(Operation.PUBLISH, 1)

        assertThrows(BackendFailure::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }
        val partial = fixture.record()
        assertEquals(PublicationState.PARTIAL, partial.state)
        assertEquals(PublicationFileState.PUBLISHED, partial.files[0].state)
        assertEquals(PublicationFileState.PUBLISHING, partial.files[1].state)
        assertTrue(fixture.backend.isVisible(0))
        assertFalse(fixture.backend.isVisible(1))

        fixture.backend.clearFailure(Operation.PUBLISH, 1)
        val result = fixture.coordinator.recover(PUBLICATION_ID)

        assertEquals(PublicationState.PUBLISHED, result.state)
        assertEquals(1, fixture.backend.calls(Operation.PUBLISH, 0))
        assertEquals(2, fixture.backend.calls(Operation.PUBLISH, 1))
        assertTrue(fixture.backend.isVisible(1))
    }

    @Test
    fun cancellationKeepsPublishedFileAndRetriesFailedCleanup() {
        val fixture = fixture("golf", "hotel")
        fixture.backend.crashAfter(Operation.ALLOCATE, 1)

        assertThrows(SimulatedCrash::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }
        assertTrue(fixture.backend.isVisible(0))
        assertEquals(BackendObjectState.ALLOCATED, fixture.backend.inspect(key(1)).state)

        fixture.coordinator.requestCancellation(PUBLICATION_ID)
        fixture.backend.failBefore(Operation.ABORT, 1)
        assertThrows(BackendFailure::class.java) { fixture.coordinator.recover(PUBLICATION_ID) }

        val pending = fixture.record()
        assertEquals(PublicationState.CANCEL_PENDING, pending.state)
        assertTrue(pending.cleanupPending)
        assertEquals(PublicationFileState.PUBLISHED, pending.files[0].state)
        assertEquals(PublicationFileState.ABORTING, pending.files[1].state)
        assertTrue(fixture.backend.isVisible(0))

        fixture.backend.clearFailure(Operation.ABORT, 1)
        val cancelled = fixture.coordinator.recover(PUBLICATION_ID)

        assertEquals(PublicationState.PARTIAL, cancelled.state)
        assertFalse(cancelled.cleanupPending)
        assertEquals(BackendObjectState.ABSENT, fixture.backend.inspect(key(1)).state)
        assertTrue(fixture.backend.isVisible(0))

        val abortCalls = fixture.backend.calls(Operation.ABORT, 1)
        fixture.coordinator.recover(PUBLICATION_ID)
        assertEquals(abortCalls, fixture.backend.calls(Operation.ABORT, 1))
    }

    @Test
    fun backendMustFullyConsumeAndCloseSealedSource() {
        val fixture = fixture("india")
        fixture.backend.ignoreSource = true

        assertThrows(PublicationIntegrityException::class.java) {
            fixture.coordinator.recover(PUBLICATION_ID)
        }
        assertEquals(PublicationFileState.WRITING, fixture.record().files[0].state)
        assertFalse(fixture.backend.isVisible(0))
    }

    @Test
    fun backendFailureAfterOpeningSourceStillClosesTheStream() {
        val fixture = fixture("juliet")
        fixture.backend.failAfterOpeningSource = true

        assertThrows(BackendFailure::class.java) {
            fixture.coordinator.recover(PUBLICATION_ID)
        }

        assertEquals(1, fixture.sources.getValue(0).closeCount)
        assertEquals(PublicationFileState.WRITING, fixture.record().files[0].state)
        assertFalse(fixture.backend.isVisible(0))
    }

    private fun fixture(vararg content: String): Fixture {
        val bytes = content.map { it.toByteArray() }
        val plan = PublicationPlan(
            publicationId = PUBLICATION_ID,
            taskId = "task-1",
            backendId = BACKEND_ID,
            files = bytes.mapIndexed { index, value ->
                PublicationFileSpec(index, "folder/file-$index.bin", value.size.toLong(), sha256(value))
            },
        )
        val journal = MemoryPublicationJournal()
        val backend = FakePublicationBackend()
        val byIndex = bytes.withIndex().associate { it.index to it.value }
        val sourceByIndex = byIndex.mapValues { (index, value) ->
            ByteArrayPublicationSource(plan.files[index].relativePath, value)
        }
        val sources = PublicationSourceProvider { _, file -> sourceByIndex.getValue(file.index) }
        val coordinator = V2PublicationCoordinator(journal, backend, sources)
        coordinator.prepare(plan)
        return Fixture(journal, backend, coordinator, sourceByIndex)
    }

    private data class Fixture(
        val journal: MemoryPublicationJournal,
        val backend: FakePublicationBackend,
        val coordinator: V2PublicationCoordinator,
        val sources: Map<Int, ByteArrayPublicationSource>,
    ) {
        fun record(): PublicationRecord = requireNotNull(journal.load(PUBLICATION_ID))
    }

    private class MemoryPublicationJournal : PublicationJournal {
        private val records = linkedMapOf<String, PublicationRecord>()

        @Synchronized
        override fun create(record: PublicationRecord): Boolean {
            if (records.containsKey(record.plan.publicationId)) return false
            records[record.plan.publicationId] = record
            return true
        }

        @Synchronized
        override fun load(publicationId: String): PublicationRecord? = records[publicationId]

        @Synchronized
        override fun compareAndSet(
            publicationId: String,
            expectedRevision: Long,
            updated: PublicationRecord,
        ): Boolean {
            val current = records[publicationId] ?: return false
            if (current.revision != expectedRevision) return false
            require(updated.plan.publicationId == publicationId)
            require(updated.revision == expectedRevision + 1L)
            records[publicationId] = updated
            return true
        }
    }

    private class ByteArrayPublicationSource(
        override val relativePath: String,
        private val bytes: ByteArray,
    ) : PublicationSource {
        override val size: Long get() = bytes.size.toLong()
        private var opened = false
        var closeCount: Int = 0
            private set

        override fun open(): InputStream {
            check(!opened) { "source opened twice" }
            opened = true
            return object : ByteArrayInputStream(bytes) {
                override fun close() {
                    closeCount++
                    super.close()
                }
            }
        }
    }

    private class FakePublicationBackend : PublicationBackend {
        override val backendId: String = BACKEND_ID

        private data class ObjectRecord(
            val token: String,
            var bytes: ByteArray? = null,
            var published: Boolean = false,
        )

        private val objects = linkedMapOf<PublicationFileKey, ObjectRecord>()
        private val callCounts = linkedMapOf<Pair<Operation, Int>, Int>()
        private val inspectionCounts = linkedMapOf<Int, Int>()
        private val crashAfter = mutableSetOf<Pair<Operation, Int>>()
        private val failBefore = mutableSetOf<Pair<Operation, Int>>()
        private val afterSideEffect = mutableMapOf<Pair<Operation, Int>, () -> Unit>()
        var ignoreSource: Boolean = false
        var failAfterOpeningSource: Boolean = false

        fun crashAfter(operation: Operation, index: Int) {
            crashAfter += operation to index
        }

        fun failBefore(operation: Operation, index: Int) {
            failBefore += operation to index
        }

        fun afterSideEffect(operation: Operation, index: Int, action: () -> Unit) {
            afterSideEffect[operation to index] = action
        }

        fun clearFailure(operation: Operation, index: Int) {
            failBefore -= operation to index
        }

        fun calls(operation: Operation, index: Int): Int = callCounts[operation to index] ?: 0
        fun inspectCalls(index: Int): Int = inspectionCounts[index] ?: 0
        fun mutationCalls(): Map<Pair<Operation, Int>, Int> = callCounts.toMap()
        fun isVisible(index: Int): Boolean = objects[key(index)]?.published == true
        fun visibleBytes(index: Int): ByteArray? = objects[key(index)]?.takeIf { it.published }?.bytes

        override fun inspect(key: PublicationFileKey): BackendInspection {
            inspectionCounts[key.fileIndex] = inspectCalls(key.fileIndex) + 1
            val value = objects[key] ?: return BackendInspection.absent()
            val bytes = value.bytes
            return when {
                value.published -> BackendInspection(
                    BackendObjectState.PUBLISHED,
                    value.token,
                    requireNotNull(bytes).size.toLong(),
                    sha256(bytes),
                )
                bytes != null -> BackendInspection(
                    BackendObjectState.WRITTEN,
                    value.token,
                    bytes.size.toLong(),
                    sha256(bytes),
                )
                else -> BackendInspection(BackendObjectState.ALLOCATED, value.token)
            }
        }

        override fun allocate(
            key: PublicationFileKey,
            relativePath: String,
            expectedSize: Long,
            expectedSha256: String,
        ): BackendInspection = operation(Operation.ALLOCATE, key.fileIndex) {
            objects.getOrPut(key) { ObjectRecord("token-${key.publicationId}-${key.fileIndex}") }
            inspectWithoutCounting(key)
        }

        override fun write(
            key: PublicationFileKey,
            targetToken: String,
            source: PublicationSource,
        ): BackendInspection = operation(Operation.WRITE, key.fileIndex) {
            val value = requireNotNull(objects[key])
            require(value.token == targetToken)
            if (failAfterOpeningSource) {
                source.open()
                throw BackendFailure("write failed after opening source")
            }
            if (!ignoreSource) {
                val bytes = source.open().use { it.readBytes() }
                if (value.bytes != null) assertArrayEquals(requireNotNull(value.bytes), bytes)
                value.bytes = bytes
            }
            inspectWithoutCounting(key)
        }

        override fun publish(key: PublicationFileKey, targetToken: String): BackendInspection =
            operation(Operation.PUBLISH, key.fileIndex) {
                val value = requireNotNull(objects[key])
                require(value.token == targetToken)
                requireNotNull(value.bytes)
                value.published = true
                inspectWithoutCounting(key)
            }

        override fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection =
            operation(Operation.ABORT, key.fileIndex) {
                val value = objects[key]
                if (value != null && !value.published) {
                    require(targetToken == null || targetToken == value.token)
                    objects.remove(key)
                }
                inspectWithoutCounting(key)
            }

        private fun inspectWithoutCounting(key: PublicationFileKey): BackendInspection {
            val value = objects[key] ?: return BackendInspection.absent()
            val bytes = value.bytes
            return when {
                value.published -> BackendInspection(
                    BackendObjectState.PUBLISHED,
                    value.token,
                    requireNotNull(bytes).size.toLong(),
                    sha256(bytes),
                )
                bytes != null -> BackendInspection(
                    BackendObjectState.WRITTEN,
                    value.token,
                    bytes.size.toLong(),
                    sha256(bytes),
                )
                else -> BackendInspection(BackendObjectState.ALLOCATED, value.token)
            }
        }

        private fun operation(
            operation: Operation,
            index: Int,
            action: () -> BackendInspection,
        ): BackendInspection {
            val key = operation to index
            callCounts[key] = (callCounts[key] ?: 0) + 1
            if (key in failBefore) throw BackendFailure("$operation failed before side effect")
            val result = action()
            afterSideEffect.remove(key)?.invoke()
            if (crashAfter.remove(key)) throw SimulatedCrash("$operation crashed after side effect")
            return result
        }
    }

    private enum class Operation { ALLOCATE, WRITE, PUBLISH, ABORT }
    private class SimulatedCrash(message: String) : RuntimeException(message)
    private class BackendFailure(message: String) : RuntimeException(message)

    private companion object {
        const val PUBLICATION_ID = "publication-1"
        const val BACKEND_ID = "fake"

        fun key(index: Int) = PublicationFileKey(PUBLICATION_ID, index)

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }
}
