package io.github.nearbytransfer.android.core.recovery

import io.github.nearbytransfer.android.V2StagingLayout
import io.github.nearbytransfer.android.core.publication.PublicationFileSpec
import io.github.nearbytransfer.android.core.publication.PublicationPlan
import io.github.nearbytransfer.android.core.publication.PublicationSource
import io.github.nearbytransfer.android.core.publication.PublicationSourceProvider
import java.io.IOException
import java.io.InputStream
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.OpenOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.atomic.AtomicBoolean

/** Reopens sealed app-private staging files without ever creating missing data. */
class AppPrivatePublicationSourceProvider(appPrivateStagingRoot: Path) : PublicationSourceProvider {
    private val root = StagingFilesystemSecurity.requireSafeRoot(appPrivateStagingRoot)

    override fun sourceFor(plan: PublicationPlan, file: PublicationFileSpec): PublicationSource {
        require(plan.files.getOrNull(file.index) == file) {
            "Publication file does not belong to the supplied plan"
        }
        val taskDirectory = V2StagingLayout.resolveTaskDirectory(root, plan.taskId)
        val stagingFile = V2StagingLayout.resolveFile(root, plan.taskId, file.index)
        return ExistingStagingSource(
            root = root,
            taskDirectory = taskDirectory,
            stagingFile = stagingFile,
            relativePath = file.relativePath,
            expectedSize = file.size,
        )
    }

    private class ExistingStagingSource(
        private val root: Path,
        private val taskDirectory: Path,
        private val stagingFile: Path,
        override val relativePath: String,
        private val expectedSize: Long,
    ) : PublicationSource {
        private val openAttempted = AtomicBoolean(false)

        override val size: Long = expectedSize

        override fun open(): InputStream {
            check(openAttempted.compareAndSet(false, true)) {
                "Publication source may be opened only once"
            }

            StagingFilesystemSecurity.requireSafeRoot(root)
            StagingFilesystemSecurity.requireRealDirectory(taskDirectory, "Staging task path")
            val options = linkedSetOf<OpenOption>(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
            val channel = FileChannel.open(stagingFile, options)
            try {
                val attributes = StagingFilesystemSecurity.readAttributes(stagingFile)
                if (!attributes.isRegularFile || attributes.isSymbolicLink) {
                    throw SecurityException("Staging source must be a real regular file")
                }
                if (attributes.size() != expectedSize || channel.size() != expectedSize) {
                    throw IOException("Staging source size no longer matches the publication plan")
                }
                return Channels.newInputStream(channel)
            } catch (error: Throwable) {
                try {
                    channel.close()
                } catch (closeError: Throwable) {
                    error.addSuppressed(closeError)
                }
                throw error
            }
        }
    }
}

internal object StagingFilesystemSecurity {
    fun requireSafeRoot(candidate: Path): Path {
        val root = V2StagingLayout.normalizeRoot(candidate)
        var current = root.root ?: throw IllegalArgumentException("Staging root must be absolute")
        requireRealDirectory(current, "Staging root path")
        for (component in root) {
            current = current.resolve(component)
            requireRealDirectory(current, "Staging root path")
        }
        return root
    }

    fun requireRealDirectory(path: Path, subject: String) {
        val attributes = readAttributes(path)
        if (!attributes.isDirectory || attributes.isSymbolicLink) {
            throw SecurityException("$subject must be a real directory")
        }
    }

    fun readAttributes(path: Path): BasicFileAttributes =
        Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
}
