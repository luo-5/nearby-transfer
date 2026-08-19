package io.github.nearbytransfer.android.core.recovery

import io.github.nearbytransfer.android.V2StagingLayout
import io.github.nearbytransfer.android.core.publication.PublicationFileSpec
import io.github.nearbytransfer.android.core.publication.PublicationPlan
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assume.assumeNoException
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Comparator

class AppPrivatePublicationSourceProviderTest {
    private lateinit var root: Path

    @Before
    fun setUp() {
        root = Files.createTempDirectory("nearby-publication-source-").toAbsolutePath()
    }

    @After
    fun tearDown() {
        deleteRecursively(root)
    }

    @Test
    fun opensExistingFileOnceWithoutCreatingAnything() {
        val bytes = "restart-safe".toByteArray()
        val plan = plan(bytes)
        val staged = stage(plan, 0, bytes)
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertEquals("folder/report.txt", source.relativePath)
        assertEquals(bytes.size.toLong(), source.size)
        source.open().use { assertArrayEquals(bytes, it.readBytes()) }
        assertThrows(IllegalStateException::class.java) { source.open() }
        assertArrayEquals(bytes, Files.readAllBytes(staged))
    }

    @Test
    fun missingSourceFailsWithoutCreatingAnEmptyFile() {
        val bytes = "missing".toByteArray()
        val plan = plan(bytes)
        Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val staged = V2StagingLayout.resolveFile(root, plan.taskId, 0)
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertThrows(IOException::class.java) { source.open() }
        assertFalse(Files.exists(staged))
        assertThrows(IllegalStateException::class.java) { source.open() }
    }

    @Test
    fun rejectsDirectoryAtExpectedFilePath() {
        val bytes = "directory".toByteArray()
        val plan = plan(bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        Files.createDirectory(task.resolve(V2StagingLayout.fileId(0)))
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertThrows(Exception::class.java) { source.open() }
    }

    @Test
    fun rejectsSymbolicLinkAtExpectedFilePath() {
        val bytes = "linked".toByteArray()
        val plan = plan(bytes)
        val task = Files.createDirectory(V2StagingLayout.resolveTaskDirectory(root, plan.taskId))
        val outside = Files.write(root.resolve("outside.bin"), bytes)
        createSymbolicLinkOrSkip(task.resolve(V2StagingLayout.fileId(0)), outside)
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertThrows(Exception::class.java) { source.open() }
    }

    @Test
    fun rejectsSymbolicLinkTaskDirectory() {
        val bytes = "linked-task".toByteArray()
        val plan = plan(bytes)
        val outsideDirectory = Files.createDirectory(root.resolve("outside-task"))
        Files.write(outsideDirectory.resolve(V2StagingLayout.fileId(0)), bytes)
        createSymbolicLinkOrSkip(
            V2StagingLayout.resolveTaskDirectory(root, plan.taskId),
            outsideDirectory,
        )
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertThrows(SecurityException::class.java) { source.open() }
    }

    @Test
    fun rejectsChangedSizeBeforeOpening() {
        val original = "original".toByteArray()
        val plan = plan(original)
        stage(plan, 0, "changed-size".toByteArray())
        val source = AppPrivatePublicationSourceProvider(root).sourceFor(plan, plan.files.single())

        assertThrows(IOException::class.java) { source.open() }
    }

    @Test
    fun rejectsTaskIdPathEscape() {
        val bytes = "escape".toByteArray()
        val unsafe = PublicationPlan(
            publicationId = "publication-escape",
            taskId = "../escape",
            backendId = "TEST",
            files = listOf(spec(0, bytes)),
        )

        assertThrows(IllegalArgumentException::class.java) {
            AppPrivatePublicationSourceProvider(root).sourceFor(unsafe, unsafe.files.single())
        }
    }

    private fun plan(bytes: ByteArray) = PublicationPlan(
        publicationId = "publication-source",
        taskId = TASK_ID,
        backendId = "TEST",
        files = listOf(spec(0, bytes)),
    )

    private fun spec(index: Int, bytes: ByteArray) = PublicationFileSpec(
        index = index,
        relativePath = "folder/report.txt",
        size = bytes.size.toLong(),
        sha256 = sha256(bytes),
    )

    private fun stage(plan: PublicationPlan, index: Int, bytes: ByteArray): Path {
        val task = V2StagingLayout.resolveTaskDirectory(root, plan.taskId)
        if (Files.notExists(task)) Files.createDirectory(task)
        return Files.write(V2StagingLayout.resolveFile(root, plan.taskId, index), bytes)
    }

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
