package io.github.nearbytransfer.android.core.model

/** Permissions recorded for a paired device. The Room entity will persist these values. */
enum class PeerPermission {
    TRANSFER,
    LIBRARY_READ,
    LIBRARY_UPLOAD,
}

enum class TrustStatus {
    TRUSTED,
    REVOKED,
}

/**
 * Platform-neutral trusted-device domain object.
 *
 * deviceId and fingerprint are protocol-v2 public identity values. The two
 * public keys bind a trusted peer to its Ed25519 signing identity and X25519
 * encryption identity. Private keys and session secrets never belong in this
 * model or its Room representation.
 */
data class TrustedPeer(
    val deviceId: String,
    val displayName: String,
    val fingerprint: String,
    val signingPublicKey: String,
    val encryptionPublicKey: String,
    val permissions: Set<PeerPermission>,
    val trustStatus: TrustStatus,
    val pairedAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
) {
    fun canTransfer(): Boolean = trustStatus == TrustStatus.TRUSTED && PeerPermission.TRANSFER in permissions

    fun canReadLibrary(): Boolean = trustStatus == TrustStatus.TRUSTED && PeerPermission.LIBRARY_READ in permissions

    fun canUploadToLibrary(): Boolean = trustStatus == TrustStatus.TRUSTED && PeerPermission.LIBRARY_UPLOAD in permissions
}
