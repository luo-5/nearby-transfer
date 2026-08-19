package io.github.nearbytransfer.android.core.data

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Locale

/** Strict normalization for the public protocol-v2 transfer manifest stored by Room. */
internal object TransferManifestCodec {
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private const val MAX_FILE_SIZE_BYTES = 1_099_511_627_776L
    private const val MAX_TOTAL_SIZE_BYTES = 4_398_046_511_104L
    private const val MAX_MANIFEST_ENTRIES = 10_000
    private const val MAX_TRANSFER_FILES = 8_192
    private const val MAX_RELATIVE_PATH_BYTES = 4_096
    private const val MAX_PATH_COMPONENT_BYTES = 255
    private const val MAX_MANIFEST_BYTES = 4 * 1024 * 1024

    private val taskIdPattern = Regex("^[A-Za-z0-9_-]{22}$")
    private val sha256Pattern = Regex("^[a-f0-9]{64}$")
    private val windowsReservedPattern = Regex(
        "^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$",
        RegexOption.IGNORE_CASE,
    )

    data class NormalizedManifest(
        val taskId: String,
        val totalBytes: Long,
        val totalFiles: Int,
        val json: String,
    )

    private data class Entry(
        val kind: String,
        val path: String,
        val size: Long? = null,
        val sha256: String? = null,
    )

    fun normalize(json: String): NormalizedManifest {
        require(json.toByteArray(StandardCharsets.UTF_8).size <= MAX_MANIFEST_BYTES) {
            "Transfer manifest exceeds the persistence size limit."
        }
        val source = try {
            JSONObject(json)
        } catch (error: Exception) {
            throw IllegalArgumentException("Transfer manifest must be a JSON object.", error)
        }
        requireExactKeys(
            source,
            setOf("app", "protocolVersion", "type", "taskId", "conflictStrategy", "entries", "totalFiles", "totalBytes"),
            "Transfer manifest",
        )
        require(source.opt("app") == "nearby-transfer") { "Transfer manifest app is invalid." }
        require(exactLong(source.opt("protocolVersion"), "protocolVersion") == 2L) {
            "Transfer manifest protocol version is invalid."
        }
        require(source.opt("type") == "transfer-manifest") { "Transfer manifest type is invalid." }
        val taskId = requireString(source, "taskId", "Transfer manifest")
        validateTaskId(taskId)
        require(source.opt("conflictStrategy") == "auto-rename") {
            "Transfer manifest conflict strategy must be auto-rename."
        }

        val sourceEntries = source.opt("entries") as? JSONArray
            ?: throw IllegalArgumentException("Transfer manifest entries must be an array.")
        require(sourceEntries.length() in 1..MAX_MANIFEST_ENTRIES) {
            "Transfer manifest must contain a bounded non-empty entry list."
        }

        val entries = ArrayList<Entry>(sourceEntries.length())
        val exactPaths = HashSet<String>()
        val windowsPaths = HashSet<String>()
        val directories = HashSet<String>()
        val filePaths = ArrayList<String>()
        var totalBytes = 0L
        var totalFiles = 0

        repeat(sourceEntries.length()) { index ->
            val value = sourceEntries.opt(index) as? JSONObject
                ?: throw IllegalArgumentException("Transfer manifest entry must be an object.")
            val kind = requireString(value, "kind", "Transfer manifest entry")
            val path = requireString(value, "path", "Transfer manifest entry")
            validateRelativePath(path)
            require(exactPaths.add(path) && windowsPaths.add(path.uppercase(Locale.ROOT))) {
                "Transfer manifest contains duplicate or Windows-colliding paths."
            }
            val entry = when (kind) {
                "directory" -> {
                    requireExactKeys(value, setOf("kind", "path"), "Transfer directory entry")
                    directories += path
                    Entry(kind, path)
                }
                "file" -> {
                    requireExactKeys(value, setOf("kind", "path", "size", "sha256"), "Transfer file entry")
                    val size = exactLong(value.opt("size"), "Transfer file size")
                    require(size in 0..MAX_FILE_SIZE_BYTES) { "Transfer file size is out of range." }
                    val sha256 = requireString(value, "sha256", "Transfer file entry")
                    require(sha256Pattern.matches(sha256)) {
                        "Transfer SHA-256 must be 64 lowercase hexadecimal characters."
                    }
                    totalFiles += 1
                    require(totalFiles <= MAX_TRANSFER_FILES) { "Transfer manifest exceeds the maximum file count." }
                    totalBytes = Math.addExact(totalBytes, size)
                    require(totalBytes <= MAX_TOTAL_SIZE_BYTES) { "Transfer manifest exceeds the maximum total size." }
                    filePaths += path
                    Entry(kind, path, size, sha256)
                }
                else -> throw IllegalArgumentException("Transfer manifest entry kind must be file or directory.")
            }
            entries += entry
        }

        directories.forEach { requireParentsDeclared(it, directories) }
        filePaths.forEach { requireParentsDeclared(it, directories) }
        require(exactLong(source.opt("totalFiles"), "Transfer manifest totalFiles") == totalFiles.toLong()) {
            "Transfer manifest totalFiles does not match its entries."
        }
        require(exactLong(source.opt("totalBytes"), "Transfer manifest totalBytes") == totalBytes) {
            "Transfer manifest totalBytes does not match its entries."
        }

        entries.sortBy { it.path }
        val canonical = buildCanonicalJson(taskId, entries, totalFiles, totalBytes)
        require(canonical.toByteArray(StandardCharsets.UTF_8).size <= MAX_MANIFEST_BYTES) {
            "Transfer manifest exceeds the persistence size limit."
        }
        return NormalizedManifest(taskId, totalBytes, totalFiles, canonical)
    }

    fun validateTaskId(taskId: String) {
        require(taskIdPattern.matches(taskId)) { "Transfer task ID must be a canonical 16-byte base64url value." }
        val decoded = try {
            Base64.getUrlDecoder().decode(taskId)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("Transfer task ID must be valid base64url.", error)
        }
        require(decoded.size == 16 && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == taskId) {
            "Transfer task ID must be a canonical 16-byte base64url value."
        }
    }

    private fun buildCanonicalJson(taskId: String, entries: List<Entry>, totalFiles: Int, totalBytes: Long): String =
        buildString {
            append("{\"app\":\"nearby-transfer\",\"conflictStrategy\":\"auto-rename\",\"entries\":[")
            entries.forEachIndexed { index, entry ->
                if (index > 0) append(',')
                append("{\"kind\":").append(JSONObject.quote(entry.kind))
                append(",\"path\":").append(JSONObject.quote(entry.path))
                if (entry.kind == "file") {
                    append(",\"sha256\":").append(JSONObject.quote(requireNotNull(entry.sha256)))
                    append(",\"size\":").append(requireNotNull(entry.size))
                }
                append('}')
            }
            append("],\"protocolVersion\":2,\"taskId\":").append(JSONObject.quote(taskId))
            append(",\"totalBytes\":").append(totalBytes)
            append(",\"totalFiles\":").append(totalFiles)
            append(",\"type\":\"transfer-manifest\"}")
        }

    private fun validateRelativePath(path: String) {
        require(path.isNotEmpty()) { "Transfer path must be non-empty." }
        requireWellFormedUnicode(path, "Transfer path")
        require(path.toByteArray(StandardCharsets.UTF_8).size <= MAX_RELATIVE_PATH_BYTES) {
            "Transfer path exceeds the maximum UTF-8 length."
        }
        require(!path.startsWith('/') && !path.startsWith('\\') && '\\' !in path) {
            "Transfer path must use a relative POSIX path."
        }
        require(!(path.length >= 2 && path[0].isLetter() && path[1] == ':')) {
            "Transfer path must use a relative POSIX path."
        }
        path.split('/').forEach { component ->
            require(component.isNotEmpty() && component != "." && component != "..") {
                "Transfer path must not contain empty or traversal components."
            }
            require(component.toByteArray(StandardCharsets.UTF_8).size <= MAX_PATH_COMPONENT_BYTES) {
                "Transfer path component exceeds the maximum UTF-8 length."
            }
            require(component.none { it.code <= 0x1f || it.code == 0x7f || it in "<>:\"/\\|?*" }) {
                "Transfer path component contains a Windows-invalid character."
            }
            require(!component.endsWith('.') && !component.endsWith(' ')) {
                "Transfer path component must not end in a period or space."
            }
            val baseName = component.substringBefore('.').trimEnd('.', ' ')
            require(!windowsReservedPattern.matches(baseName)) {
                "Transfer path component uses a Windows reserved device name."
            }
        }
    }

    private fun requireParentsDeclared(path: String, directories: Set<String>) {
        var slash = path.indexOf('/')
        while (slash >= 0) {
            require(path.substring(0, slash) in directories) {
                "Transfer manifest parent directory is not declared."
            }
            slash = path.indexOf('/', slash + 1)
        }
    }

    private fun exactLong(value: Any?, label: String): Long {
        val result = when (value) {
            is Byte -> value.toLong()
            is Short -> value.toLong()
            is Int -> value.toLong()
            is Long -> value
            is BigInteger -> value.longValueExact()
            is BigDecimal -> value.longValueExact()
            else -> throw IllegalArgumentException("$label must be an exact integer.")
        }
        require(result in 0..MAX_SAFE_INTEGER) { "$label is out of range." }
        return result
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
}
