package io.github.nearbytransfer.android.core.publication

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * API 29+ publication backend backed by the MediaStore Downloads collection.
 *
 * Each file is stored in a deterministic, app-owned namespace whose relative path contains only
 * cryptographic identifiers and the expected immutable metadata. This makes a file discoverable
 * from [PublicationFileKey] after a process death without relying on undocumented MediaStore
 * columns. The original basename remains the display name; unrelated same-named Downloads are
 * never opened, updated, or deleted.
 *
 * Publication is deliberately per-file: a verified pending row becomes visible by clearing
 * [MediaStore.MediaColumns.IS_PENDING]. Published rows are never deleted by [abort].
 */
class MediaStorePublicationBackend(
    context: Context,
    collection: Uri = MediaStore.Downloads.EXTERNAL_CONTENT_URI,
) : PublicationBackend {
    private val resolver: ContentResolver = context.applicationContext.contentResolver
    private val ownerPackage: String = context.packageName
    private val collection: Uri = canonicalCollection(collection)
    private val collectionLockIdentity: String = this.collection.toString()

    init {
        require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "MediaStore publication requires Android 10 (API 29) or newer"
        }
    }

    override val backendId: String = BACKEND_ID

    private fun processLock(key: PublicationFileKey): Any {
        val hash = 31 * collectionLockIdentity.hashCode() + key.hashCode()
        return PROCESS_LOCKS[Math.floorMod(hash, PROCESS_LOCKS.size)]
    }

    override fun inspect(key: PublicationFileKey): BackendInspection = synchronized(processLock(key)) {
        inspectLocked(key)
    }

    override fun allocate(
        key: PublicationFileKey,
        relativePath: String,
        expectedSize: Long,
        expectedSha256: String,
    ): BackendInspection = synchronized(processLock(key)) {
        requireSafeRelativePath(relativePath)
        require(expectedSize >= 0L) { "Expected size must be non-negative" }
        require(SHA256.matches(expectedSha256)) { "Expected sha256 must be lowercase hexadecimal" }

        val expected = Descriptor(
            key = key,
            expectedSize = expectedSize,
            expectedSha256 = expectedSha256,
            relativePathSha256 = sha256(relativePath.toByteArray(Charsets.UTF_8)),
            displayNameSha256 = sha256(
                relativePath.substringAfterLast('/').toByteArray(Charsets.UTF_8),
            ),
            displayName = relativePath.substringAfterLast('/'),
        )

        when (val current = inspectRowsLocked(key)) {
            is RowLookup.Conflict -> return current.inspection
            is RowLookup.Found -> {
                if (!current.row.descriptor.sameAllocation(expected)) {
                    return current.row.conflictInspection()
                }
                return inspectRowLocked(current.row)
            }
            RowLookup.Absent -> Unit
        }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, expected.displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, BINARY_MIME_TYPE)
            put(MediaStore.MediaColumns.RELATIVE_PATH, expected.relativePath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val inserted = providerCall("allocate MediaStore row") {
            resolver.insert(collection, values)
        } ?: throw PublicationException("MediaStore refused to allocate a destination row")

        // Detect a cross-instance race. If another row won the same idempotency key, remove only
        // the row inserted by this call (and only while it is still pending), then report conflict.
        return when (val afterInsert = inspectRowsLocked(key)) {
            RowLookup.Absent -> throw PublicationIntegrityException(
                "Allocated MediaStore row disappeared before it could be inspected",
            )
            is RowLookup.Conflict -> {
                deletePendingToken(inserted)
                afterInsert.inspection
            }
            is RowLookup.Found -> {
                if (afterInsert.row.uri != inserted || !afterInsert.row.descriptor.sameAllocation(expected)) {
                    deletePendingToken(inserted)
                    BackendInspection(BackendObjectState.CONFLICT)
                } else if (!afterInsert.row.pending) {
                    afterInsert.row.conflictInspection()
                } else {
                    // A fresh allocation is reported as ALLOCATED even for an empty file. A later
                    // inspect can truthfully promote an already-correct zero-byte row to WRITTEN.
                    val observed = hashContent(afterInsert.row.uri)
                    BackendInspection(
                        state = BackendObjectState.ALLOCATED,
                        targetToken = inserted.toString(),
                        size = observed.size,
                        sha256 = observed.sha256,
                    )
                }
            }
        }
    }

    override fun write(
        key: PublicationFileKey,
        targetToken: String,
        source: PublicationSource,
    ): BackendInspection = synchronized(processLock(key)) {
        val row = requireTargetRow(key, targetToken)
        val before = inspectRowLocked(row)
        if (before.state == BackendObjectState.CONFLICT) return before
        if (before.state == BackendObjectState.PUBLISHED) return before
        if (!row.pending) return row.conflictInspection()

        val sourcePathHash = sha256(source.relativePath.toByteArray(Charsets.UTF_8))
        if (sourcePathHash != row.descriptor.relativePathSha256 ||
            source.relativePath.substringAfterLast('/') != row.descriptor.displayName
        ) {
            throw PublicationConflictException("Publication source path does not match allocated destination")
        }
        if (source.size != row.descriptor.expectedSize) {
            throw PublicationIntegrityException("Publication source size changed before MediaStore write")
        }

        val copied = providerCall("write MediaStore row") {
            source.open().use { input ->
                val output = resolver.openOutputStream(row.uri, WRITE_MODE)
                    ?: throw PublicationException("MediaStore refused to open the destination for writing")
                output.use { copyAndHash(input, it) }
            }
        }
        if (copied.size != row.descriptor.expectedSize || copied.sha256 != row.descriptor.expectedSha256) {
            throw PublicationIntegrityException("Publication source ended with an unexpected size or sha256")
        }

        // Re-read through MediaStore. A successful OutputStream close alone is not proof that the
        // provider persisted the expected bytes.
        val verified = inspectLocked(key)
        if (verified.targetToken != targetToken) {
            throw PublicationConflictException("MediaStore target changed while it was being written")
        }
        if (verified.state != BackendObjectState.WRITTEN &&
            verified.state != BackendObjectState.PUBLISHED
        ) {
            throw PublicationIntegrityException("MediaStore did not retain the verified file content")
        }
        verified
    }

    override fun publish(key: PublicationFileKey, targetToken: String): BackendInspection = synchronized(processLock(key)) {
        val row = requireTargetRow(key, targetToken)
        val before = inspectRowLocked(row)
        when (before.state) {
            BackendObjectState.PUBLISHED -> return before
            BackendObjectState.CONFLICT -> return before
            BackendObjectState.WRITTEN -> Unit
            BackendObjectState.ABSENT,
            BackendObjectState.ALLOCATED,
            -> throw PublicationIntegrityException("Cannot publish an unverified MediaStore row")
        }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.IS_PENDING, 0)
            putNull(MediaStore.MediaColumns.DATE_EXPIRES)
        }
        providerCall("publish MediaStore row") {
            resolver.update(
                collection,
                values,
                "${MediaStore.MediaColumns._ID} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 1",
                arrayOf(row.id.toString()),
            )
        }

        val published = inspectLocked(key)
        if (published.targetToken != targetToken || published.state != BackendObjectState.PUBLISHED) {
            throw PublicationIntegrityException("MediaStore row was not published atomically")
        }
        published
    }

    override fun abort(key: PublicationFileKey, targetToken: String?): BackendInspection = synchronized(processLock(key)) {
        val lookup = inspectRowsLocked(key)
        when (lookup) {
            RowLookup.Absent -> return BackendInspection.absent()
            is RowLookup.Conflict -> return lookup.inspection
            is RowLookup.Found -> {
                val row = lookup.row
                if (targetToken != null && row.uri.toString() != targetToken) {
                    throw PublicationConflictException("Target token does not belong to publication file")
                }
                val current = inspectRowLocked(row)
                if (current.state == BackendObjectState.PUBLISHED ||
                    current.state == BackendObjectState.CONFLICT
                ) {
                    return current
                }

                // The pending predicate prevents a publish/abort race from deleting a row that has
                // already become visible.
                providerCall("abort MediaStore row") {
                    resolver.delete(
                        collection,
                        "${MediaStore.MediaColumns._ID} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 1",
                        arrayOf(row.id.toString()),
                    )
                }
                return inspectLocked(key)
            }
        }
    }

    private fun inspectLocked(key: PublicationFileKey): BackendInspection = when (val rows = inspectRowsLocked(key)) {
        RowLookup.Absent -> BackendInspection.absent()
        is RowLookup.Conflict -> rows.inspection
        is RowLookup.Found -> inspectRowLocked(rows.row)
    }

    private fun inspectRowsLocked(key: PublicationFileKey): RowLookup {
        val prefix = keyPrefix(key)
        val rows = providerCall("query MediaStore publication rows") {
            resolver.query(
                collection,
                PROJECTION,
                "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                arrayOf("$prefix%"),
                null,
            )
        } ?: throw PublicationException("MediaStore returned no cursor for publication query")

        rows.use { cursor ->
            val found = ArrayList<Row>()
            var malformed = false
            while (cursor.moveToNext()) {
                val relativePath = cursor.requiredString(MediaStore.MediaColumns.RELATIVE_PATH)
                if (!relativePath.startsWith(prefix)) continue
                val descriptor = parseDescriptor(key, relativePath)
                if (descriptor == null) {
                    malformed = true
                    continue
                }
                val id = cursor.requiredLong(MediaStore.MediaColumns._ID)
                val displayName = cursor.requiredString(MediaStore.MediaColumns.DISPLAY_NAME)
                val pending = cursor.requiredInt(MediaStore.MediaColumns.IS_PENDING) != 0
                val owner = cursor.optionalString(MediaStore.MediaColumns.OWNER_PACKAGE_NAME)
                val uri = ContentUris.withAppendedId(collection, id)
                val row = Row(id, uri, descriptor.copy(displayName = displayName), pending, owner)
                if (owner != ownerPackage) malformed = true
                if (displayName.isBlank() || '/' in displayName ||
                    sha256(displayName.toByteArray(Charsets.UTF_8)) != descriptor.displayNameSha256
                ) malformed = true
                found += row
            }
            if (malformed || found.size > 1) {
                return RowLookup.Conflict(BackendInspection(BackendObjectState.CONFLICT))
            }
            return found.singleOrNull()?.let(RowLookup::Found) ?: RowLookup.Absent
        }
    }

    private fun inspectRowLocked(row: Row): BackendInspection {
        if (row.ownerPackage != ownerPackage) {
            return row.conflictInspection()
        }
        val observed = hashContent(row.uri)
        val matches = observed.size == row.descriptor.expectedSize &&
            observed.sha256 == row.descriptor.expectedSha256
        val state = when {
            row.pending && matches -> BackendObjectState.WRITTEN
            row.pending -> BackendObjectState.ALLOCATED
            matches -> BackendObjectState.PUBLISHED
            else -> BackendObjectState.CONFLICT
        }
        return BackendInspection(state, row.uri.toString(), observed.size, observed.sha256)
    }

    private fun requireTargetRow(key: PublicationFileKey, targetToken: String): Row =
        when (val rows = inspectRowsLocked(key)) {
            RowLookup.Absent -> throw PublicationConflictException("Publication destination no longer exists")
            is RowLookup.Conflict -> throw PublicationConflictException("Publication destination is ambiguous")
            is RowLookup.Found -> {
                if (rows.row.uri.toString() != targetToken) {
                    throw PublicationConflictException("Target token does not belong to publication file")
                }
                rows.row
            }
        }

    private fun hashContent(uri: Uri): ContentDigest = providerCall("read MediaStore row for verification") {
        val input = resolver.openInputStream(uri)
            ?: throw PublicationException("MediaStore refused to open the destination for verification")
        input.use(::readAndHash)
    }

    private fun deletePendingToken(uri: Uri) {
        val id = runCatching { ContentUris.parseId(uri) }.getOrNull() ?: return
        runCatching {
            resolver.delete(
                collection,
                "${MediaStore.MediaColumns._ID} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 1",
                arrayOf(id.toString()),
            )
        }
    }

    private fun parseDescriptor(key: PublicationFileKey, relativePath: String): Descriptor? {
        val prefix = keyPrefix(key)
        if (!relativePath.startsWith(prefix)) return null
        val match = METADATA_SEGMENT.matchEntire(relativePath.removePrefix(prefix)) ?: return null
        val size = match.groupValues[1].toLongOrNull() ?: return null
        val contentHash = match.groupValues[2]
        val pathHash = match.groupValues[3]
        val displayNameHash = match.groupValues[4]
        if (size < 0L) return null
        return Descriptor(key, size, contentHash, pathHash, displayNameHash, displayName = "")
    }

    private fun keyPrefix(key: PublicationFileKey): String =
        "$ROOT_PATH/p_${sha256(key.publicationId.toByteArray(Charsets.UTF_8))}/f_${key.fileIndex}_"

    private val Descriptor.relativePath: String
        get() = "${keyPrefix(key)}s_${expectedSize}_h_${expectedSha256}_r_${relativePathSha256}_n_${displayNameSha256}/"

    private fun requireSafeRelativePath(path: String) {
        require(path.isNotBlank() && !path.startsWith('/') && !path.startsWith('\\') && '\\' !in path) {
            "Publication path must be a normalized relative path"
        }
        require(path.split('/').none { it.isEmpty() || it == "." || it == ".." }) {
            "Publication path must be a normalized relative path"
        }
    }

    private inline fun <T> providerCall(operation: String, block: () -> T): T = try {
        block()
    } catch (error: PublicationException) {
        throw error
    } catch (error: Exception) {
        throw PublicationException("Failed to $operation", error)
    }

    private fun Cursor.requiredString(column: String): String {
        val index = getColumnIndex(column)
        if (index < 0 || isNull(index)) throw PublicationIntegrityException("MediaStore omitted $column")
        return getString(index)
    }

    private fun Cursor.requiredLong(column: String): Long {
        val index = getColumnIndex(column)
        if (index < 0 || isNull(index)) throw PublicationIntegrityException("MediaStore omitted $column")
        return getLong(index)
    }

    private fun Cursor.requiredInt(column: String): Int {
        val index = getColumnIndex(column)
        if (index < 0 || isNull(index)) throw PublicationIntegrityException("MediaStore omitted $column")
        return getInt(index)
    }

    private fun Cursor.optionalString(column: String): String? {
        val index = getColumnIndex(column)
        return if (index < 0 || isNull(index)) null else getString(index)
    }

    private data class Descriptor(
        val key: PublicationFileKey,
        val expectedSize: Long,
        val expectedSha256: String,
        val relativePathSha256: String,
        val displayNameSha256: String,
        val displayName: String,
    ) {
        fun sameAllocation(other: Descriptor): Boolean =
            key == other.key &&
                expectedSize == other.expectedSize &&
                expectedSha256 == other.expectedSha256 &&
                relativePathSha256 == other.relativePathSha256 &&
                displayNameSha256 == other.displayNameSha256 &&
                displayName == other.displayName
    }

    private data class Row(
        val id: Long,
        val uri: Uri,
        val descriptor: Descriptor,
        val pending: Boolean,
        val ownerPackage: String?,
    ) {
        fun conflictInspection(): BackendInspection =
            BackendInspection(BackendObjectState.CONFLICT, uri.toString())
    }

    private sealed interface RowLookup {
        data object Absent : RowLookup
        data class Found(val row: Row) : RowLookup
        data class Conflict(val inspection: BackendInspection) : RowLookup
    }

    private data class ContentDigest(val size: Long, val sha256: String)

    companion object {
        const val BACKEND_ID = "android-mediastore-downloads-v1"

        // ContentResolver instances can address the same row from independent workers. Shared
        // striped locks keep each file's read/check/mutate sequence process-serial without forcing
        // every unrelated file through one global lock. Hash collisions may conservatively serialize
        // unrelated keys, while a stale writer can never open the same published row with "rwt".
        private val PROCESS_LOCKS = Array(64) { Any() }

        private fun canonicalCollection(collection: Uri): Uri {
            require(collection.scheme.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true)) {
                "MediaStore collection must be a content URI"
            }
            require(!collection.isOpaque && !collection.authority.isNullOrBlank()) {
                "MediaStore collection must be a hierarchical content URI with an authority"
            }
            require(collection.encodedQuery == null) {
                "MediaStore collection must not contain a query"
            }
            require(collection.encodedFragment == null) {
                "MediaStore collection must not contain a fragment"
            }
            return collection.normalizeScheme()
        }

        private const val BINARY_MIME_TYPE = "application/octet-stream"
        private const val WRITE_MODE = "rwt"
        private val SHA256 = Regex("[0-9a-f]{64}")
        private val METADATA_SEGMENT = Regex(
            "s_([0-9]+)_h_([0-9a-f]{64})_r_([0-9a-f]{64})_n_([0-9a-f]{64})/",
        )
        private val ROOT_PATH =
            "${Environment.DIRECTORY_DOWNLOADS}/Nearby Transfer/Received/v2"
        private val PROJECTION = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.RELATIVE_PATH,
            MediaStore.MediaColumns.IS_PENDING,
            MediaStore.MediaColumns.OWNER_PACKAGE_NAME,
        )

        private fun copyAndHash(input: InputStream, output: OutputStream): ContentDigest {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var size = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) {
                    val single = input.read()
                    if (single < 0) break
                    output.write(single)
                    digest.update(single.toByte())
                    size++
                } else {
                    output.write(buffer, 0, read)
                    digest.update(buffer, 0, read)
                    size = Math.addExact(size, read.toLong())
                }
            }
            output.flush()
            return ContentDigest(size, digest.digest().toHex())
        }

        private fun readAndHash(input: InputStream): ContentDigest {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var size = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                digest.update(buffer, 0, read)
                size = Math.addExact(size, read.toLong())
            }
            return ContentDigest(size, digest.digest().toHex())
        }

        private fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

        private fun ByteArray.toHex(): String =
            joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }
}
