package io.github.nearbytransfer.android.core.data

import io.github.nearbytransfer.android.core.data.local.PeerPermissionCodec
import io.github.nearbytransfer.android.core.data.local.TrustedPeerEntity
import io.github.nearbytransfer.android.core.model.TrustStatus
import io.github.nearbytransfer.android.core.model.TrustedPeer

internal fun TrustedPeer.toEntity(): TrustedPeerEntity {
    val effectivePermissions = if (trustStatus == TrustStatus.REVOKED) emptySet() else permissions
    return TrustedPeerEntity(
        deviceId = deviceId,
        displayName = displayName,
        fingerprint = fingerprint,
        encodedPermissions = PeerPermissionCodec.encode(effectivePermissions),
        trustStatus = trustStatus.name,
        pairedAtEpochMillis = pairedAtEpochMillis,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )
}

internal fun TrustedPeerEntity.toDomain(): TrustedPeer {
    val status = runCatching { TrustStatus.valueOf(trustStatus) }
        .getOrElse { throw IllegalStateException("Unknown trusted-peer status: $trustStatus", it) }
    val permissions = if (status == TrustStatus.REVOKED) emptySet() else PeerPermissionCodec.decode(encodedPermissions)

    return TrustedPeer(
        deviceId = deviceId,
        displayName = displayName,
        fingerprint = fingerprint,
        permissions = permissions,
        trustStatus = status,
        pairedAtEpochMillis = pairedAtEpochMillis,
        updatedAtEpochMillis = updatedAtEpochMillis,
    )
}