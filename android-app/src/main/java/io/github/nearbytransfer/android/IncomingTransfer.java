package io.github.nearbytransfer.android;

final class IncomingTransfer {
    final String transferId;
    final PeerDevice sender;
    final String fileName;
    final long size;
    final String sha256;
    final String savePath;

    IncomingTransfer(String transferId, PeerDevice sender, String fileName, long size, String sha256, String savePath) {
        this.transferId = transferId;
        this.sender = sender;
        this.fileName = fileName;
        this.size = size;
        this.sha256 = sha256;
        this.savePath = savePath;
    }
}
