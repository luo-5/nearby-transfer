package io.github.nearbytransfer.android;

final class PeerDevice {
    final String deviceId;
    final String deviceName;
    final String host;
    final int port;
    final String signingPublicKey;
    final String encryptionPublicKey;
    final String fingerprint;
    final long lastSeen;

    PeerDevice(
        String deviceId,
        String deviceName,
        String host,
        int port,
        String signingPublicKey,
        String encryptionPublicKey,
        String fingerprint,
        long lastSeen
    ) {
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.host = host;
        this.port = port;
        this.signingPublicKey = signingPublicKey;
        this.encryptionPublicKey = encryptionPublicKey;
        this.fingerprint = fingerprint;
        this.lastSeen = lastSeen;
    }
}
