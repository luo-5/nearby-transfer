package io.github.nearbytransfer.android.core.recovery

import android.content.Context
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

/** Shared app-private locations used by protocol-v2 receive recovery. */
object V2RecoveryPaths {
    private const val STAGING_DIRECTORY = "v2-staging"

    /**
     * Returns the durable receive staging root and creates it if necessary.
     *
     * The root deliberately lives under filesDir so recovery can reopen verified payloads after a
     * process restart without requesting broad storage permissions.
     */
    fun stagingRoot(context: Context): Path {
        val configuredFilesRoot = context.applicationContext.filesDir.toPath().toAbsolutePath().normalize()
        Files.createDirectories(configuredFilesRoot)

        // filesDir can legitimately be exposed through a framework path alias. Resolve that trusted
        // anchor first, then require the recovery directory itself to stay below the real app root.
        val realFilesRoot = configuredFilesRoot.toRealPath()
        val configuredStagingRoot = realFilesRoot.resolve(STAGING_DIRECTORY).normalize()
        if (!configuredStagingRoot.startsWith(realFilesRoot) || configuredStagingRoot == realFilesRoot) {
            throw SecurityException("Recovery staging root escapes the app-private files directory")
        }
        Files.createDirectories(configuredStagingRoot)
        val attributes = Files.readAttributes(
            configuredStagingRoot,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (!attributes.isDirectory || attributes.isSymbolicLink) {
            throw SecurityException("Recovery staging root must be a real directory")
        }
        val realStagingRoot = configuredStagingRoot.toRealPath()
        if (!realStagingRoot.startsWith(realFilesRoot) || realStagingRoot == realFilesRoot) {
            throw SecurityException("Recovery staging root escapes the app-private files directory")
        }
        return realStagingRoot
    }
}
