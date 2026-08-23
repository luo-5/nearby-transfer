/**
 * Pairing message router: dispatches decoded wire frames to the pairing API.
 * Ported from src/v2/pairing-router.js.
 *
 * Routes pairing offer/confirmation/cancel frames to the appropriate pairing
 * API methods, enforcing connection binding (one pairingId + one remote
 * deviceId per connection).
 */

import { Buffer } from 'node:buffer';
import { MESSAGE_TYPES } from '../constants.js';
import { verifyPairingCancel } from './sas.js';
import { decodeControlMessage } from './message-codec.js';
import type { WireFrame } from '../transfer/wire-frame.js';

export interface PairingApi {
  listPairingSessions(): Array<{ pairingId: string; role: string; status: string; peer?: { identity: { deviceId: string; signingPublicKey: string } } }>;
  startPairing?(args: { capabilities: string[] }): { session: { pairingId: string }; outboundOffer: unknown };
  receiveIncomingOffer(args: { offer: unknown; signature: string }): PairingSession;
  receiveRemoteOffer(args: { pairingId: string; offer: unknown; signature: string }): PairingSession;
  receiveRemoteConfirmation(args: { pairingId: string; confirmation: unknown; signature: string }): PairingSession;
  createLocalConfirmation?(pairingId: string): { confirmation: unknown; signature: string };
  createResponderOffer?(pairingId: string, opts: { capabilities: string[] }): { offer: unknown; signature: string };
  complete?(pairingId: string, options?: unknown): unknown;
  cancel(pairingId: string, reason: string): void;
  getPairingSession(pairingId: string): PairingSession | null;
}

export interface PairingSession {
  pairingId: string;
  role: string;
  status: string;
  peer?: { identity: { deviceId: string; signingPublicKey: string } };
}

export interface ConnectionBinding {
  expectedDeviceId?: string;
  pairingId?: string;
  remoteDeviceId?: string;
}

export interface RouterResult {
  kind: 'offer' | 'confirmation' | 'cancellation';
  session: PairingSession | null;
  binding: ConnectionBinding;
}

export class PairingRouter {
  pairingApi: PairingApi;

  constructor({ pairingApi }: { pairingApi: PairingApi }) {
    if (
      !pairingApi ||
      typeof pairingApi.listPairingSessions !== 'function' ||
      typeof pairingApi.receiveIncomingOffer !== 'function' ||
      typeof pairingApi.receiveRemoteOffer !== 'function' ||
      typeof pairingApi.receiveRemoteConfirmation !== 'function' ||
      typeof pairingApi.cancel !== 'function'
    ) {
      throw new TypeError('A complete pairing API is required');
    }
    this.pairingApi = pairingApi;
  }

  receiveFrame(frame: WireFrame, binding: ConnectionBinding = {}): RouterResult {
    if (!frame || !frame.header || !Buffer.isBuffer(frame.payload)) throw new TypeError('A decoded wire frame is required');
    const { type } = frame.header;
    const message = decodeControlMessage(type, frame.payload);
    switch (type) {
      case MESSAGE_TYPES.PAIRING_OFFER:
        return this.receiveOffer(message as { offer: { pairingId: string; identity: { deviceId: string } }; signature: string }, binding);
      case MESSAGE_TYPES.PAIRING_CONFIRM:
        return this.receiveConfirmation(message as { confirmation: { pairingId: string; deviceId: string }; signature: string }, binding);
      case MESSAGE_TYPES.PAIRING_CANCEL:
        return this.receiveCancellation(message as { cancellation: { pairingId: string; deviceId: string; reason: string }; signature: string }, binding);
      default:
        throw new TypeError('This service only accepts pairing control frames');
    }
  }

  private receiveOffer({ offer, signature }: { offer: { pairingId: string; identity: { deviceId: string } }; signature: string }, binding: ConnectionBinding): RouterResult {
    assertOrBind(binding, offer.pairingId, offer.identity.deviceId);
    const existing = this.pairingApi.listPairingSessions().find((session) => session.pairingId === offer.pairingId);
    const session =
      existing && existing.role === 'initiator' && existing.status === 'awaiting-remote-offer'
        ? this.pairingApi.receiveRemoteOffer({ pairingId: offer.pairingId, offer, signature })
        : this.pairingApi.receiveIncomingOffer({ offer, signature });
    assertSessionBinding(session, binding);
    return { kind: 'offer', session, binding };
  }

  private receiveConfirmation({ confirmation, signature }: { confirmation: { pairingId: string; deviceId: string }; signature: string }, binding: ConnectionBinding): RouterResult {
    assertBound(binding, confirmation.pairingId, confirmation.deviceId);
    const session = this.pairingApi.receiveRemoteConfirmation({ pairingId: confirmation.pairingId, confirmation, signature });
    assertSessionBinding(session, binding);
    return { kind: 'confirmation', session, binding };
  }

  private receiveCancellation({ cancellation, signature }: { cancellation: { pairingId: string; deviceId: string; reason: string }; signature: string }, binding: ConnectionBinding): RouterResult {
    assertBound(binding, cancellation.pairingId, cancellation.deviceId);
    const session = this.pairingApi.listPairingSessions().find((item) => item.pairingId === cancellation.pairingId);
    if (!session || !session.peer || session.peer.identity.deviceId !== cancellation.deviceId) {
      throw new Error('Remote cancellation does not match an active pairing session');
    }
    const peerIdentity = this.peerIdentityForSession(cancellation.pairingId);
    if (!verifyPairingCancel(cancellation as Parameters<typeof verifyPairingCancel>[0], signature, peerIdentity.signingPublicKey)) {
      throw new TypeError('Pairing cancellation signature is invalid');
    }
    this.pairingApi.cancel(cancellation.pairingId, cancellation.reason);
    return { kind: 'cancellation', session: null, binding };
  }

  private peerIdentityForSession(pairingId: string): { deviceId: string; signingPublicKey: string } {
    if (typeof this.pairingApi.getPairingSession !== 'function') {
      throw new TypeError('Pairing API must provide private session lookup for remote cancellation');
    }
    const session = this.pairingApi.getPairingSession(pairingId);
    if (!session || !session.peer) throw new Error('Pairing session has no verified peer identity');
    return session.peer.identity;
  }
}

function assertOrBind(binding: ConnectionBinding, pairingId: string, deviceId: string): void {
  if (binding.expectedDeviceId && binding.expectedDeviceId !== deviceId) throw new TypeError('Remote identity does not match the selected discovery peer');
  if (binding.pairingId && binding.pairingId !== pairingId) throw new TypeError('A connection cannot carry multiple pairing IDs');
  if (binding.remoteDeviceId && binding.remoteDeviceId !== deviceId) throw new TypeError('A connection cannot switch remote identities');
  binding.pairingId = pairingId;
  binding.remoteDeviceId = deviceId;
}

function assertBound(binding: ConnectionBinding, pairingId: string, deviceId: string): void {
  if (!binding.pairingId || !binding.remoteDeviceId) throw new Error('A pairing offer is required before this message');
  if (binding.pairingId !== pairingId || binding.remoteDeviceId !== deviceId) throw new TypeError('Pairing message does not match the connection binding');
}

function assertSessionBinding(session: PairingSession, binding: ConnectionBinding): void {
  if (!session || session.pairingId !== binding.pairingId || !session.peer || session.peer.identity.deviceId !== binding.remoteDeviceId) {
    throw new Error('Pairing session does not match the connection binding');
  }
}
