package io.github.nearbytransfer.android.core.recovery

import io.github.nearbytransfer.android.V2StagingLayout
import io.github.nearbytransfer.android.core.publication.PublicationFileSpec
import io.github.nearbytransfer.android.core.publication.PublicationPlan
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNoException
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Comparator

class AppPrivateStagingCleanerTest {
    private lateinit var root: Path

    @Before
    fun setUp() {
        root = Files.createTempDirectory("nearby-staging-cleaner-").toAbsolutePath()
    }

    @After
    fun tearDown() {
        deleteRecursively(root)
    }

    @Test
    fun removesOnlyOwnedFilesAndIsRepeatable() {
        val plan = plan("alpha".toByteArray(), "bravo".toByteArray())
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        Files.write(task.resolve(V2StagingLayout.fileId(0)), "alpha".toByteArray())
        Files.write(task.resolve(V2StagingLayout.fileId(1)), "bravo".toByteArray())
        val cleaner = AppPrivateStagingCleaner(root)

        cleaner.cleanup(plan)
        assertFalse(Files.exists(task))
        cleaner.cleanup(plan)
        assertFalse(Files.exists(task))
    }

    @Test
    fun resumesAfterSomeExpectedFilesWereAlreadyRemoved() {
        val bytes = "remaining".toByteArray()
        val plan = plan("removed".toByteArray(), bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val remaining = Files.write(task.resolve(V2StagingLayout.fileId(1)), bytes)

        AppPrivateStagingCleaner(root).cleanup(plan)

        assertFalse(Files.exists(task))
        assertFalse(Files.exists(remaining))
    }

    @Test
    fun unknownFileFailsClosedBeforeDeletingKnownFiles() {
        val bytes = "owned".toByteArray()
        val plan = plan(bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val known = Files.write(task.resolve(V2StagingLayout.fileId(0)), bytes)
        val unknown = Files.write(task.resolve("unexpected.bin"), "unknown".toByteArray())

        assertThrows(SecurityException::class.java) { AppPrivateStagingCleaner(root).cleanup(plan) }

        assertArrayEquals(bytes, Files.readAllBytes(known))
        assertTrue(Files.exists(unknown))
        assertTrue(Files.exists(task))
    }

    @Test
    fun expectedDirectoryEntryFailsClosed() {
        val bytes = "owned".toByteArray()
        val plan = plan(bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val expected = Files.createDirectory(task.resolve(V2StagingLayout.fileId(0)))

        assertThrows(SecurityException::class.java) { AppPrivateStagingCleaner(root).cleanup(plan) }
        assertTrue(Files.isDirectory(expected))
    }

    @Test
    fun expectedSymbolicLinkFailsClosed() {
        val bytes = "owned".toByteArray()
        val plan = plan(bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val outside = Files.write(root.resolve("outside.bin"), bytes)
        val link = task.resolve(V2StagingLayout.fileId(0))
        createSymbolicLinkOrSkip(link, outside)

        assertThrows(SecurityException::class.java) { AppPrivateStagingCleaner(root).cleanup(plan) }
        assertTrue(Files.isSymbolicLink(link))
        assertArrayEquals(bytes, Files.readAllBytes(outside))
    }

    @Test
    fun taskDirectorySymbolicLinkIsRejectedWithoutTouchingTarget() {
        val bytes = "outside".toByteArray()
        val plan = plan(bytes)
        val outsideDirectory = Files.createDirectory(root.resolve("outside-task"))
        val outsideFile = Files.write(outsideDirectory.resolve(V2StagingLayout.fileId(0)), bytes)
        val taskLink = V2StagingLayout.resolveTaskDirectory(root, plan.taskId)
        createSymbolicLinkOrSkip(taskLink, outsideDirectory)

        assertThrows(SecurityException::class.java) { AppPrivateStagingCleaner(root).cleanup(plan) }
        assertArrayEquals(bytes, Files.readAllBytes(outsideFile))
    }

    @Test
    fun rejectsTaskIdPathEscape() {
        val bytes = "escape".toByteArray()
        val unsafe = PublicationPlan(
            publicationId = "publication-cleanup-escape",
            taskId = "../escape",
            backendId = "TEST",
            files = listOf(spec(0, bytes)),
        )

        assertThrows(IllegalArgumentException::class.java) {
            AppPrivateStagingCleaner(root).cleanup(unsafe)
        }
    }

    private fun plan(vararg payloads: ByteArray) = PublicationPlan(
        publicationId = "publication-cleanup",
        taskId = TASK_ID,
        backendId = "TEST",
        files = payloads.mapIndexed(::spec),
    )

    private fun spec(index: Int, bytes: ByteArray) = PublicationFileSpec(
        index = index,
        relativePath = "file-$index.bin",
        size = bytes.size.toLong(),
        sha256 = sha256(bytes),
    )

    private fun createSymbolicLinkOrSkip(link: Path, target: Path) {
        try {
            Files.createSymbolicLink(link, target)
        } catch (error: Exception) {
            assumeNoException("Symbolic links are unavailable on this host", error)
        }
    }

    private fun deleteRecursively(path: Path) {
        if (Files.notExists(path)) return
        Files.walk(path).use { paths ->
            paths.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
        }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private companion object {
        const val TASK_ID = "ABEiM0RVZneImaq7zN3u_w"
    }
}
