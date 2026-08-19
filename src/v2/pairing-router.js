'use strict';

const { MESSAGE_TYPES } = require('./constants');
const { decodeControlMessage } = require('./message-codec');

class PairingRouter {
  constructor({ pairingApi }) {
    if (!pairingApi || typeof pairingApi.listPairingSessions !== 'function' ||
        typeof pairingApi.receiveIncomingOffer !== 'function' || typeof pairingApi.receiveRemoteOffer !== 'function' ||
        typeof pairingApi.receiveRemoteConfirmation !== 'function' || typeof pairingApi.cancel !== 'function') {
      throw new TypeError('A complete pairing API is required');
    }
    this.pairingApi = pairingApi;
  }

  receiveFrame(frame, binding = {}) {
    if (!frame || !frame.header || !Buffer.isBuffer(frame.payload)) throw new TypeError('A decoded wire frame is required');
    const { type } = frame.header;
    const message = decodeControlMessage(type, frame.payload);
    switch (type) {
      case MESSAGE_TYPES.PAIRING_OFFER:
        return this._receiveOffer(message, binding);
      case MESSAGE_TYPES.PAIRING_CONFIRM:
        return this._receiveConfirmation(message, binding);
      case MESSAGE_TYPES.PAIRING_CANCEL:
        return this._receiveCancellation(message, binding);
      default:
        throw new TypeError('This service only accepts pairing control frames');
    }
  }

  _receiveOffer({ offer, signature }, binding) {
    assertOrBind(binding, offer.pairingId, offer.identity.deviceId);
    const existing = this.pairingApi.listPairingSessions().find((session) => session.pairingId === offer.pairingId);
    const session = existing && existing.role === 'initiator' && existing.status === 'awaiting-remote-offer'
      ? this.pairingApi.receiveRemoteOffer({ pairingId: offer.pairingId, offer, signature })
      : this.pairingApi.receiveIncomingOffer({ offer, signature });
    assertSessionBinding(session, binding);
    return { kind: 'offer', session, binding };
  }

  _receiveConfirmation({ confirmation, signature }, binding) {
    assertBound(binding, confirmation.pairingId, confirmation.deviceId);
    const session = this.pairingApi.receiveRemoteConfirmation({
      pairingId: confirmation.pairingId,
      confirmation,
      signature
    });
    assertSessionBinding(session, binding);
    return { kind: 'confirmation', session, binding };
  }

  _receiveCancellation({ cancellation, signature }, binding) {
    assertBound(binding, cancellation.pairingId, cancellation.deviceId);
    const session = this.pairingApi.listPairingSessions().find((item) => item.pairingId === cancellation.pairingId);
    if (!session || !session.peer || session.peer.deviceId !== cancellation.deviceId) {
      throw new Error('Remote cancellation does not match an active pairing session');
    }
    const peerIdentity = this._peerIdentityForSession(cancellation.pairingId);
    const { verifyPairingCancel } = require('./pairing');
    if (!verifyPairingCancel(cancellation, signature, peerIdentity.signingPublicKey)) {
      throw new TypeError('Pairing cancellation signature is invalid');
    }
    this.pairingApi.cancel(cancellation.pairingId, cancellation.reason);
    return { kind: 'cancellation', session: null, binding };
  }

  _peerIdentityForSession(pairingId) {
    if (typeof this.pairingApi.getPairingSession !== 'function') {
      throw new TypeError('Pairing API must provide private session lookup for remote cancellation');
    }
    const session = this.pairingApi.getPairingSession(pairingId);
    if (!session || !session.peer) throw new Error('Pairing session has no verified peer identity');
    return session.peer.identity;
  }
}

function assertOrBind(binding, pairingId, deviceId) {
  if (binding.expectedDeviceId && binding.expectedDeviceId !== deviceId) throw new TypeError('Remote identity does not match the selected discovery peer');
  if (binding.pairingId && binding.pairingId !== pairingId) throw new TypeError('A connection cannot carry multiple pairing IDs');
  if (binding.remoteDeviceId && binding.remoteDeviceId !== deviceId) throw new TypeError('A connection cannot switch remote identities');
  binding.pairingId = pairingId;
  binding.remoteDeviceId = deviceId;
}

function assertBound(binding, pairingId, deviceId) {
  if (!binding.pairingId || !binding.remoteDeviceId) throw new Error('A pairing offer is required before this message');
  if (binding.pairingId !== pairingId || binding.remoteDeviceId !== deviceId) throw new TypeError('Pairing message does not match the connection binding');
}

function assertSessionBinding(session, binding) {
  if (!session || session.pairingId !== binding.pairingId || !session.peer ||
      session.peer.identity.deviceId !== binding.remoteDeviceId) {
    throw new Error('Pairing session does not match the connection binding');
  }
}

module.exports = {
  PairingRouter
};