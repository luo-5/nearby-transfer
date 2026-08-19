package io.github.nearbytransfer.android.core.data.local

import io.github.nearbytransfer.android.core.model.PeerPermission

/**
 * Stable, strict storage format for peer permissions.
 *
 * Values are enum names sorted lexicographically and joined by commas. An empty
 * string is the only encoding of an empty permission set. Decoding fails closed
 * for malformed rows so corrupted data cannot silently grant access.
 */
object PeerPermissionCodec {
    fun encode(permissions: Set<PeerPermission>): String = permissions
        .map(PeerPermission::name)
        .sorted()
        .joinToString(",")

    fun decode(encodedPermissions: String): Set<PeerPermission> {
        if (encodedPermissions.isEmpty()) return emptySet()

        val names = encodedPermissions.split(',')
        require(names.none(String::isEmpty)) { "Permission encoding contains an empty value." }
        require(names == names.sorted()) { "Permission encoding is not canonical." }
        require(names.distinct().size == names.size) { "Permission encoding contains duplicates." }

        return names.mapTo(linkedSetOf()) { name ->
            runCatching { PeerPermission.valueOf(name) }
                .getOrElse { throw IllegalArgumentException("Unknown peer permission: $name", it) }
        }
    }
}