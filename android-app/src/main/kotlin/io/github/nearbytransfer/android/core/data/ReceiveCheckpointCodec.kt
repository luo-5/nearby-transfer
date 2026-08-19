package io.github.nearbytransfer.android.core.data

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

/**
 * Strict codec for the receiver checkpoint persisted beside a protocol-v2 manifest.
 *
 * Persistence format (canonical key order):
 * `files`, `formatVersion`, `manifestHash`, `nextSequence`, `taskId`, `transferredBytes`.
 * File records contain only `committedOffset`, `completed`, and `path`; their sizes and
 * ordering are authoritatively supplied by the normalized manifest.
 */
internal object ReceiveCheckpointCodec {
    private const val FORMAT_VERSION = 1L
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private const val MAX_SEQUENCE = MAX_SAFE_INTEGER
    private const val MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024
    private const val MAX_RELATIVE_PATH_BYTES = 4_096
    private const val MAX_PATH_COMPONENT_BYTES = 255

    private val sha256Pattern = Regex("^[a-f0-9]{64}$")
    private val windowsReservedPattern = Regex(
        "^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$",
        RegexOption.IGNORE_CASE,
    )

    data class FileCheckpoint(
        val path: String,
        val committedOffset: Long,
        val completed: Boolean,
    )

    data class NormalizedCheckpoint(
        val taskId: String,
        val manifestHash: String,
        val files: List<FileCheckpoint>,
        val nextSequence: Long,
        val transferredBytes: Long,
        val json: String,
    )

    private data class ManifestFile(val path: String, val size: Long)

    private data class ManifestBinding(
        val taskId: String,
        val manifestHash: String,
        val files: List<ManifestFile>,
    )

    /** Creates the canonical all-zero receive checkpoint for a manifest. */
    fun createInitial(manifestJson: String, nextSequence: Long = 0): NormalizedCheckpoint {
        requireSequence(nextSequence)
        val manifest = bindManifest(manifestJson)
        return normalized(
            manifest = manifest,
            files = manifest.files.map { FileCheckpoint(it.path, 0, false) },
            nextSequence = nextSequence,
            transferredBytes = 0,
        )
    }

    /** Parses, validates against the manifest, and emits deterministic canonical JSON. */
    fun normalize(manifestJson: String, checkpointJson: String): NormalizedCheckpoint {
        val manifest = bindManifest(manifestJson)
        require(checkpointJson.toByteArray(StandardCharsets.UTF_8).size <= MAX_CHECKPOINT_BYTES) {
            "Receive checkpoint exceeds the persistence size limit."
        }
        val source = try {
            JSONObject(checkpointJson)
        } catch (error: Exception) {
            throw IllegalArgumentException("Receive checkpoint must be a JSON object.", error)
        }
        requireExactKeys(
            source,
            setOf("files", "formatVersion", "manifestHash", "nextSequence", "taskId", "transferredBytes"),
            "Receive checkpoint",
        )
        require(exactLong(source.opt("formatVersion"), "Receive checkpoint formatVersion") == FORMAT_VERSION) {
            "Receive checkpoint format version is invalid."
        }
        val taskId = requireString(source, "taskId", "Receive checkpoint")
        require(taskId == manifest.taskId) { "Receive checkpoint task ID does not match the manifest." }
        val manifestHash = requireString(source, "manifestHash", "Receive checkpoint")
        require(sha256Pattern.matches(manifestHash)) {
            "Receive checkpoint manifest hash must be 64 lowercase hexadecimal characters."
        }
        require(manifestHash == manifest.manifestHash) {
            "Receive checkpoint manifest hash does not match the canonical manifest."
        }

        val sourceFiles = source.opt("files") as? JSONArray
            ?: throw IllegalArgumentException("Receive checkpoint files must be an array.")
        require(sourceFiles.length() == manifest.files.size) {
            "Receive checkpoint file count does not match the manifest."
        }

        val files = ArrayList<FileCheckpoint>(sourceFiles.length())
        val exactPaths = HashSet<String>()
        val windowsPaths = HashSet<String>()
        repeat(sourceFiles.length()) { index ->
            val value = sourceFiles.opt(index) as? JSONObject
                ?: throw IllegalArgumentException("Receive checkpoint file must be an object.")
            requireExactKeys(value, setOf("committedOffset", "completed", "path"), "Receive checkpoint file")
            val path = requireString(value, "path", "Receive checkpoint file")
            validateRelativePath(path)
            require(exactPaths.add(path)) { "Receive checkpoint contains duplicate paths." }
            require(windowsPaths.add(path.uppercase(Locale.ROOT))) {
                "Receive checkpoint contains Windows-colliding paths."
            }
            val manifestFile = manifest.files[index]
            require(path == manifestFile.path) {
                "Receive checkpoint file ordering or path does not match the manifest."
            }
            val committedOffset = exactLong(value.opt("committedOffset"), "Receive checkpoint committedOffset")
            require(committedOffset <= manifestFile.size) {
                "Receive checkpoint committed offset exceeds the manifest file size."
            }
            val completed = value.opt("completed") as? Boolean
                ?: throw IllegalArgumentException("Receive checkpoint completed must be a boolean.")
            require(!completed || committedOffset == manifestFile.size) {
                "Completed receive checkpoint files must be committed through their full size."
            }
            require(completed || manifestFile.size == 0L || committedOffset < manifestFile.size) {
                "A non-completed non-empty file cannot be committed through its full size."
            }
            files += FileCheckpoint(path, committedOffset, completed)
        }

        validateContiguousProgress(files)
        val transferredBytes = exactLong(
            source.opt("transferredBytes"),
            "Receive checkpoint transferredBytes",
        )
        val committedTotal = checkedOffsetSum(files)
        require(transferredBytes == committedTotal) {
            "Receive checkpoint transferredBytes must equal the sum of committed offsets."
        }
        val nextSequence = exactLong(source.opt("nextSequence"), "Receive checkpoint nextSequence")
        requireSequence(nextSequence)
        return normalized(manifest, files, nextSequence, transferredBytes)
    }

    /**
     * Validates a candidate against both the manifest and a previously persisted checkpoint.
     * Every file offset/completion marker and the sequence must move monotonically forward.
     */
    fun advance(
        manifestJson: String,
        previousCheckpointJson: String?,
        candidateCheckpointJson: String,
    ): NormalizedCheckpoint {
        val candidate = normalize(manifestJson, candidateCheckpointJson)
        if (previousCheckpointJson == null) return candidate
        val previous = normalize(manifestJson, previousCheckpointJson)
        requireMonotonic(previous, candidate)
        return candidate
    }

    fun requireMonotonic(previous: NormalizedCheckpoint, candidate: NormalizedCheckpoint) {
        require(previous.taskId == candidate.taskId && previous.manifestHash == candidate.manifestHash) {
            "Receive checkpoints are bound to different transfers."
        }
        require(previous.files.size == candidate.files.size) {
            "Receive checkpoint file lists differ."
        }
        previous.files.indices.forEach { index ->
            val before = previous.files[index]
            val after = candidate.files[index]
            require(before.path == after.path) { "Receive checkpoint file lists differ." }
            require(after.committedOffset >= before.committedOffset) {
                "Receive checkpoint file offsets must not move backwards."
            }
            require(!before.completed || after.completed) {
                "Receive checkpoint completion markers must not move backwards."
            }
        }
        require(candidate.transferredBytes >= previous.transferredBytes) {
            "Receive checkpoint transferred bytes must not move backwards."
        }
        require(candidate.nextSequence >= previous.nextSequence) {
            "Receive checkpoint sequence must not move backwards."
        }
    }

    private fun bindManifest(manifestJson: String): ManifestBinding {
        val normalized = TransferManifestCodec.normalize(manifestJson)
        val source = JSONObject(normalized.json)
        val entries = source.getJSONArray("entries")
        val files = ArrayList<ManifestFile>(normalized.totalFiles)
        repeat(entries.length()) { index ->
            val entry = entries.getJSONObject(index)
            if (entry.getString("kind") == "file") {
                files += ManifestFile(entry.getString("path"), entry.getLong("size"))
            }
        }
        check(files.size == normalized.totalFiles)
        return ManifestBinding(
            taskId = normalized.taskId,
            manifestHash = sha256Hex(normalized.json.toByteArray(StandardCharsets.UTF_8)),
            files = files,
        )
    }

    private fun normalized(
        manifest: ManifestBinding,
        files: List<FileCheckpoint>,
        nextSequence: Long,
        transferredBytes: Long,
    ): NormalizedCheckpoint {
        val immutableFiles = files.toList()
        val canonical = buildCanonicalJson(
            taskId = manifest.taskId,
            manifestHash = manifest.manifestHash,
            files = immutableFiles,
            nextSequence = nextSequence,
            transferredBytes = transferredBytes,
        )
        require(canonical.toByteArray(StandardCharsets.UTF_8).size <= MAX_CHECKPOINT_BYTES) {
            "Receive checkpoint exceeds the persistence size limit."
        }
        return NormalizedCheckpoint(
            taskId = manifest.taskId,
            manifestHash = manifest.manifestHash,
            files = immutableFiles,
            nextSequence = nextSequence,
            transferredBytes = transferredBytes,
            json = canonical,
        )
    }

    private fun validateContiguousProgress(files: List<FileCheckpoint>) {
        var foundIncomplete = false
        files.forEach { file ->
            if (!foundIncomplete) {
                if (!file.completed) foundIncomplete = true
            } else {
                require(!file.completed && file.committedOffset == 0L) {
                    "Only the first incomplete file may be partially committed; later files must remain at zero."
                }
            }
        }
    }

    private fun checkedOffsetSum(files: List<FileCheckpoint>): Long {
        var total = 0L
        files.forEach { file ->
            total = try {
                Math.addExact(total, file.committedOffset)
            } catch (error: ArithmeticException) {
                throw IllegalArgumentException("Receive checkpoint committed offsets overflow Long.", error)
            }
            require(total <= MAX_SAFE_INTEGER) {
                "Receive checkpoint committed offsets exceed safe integer precision."
            }
        }
        return total
    }

    private fun buildCanonicalJson(
        taskId: String,
        manifestHash: String,
        files: List<FileCheckpoint>,
        nextSequence: Long,
        transferredBytes: Long,
    ): String = buildString {
        append("{\"files\":[")
        files.forEachIndexed { index, file ->
            if (index > 0) append(',')
            append("{\"committedOffset\":").append(file.committedOffset)
            append(",\"completed\":").append(file.completed)
            append(",\"path\":").append(JSONObject.quote(file.path)).append('}')
        }
        append("],\"formatVersion\":1,\"manifestHash\":").append(JSONObject.quote(manifestHash))
        append(",\"nextSequence\":").append(nextSequence)
        append(",\"taskId\":").append(JSONObject.quote(taskId))
        append(",\"transferredBytes\":").append(transferredBytes).append('}')
    }

    private fun exactLong(value: Any?, label: String): Long {
        val result = try {
            when (value) {
                is Byte -> value.toLong()
                is Short -> value.toLong()
                is Int -> value.toLong()
                is Long -> value
                is BigInteger -> value.longValueExact()
                else -> throw IllegalArgumentException("$label must be an exact JSON integer.")
            }
        } catch (error: ArithmeticException) {
            throw IllegalArgumentException("$label is outside Long range.", error)
        }
        require(result in 0..MAX_SAFE_INTEGER) { "$label is out of safe integer range." }
        return result
    }

    private fun requireSequence(value: Long) {
        require(value in 0..MAX_SEQUENCE) { "Receive checkpoint nextSequence exceeds the protocol limit." }
    }

    private fun requireExactKeys(value: JSONObject, expected: Set<String>, label: String) {
        val actual = value.keys().asSequence().toSet()
        require(actual == expected) { "$label contains missing or unexpected fields." }
    }

    private fun requireString(value: JSONObject, key: String, label: String): String {
        val result = value.opt(key) as? String
            ?: throw IllegalArgumentException("$label $key must be a string.")
        require(result.isNotEmpty()) { "$label $key must be non-empty." }
        requireWellFormedUnicode(result, "$label $key")
        return result
    }

    private fun validateRelativePath(path: String) {
        require(path.isNotEmpty()) { "Receive checkpoint path must be non-empty." }
        requireWellFormedUnicode(path, "Receive checkpoint path")
        require(path.toByteArray(StandardCharsets.UTF_8).size <= MAX_RELATIVE_PATH_BYTES) {
            "Receive checkpoint path exceeds the maximum UTF-8 length."
        }
        require(!path.startsWith('/') && !path.startsWith('\\') && '\\' !in path) {
            "Receive checkpoint path must use a relative POSIX path."
        }
        require(!(path.length >= 2 && path[0].isLetter() && path[1] == ':')) {
            "Receive checkpoint path must use a relative POSIX path."
        }
        path.split('/').forEach { component ->
            require(component.isNotEmpty() && component != "." && component != "..") {
                "Receive checkpoint path must not contain empty or traversal components."
            }
            require(component.toByteArray(StandardCharsets.UTF_8).size <= MAX_PATH_COMPONENT_BYTES) {
                "Receive checkpoint path component exceeds the maximum UTF-8 length."
            }
            require(component.none { it.code <= 0x1f || it.code == 0x7f || it in "<>:\"/\\|?*" }) {
                "Receive checkpoint path component contains a Windows-invalid character."
            }
            require(!component.endsWith('.') && !component.endsWith(' ')) {
                "Receive checkpoint path component must not end in a period or space."
            }
            val baseName = component.substringBefore('.').trimEnd('.', ' ')
            require(!windowsReservedPattern.matches(baseName)) {
                "Receive checkpoint path component uses a Windows reserved device name."
            }
        }
    }

    private fun requireWellFormedUnicode(value: String, label: String) {
        var index = 0
        while (index < value.length) {
            val current = value[index]
            if (Character.isHighSurrogate(current)) {
                require(index + 1 < value.length && Character.isLowSurrogate(value[index + 1])) {
                    "$label contains malformed Unicode."
                }
                index += 2
            } else {
                require(!Character.isLowSurrogate(current)) { "$label contains malformed Unicode." }
                index += 1
            }
        }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val alphabet = "0123456789abcdef"
        return buildString(digest.size * 2) {
            digest.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(alphabet[value ushr 4])
                append(alphabet[value and 0x0f])
            }
        }
    }
}
