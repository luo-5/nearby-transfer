package io.github.nearbytransfer.android.core.publication

import io.github.nearbytransfer.android.core.data.PublicationBackend
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** Normalizes persisted publication backend identifiers to the runtime backend id format. */
object PublicationBackendIdCodec {
    private const val SAF_TREE_PREFIX = "saf-tree-v1:"

    fun backendIdFor(backend: PublicationBackend, publicationRootToken: String?): String = when (backend) {
        PublicationBackend.MEDIA_STORE -> MediaStorePublicationBackend.BACKEND_ID
        PublicationBackend.SAF_TREE -> SAF_TREE_PREFIX + requireTreeFingerprint(publicationRootToken)
        PublicationBackend.FILESYSTEM -> PublicationBackend.FILESYSTEM.name
    }

    fun publicationBackendFor(persistedBackendId: String?, publicationRootToken: String?): PublicationBackend? {
        if (persistedBackendId == null) return null
        return when {
            persistedBackendId == PublicationBackend.MEDIA_STORE.name ||
                persistedBackendId == MediaStorePublicationBackend.BACKEND_ID -> PublicationBackend.MEDIA_STORE

            persistedBackendId == PublicationBackend.SAF_TREE.name ||
                persistedBackendId.startsWith(SAF_TREE_PREFIX) -> {
                if (publicationRootToken != null && persistedBackendId.startsWith(SAF_TREE_PREFIX)) {
                    require(persistedBackendId == backendIdFor(PublicationBackend.SAF_TREE, publicationRootToken)) {
                        "Persisted SAF tree backend does not match the publication root token."
                    }
                }
                PublicationBackend.SAF_TREE
            }

            persistedBackendId == PublicationBackend.FILESYSTEM.name -> PublicationBackend.FILESYSTEM
            else -> null
        }
    }

    fun canonicalBackendId(persistedBackendId: String?, publicationRootToken: String?): String? {
        if (persistedBackendId == null) return null
        return when {
            persistedBackendId == PublicationBackend.MEDIA_STORE.name ||
                persistedBackendId == MediaStorePublicationBackend.BACKEND_ID -> MediaStorePublicationBackend.BACKEND_ID

            persistedBackendId == PublicationBackend.SAF_TREE.name -> {
                publicationRootToken?.let { backendIdFor(PublicationBackend.SAF_TREE, it) }
                    ?: PublicationBackend.SAF_TREE.name
            }

            persistedBackendId.startsWith(SAF_TREE_PREFIX) -> {
                if (publicationRootToken == null) {
                    persistedBackendId
                } else {
                    backendIdFor(PublicationBackend.SAF_TREE, publicationRootToken).also {
                        require(it == persistedBackendId) {
                            "Persisted SAF tree backend does not match the publication root token."
                        }
                    }
                }
            }

            persistedBackendId == PublicationBackend.FILESYSTEM.name -> PublicationBackend.FILESYSTEM.name
            else -> persistedBackendId
        }
    }

    fun backendIdsMatch(
        persistedBackendId: String?,
        expectedBackendId: String,
        publicationRootToken: String?,
    ): Boolean {
        if (persistedBackendId == null) return false
        if (persistedBackendId == expectedBackendId) return true
        return canonicalBackendId(persistedBackendId, publicationRootToken) == expectedBackendId
    }

    private fun requireTreeFingerprint(publicationRootToken: String?): String {
        val rootToken = publicationRootToken?.trim()
            ?: throw IllegalArgumentException("Publication root token is required for SAF tree backends.")
        require(rootToken.isNotEmpty()) { "Publication root token is required for SAF tree backends." }
        return sha256(rootToken).take(24)
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .toHex()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
