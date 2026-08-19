package io.github.nearbytransfer.android.core.recovery

import io.github.nearbytransfer.android.V2StagingLayout
import io.github.nearbytransfer.android.core.publication.PublicationPlan
import java.nio.file.DirectoryStream
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path

/** Deletes only the staging files that a durable publication plan proves it owns. */
class AppPrivateStagingCleaner(appPrivateStagingRoot: Path) {
    private val root = StagingFilesystemSecurity.requireSafeRoot(appPrivateStagingRoot)

    /**
     * Idempotently removes the plan's app-private staging directory.
     *
     * Missing expected files are accepted because a previous cleanup attempt may have removed them.
     * Any unknown, linked, or non-regular entry aborts cleanup before known entries are removed.
     */
    fun cleanup(plan: PublicationPlan) {
        StagingFilesystemSecurity.requireSafeRoot(root)
        val taskDirectory = V2StagingLayout.resolveTaskDirectory(root, plan.taskId)
        if (!requireExistingTaskDirectory(taskDirectory)) return

        val expectedNames = plan.files.mapTo(linkedSetOf()) { V2StagingLayout.fileId(it.index) }
        val entries = mutableListOf<Path>()
        Files.newDirectoryStream(taskDirectory).use { directory: DirectoryStream<Path> ->
            for (entry in directory) {
                val name = entry.fileName.toString()
                if (name !in expectedNames) {
                    throw SecurityException("Unexpected staging cleanup entry: $name")
                }
                requireExpectedRegularFile(entry)
                entries.add(entry)
            }
        }

        entries.sortedBy { it.fileName.toString() }.forEach(::deleteExpectedFileIfPresent)
        if (!requireExistingTaskDirectory(taskDirectory)) return
        try {
            Files.delete(taskDirectory)
        } catch (_: NoSuchFileException) {
            // A repeated or resumed cleanup already removed the now-empty task directory.
        }
    }

    private fun requireExistingTaskDirectory(taskDirectory: Path): Boolean {
        val attributes = try {
            StagingFilesystemSecurity.readAttributes(taskDirectory)
        } catch (_: NoSuchFileException) {
            return false
        }
        if (!attributes.isDirectory || attributes.isSymbolicLink) {
            throw SecurityException("Staging task path must be a real directory")
        }
        return true
    }

    private fun requireExpectedRegularFile(entry: Path) {
        val attributes = StagingFilesystemSecurity.readAttributes(entry)
        if (!attributes.isRegularFile || attributes.isSymbolicLink) {
            throw SecurityException("Staging cleanup entry must be a real regular file")
        }
    }

    private fun deleteExpectedFileIfPresent(entry: Path) {
        try {
            requireExpectedRegularFile(entry)
            Files.delete(entry)
        } catch (_: NoSuchFileException) {
            // A previous cleanup attempt may already have removed this expected file.
        }
    }
}
