import {
  JOB_DIRECTION,
  JOB_STATUS,
  type DiscoveredPeerEntry,
  type TransferManifest,
} from '@luo-5/core';
import type { CliDevice } from './device.js';

export interface CliTransferSource {
  path: string;
  sourcePath: string;
  size: number;
  sha256: string;
}

type CliTransferPeer = Pick<
  DiscoveredPeerEntry,
  | 'deviceId'
  | 'deviceName'
  | 'fingerprint'
  | 'signingPublicKey'
  | 'encryptionPublicKey'
  | 'host'
  | 'port'
>;

/** Build the exact runtime shapes required by the core transfer executor. */
export function createCliTransferContext(options: {
  device: CliDevice;
  peer: CliTransferPeer;
  manifest: TransferManifest;
  sources: CliTransferSource[];
  now?: number;
}) {
  const { device, peer, manifest, sources } = options;
  const now = options.now ?? Date.now();
  const totalBytes = sources.reduce((sum, source) => sum + source.size, 0);

  return {
    job: {
      taskId: manifest.taskId,
      peerDeviceId: peer.deviceId,
      direction: JOB_DIRECTION.OUTGOING,
      status: JOB_STATUS.TRANSFERRING,
      manifest,
      sources,
      sourceMappingStatus: 'available',
      progress: { transferredBytes: 0, totalBytes },
      createdAt: now,
      updatedAt: now,
      localDeviceId: device.deviceId,
      signingPrivateKey: device.signingPrivateKey,
      remoteSigningPublicKey: peer.signingPublicKey,
      remoteEncryptionPublicKey: peer.encryptionPublicKey,
      peer: { host: peer.host, port: peer.port },
    },
    trustedPeer: {
      identity: {
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        fingerprint: peer.fingerprint,
        signingPublicKey: peer.signingPublicKey,
        encryptionPublicKey: peer.encryptionPublicKey,
      },
      permissions: { transfer: true },
      revokedAt: null,
    },
  };
}

/** The CLI does not persist resumable checkpoints yet, but must acknowledge the exact candidate. */
export function commitCliCheckpoint<T>(checkpoint: T): T {
  return checkpoint;
}
