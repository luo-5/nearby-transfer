package io.github.nearbytransfer.android.core.publication

/** A durable, serializable publication plan. It deliberately contains no live stream handles. */
data class PublicationPlan(
    val publicationId: String,
    val taskId: String,
    val backendId: String,
    val files: List<PublicationFileSpec>,
) {
    init {
        require(publicationId.isNotBlank()) { "publicationId is required" }
        require(taskId.isNotBlank()) { "taskId is required" }
        require(backendId.isNotBlank()) { "backendId is required" }
        require(files.isNotEmpty()) { "At least one publication file is required" }
        require(files.map { it.index }.toSet().size == files.size) { "File indexes must be unique" }
        require(files.map { it.relativePath }.toSet().size == files.size) { "File paths must be unique" }
        require(files.map { it.index } == files.indices.toList()) { "Files must use contiguous manifest order" }
    }
}

data class PublicationFileSpec(
    val index: Int,
    val relativePath: String,
    val size: Long,
    val sha256: String,
) {
    init {
        require(index >= 0) { "File index must be non-negative" }
        require(isSafeRelativePath(relativePath)) { "File path must be a normalized relative path" }
        require(size >= 0L) { "File size must be non-negative" }
        require(SHA256.matches(sha256)) { "sha256 must be lowercase hexadecimal" }
    }

    companion object {
        private val SHA256 = Regex("[0-9a-f]{64}")

        private fun isSafeRelativePath(path: String): Boolean {
            if (path.isBlank() || path.startsWith('/') || path.startsWith('\\') || '\\' in path) return false
            return path.split('/').none { it.isEmpty() || it == "." || it == ".." }
        }
    }
}

data class PublicationFileKey(
    val publicationId: String,
    val fileIndex: Int,
) {
    init {
        require(publicationId.isNotBlank()) { "publicationId is required" }
        require(fileIndex >= 0) { "fileIndex must be non-negative" }
    }
}

enum class PublicationFileState {
    PLANNED,
    ALLOCATING,
    ALLOCATED,
    WRITING,
    WRITTEN,
    PUBLISHING,
    PUBLISHED,
    ABORTING,
    ABORTED,
}

enum class PublicationState {
    PREPARED,
    PUBLISHING,
    PARTIAL,
    PUBLISHED,
    CANCEL_PENDING,
    CANCELLED,
}

data class PublicationFileRecord(
    val spec: PublicationFileSpec,
    val state: PublicationFileState = PublicationFileState.PLANNED,
    val targetToken: String? = null,
    val observedSize: Long? = null,
    val observedSha256: String? = null,
    val lastError: String? = null,
)

data class PublicationRecord(
    val plan: PublicationPlan,
    val files: List<PublicationFileRecord> = plan.files.map(::PublicationFileRecord),
    val state: PublicationState = PublicationState.PREPARED,
    val cancelRequested: Boolean = false,
    val cleanupPending: Boolean = false,
    val revision: Long = 0L,
) {
    init {
        require(revision >= 0L) { "revision must be non-negative" }
        require(files.map { it.spec } == plan.files) { "Journal files must exactly match the plan" }
    }
}

data class PublicationRunResult(
    val publicationId: String,
    val state: PublicationState,
    val publishedFiles: Int,
    val pendingFiles: Int,
    val cleanupPending: Boolean,
)
