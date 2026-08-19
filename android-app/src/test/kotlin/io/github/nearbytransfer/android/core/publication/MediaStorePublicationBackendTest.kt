package io.github.nearbytransfer.android.core.publication

import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
@Config(sdk = [Build.VERSION_CODES.Q])
class MediaStorePublicationBackendTest {
    private lateinit var context: Context
    private lateinit var collection: Uri
    private lateinit var provider: FakeDownloadsProvider
    private lateinit var backend: MediaStorePublicationBackend

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        val authority = "io.github.nearbytransfer.test.mediastore.${NEXT_AUTHORITY.incrementAndGet()}"
        collection = Uri.parse("content://$authority/downloads")
        provider = FakeDownloadsProvider(authority)
        provider.attachInfo(context, ProviderInfo().apply {
            this.authority = authority
            exported = false
        })
        ShadowContentResolver.registerProviderInternal(authority, provider)
        backend = MediaStorePublicationBackend(context, collection)
    }

    @Test
    fun repeatedAllocateWriteAndPublishAreIdempotent() {
        val key = PublicationFileKey("publication-repeat", 0)
        val content = "hello from MediaStore".toByteArray()
        val hash = sha256(content)

        val allocated = backend.allocate(key, "reports/result.txt", content.size.toLong(), hash)
        assertEquals(BackendObjectState.ALLOCATED, allocated.state)
        assertNotNull(allocated.targetToken)
        assertEquals(1, provider.rowCount())

        val allocatedAgain = backend.allocate(key, "reports/result.txt", content.size.toLong(), hash)
        assertEquals(BackendObjectState.ALLOCATED, allocatedAgain.state)
        assertEquals(allocated.targetToken, allocatedAgain.targetToken)
        assertEquals(1, provider.rowCount())

        val firstSource = TrackingSource("reports/result.txt", content.size.toLong(), content)
        val written = backend.write(key, allocated.targetToken!!, firstSource)
        assertEquals(BackendObjectState.WRITTEN, written.state)
        assertEquals(content.size.toLong(), written.size)
        assertEquals(hash, written.sha256)
        assertEquals(1, firstSource.openCount)
        assertEquals(1, firstSource.closeCount)

        val secondSource = TrackingSource("reports/result.txt", content.size.toLong(), content)
        val writtenAgain = backend.write(key, allocated.targetToken!!, secondSource)
        assertEquals(BackendObjectState.WRITTEN, writtenAgain.state)
        assertEquals(1, provider.rowCount())
        assertEquals(1, secondSource.closeCount)

        val published = backend.publish(key, allocated.targetToken!!)
        assertEquals(BackendObjectState.PUBLISHED, published.state)
        assertFalse(provider.isPending(Uri.parse(allocated.targetToken!!)))

        val publishedAgain = backend.publish(key, allocated.targetToken!!)
        assertEquals(published, publishedAgain)
        assertEquals(published, backend.inspect(key))
        assertEquals(1, provider.rowCount())
    }

    @Test
    fun separateBackendInstancesSerializeWriteAndPublishInTheSameProcess() {
        val equivalentCollection = Uri.parse(collection.toString())
        assertEquals(collection, equivalentCollection)
        assertFalse(collection === equivalentCollection)
        val secondBackend = MediaStorePublicationBackend(context, equivalentCollection)
        val key = PublicationFileKey("publication-shared-lock", 0)
        val content = "shared lock payload".toByteArray()
        val allocated = backend.allocate(key, "shared/file.bin", content.size.toLong(), sha256(content))
        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("shared/file.bin", content.size.toLong(), content),
        )

        provider.blockNextWriteOpen()
        provider.watchNextPublishUpdate()
        val executor = Executors.newFixedThreadPool(2)
        val publishTaskStarted = CountDownLatch(1)
        val publishThread = AtomicReference<Thread>()
        try {
            val rewrite = executor.submit<BackendInspection> {
                backend.write(
                    key,
                    allocated.targetToken!!,
                    TrackingSource("shared/file.bin", content.size.toLong(), content),
                )
            }
            assertTrue("rewrite did not reach the provider", provider.awaitBlockedWrite())

            val publish = executor.submit<BackendInspection> {
                publishThread.set(Thread.currentThread())
                publishTaskStarted.countDown()
                secondBackend.publish(key, allocated.targetToken!!)
            }
            assertTrue("publish task did not start", publishTaskStarted.await(5, TimeUnit.SECONDS))
            assertTrue(
                "publish thread did not block on the process-wide file monitor",
                awaitThreadState(publishThread.get(), Thread.State.BLOCKED, 5, TimeUnit.SECONDS),
            )

            // Reaching BLOCKED after entering the publish call proves the independent backend is
            // contending for the monitor held by the writer, rather than merely not being scheduled.
            assertFalse(provider.awaitPublishUpdate(0, TimeUnit.MILLISECONDS))
            assertFalse(publish.isDone)

            provider.releaseBlockedWrite()
            assertEquals(BackendObjectState.WRITTEN, rewrite.get(5, TimeUnit.SECONDS).state)
            assertEquals(BackendObjectState.PUBLISHED, publish.get(5, TimeUnit.SECONDS).state)
            assertTrue(provider.awaitPublishUpdate(5, TimeUnit.SECONDS))
            assertArrayEquals(content, provider.bytes(Uri.parse(allocated.targetToken!!)))
        } finally {
            provider.releaseBlockedWrite()
            executor.shutdownNow()
        }
    }

    @Test
    fun collectionRejectsQueryAndFragmentComponents() {
        assertThrows(IllegalArgumentException::class.java) {
            MediaStorePublicationBackend(
                context,
                collection.buildUpon().encodedQuery("volume=external").build(),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            MediaStorePublicationBackend(
                context,
                collection.buildUpon().fragment("downloads").build(),
            )
        }
    }

    @Test
    fun sameNamedDownloadsAndOtherPublicationsAreNeverOverwritten() {
        val unrelated = provider.seed(
            displayName = "report.txt",
            relativePath = "Download/Nearby Transfer/",
            bytes = "keep me".toByteArray(),
            pending = false,
        )
        val content = "new report".toByteArray()
        val firstKey = PublicationFileKey("publication-one", 0)
        val secondKey = PublicationFileKey("publication-two", 0)

        val first = backend.allocate(firstKey, "folder/report.txt", content.size.toLong(), sha256(content))
        assertNotEquals(unrelated.toString(), first.targetToken)
        backend.write(
            firstKey,
            first.targetToken!!,
            TrackingSource("folder/report.txt", content.size.toLong(), content),
        )
        backend.publish(firstKey, first.targetToken!!)

        val second = backend.allocate(secondKey, "folder/report.txt", content.size.toLong(), sha256(content))
        assertNotEquals(first.targetToken, second.targetToken)
        assertEquals(3, provider.rowCount())
        assertArrayEquals("keep me".toByteArray(), provider.bytes(unrelated))
        assertEquals(3, provider.displayNames().count { it == "report.txt" })
    }

    @Test
    fun inspectRecoversCompletedWriteAndPublishAfterSideEffectCrash() {
        val key = PublicationFileKey("publication-crash", 3)
        val content = "durable bytes".toByteArray()
        val allocated = backend.allocate(key, "crash/data.bin", content.size.toLong(), sha256(content))
        val token = Uri.parse(allocated.targetToken!!)

        // Simulate process death after the provider persisted bytes but before write returned.
        provider.replaceBytes(token, content)
        val recoveredWrite = backend.inspect(key)
        assertEquals(BackendObjectState.WRITTEN, recoveredWrite.state)
        assertEquals(sha256(content), recoveredWrite.sha256)

        // Simulate the provider applying IS_PENDING=0 and then the caller losing the result.
        provider.throwAfterNextPublishUpdate = true
        assertThrows(PublicationException::class.java) {
            backend.publish(key, allocated.targetToken!!)
        }
        val recoveredPublish = backend.inspect(key)
        assertEquals(BackendObjectState.PUBLISHED, recoveredPublish.state)
        assertEquals(recoveredPublish, backend.publish(key, allocated.targetToken!!))
    }

    @Test
    fun abortDeletesOnlyPendingRowsAndNeverPublishedRows() {
        val pendingKey = PublicationFileKey("publication-abort", 0)
        val pendingBytes = "pending".toByteArray()
        val pending = backend.allocate(
            pendingKey,
            "pending.bin",
            pendingBytes.size.toLong(),
            sha256(pendingBytes),
        )
        backend.write(
            pendingKey,
            pending.targetToken!!,
            TrackingSource("pending.bin", pendingBytes.size.toLong(), pendingBytes),
        )
        assertEquals(BackendObjectState.ABSENT, backend.abort(pendingKey, pending.targetToken).state)
        assertEquals(BackendObjectState.ABSENT, backend.abort(pendingKey, pending.targetToken).state)

        val publishedKey = PublicationFileKey("publication-abort", 1)
        val publishedBytes = "published".toByteArray()
        val published = backend.allocate(
            publishedKey,
            "published.bin",
            publishedBytes.size.toLong(),
            sha256(publishedBytes),
        )
        backend.write(
            publishedKey,
            published.targetToken!!,
            TrackingSource("published.bin", publishedBytes.size.toLong(), publishedBytes),
        )
        backend.publish(publishedKey, published.targetToken!!)

        val afterAbort = backend.abort(publishedKey, published.targetToken)
        assertEquals(BackendObjectState.PUBLISHED, afterAbort.state)
        assertArrayEquals(publishedBytes, provider.bytes(Uri.parse(published.targetToken)))
        assertEquals(1, provider.rowCount())
    }

    @Test
    fun partialSourceAndExceptionalCloseRemainRecoverable() {
        val key = PublicationFileKey("publication-source-failure", 0)
        val content = "complete payload".toByteArray()
        val allocated = backend.allocate(key, "payload.bin", content.size.toLong(), sha256(content))

        val partial = TrackingSource(
            relativePath = "payload.bin",
            declaredSize = content.size.toLong(),
            bytes = content.copyOf(content.size - 3),
        )
        assertThrows(PublicationIntegrityException::class.java) {
            backend.write(key, allocated.targetToken!!, partial)
        }
        assertEquals(1, partial.closeCount)
        assertEquals(BackendObjectState.ALLOCATED, backend.inspect(key).state)

        val closeFailure = TrackingSource(
            relativePath = "payload.bin",
            declaredSize = content.size.toLong(),
            bytes = content,
            throwOnClose = true,
        )
        assertThrows(PublicationException::class.java) {
            backend.write(key, allocated.targetToken!!, closeFailure)
        }
        assertEquals(1, closeFailure.closeCount)
        // The close acknowledgement was lost, but inspect can prove that the provider has the file.
        assertEquals(BackendObjectState.WRITTEN, backend.inspect(key).state)

        assertEquals(BackendObjectState.PUBLISHED, backend.publish(key, allocated.targetToken!!).state)
    }

    @Test
    fun conflictingMetadataAndPublishedTamperingAreReportedWithoutDeletion() {
        val key = PublicationFileKey("publication-conflict", 0)
        val original = "original".toByteArray()
        val allocated = backend.allocate(key, "one/file.bin", original.size.toLong(), sha256(original))

        val conflicting = backend.allocate(key, "two/file.bin", original.size.toLong(), sha256(original))
        assertEquals(BackendObjectState.CONFLICT, conflicting.state)
        assertEquals(1, provider.rowCount())

        backend.write(
            key,
            allocated.targetToken!!,
            TrackingSource("one/file.bin", original.size.toLong(), original),
        )
        backend.publish(key, allocated.targetToken!!)
        provider.replaceBytes(Uri.parse(allocated.targetToken!!), "tampered".toByteArray())

        assertEquals(BackendObjectState.CONFLICT, backend.inspect(key).state)
        assertEquals(BackendObjectState.CONFLICT, backend.abort(key, allocated.targetToken).state)
        assertEquals(1, provider.rowCount())
    }

    private class TrackingSource(
        override val relativePath: String,
        private val declaredSize: Long,
        private val bytes: ByteArray,
        private val throwOnClose: Boolean = false,
    ) : PublicationSource {
        override val size: Long get() = declaredSize
        var openCount = 0
        var closeCount = 0

        override fun open(): InputStream {
            openCount++
            return object : FilterInputStream(ByteArrayInputStream(bytes)) {
                override fun close() {
                    closeCount++
                    super.close()
                    if (throwOnClose) throw IOException("simulated source close failure")
                }
            }
        }
    }

    private class FakeDownloadsProvider(private val authority: String) : ContentProvider() {
        private data class Entry(
            val id: Long,
            val values: ContentValues,
            val file: File,
        )

        private val entries = linkedMapOf<Long, Entry>()
        private var nextId = 1L
        var throwAfterNextPublishUpdate = false
        @Volatile private var blockNextWriteOpen = false
        @Volatile private var writeOpenEntered = CountDownLatch(0)
        @Volatile private var allowWriteOpen = CountDownLatch(0)
        @Volatile private var publishUpdateEntered = CountDownLatch(0)

        override fun onCreate(): Boolean = true

        override fun insert(uri: Uri, values: ContentValues?): Uri {
            val id = nextId++
            val stored = ContentValues(values ?: ContentValues()).apply {
                put(MediaStore.MediaColumns._ID, id)
                put(MediaStore.MediaColumns.OWNER_PACKAGE_NAME, context!!.packageName)
                if (!containsKey(MediaStore.MediaColumns.IS_PENDING)) {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
            }
            val file = File(context!!.cacheDir, "fake-mediastore-$id.bin").apply {
                parentFile?.mkdirs()
                writeBytes(ByteArray(0))
            }
            entries[id] = Entry(id, stored, file)
            return ContentUris.withAppendedId(uri, id)
        }

        fun seed(
            displayName: String,
            relativePath: String,
            bytes: ByteArray,
            pending: Boolean,
        ): Uri {
            val collection = Uri.parse("content://$authority/downloads")
            val uri = insert(collection, ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                put(MediaStore.MediaColumns.IS_PENDING, if (pending) 1 else 0)
            })
            replaceBytes(uri, bytes)
            return uri
        }

        fun replaceBytes(uri: Uri, bytes: ByteArray) {
            entry(uri).file.writeBytes(bytes)
        }

        fun bytes(uri: Uri): ByteArray = entry(uri).file.readBytes()

        fun isPending(uri: Uri): Boolean =
            entry(uri).values.getAsInteger(MediaStore.MediaColumns.IS_PENDING) != 0

        fun rowCount(): Int = entries.size

        fun displayNames(): List<String> =
            entries.values.map { it.values.getAsString(MediaStore.MediaColumns.DISPLAY_NAME) }

        fun blockNextWriteOpen() {
            writeOpenEntered = CountDownLatch(1)
            allowWriteOpen = CountDownLatch(1)
            blockNextWriteOpen = true
        }

        fun awaitBlockedWrite(): Boolean = writeOpenEntered.await(5, TimeUnit.SECONDS)

        fun releaseBlockedWrite() {
            allowWriteOpen.countDown()
        }

        fun watchNextPublishUpdate() {
            publishUpdateEntered = CountDownLatch(1)
        }

        fun awaitPublishUpdate(timeout: Long, unit: TimeUnit): Boolean =
            publishUpdateEntered.await(timeout, unit)

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor {
            val columns = projection?.map { it }?.toTypedArray() ?: DEFAULT_COLUMNS
            val cursor = MatrixCursor(columns)
            entries.values.filter { matches(it, uri, selection, selectionArgs) }.forEach { entry ->
                val row = cursor.newRow()
                columns.forEach { column -> row.add(value(entry, column)) }
            }
            return cursor
        }

        override fun update(
            uri: Uri,
            values: ContentValues?,
            selection: String?,
            selectionArgs: Array<out String>?,
        ): Int {
            var changed = 0
            entries.values.filter { matches(it, uri, selection, selectionArgs) }.forEach { entry ->
                if (values?.containsKey(MediaStore.MediaColumns.IS_PENDING) == true) {
                    entry.values.put(
                        MediaStore.MediaColumns.IS_PENDING,
                        values.getAsInteger(MediaStore.MediaColumns.IS_PENDING),
                    )
                }
                if (values?.containsKey(MediaStore.MediaColumns.DATE_EXPIRES) == true) {
                    if (values.get(MediaStore.MediaColumns.DATE_EXPIRES) == null) {
                        entry.values.putNull(MediaStore.MediaColumns.DATE_EXPIRES)
                    } else {
                        entry.values.put(
                            MediaStore.MediaColumns.DATE_EXPIRES,
                            values.getAsLong(MediaStore.MediaColumns.DATE_EXPIRES),
                        )
                    }
                }
                changed++
            }
            val published = values?.getAsInteger(MediaStore.MediaColumns.IS_PENDING) == 0
            if (published) publishUpdateEntered.countDown()
            if (published && changed > 0 && throwAfterNextPublishUpdate) {
                throwAfterNextPublishUpdate = false
                throw IOException("simulated crash after publish side effect")
            }
            return changed
        }

        override fun delete(
            uri: Uri,
            selection: String?,
            selectionArgs: Array<out String>?,
        ): Int {
            val ids = entries.values
                .filter { matches(it, uri, selection, selectionArgs) }
                .map { it.id }
            ids.forEach { id -> entries.remove(id)?.file?.delete() }
            return ids.size
        }

        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            if ('w' in mode && blockNextWriteOpen) {
                blockNextWriteOpen = false
                writeOpenEntered.countDown()
                check(allowWriteOpen.await(5, TimeUnit.SECONDS)) {
                    "timed out waiting to release blocked MediaStore write"
                }
            }
            val file = entry(uri).file
            val flags = if ('w' in mode) {
                ParcelFileDescriptor.MODE_CREATE or
                    ParcelFileDescriptor.MODE_READ_WRITE or
                    if ('t' in mode) ParcelFileDescriptor.MODE_TRUNCATE else 0
            } else {
                ParcelFileDescriptor.MODE_READ_ONLY
            }
            return ParcelFileDescriptor.open(file, flags)
        }

        override fun getType(uri: Uri): String = "application/octet-stream"

        private fun matches(
            entry: Entry,
            uri: Uri,
            selection: String?,
            selectionArgs: Array<out String>?,
        ): Boolean {
            val itemId = uri.lastPathSegment?.toLongOrNull()
            if (itemId != null && itemId != entry.id) return false
            if (selection == null) return true

            if (selection.contains("LIKE", ignoreCase = true)) {
                val prefix = selectionArgs?.singleOrNull()?.removeSuffix("%") ?: return false
                return entry.values.getAsString(MediaStore.MediaColumns.RELATIVE_PATH)
                    ?.startsWith(prefix) == true
            }
            if (selection.contains(MediaStore.MediaColumns._ID)) {
                val expectedId = selectionArgs?.firstOrNull()?.toLongOrNull() ?: return false
                if (entry.id != expectedId) return false
            }
            if (selection.contains("${MediaStore.MediaColumns.IS_PENDING} = 1")) {
                if (entry.values.getAsInteger(MediaStore.MediaColumns.IS_PENDING) != 1) return false
            }
            return true
        }

        private fun value(entry: Entry, column: String): Any? = when (column) {
            MediaStore.MediaColumns.SIZE -> entry.file.length()
            else -> entry.values.get(column)
        }

        private fun entry(uri: Uri): Entry =
            entries[ContentUris.parseId(uri)] ?: error("Unknown fake MediaStore row: $uri")

        companion object {
            private val DEFAULT_COLUMNS = arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.RELATIVE_PATH,
                MediaStore.MediaColumns.IS_PENDING,
                MediaStore.MediaColumns.OWNER_PACKAGE_NAME,
                MediaStore.MediaColumns.SIZE,
            )
        }
    }

    companion object {
        private val NEXT_AUTHORITY = AtomicInteger()

        private fun awaitThreadState(
            thread: Thread,
            expected: Thread.State,
            timeout: Long,
            unit: TimeUnit,
        ): Boolean {
            val deadline = System.nanoTime() + unit.toNanos(timeout)
            while (System.nanoTime() < deadline) {
                if (thread.state == expected) return true
                if (!thread.isAlive) return false
                Thread.sleep(1)
            }
            return thread.state == expected
        }

        private fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }
}
