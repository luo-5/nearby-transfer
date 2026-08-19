package io.github.nearbytransfer.android.core.publication

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID

/**
 * Crash-recoverable publication into a persisted SAF tree.
 *
 * Ownership and operation phase are synchronously persisted in app-private preferences before
 * provider side effects and mirrored under a private directory in the selected tree. Bytes are
 * copied to an owned temporary destination and become visible under the requested name only via
 * renameDocument(). DocumentsProvider does not guarantee atomic rename, so unsupported or
 * name-changing providers fail closed and retain recoverable staging data.
 */
class SafTreePublicationBackend(
    context: Context,
    private val resolver: ContentResolver,
    private val treeUri: Uri,
) : PublicationBackend {
    constructor(context: Context, treeUri: Uri) : this(context, context.contentResolver, treeUri)

    private val appContext = context.applicationContext
    private val treeFingerprint = sha256(treeUri.toString()).take(24)
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val rootUri: Uri

    override val backendId = "saf-tree-v1:$treeFingerprint"

    init {
        require(treeUri.scheme == ContentResolver.SCHEME_CONTENT && DocumentsContract.isTreeUri(treeUri)) {
            "A content:// SAF tree Uri is required"
        }
        rootUri = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri),
        )
    }

    override fun inspect(key: PublicationFileKey): BackendInspection = synchronized(LOCK) {
        inspectLocked(key)
    }

    override fun allocate(
        key: PublicationFileKey,
        relativePath: String,
        expectedSize: Long,
        expectedSha256: String,
    ): BackendInspection = synchronized(LOCK) {
        requireSafePath(relativePath)
        require(expectedSize >= 0L)
        require(SHA256.matches(expectedSha256))

        load(key)?.let { record ->
            if (record.relativePath != relativePath || record.expectedSize != expectedSize ||
                record.expectedSha256 != expectedSha256
            ) throw PublicationConflictException("Publication key belongs to different SAF content")
            return@synchronized inspectLocked(key)
        }
        if (findDestination(relativePath, false)?.leaf != null) return@synchronized conflict()

        var record = Record(
            key.publicationId,
            key.fileIndex,
            relativePath,
            expectedSize,
            expectedSha256,
            "saf-v1-${UUID.randomUUID()}",
            Phase.ALLOCATING,
        )
        save(record)
        try {
            val binding = ensureOwned(record)
            record = binding.record
            writeMarker(binding.owned.marker, record)
            record = record.copy(phase = Phase.ALLOCATED)
            save(record)
            writeMarker(binding.owned.marker, record)
            allocated(record)
        } catch (error: Throwable) {
            throw failure("Unable to allocate SAF staging", error)
        }
    }

    override fun write(
        key: PublicationFileKey,
        targetToken: String,
        source: PublicationSource,
    ): BackendInspection = synchronized(LOCK) {
        var record = requireRecord(key, targetToken)
        require(source.relativePath == record.relativePath) { "Publication source path changed" }
        require(source.size == record.expectedSize) { "Publication source size changed" }
        val current = inspectLocked(key)
        when (current.state) {
            BackendObjectState.PUBLISHED -> return@synchronized current
            BackendObjectState.CONFLICT -> throw PublicationConflictException("SAF destination conflict")
            else -> Unit
        }

        val binding = ensureOwned(record)
        record = binding.record
        val owned = binding.owned
        record = record.copy(phase = Phase.WRITING)
        save(record)
        writeMarkerBestEffort(owned.marker, record)
        try {
            val copied = resolver.openOutputStream(owned.payload.uri, "w")?.use { output ->
                source.open().use { input -> copyAndDigest(input, output) }
            } ?: throw IOException("Provider returned no staging output stream")
            if (!record.matches(copied)) {
                save(record.copy(phase = Phase.ALLOCATED))
                throw PublicationIntegrityException("Publication source size or hash changed")
            }
            if (!record.matches(digestDocument(owned.payload.uri))) {
                save(record.copy(phase = Phase.ALLOCATED))
                throw PublicationIntegrityException("Provider did not persist expected bytes")
            }
            record = record.copy(phase = Phase.WRITTEN)
            save(record)
            writeMarkerBestEffort(owned.marker, record)
            written(record)
        } catch (error: Throwable) {
            throw failure("Unable to write SAF staging", error)
        }
    }

    override fun publish(key: PublicationFileKey, targetToken: String): BackendInspection = synchronized(LOCK) {
        var record = requireRecord(key, targetToken)
        val current = inspectLocked(key)
        when (current.state) {
            BackendObjectState.PUBLISHED -> return@synchronized current
            BackendObjectState.CONFLICT -> throw PublicationConflictException("SAF destination conflict")
            BackendObjectState.ALLOCATED, BackendObjectState.ABSENT ->
                throw PublicationIntegrityException("SAF staging is not completely written")
            BackendObjectState.WRITTEN -> Unit
        }
        val owned = requireCompleteOwned(record)
        requireMatch(record, digestDocument(owned.payload.uri), "SAF staging content changed")
        val destination = findDestination(record.relativePath, true)
            ?: throw PublicationException("Unable to resolve SAF destination")
        if (destination.leaf != null) throw PublicationConflictException("Destination already exists")

        record = record.copy(phase = Phase.PUBLISHING)
        save(record)
        writeMarkerBestEffort(owned.marker, record)
        try {
            var temporary = findTemporary(record, destination.parent)
            if (temporary != null && !record.matches(digestDocument(temporary.uri))) {
                deleteOwned(temporary.uri, "stale temporary destination")
                record = record.copy(temporaryDocumentId = null)
                save(record)
                temporary = null
            }
            if (temporary == null) {
                if (findChild(destination.parent, record.temporaryName) != null) {
                    throw PublicationConflictException("Unowned temporary destination already exists")
                }
                temporary = createExact(destination.parent, MIME_BINARY, record.temporaryName)
                record = record.copy(temporaryDocumentId = temporary.documentId)
                save(record)
                resolver.openOutputStream(temporary.uri, "w")?.use { output ->
                    resolver.openInputStream(owned.payload.uri)?.use { input -> copyAndDigest(input, output) }
                        ?: throw IOException("Provider returned no staging input stream")
                } ?: throw IOException("Provider returned no temporary output stream")
            }
            requireMatch(record, digestDocument(temporary.uri), "Temporary destination is corrupt")
            if (findChild(destination.parent, destination.leafName) != null) {
                throw PublicationConflictException("Destination appeared during publication")
            }
            val renamed = try {
                DocumentsContract.renameDocument(resolver, temporary.uri, destination.leafName)
            } catch (error: UnsupportedOperationException) {
                throw PublicationException("SAF provider does not support recoverable rename", error)
            } ?: throw PublicationException("SAF provider refused rename publication")
            val renamedDocument = queryDocument(renamed)
                ?: throw PublicationException("Provider hid the renamed destination")
            val finalDocument = findChild(destination.parent, destination.leafName)
                ?: throw PublicationException("Provider did not expose the requested final name")
            if (renamedDocument.documentId != finalDocument.documentId ||
                renamedDocument.name != destination.leafName
            ) {
                throw PublicationConflictException("Renamed SAF destination identity changed")
            }
            requireMatch(record, digestDocument(finalDocument.uri), "Published SAF content is corrupt")
            record = record.copy(
                phase = Phase.PUBLISHED,
                publishedUri = finalDocument.uri.toString(),
                publishedDocumentId = finalDocument.documentId,
                temporaryDocumentId = null,
                stagingCleanupPending = true,
            )
            save(record)
            writeMarkerBestEffort(owned.marker, record)
            published(cleanPublishedStaging(record))
        } catch (error: Throwable) {
            throw failure("Unable to publish through SAF", error)
        }
    }

    override fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection = synchronized(LOCK) {
        var record = load(key) ?: return@synchronized BackendInspection.absent()
        if (targetToken != null && targetToken != record.targetToken) {
            throw PublicationConflictException("SAF target token does not belong to this file")
        }
        val current = inspectLocked(key)
        when (current.state) {
            BackendObjectState.PUBLISHED, BackendObjectState.CONFLICT -> return@synchronized current
            else -> Unit
        }
        val persistedOwnedIds = record.ownedArtifactDocumentIds()
        try {
            record = deleteTemporary(record)
            record = deleteOwnedArtifacts(record)
            persistedOwnedIds.forEach { (documentId, description) ->
                if (queryDocumentById(documentId) != null) {
                    throw PublicationConflictException("Owned $description still exists outside its expected location")
                }
            }
            if (!preferences.edit().remove(preferenceKey(key)).commit()) {
                throw IOException("Unable to remove SAF ownership record")
            }
            BackendInspection.absent()
        } catch (error: Throwable) {
            throw failure("Unable to abort SAF publication", error)
        }
    }

    private fun inspectLocked(key: PublicationFileKey): BackendInspection {
        val record = load(key)
        if (record == null) return BackendInspection.absent()

        val destination = try {
            findDestination(record.relativePath, false)
        } catch (_: PublicationConflictException) {
            return conflict()
        }
        destination?.leaf?.let { finalDocument ->
            if (record.phase != Phase.PUBLISHING && record.phase != Phase.PUBLISHED) return conflict()
            val expectedDocumentId = when (record.phase) {
                Phase.PUBLISHING -> record.temporaryDocumentId
                Phase.PUBLISHED -> record.publishedDocumentId
                else -> null
            } ?: return conflict()
            if (finalDocument.documentId != expectedDocumentId) return conflict()
            val digest = digestDocument(finalDocument.uri)
            if (!record.matches(digest)) return conflict()
            var publishedRecord = record.copy(
                phase = Phase.PUBLISHED,
                publishedUri = finalDocument.uri.toString(),
                publishedDocumentId = finalDocument.documentId,
                temporaryDocumentId = null,
                stagingCleanupPending = record.stagingCleanupPending || record.hasStagingBindings(),
            )
            if (publishedRecord != record) save(publishedRecord)
            publishedRecord = cleanPublishedStaging(publishedRecord)
            return published(publishedRecord)
        }
        if (record.phase == Phase.PUBLISHED) return conflict()

        destination?.let { findTemporary(record, it.parent) }?.let { temporary ->
            if (record.phase != Phase.PUBLISHING) return conflict()
            return if (record.matches(digestDocument(temporary.uri))) written(record) else allocated(record)
        }
        val owned = findOwnedArtifacts(record)
        val payload = owned.payload ?: return allocated(record)
        val digest = try {
            digestDocument(payload.uri)
        } catch (_: Throwable) {
            return allocated(record)
        }
        return if (record.matches(digest)) written(record) else allocated(record)
    }

    private fun requireRecord(key: PublicationFileKey, token: String): Record {
        val record = load(key)
            ?: throw PublicationConflictException("No SAF ownership record exists")
        if (record.targetToken != token) {
            throw PublicationConflictException("SAF target token does not belong to this file")
        }
        return record
    }

    private fun save(record: Record) {
        val key = PublicationFileKey(record.publicationId, record.fileIndex)
        if (!preferences.edit().putString(preferenceKey(key), record.toJson().toString()).commit()) {
            throw PublicationException("Unable to persist SAF ownership record")
        }
    }

    private fun load(key: PublicationFileKey): Record? {
        val encoded = preferences.getString(preferenceKey(key), null) ?: return null
        return try {
            Record.fromJson(JSONObject(encoded)).also {
                if (it.publicationId != key.publicationId || it.fileIndex != key.fileIndex) {
                    throw PublicationConflictException("SAF ownership record key mismatch")
                }
            }
        } catch (error: PublicationException) {
            throw error
        } catch (error: Throwable) {
            throw PublicationIntegrityException("SAF ownership record is corrupt: ${error.message}")
        }
    }

    private fun preferenceKey(key: PublicationFileKey) =
        "record:$treeFingerprint:${sha256(key.publicationId).take(40)}:${key.fileIndex}"

    private fun ensureOwned(initial: Record): BoundOwned {
        var record = initial
        val stagingRoot = ensureDirectory(rootUri, stagingRootName())
        val publication = ensureDirectory(stagingRoot.uri, publicationDirectoryName(record.publicationId))
        val fileDirectory = if (record.fileDirectoryDocumentId == null) {
            if (findChild(publication.uri, record.fileDirectoryName) != null) {
                throw PublicationConflictException("Unowned SAF file staging already exists")
            }
            createExact(
                publication.uri,
                DocumentsContract.Document.MIME_TYPE_DIR,
                record.fileDirectoryName,
            ).also { created ->
                record = record.copy(fileDirectoryDocumentId = created.documentId)
                save(record)
            }
        } else {
            requireBoundChild(
                publication.uri,
                record.fileDirectoryName,
                record.fileDirectoryDocumentId,
                expectDirectory = true,
                description = "file staging directory",
            ) ?: throw PublicationIntegrityException("Owned SAF file staging disappeared")
        }

        val marker = if (record.markerDocumentId == null) {
            if (findChild(fileDirectory.uri, MARKER_NAME) != null) {
                throw PublicationConflictException("Unowned SAF staging marker already exists")
            }
            createExact(fileDirectory.uri, MIME_JSON, MARKER_NAME).also { created ->
                record = record.copy(markerDocumentId = created.documentId)
                save(record)
            }
        } else {
            requireBoundChild(
                fileDirectory.uri,
                MARKER_NAME,
                record.markerDocumentId,
                expectDirectory = false,
                description = "staging marker",
            ) ?: throw PublicationIntegrityException("Owned SAF staging marker disappeared")
        }

        val payload = if (record.payloadDocumentId == null) {
            if (findChild(fileDirectory.uri, PAYLOAD_NAME) != null) {
                throw PublicationConflictException("Unowned SAF staging payload already exists")
            }
            createExact(fileDirectory.uri, MIME_BINARY, PAYLOAD_NAME).also { created ->
                record = record.copy(payloadDocumentId = created.documentId)
                save(record)
                writeMarker(marker, record)
            }
        } else {
            requireBoundChild(
                fileDirectory.uri,
                PAYLOAD_NAME,
                record.payloadDocumentId,
                expectDirectory = false,
                description = "staging payload",
            ) ?: throw PublicationIntegrityException("Owned SAF staging payload disappeared")
        }
        return BoundOwned(record, Owned(fileDirectory, marker, payload))
    }

    private fun requireCompleteOwned(record: Record): Owned {
        val artifacts = findOwnedArtifacts(record)
        return Owned(
            artifacts.fileDirectory
                ?: throw PublicationIntegrityException("Owned SAF file staging disappeared"),
            artifacts.marker
                ?: throw PublicationIntegrityException("Owned SAF staging marker disappeared"),
            artifacts.payload
                ?: throw PublicationIntegrityException("Owned SAF staging payload disappeared"),
        )
    }

    private fun findOwnedArtifacts(record: Record): OwnedArtifacts {
        val stagingRoot = findChild(rootUri, stagingRootName()) ?: run {
            requirePersistedDocumentsAbsent(record.stagingArtifactDocumentIds())
            return OwnedArtifacts()
        }
        if (!stagingRoot.isDirectory) throw PublicationConflictException("SAF staging root is not a directory")
        val publication = findChild(stagingRoot.uri, publicationDirectoryName(record.publicationId)) ?: run {
            requirePersistedDocumentsAbsent(record.stagingArtifactDocumentIds())
            return OwnedArtifacts()
        }
        if (!publication.isDirectory) throw PublicationConflictException("SAF publication staging is not a directory")
        val directoryId = record.fileDirectoryDocumentId ?: run {
            if (findChild(publication.uri, record.fileDirectoryName) != null) {
                throw PublicationConflictException("SAF file staging has no persisted ownership binding")
            }
            requirePersistedDocumentsAbsent(record.stagingChildDocumentIds())
            return OwnedArtifacts()
        }
        val fileDirectory = requireBoundChild(
            publication.uri,
            record.fileDirectoryName,
            directoryId,
            expectDirectory = true,
            description = "file staging directory",
        ) ?: run {
            requirePersistedDocumentsAbsent(record.stagingChildDocumentIds())
            return OwnedArtifacts()
        }
        val marker = boundArtifact(
            fileDirectory.uri,
            MARKER_NAME,
            record.markerDocumentId,
            MIME_JSON,
            "staging marker",
        )
        val payload = boundArtifact(
            fileDirectory.uri,
            PAYLOAD_NAME,
            record.payloadDocumentId,
            MIME_BINARY,
            "staging payload",
        )
        return OwnedArtifacts(fileDirectory, marker, payload)
    }

    private fun boundArtifact(
        parent: Uri,
        name: String,
        documentId: String?,
        mimeType: String,
        description: String,
    ): Document? {
        if (documentId == null) {
            if (findChild(parent, name) != null) {
                throw PublicationConflictException("$description has no persisted ownership binding")
            }
            return null
        }
        return requireBoundChild(parent, name, documentId, false, description)?.also {
            if (it.mimeType != mimeType) {
                throw PublicationConflictException("Owned $description has unexpected MIME type")
            }
        }
    }

    private fun requireBoundChild(
        parent: Uri,
        expectedName: String,
        expectedDocumentId: String,
        expectDirectory: Boolean,
        description: String,
    ): Document? {
        val persisted = queryDocumentById(expectedDocumentId)
        val children = listChildren(parent)
        val byId = children.singleOrNull { it.documentId == expectedDocumentId }
        val byName = children.filter { it.name == expectedName }
        if (persisted == null) {
            if (byName.isNotEmpty()) {
                throw PublicationConflictException("Unowned object replaced $description")
            }
            return null
        }
        if (byId == null) {
            throw PublicationConflictException("Owned $description moved outside its expected parent")
        }
        if (byId.name != expectedName || byName.size != 1 || byName.single().documentId != expectedDocumentId) {
            throw PublicationConflictException("Owned $description identity changed")
        }
        if (byId.isDirectory != expectDirectory || persisted.isDirectory != expectDirectory) {
            throw PublicationConflictException("Owned $description type changed")
        }
        if (persisted.name != byId.name || persisted.mimeType != byId.mimeType) {
            throw PublicationConflictException("Owned $description metadata changed")
        }
        return byId
    }

    private fun requirePersistedDocumentsAbsent(documents: List<Pair<String, String>>) {
        documents.forEach { (documentId, description) ->
            if (queryDocumentById(documentId) != null) {
                throw PublicationConflictException("Owned $description moved outside its expected parent")
            }
        }
    }

    private fun findTemporary(record: Record, parent: Uri): Document? {
        val id = record.temporaryDocumentId
        if (id == null) {
            if (findChild(parent, record.temporaryName) != null) {
                throw PublicationConflictException("Temporary destination has no persisted ownership binding")
            }
            return null
        }
        return requireBoundChild(
            parent,
            record.temporaryName,
            id,
            expectDirectory = false,
            description = "temporary destination",
        )
    }

    private fun cleanPublishedStaging(initial: Record): Record {
        var record = initial
        if (!record.stagingCleanupPending && !record.hasStagingBindings()) return record
        if (!record.stagingCleanupPending) {
            record = record.copy(stagingCleanupPending = true)
            save(record)
        }
        record = deleteOwnedArtifacts(record)
        record = record.copy(stagingCleanupPending = false)
        save(record)
        return record
    }

    private fun deleteTemporary(initial: Record): Record {
        val documentId = initial.temporaryDocumentId ?: return initial
        val destination = findDestination(initial.relativePath, false)
        if (destination == null) {
            if (queryDocumentById(documentId) != null) {
                throw PublicationConflictException("Owned temporary destination moved outside its expected parent")
            }
            return initial.copy(temporaryDocumentId = null).also(::save)
        }
        val temporary = findTemporary(initial, destination.parent)
        if (temporary != null) {
            deleteOwnedAndConfirm(temporary, "temporary destination")
        }
        return initial.copy(temporaryDocumentId = null).also(::save)
    }

    private fun deleteOwnedArtifacts(initial: Record): Record {
        var record = initial
        var owned = findOwnedArtifacts(record)
        if (record.payloadDocumentId != null) {
            owned.payload?.let { deleteOwnedAndConfirm(it, "staging payload") }
            record = record.copy(payloadDocumentId = null)
            save(record)
        }
        owned = findOwnedArtifacts(record)
        if (record.markerDocumentId != null) {
            owned.marker?.let { deleteOwnedAndConfirm(it, "staging marker") }
            record = record.copy(markerDocumentId = null)
            save(record)
        }
        owned = findOwnedArtifacts(record)
        if (record.fileDirectoryDocumentId != null) {
            owned.fileDirectory?.let { directory ->
                if (owned.payload != null || owned.marker != null) {
                    throw IOException("Owned SAF staging artifacts remain")
                }
                if (listChildren(directory.uri).isNotEmpty()) {
                    throw PublicationConflictException("SAF staging directory contains unowned objects")
                }
                deleteOwnedAndConfirm(directory, "empty staging directory")
            }
            record = record.copy(fileDirectoryDocumentId = null)
            save(record)
        }
        if (record.hasStagingBindings()) {
            throw IOException("Owned SAF staging cleanup is incomplete")
        }
        return record
    }

    private fun writeMarker(marker: Document, record: Record) {
        resolver.openOutputStream(marker.uri, "w")?.use {
            it.write(record.toJson().toString().toByteArray(StandardCharsets.UTF_8))
        } ?: throw IOException("Provider returned no marker output stream")
    }

    private fun writeMarkerBestEffort(marker: Document, record: Record) {
        try {
            writeMarker(marker, record)
        } catch (_: Throwable) {
            // Preferences remain the authoritative process-crash recovery record.
        }
    }

    private fun findDestination(relativePath: String, createDirectories: Boolean): Destination? {
        requireSafePath(relativePath)
        val components = relativePath.split('/')
        var parent = rootUri
        for (component in components.dropLast(1)) {
            val existing = findChild(parent, component)
            if (existing == null) {
                if (!createDirectories) return null
                parent = ensureDirectory(parent, component).uri
            } else {
                if (!existing.isDirectory) {
                    throw PublicationConflictException("Destination component is a file: $component")
                }
                parent = existing.uri
            }
        }
        val leafName = components.last()
        return Destination(parent, leafName, findChild(parent, leafName))
    }

    private fun ensureDirectory(parent: Uri, name: String): Document {
        findChild(parent, name)?.let {
            if (!it.isDirectory) throw PublicationConflictException("Directory name is occupied: $name")
            return it
        }
        return createExact(parent, DocumentsContract.Document.MIME_TYPE_DIR, name).also {
            if (!it.isDirectory) {
                deleteBestEffort(it.uri)
                throw PublicationConflictException("Provider did not create directory $name")
            }
        }
    }

    private fun createExact(parent: Uri, mimeType: String, name: String): Document {
        val uri = DocumentsContract.createDocument(resolver, parent, mimeType, name)
            ?: throw IOException("Provider refused to create $name")
        val created = queryDocument(uri) ?: throw IOException("Provider hid newly created $name")
        if (created.name != name) {
            deleteBestEffort(created.uri)
            throw PublicationConflictException("Provider changed requested name $name")
        }
        val matches = listChildren(parent).filter { it.name == name }
        if (matches.size != 1 || matches.single().documentId != created.documentId) {
            deleteBestEffort(created.uri)
            throw PublicationConflictException("Document name raced with another entry: $name")
        }
        return created
    }

    private fun findChild(parent: Uri, name: String): Document? {
        val matches = listChildren(parent).filter { it.name == name }
        if (matches.size > 1) throw PublicationConflictException("Provider returned duplicate name $name")
        return matches.singleOrNull()
    }

    private fun listChildren(parent: Uri): List<Document> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(
            parent,
            DocumentsContract.getDocumentId(parent),
        )
        return resolver.query(uri, PROJECTION, Bundle.EMPTY, null)?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(document(cursor.getString(0), cursor.getString(1), cursor.getString(2)))
                }
            }
        } ?: throw IOException("Provider returned no child cursor")
    }

    private fun queryDocument(uri: Uri): Document? =
        resolver.query(uri, PROJECTION, Bundle.EMPTY, null)?.use { cursor ->
            if (!cursor.moveToFirst()) null
            else document(cursor.getString(0), cursor.getString(1), cursor.getString(2))
        }

    private fun queryDocumentById(documentId: String): Document? = try {
        queryDocument(DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId))
    } catch (_: FileNotFoundException) {
        null
    }

    private fun document(id: String, name: String, mimeType: String) = Document(
        DocumentsContract.buildDocumentUriUsingTree(treeUri, id),
        id,
        name,
        mimeType,
    )

    private fun digestDocument(uri: Uri): Digest =
        resolver.openInputStream(uri)?.use(::digest)
            ?: throw IOException("Provider returned no input stream")

    private fun digest(input: InputStream): Digest {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        var size = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) {
                val single = input.read()
                if (single < 0) break
                hash.update(single.toByte())
                size = Math.addExact(size, 1L)
                continue
            }
            hash.update(buffer, 0, count)
            size = Math.addExact(size, count.toLong())
        }
        return Digest(size, hash.digest().toHex())
    }

    private fun copyAndDigest(input: InputStream, output: OutputStream): Digest {
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        var size = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) {
                val single = input.read()
                if (single < 0) break
                output.write(single)
                hash.update(single.toByte())
                size = Math.addExact(size, 1L)
                continue
            }
            output.write(buffer, 0, count)
            hash.update(buffer, 0, count)
            size = Math.addExact(size, count.toLong())
        }
        output.flush()
        return Digest(size, hash.digest().toHex())
    }

    private fun requireMatch(record: Record, digest: Digest, message: String) {
        if (!record.matches(digest)) throw PublicationIntegrityException(message)
    }

    private fun deleteOwned(uri: Uri, description: String) {
        if (!DocumentsContract.deleteDocument(resolver, uri)) {
            throw IOException("Provider refused to delete $description")
        }
    }

    private fun deleteOwnedAndConfirm(document: Document, description: String) {
        var failure: Throwable? = null
        try {
            deleteOwned(document.uri, description)
        } catch (error: Throwable) {
            failure = error
        }
        val remaining = queryDocumentById(document.documentId)
        if (remaining != null) {
            if (failure != null) throw failure
            throw IOException("Owned $description still exists after deletion")
        }
    }

    private fun deleteBestEffort(uri: Uri) {
        try {
            DocumentsContract.deleteDocument(resolver, uri)
        } catch (_: Throwable) {
            // Used only for an object this backend just created or no longer needs after publication.
        }
    }

    private fun stagingRootName() =
        ".nearby-transfer-private-${sha256(appContext.packageName + ":" + treeFingerprint).take(20)}"

    private fun publicationDirectoryName(publicationId: String) = "p-${sha256(publicationId).take(32)}"

    private fun requireSafePath(path: String) {
        require(path.toByteArray(StandardCharsets.UTF_8).size <= MAX_PATH_BYTES)
        require(path == Normalizer.normalize(path, Normalizer.Form.NFC))
        require(path.isNotBlank() && !path.startsWith('/') && !path.startsWith('\\') && '\\' !in path)
        require(path.split('/').all { component ->
            component.isNotEmpty() && component != "." && component != ".." &&
                component.none { it == '\u0000' || it.code in 1..31 || it.code == 127 }
        })
    }

    private fun allocated(record: Record) = BackendInspection(
        BackendObjectState.ALLOCATED,
        targetToken = record.targetToken,
    )

    private fun written(record: Record) = BackendInspection(
        BackendObjectState.WRITTEN,
        targetToken = record.targetToken,
        size = record.expectedSize,
        sha256 = record.expectedSha256,
    )

    private fun published(record: Record) = BackendInspection(
        BackendObjectState.PUBLISHED,
        targetToken = record.targetToken,
        size = record.expectedSize,
        sha256 = record.expectedSha256,
    )

    private fun conflict() = BackendInspection(BackendObjectState.CONFLICT)

    private fun failure(message: String, error: Throwable): PublicationException =
        if (error is PublicationException) error else PublicationException(message, error)

    private data class Document(
        val uri: Uri,
        val documentId: String,
        val name: String,
        val mimeType: String,
    ) {
        val isDirectory get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
    }

    private data class Owned(
        val fileDirectory: Document,
        val marker: Document,
        val payload: Document,
    )

    private data class OwnedArtifacts(
        val fileDirectory: Document? = null,
        val marker: Document? = null,
        val payload: Document? = null,
    )

    private data class BoundOwned(val record: Record, val owned: Owned)

    private data class Destination(
        val parent: Uri,
        val leafName: String,
        val leaf: Document?,
    )

    private data class Digest(val size: Long, val sha256: String)

    private enum class Phase { ALLOCATING, ALLOCATED, WRITING, WRITTEN, PUBLISHING, PUBLISHED }

    private data class Record(
        val publicationId: String,
        val fileIndex: Int,
        val relativePath: String,
        val expectedSize: Long,
        val expectedSha256: String,
        val targetToken: String,
        val phase: Phase,
        val publishedUri: String? = null,
        val publishedDocumentId: String? = null,
        val fileDirectoryDocumentId: String? = null,
        val markerDocumentId: String? = null,
        val payloadDocumentId: String? = null,
        val temporaryDocumentId: String? = null,
        val stagingCleanupPending: Boolean = false,
    ) {
        val fileDirectoryName: String
            get() = "f-$fileIndex-${sha256(targetToken).take(16)}"

        val temporaryName: String
            get() = ".nearby-transfer-${sha256(publicationId).take(16)}-$fileIndex-" +
                "${sha256(targetToken).take(12)}.part"

        fun matches(digest: Digest) =
            digest.size == expectedSize && digest.sha256 == expectedSha256

        fun hasStagingBindings() =
            fileDirectoryDocumentId != null || markerDocumentId != null || payloadDocumentId != null

        fun ownedArtifactDocumentIds() = listOfNotNull(
            fileDirectoryDocumentId?.let { it to "file staging directory" },
            markerDocumentId?.let { it to "staging marker" },
            payloadDocumentId?.let { it to "staging payload" },
            temporaryDocumentId?.let { it to "temporary destination" },
        )

        fun stagingArtifactDocumentIds() = listOfNotNull(
            fileDirectoryDocumentId?.let { it to "file staging directory" },
            markerDocumentId?.let { it to "staging marker" },
            payloadDocumentId?.let { it to "staging payload" },
        )

        fun stagingChildDocumentIds() = listOfNotNull(
            markerDocumentId?.let { it to "staging marker" },
            payloadDocumentId?.let { it to "staging payload" },
        )

        fun toJson() = JSONObject()
            .put("version", RECORD_VERSION)
            .put("publicationId", publicationId)
            .put("fileIndex", fileIndex)
            .put("relativePath", relativePath)
            .put("expectedSize", expectedSize)
            .put("expectedSha256", expectedSha256)
            .put("targetToken", targetToken)
            .put("phase", phase.name)
            .put("publishedUri", publishedUri ?: JSONObject.NULL)
            .put("publishedDocumentId", publishedDocumentId ?: JSONObject.NULL)
            .put("fileDirectoryDocumentId", fileDirectoryDocumentId ?: JSONObject.NULL)
            .put("markerDocumentId", markerDocumentId ?: JSONObject.NULL)
            .put("payloadDocumentId", payloadDocumentId ?: JSONObject.NULL)
            .put("temporaryDocumentId", temporaryDocumentId ?: JSONObject.NULL)
            .put("stagingCleanupPending", stagingCleanupPending)

        companion object {
            fun fromJson(json: JSONObject): Record {
                val version = json.getInt("version")
                require(version in 2..RECORD_VERSION)
                val phase = Phase.valueOf(json.getString("phase"))
                val publishedUri = nullableString(json, "publishedUri")
                val fileDirectoryDocumentId = nullableString(json, "fileDirectoryDocumentId")
                val markerDocumentId = nullableString(json, "markerDocumentId")
                val payloadDocumentId = nullableString(json, "payloadDocumentId")
                return Record(
                    publicationId = json.getString("publicationId"),
                    fileIndex = json.getInt("fileIndex"),
                    relativePath = json.getString("relativePath"),
                    expectedSize = json.getLong("expectedSize"),
                    expectedSha256 = json.getString("expectedSha256"),
                    targetToken = json.getString("targetToken"),
                    phase = phase,
                    publishedUri = publishedUri,
                    publishedDocumentId = nullableString(json, "publishedDocumentId")
                        ?: publishedUri?.let(::documentIdOrNull),
                    fileDirectoryDocumentId = fileDirectoryDocumentId,
                    markerDocumentId = markerDocumentId,
                    payloadDocumentId = payloadDocumentId,
                    temporaryDocumentId = nullableString(json, "temporaryDocumentId"),
                    stagingCleanupPending = if (json.has("stagingCleanupPending")) {
                        json.getBoolean("stagingCleanupPending")
                    } else {
                        phase == Phase.PUBLISHED && listOf(
                            fileDirectoryDocumentId,
                            markerDocumentId,
                            payloadDocumentId,
                        ).any { it != null }
                    },
                ).also {
                    require(it.publicationId.isNotBlank())
                    require(it.fileIndex >= 0)
                    require(it.expectedSize >= 0L)
                    require(SHA256.matches(it.expectedSha256))
                    require(it.targetToken.isNotBlank())
                    listOf(
                        it.publishedDocumentId,
                        it.fileDirectoryDocumentId,
                        it.markerDocumentId,
                        it.payloadDocumentId,
                        it.temporaryDocumentId,
                    ).filterNotNull().forEach { documentId -> require(documentId.isNotBlank()) }
                }
            }

            private fun nullableString(json: JSONObject, name: String): String? =
                if (!json.has(name) || json.isNull(name)) null else json.getString(name)

            private fun documentIdOrNull(uri: String): String? = try {
                DocumentsContract.getDocumentId(Uri.parse(uri))
            } catch (_: Throwable) {
                null
            }
        }
    }

    private companion object {
        val LOCK = Any()
        val SHA256 = Regex("[0-9a-f]{64}")
        val PROJECTION = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        const val PREFERENCES_NAME = "nearby_transfer_saf_publication_v1"
        const val RECORD_VERSION = 3
        const val MARKER_NAME = "record.json"
        const val PAYLOAD_NAME = "payload.part"
        const val MIME_JSON = "application/json"
        const val MIME_BINARY = "application/octet-stream"
        const val MAX_PATH_BYTES = 4096
        const val BUFFER_SIZE = 64 * 1024

        fun sha256(value: String) = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .toHex()

        fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    }
}
