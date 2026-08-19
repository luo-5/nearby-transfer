package io.github.nearbytransfer.android.core.publication

import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.UPSIDE_DOWN_CAKE])
class SafTreePublicationBackendTest {
    private lateinit var context: Context
    private lateinit var provider: FakeTreeProvider
    private lateinit var treeUri: Uri
    private lateinit var backend: SafTreePublicationBackend

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("nearby_transfer_saf_publication_v1", Context.MODE_PRIVATE)
            .edit().clear().commit()
        val authority = "io.github.nearbytransfer.test.saf.${NEXT_AUTHORITY.incrementAndGet()}"
        provider = FakeTreeProvider(authority)
        provider.attachInfo(context, ProviderInfo().apply {
            this.authority = authority
            exported = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
            grantUriPermissions = true
        })
        ShadowContentResolver.registerProviderInternal(authority, provider)
        treeUri = DocumentsContract.buildTreeDocumentUri(authority, FakeTreeProvider.ROOT_ID)
        backend = SafTreePublicationBackend(context, context.contentResolver, treeUri)
    }

    @Test
    fun repeatedOperationsPublishNestedPathWithoutDuplicates() {
        val bytes = "nested SAF payload".toByteArray()
        val key = PublicationFileKey("publication-repeat", 0)
        val hash = sha256(bytes)

        val first = backend.allocate(key, "reports/2026/result.txt", bytes.size.toLong(), hash)
        val second = backend.allocate(key, "reports/2026/result.txt", bytes.size.toLong(), hash)
        assertEquals(BackendObjectState.ALLOCATED, first.state)
        assertEquals(first.targetToken, second.targetToken)

        val source = TrackingSource("reports/2026/result.txt", bytes.size.toLong(), bytes)
        assertEquals(BackendObjectState.WRITTEN, backend.write(key, first.targetToken!!, source).state)
        assertEquals(1, source.openCount)
        assertEquals(1, source.closeCount)

        val restarted = SafTreePublicationBackend(context, context.contentResolver, treeUri)
        assertEquals(BackendObjectState.WRITTEN, restarted.inspect(key).state)
        val published = restarted.publish(key, first.targetToken!!)
        assertEquals(BackendObjectState.PUBLISHED, published.state)
        assertEquals(published, restarted.publish(key, first.targetToken!!))
        assertEquals(published, restarted.inspect(key))
        assertArrayEquals(bytes, provider.bytesAt("reports/2026/result.txt"))
        assertEquals(1, provider.countAt("reports/2026/result.txt"))
    }

    @Test
    fun existingDestinationAndDirectoryFileConflictAreNeverOverwritten() {
        val unrelated = "leave me alone".toByteArray()
        provider.seed("reports/result.txt", unrelated)
        val key = PublicationFileKey("publication-conflict", 0)
        val allocated = backend.allocate(key, "reports/result.txt", unrelated.size.toLong(), sha256(unrelated))
        assertEquals(BackendObjectState.CONFLICT, allocated.state)
        assertArrayEquals(unrelated, provider.bytesAt("reports/result.txt"))

        provider.seed("blocked", "not a directory".toByteArray())
        assertThrows(PublicationConflictException::class.java) {
            backend.allocate(
                PublicationFileKey("publication-directory-conflict", 0),
                "blocked/file.bin",
                1,
                sha256(byteArrayOf(1)),
            )
        }
        assertArrayEquals("not a directory".toByteArray(), provider.bytesAt("blocked"))
    }

    @Test
    fun renameSideEffectIsRecoveredAfterProcessCrash() {
        val bytes = "recover after rename".toByteArray()
        val key = PublicationFileKey("publication-rename-crash", 0)
        val allocated = backend.allocate(key, "folder/final.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(key, allocated.targetToken!!, TrackingSource("folder/final.bin", bytes.size.toLong(), bytes))

        provider.throwAfterNextRename = true
        assertThrows(PublicationException::class.java) {
            backend.publish(key, allocated.targetToken!!)
        }
        val restarted = SafTreePublicationBackend(context, context.contentResolver, treeUri)
        assertEquals(BackendObjectState.PUBLISHED, restarted.inspect(key).state)
        assertEquals(BackendObjectState.PUBLISHED, restarted.publish(key, allocated.targetToken!!).state)
        assertArrayEquals(bytes, provider.bytesAt("folder/final.bin"))
    }

    @Test
    fun unsupportedRenameFailsClosedAndCanRetry() {
        val bytes = "rename later".toByteArray()
        val key = PublicationFileKey("publication-rename-unsupported", 0)
        val allocated = backend.allocate(key, "later.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(key, allocated.targetToken!!, TrackingSource("later.bin", bytes.size.toLong(), bytes))

        provider.renameSupported = false
        assertThrows(PublicationException::class.java) {
            backend.publish(key, allocated.targetToken!!)
        }
        assertFalse(provider.exists("later.bin"))
        assertEquals(BackendObjectState.WRITTEN, backend.inspect(key).state)

        provider.renameSupported = true
        assertEquals(BackendObjectState.PUBLISHED, backend.publish(key, allocated.targetToken!!).state)
        assertArrayEquals(bytes, provider.bytesAt("later.bin"))
    }

    @Test
    fun abortDeletesOnlyOwnedUnpublishedObjects() {
        val unrelated = provider.seed("keep.txt", "keep".toByteArray())
        val bytes = "cancel me".toByteArray()
        val key = PublicationFileKey("publication-cancel", 0)
        val allocated = backend.allocate(key, "cancel/me.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(key, allocated.targetToken!!, TrackingSource("cancel/me.bin", bytes.size.toLong(), bytes))

        assertEquals(BackendObjectState.ABSENT, backend.abort(key, allocated.targetToken).state)
        assertEquals(BackendObjectState.ABSENT, backend.abort(key, allocated.targetToken).state)
        assertTrue(provider.exists("keep.txt"))
        assertArrayEquals("keep".toByteArray(), provider.bytes(unrelated))
        assertFalse(provider.exists("cancel/me.bin"))

        val publishedKey = PublicationFileKey("publication-cancel", 1)
        val published = backend.allocate(
            publishedKey,
            "published.bin",
            bytes.size.toLong(),
            sha256(bytes),
        )
        backend.write(
            publishedKey,
            published.targetToken!!,
            TrackingSource("published.bin", bytes.size.toLong(), bytes),
        )
        backend.publish(publishedKey, published.targetToken!!)
        assertEquals(BackendObjectState.PUBLISHED, backend.abort(publishedKey, published.targetToken).state)
        assertArrayEquals(bytes, provider.bytesAt("published.bin"))
    }

    @Test
    fun forgedStagingReplacementIsNeverOverwrittenOrDeleted() {
        val bytes = "owned payload".toByteArray()
        val forgedBytes = "external replacement".toByteArray()
        val key = PublicationFileKey("publication-forged-staging", 0)
        val allocated = backend.allocate(key, "forged.bin", bytes.size.toLong(), sha256(bytes))
        val forged = provider.replaceOnlyNamed("payload.part", forgedBytes)

        assertThrows(PublicationConflictException::class.java) {
            backend.write(
                key,
                allocated.targetToken!!,
                TrackingSource("forged.bin", bytes.size.toLong(), bytes),
            )
        }
        assertArrayEquals(forgedBytes, provider.bytes(forged))

        assertThrows(PublicationConflictException::class.java) {
            backend.abort(key, allocated.targetToken)
        }
        assertArrayEquals(forgedBytes, provider.bytes(forged))
    }

    @Test
    fun forgedMarkerReplacementIsNeverOverwrittenOrDeleted() {
        val bytes = "owned payload".toByteArray()
        val forgedBytes = "external marker".toByteArray()
        val key = PublicationFileKey("publication-forged-marker", 0)
        val allocated = backend.allocate(key, "forged-marker.bin", bytes.size.toLong(), sha256(bytes))
        val forged = provider.replaceOnlyNamed("record.json", forgedBytes)

        assertThrows(PublicationConflictException::class.java) {
            backend.write(
                key,
                allocated.targetToken!!,
                TrackingSource("forged-marker.bin", bytes.size.toLong(), bytes),
            )
        }
        assertArrayEquals(forgedBytes, provider.bytes(forged))

        assertThrows(PublicationConflictException::class.java) {
            backend.abort(key, allocated.targetToken)
        }
        assertArrayEquals(forgedBytes, provider.bytes(forged))
    }

    @Test
    fun abortConfirmsPayloadDeletionAfterProviderThrows() {
        val bytes = "resume abort".toByteArray()
        val key = PublicationFileKey("publication-abort-resume", 0)
        val allocated = backend.allocate(key, "cancel/resume.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("cancel/resume.bin", bytes.size.toLong(), bytes),
        )

        provider.throwAfterDeletingName = "payload.part"
        assertEquals(BackendObjectState.ABSENT, backend.abort(key, allocated.targetToken).state)
        assertEquals(0, provider.countNamed("payload.part"))
        assertEquals(0, provider.countNamed("record.json"))

        val restarted = SafTreePublicationBackend(context, context.contentResolver, treeUri)
        assertEquals(BackendObjectState.ABSENT, restarted.abort(key, allocated.targetToken).state)
        assertEquals(0, provider.countNamed("payload.part"))
        assertEquals(0, provider.countNamed("record.json"))
        assertEquals(BackendObjectState.ABSENT, restarted.abort(key, allocated.targetToken).state)
    }


    @Test
    fun publishedStagingCleanupRetriesAfterProviderFailures() {
        listOf("payload", "marker", "directory").forEachIndexed { index, stage ->
            val bytes = "published cleanup $stage".toByteArray()
            val key = PublicationFileKey("publication-published-cleanup-$stage", index)
            val relativePath = "cleanup/$stage.bin"
            val allocated = backend.allocate(key, relativePath, bytes.size.toLong(), sha256(bytes))
            backend.write(
                key,
                allocated.targetToken!!,
                TrackingSource(relativePath, bytes.size.toLong(), bytes),
            )
            val failedName = when (stage) {
                "payload" -> "payload.part"
                "marker" -> "record.json"
                else -> provider.lastNameStartingWith("f-")
            }
            provider.throwBeforeDeletingName = failedName

            assertThrows(PublicationException::class.java) {
                backend.publish(key, allocated.targetToken!!)
            }
            assertArrayEquals(bytes, provider.bytesAt(relativePath))
            assertTrue(provider.countNamed(failedName) > 0)
            assertTrue(ownershipRecords().isNotEmpty())

            val restarted = SafTreePublicationBackend(context, context.contentResolver, treeUri)
            assertEquals(BackendObjectState.PUBLISHED, restarted.publish(key, allocated.targetToken!!).state)
            assertEquals(0, provider.countNamed("payload.part"))
            assertEquals(0, provider.countNamed("record.json"))
            assertEquals(0, provider.countNamed(failedName))
            assertArrayEquals(bytes, provider.bytesAt(relativePath))
        }
    }

    @Test
    fun abortKeepsOwnershipWhenOwnedPayloadWasMoved() {
        val bytes = "moved owned payload".toByteArray()
        val key = PublicationFileKey("publication-moved-payload", 0)
        val allocated = backend.allocate(key, "moved/payload.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("moved/payload.bin", bytes.size.toLong(), bytes),
        )
        val moved = provider.moveOnlyNamed("payload.part", FakeTreeProvider.ROOT_ID, "moved-payload.bin")

        assertThrows(PublicationConflictException::class.java) {
            backend.abort(key, allocated.targetToken)
        }
        assertArrayEquals(bytes, provider.bytes(moved))
        assertTrue(ownershipRecords().isNotEmpty())
    }

    @Test
    fun abortKeepsOwnershipWhenOwnedTemporaryWasMoved() {
        val bytes = "moved owned temporary".toByteArray()
        val key = PublicationFileKey("publication-moved-temporary", 0)
        val allocated = backend.allocate(key, "moved/temporary.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("moved/temporary.bin", bytes.size.toLong(), bytes),
        )
        provider.renameSupported = false
        assertThrows(PublicationException::class.java) {
            backend.publish(key, allocated.targetToken!!)
        }
        val moved = provider.moveOnlyNameStartingWith(
            ".nearby-transfer-",
            FakeTreeProvider.ROOT_ID,
            "moved-temporary.part",
        )

        assertThrows(PublicationConflictException::class.java) {
            backend.abort(key, allocated.targetToken)
        }
        assertArrayEquals(bytes, provider.bytes(moved))
        assertTrue(ownershipRecords().isNotEmpty())
    }

    @Test
    fun renameReturningNewDocumentIdRemainsProvablyPublished() {
        val bytes = "provider changes rename id".toByteArray()
        val key = PublicationFileKey("publication-renamed-id", 0)
        val allocated = backend.allocate(key, "renamed-id.bin", bytes.size.toLong(), sha256(bytes))
        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("renamed-id.bin", bytes.size.toLong(), bytes),
        )
        provider.renameChangesDocumentId = true

        assertEquals(BackendObjectState.PUBLISHED, backend.publish(key, allocated.targetToken!!).state)
        val restarted = SafTreePublicationBackend(context, context.contentResolver, treeUri)
        assertEquals(BackendObjectState.PUBLISHED, restarted.inspect(key).state)
        assertArrayEquals(bytes, provider.bytesAt("renamed-id.bin"))
    }

    @Test
    fun partialAndExceptionalSourcesCloseAndRemainRecoverable() {
        val bytes = "complete source".toByteArray()
        val key = PublicationFileKey("publication-source", 0)
        val allocated = backend.allocate(key, "source.bin", bytes.size.toLong(), sha256(bytes))
        val partial = TrackingSource("source.bin", bytes.size.toLong(), bytes.copyOf(bytes.size - 2))
        assertThrows(PublicationIntegrityException::class.java) {
            backend.write(key, allocated.targetToken!!, partial)
        }
        assertEquals(1, partial.closeCount)
        assertEquals(BackendObjectState.ALLOCATED, backend.inspect(key).state)

        val closeFailure = TrackingSource("source.bin", bytes.size.toLong(), bytes, throwOnClose = true)
        assertThrows(PublicationException::class.java) {
            backend.write(key, allocated.targetToken!!, closeFailure)
        }
        assertEquals(1, closeFailure.closeCount)
        assertEquals(BackendObjectState.WRITTEN, backend.inspect(key).state)
        assertEquals(BackendObjectState.PUBLISHED, backend.publish(key, allocated.targetToken!!).state)
    }

    @Test
    fun unsafeOrNonNormalizedPathsAreRejected() {
        val hash = sha256(byteArrayOf(1))
        listOf("../escape", "/absolute", "a\\b", "a//b", "e\u0301.txt").forEachIndexed { index, path ->
            assertThrows(IllegalArgumentException::class.java) {
                backend.allocate(PublicationFileKey("bad-path", index), path, 1, hash)
            }
        }
    }

    private fun ownershipRecords() =
        context.getSharedPreferences("nearby_transfer_saf_publication_v1", Context.MODE_PRIVATE).all

    private class TrackingSource(
        override val relativePath: String,
        private val declaredSize: Long,
        private val bytes: ByteArray,
        private val throwOnClose: Boolean = false,
    ) : PublicationSource {
        override val size get() = declaredSize
        var openCount = 0
        var closeCount = 0

        override fun open(): InputStream {
            openCount++
            return object : FilterInputStream(ByteArrayInputStream(bytes)) {
                override fun close() {
                    closeCount++
                    super.close()
                    if (throwOnClose) throw IOException("simulated close failure")
                }
            }
        }
    }

    private class FakeTreeProvider(private val authority: String) : DocumentsProvider() {
        private data class Node(
            val id: String,
            var parentId: String?,
            var name: String,
            val mimeType: String,
            val file: File?,
        )

        private val nodes = linkedMapOf<String, Node>()
        private var nextId = 1
        var throwAfterNextRename = false
        var renameSupported = true
        var renameChangesDocumentId = false
        var throwBeforeDeletingName: String? = null
        var throwAfterDeletingName: String? = null

        override fun onCreate(): Boolean {
            nodes[ROOT_ID] = Node(
                ROOT_ID,
                null,
                "root",
                DocumentsContract.Document.MIME_TYPE_DIR,
                null,
            )
            return true
        }

        override fun queryRoots(projection: Array<out String>?): Cursor {
            val columns = projection?.map { it }?.toTypedArray() ?: ROOT_COLUMNS
            return MatrixCursor(columns).apply {
                val row = newRow()
                columns.forEach { column ->
                    row.add(when (column) {
                        DocumentsContract.Root.COLUMN_ROOT_ID -> ROOT_ID
                        DocumentsContract.Root.COLUMN_DOCUMENT_ID -> ROOT_ID
                        DocumentsContract.Root.COLUMN_TITLE -> "Test tree"
                        DocumentsContract.Root.COLUMN_FLAGS ->
                            DocumentsContract.Root.FLAG_SUPPORTS_CREATE or DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD
                        else -> null
                    })
                }
            }
        }

        override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
            val columns = projection?.map { it }?.toTypedArray() ?: DOCUMENT_COLUMNS
            return MatrixCursor(columns).apply { addNode(requireNode(documentId), columns) }
        }

        override fun queryChildDocuments(
            parentDocumentId: String,
            projection: Array<out String>?,
            sortOrder: String?,
        ): Cursor {
            requireNode(parentDocumentId)
            val columns = projection?.map { it }?.toTypedArray() ?: DOCUMENT_COLUMNS
            return MatrixCursor(columns).apply {
                nodes.values.filter { it.parentId == parentDocumentId }.forEach { addNode(it, columns) }
            }
        }

        override fun openDocument(
            documentId: String,
            mode: String,
            signal: CancellationSignal?,
        ): ParcelFileDescriptor {
            val file = requireNotNull(requireNode(documentId).file) { "Cannot open directory" }
            val flags = when {
                'w' in mode -> ParcelFileDescriptor.MODE_CREATE or
                    ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_TRUNCATE
                else -> ParcelFileDescriptor.MODE_READ_ONLY
            }
            return ParcelFileDescriptor.open(file, flags)
        }

        override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
            val parent = requireNode(parentDocumentId)
            require(parent.mimeType == DocumentsContract.Document.MIME_TYPE_DIR)
            if (nodes.values.any { it.parentId == parentDocumentId && it.name == displayName }) {
                throw IOException("duplicate name")
            }
            val id = "doc-${nextId++}"
            val file = if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) null else
                File(context!!.cacheDir, "fake-saf-$authority-$id.bin").apply {
                    parentFile?.mkdirs()
                    writeBytes(ByteArray(0))
                }
            nodes[id] = Node(id, parentDocumentId, displayName, mimeType, file)
            return id
        }

        override fun renameDocument(documentId: String, displayName: String): String {
            if (!renameSupported) throw UnsupportedOperationException("rename unsupported")
            val node = requireNode(documentId)
            if (nodes.values.any { it.id != documentId && it.parentId == node.parentId && it.name == displayName }) {
                throw IOException("duplicate destination")
            }
            node.name = displayName
            val renamedId = if (renameChangesDocumentId) {
                val replacementId = "doc-${nextId++}"
                nodes.remove(documentId)
                nodes[replacementId] = Node(
                    replacementId,
                    node.parentId,
                    displayName,
                    node.mimeType,
                    node.file,
                )
                replacementId
            } else {
                documentId
            }
            if (throwAfterNextRename) {
                throwAfterNextRename = false
                throw IOException("simulated crash after rename")
            }
            return renamedId
        }

        override fun deleteDocument(documentId: String) {
            val deletedName = requireNode(documentId).name
            if (throwBeforeDeletingName == deletedName) {
                throwBeforeDeletingName = null
                throw IOException("simulated failure before deleting $deletedName")
            }
            val descendants = mutableListOf(documentId)
            var index = 0
            while (index < descendants.size) {
                val parent = descendants[index++]
                descendants += nodes.values.filter { it.parentId == parent }.map { it.id }
            }
            descendants.asReversed().forEach { nodes.remove(it)?.file?.delete() }
            if (throwAfterDeletingName == deletedName) {
                throwAfterDeletingName = null
                throw IOException("simulated crash after deleting $deletedName")
            }
        }

        override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
            if (documentId !in nodes) return parentDocumentId == ROOT_ID
            var current = nodes[documentId]
            while (current != null) {
                if (current.parentId == parentDocumentId) return true
                current = current.parentId?.let(nodes::get)
            }
            return false
        }

        fun seed(relativePath: String, bytes: ByteArray): Uri {
            val parts = relativePath.split('/')
            var parent = ROOT_ID
            parts.dropLast(1).forEach { name ->
                val existing = nodes.values.singleOrNull { it.parentId == parent && it.name == name }
                parent = existing?.id ?: createDocument(
                    parent,
                    DocumentsContract.Document.MIME_TYPE_DIR,
                    name,
                )
            }
            val id = createDocument(parent, "application/octet-stream", parts.last())
            requireNode(id).file!!.writeBytes(bytes)
            return DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(authority, ROOT_ID),
                id,
            )
        }

        fun replaceOnlyNamed(name: String, bytes: ByteArray): Uri {
            val original = nodes.values.single { it.name == name }
            val parentId = requireNotNull(original.parentId)
            nodes.remove(original.id)?.file?.delete()
            val replacementId = createDocument(parentId, original.mimeType, name)
            requireNode(replacementId).file!!.writeBytes(bytes)
            return DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(authority, ROOT_ID),
                replacementId,
            )
        }

        fun moveOnlyNamed(name: String, newParentId: String, newName: String): Uri {
            val node = nodes.values.single { it.name == name }
            requireNode(newParentId)
            node.parentId = newParentId
            node.name = newName
            return DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(authority, ROOT_ID),
                node.id,
            )
        }

        fun moveOnlyNameStartingWith(prefix: String, newParentId: String, newName: String): Uri {
            val node = nodes.values.single { it.file != null && it.name.startsWith(prefix) }
            return moveOnlyNamed(node.name, newParentId, newName)
        }

        fun lastNameStartingWith(prefix: String): String =
            nodes.values.last { it.name.startsWith(prefix) }.name

        fun countNamed(name: String): Int = nodes.values.count { it.name == name }

        fun exists(relativePath: String): Boolean = nodeAt(relativePath) != null
        fun countAt(relativePath: String): Int {
            val parts = relativePath.split('/')
            val parent = nodeAt(parts.dropLast(1).joinToString("/")) ?: nodes[ROOT_ID]
            return nodes.values.count { it.parentId == parent?.id && it.name == parts.last() }
        }
        fun bytesAt(relativePath: String): ByteArray = requireNotNull(nodeAt(relativePath)).file!!.readBytes()
        fun bytes(uri: Uri): ByteArray = requireNode(DocumentsContract.getDocumentId(uri)).file!!.readBytes()

        private fun nodeAt(relativePath: String): Node? {
            if (relativePath.isEmpty()) return nodes[ROOT_ID]
            var current = nodes[ROOT_ID]
            relativePath.split('/').forEach { name ->
                current = nodes.values.singleOrNull { it.parentId == current?.id && it.name == name }
                    ?: return null
            }
            return current
        }

        private fun requireNode(id: String) = nodes[id] ?: throw java.io.FileNotFoundException(id)

        private fun MatrixCursor.addNode(node: Node, columns: Array<String>) {
            val row = newRow()
            columns.forEach { column ->
                row.add(when (column) {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID -> node.id
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME -> node.name
                    DocumentsContract.Document.COLUMN_MIME_TYPE -> node.mimeType
                    DocumentsContract.Document.COLUMN_SIZE -> node.file?.length()
                    DocumentsContract.Document.COLUMN_FLAGS -> if (node.mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
                        DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE or
                            DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
                            DocumentsContract.Document.FLAG_SUPPORTS_RENAME
                    } else {
                        DocumentsContract.Document.FLAG_SUPPORTS_WRITE or
                            DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
                            DocumentsContract.Document.FLAG_SUPPORTS_RENAME
                    }
                    else -> null
                })
            }
        }

        companion object {
            const val ROOT_ID = "root"
            val DOCUMENT_COLUMNS = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            val ROOT_COLUMNS = arrayOf(
                DocumentsContract.Root.COLUMN_ROOT_ID,
                DocumentsContract.Root.COLUMN_DOCUMENT_ID,
                DocumentsContract.Root.COLUMN_TITLE,
                DocumentsContract.Root.COLUMN_FLAGS,
            )
        }
    }

    companion object {
        private val NEXT_AUTHORITY = AtomicInteger()
        private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }
}
