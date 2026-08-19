'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { canonicalJson } = require('./canonical-json');
const {
  assertValidPairingOffer,
  assertValidPairingConfirmation,
  assertValidPublicIdentity,
  createPairingConfirmation,
  createPairingOffer,
  derivePairingCode,
  publicIdentity,
  signPairingConfirmation,
  signPairingOffer,
  verifyPairingConfirmation,
  verifyPairingOffer
} = require('./pairing');
const { DATABASE_FILE } = require('./trusted-peer-store');

const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MAX_ACTIVE_SESSIONS = 32;

const SESSION_STATUS = Object.freeze({
  AWAITING_REMOTE_OFFER: 'awaiting-remote-offer',
  AWAITING_LOCAL_CONFIRMATION: 'awaiting-local-confirmation',
  AWAITING_REMOTE_CONFIRMATION: 'awaiting-remote-confirmation',
  READY_TO_TRUST: 'ready-to-trust',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
});

class PairingSessionStore {
  constructor(userDataDir) {
    if (typeof userDataDir !== 'string' || userDataDir.trim().length === 0) {
      throw new TypeError('A user-data directory is required');
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    this.databasePath = path.join(userDataDir, DATABASE_FILE);
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this._migrate();
  }

  startOutgoing({ localDevice, localPrivateKey, capabilities = [], now = Date.now() }) {
    this._expireSessions(now);
    this._assertCapacity();
    const offer = createPairingOffer({ device: localDevice, capabilities, issuedAt: now });
    const signature = signPairingOffer(offer, localPrivateKey);
    this.database.prepare(`
      INSERT INTO pairing_sessions (
        pairing_id, role, status, peer_device_id, peer_offer_json, peer_signature,
        pairing_code, created_at, expires_at, local_confirmed_at, remote_confirmed_at,
        completed_at, cancellation_reason, updated_at
      ) VALUES (?, 'initiator', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)
    `).run(
      offer.pairingId,
      SESSION_STATUS.AWAITING_REMOTE_OFFER,
      now,
      now + PAIRING_SESSION_TTL_MS,
      now
    );
    return { offer, signature, session: this.get(offer.pairingId, { includeTerminal: true }) };
  }

  receiveIncomingOffer({ offer, signature, localDevice, now = Date.now() }) {
    this._expireSessions(now);
    assertFreshVerifiedOffer(offer, signature, now);
    const localIdentity = assertValidPublicIdentity(localDevice);
    const session = this.get(offer.pairingId, { includeTerminal: true });

    if (session) {
      if (session.role !== 'responder' || session.status !== SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION ||
          session.peer.identity.deviceId !== offer.identity.deviceId) {
        throw new Error('Pairing ID is already in use');
      }
      return session;
    }

    this._assertCapacity();
    const expiresAt = Math.min(offer.issuedAt + PAIRING_SESSION_TTL_MS, now + PAIRING_SESSION_TTL_MS);
    this.database.prepare(`
      INSERT INTO pairing_sessions (
        pairing_id, role, status, peer_device_id, peer_offer_json, peer_signature,
        pairing_code, created_at, expires_at, local_confirmed_at, remote_confirmed_at,
        completed_at, cancellation_reason, updated_at
      ) VALUES (?, 'responder', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
    `).run(
      offer.pairingId,
      SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION,
      offer.identity.deviceId,
      canonicalJson(offer),
      signature,
      derivePairingCode({ pairingId: offer.pairingId, initiator: offer.identity, responder: localIdentity }),
      now,
      expiresAt,
      now
    );
    return this.get(offer.pairingId, { includeTerminal: true });
  }

  receiveRemoteOffer({ pairingId, offer, signature, localDevice, now = Date.now() }) {
    this._expireSessions(now);
    assertFreshVerifiedOffer(offer, signature, now);
    if (offer.pairingId !== pairingId) {
      throw new TypeError('Remote pairing offer ID does not match the session');
    }
    const session = this._requireActiveSession(pairingId, now);
    if (session.role !== 'initiator' || session.status !== SESSION_STATUS.AWAITING_REMOTE_OFFER) {
      throw new Error('Pairing session is not waiting for a remote offer');
    }
    const localIdentity = assertValidPublicIdentity(localDevice);
    const expiresAt = Math.min(session.expiresAt, offer.issuedAt + PAIRING_SESSION_TTL_MS);
    if (expiresAt <= now) {
      this._setStatus(pairingId, SESSION_STATUS.EXPIRED, now);
      throw new Error('Pairing offer expired');
    }
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, peer_device_id = ?, peer_offer_json = ?, peer_signature = ?, pairing_code = ?,
          expires_at = ?, updated_at = ?
      WHERE pairing_id = ?
    `).run(
      SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION,
      offer.identity.deviceId,
      canonicalJson(offer),
      signature,
      derivePairingCode({ pairingId, initiator: localIdentity, responder: offer.identity }),
      expiresAt,
      now,
      pairingId
    );
    return this.get(pairingId, { includeTerminal: true });
  }

  respondToIncomingOffer(pairingId, { localDevice, localPrivateKey, capabilities = [], now = Date.now() }) {
    const session = this._requireActiveSession(pairingId, now);
    if (session.role !== 'responder' || !session.peer) {
      throw new Error('Pairing session cannot create a responder offer');
    }
    const offer = createPairingOffer({
      device: localDevice,
      capabilities,
      pairingId,
      issuedAt: now
    });
    return {
      offer,
      signature: signPairingOffer(offer, localPrivateKey),
      session: this.get(pairingId, { includeTerminal: true })
    };
  }

  createLocalConfirmation(pairingId, { localDevice, localPrivateKey, now = Date.now() }) {
    const session = this.confirmLocal(pairingId, now);
    const confirmation = createPairingConfirmation({
      pairingId,
      device: localDevice,
      pairingCode: session.pairingCode,
      issuedAt: now
    });
    return {
      confirmation,
      signature: signPairingConfirmation(confirmation, localPrivateKey),
      session
    };
  }

  receiveRemoteConfirmation({ pairingId, confirmation, signature, now = Date.now() }) {
    const session = this._requireActiveSession(pairingId, now);
    if (!session.peer || !session.pairingCode) {
      throw new Error('A verified remote offer is required before remote confirmation');
    }
    assertValidPairingConfirmation(confirmation);
    if (confirmation.pairingId !== pairingId || confirmation.deviceId !== session.peer.identity.deviceId) {
      throw new TypeError('Remote pairing confirmation does not match the session');
    }
    if (confirmation.issuedAt > now + MAX_CLOCK_SKEW_MS || confirmation.issuedAt > session.expiresAt ||
        now - confirmation.issuedAt > PAIRING_SESSION_TTL_MS) {
      throw new Error('Pairing confirmation expired or has an invalid clock');
    }
    if (confirmation.pairingCode !== session.pairingCode ||
        !verifyPairingConfirmation(confirmation, signature, session.peer.identity.signingPublicKey)) {
      throw new TypeError('Pairing confirmation signature or code is invalid');
    }
    return this.confirmRemote(pairingId, confirmation.deviceId, now);
  }

  confirmLocal(pairingId, now = Date.now()) {
    const session = this._requireActiveSession(pairingId, now);
    if (!session.peer || !session.pairingCode) {
      throw new Error('A verified remote offer is required before local confirmation');
    }
    if (session.localConfirmedAt) {
      return session;
    }
    const nextStatus = session.remoteConfirmedAt
      ? SESSION_STATUS.READY_TO_TRUST
      : SESSION_STATUS.AWAITING_REMOTE_CONFIRMATION;
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, local_confirmed_at = ?, updated_at = ?
      WHERE pairing_id = ?
    `).run(nextStatus, now, now, pairingId);
    return this.get(pairingId, { includeTerminal: true });
  }

  confirmRemote(pairingId, remoteDeviceId, now = Date.now()) {
    const session = this._requireActiveSession(pairingId, now);
    if (!session.peer || session.peer.identity.deviceId !== remoteDeviceId) {
      throw new Error('Remote confirmation identity does not match the session');
    }
    if (session.remoteConfirmedAt) {
      return session;
    }
    const nextStatus = session.localConfirmedAt
      ? SESSION_STATUS.READY_TO_TRUST
      : SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION;
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, remote_confirmed_at = ?, updated_at = ?
      WHERE pairing_id = ?
    `).run(nextStatus, now, now, pairingId);
    return this.get(pairingId, { includeTerminal: true });
  }

  complete(pairingId, trustedPeerStore, { displayName, permissions, now = Date.now() } = {}) {
    const session = this._requireActiveSession(pairingId, now);
    if (session.status !== SESSION_STATUS.READY_TO_TRUST || !session.localConfirmedAt || !session.remoteConfirmedAt) {
      throw new Error('Both pairing confirmations are required before trusting a peer');
    }
    if (!trustedPeerStore || typeof trustedPeerStore.upsertTrustedPeer !== 'function') {
      throw new TypeError('A trusted peer store is required to complete pairing');
    }
    const peer = trustedPeerStore.upsertTrustedPeer({
      identity: session.peer.identity,
      displayName,
      permissions,
      pairedAt: now
    });
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, completed_at = ?, updated_at = ?
      WHERE pairing_id = ?
    `).run(SESSION_STATUS.COMPLETED, now, now, pairingId);
    return peer;
  }

  cancel(pairingId, reason = 'cancelled-by-user', now = Date.now()) {
    const session = this.get(pairingId, { includeTerminal: true });
    if (!session || isTerminal(session.status)) {
      return false;
    }
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, cancellation_reason = ?, updated_at = ?
      WHERE pairing_id = ?
    `).run(SESSION_STATUS.CANCELLED, normalizeReason(reason), now, pairingId);
    return true;
  }

  get(pairingId, { includeTerminal = false } = {}) {
    assertPairingId(pairingId);
    const row = this.database.prepare(`
      SELECT * FROM pairing_sessions
      WHERE pairing_id = ? ${includeTerminal ? '' : "AND status NOT IN ('completed', 'cancelled', 'expired')"}
    `).get(pairingId);
    return row ? rowToSession(row) : null;
  }

  listActive(now = Date.now()) {
    this._expireSessions(now);
    return this.database.prepare(`
      SELECT * FROM pairing_sessions
      WHERE status NOT IN ('completed', 'cancelled', 'expired')
      ORDER BY created_at ASC
    `).all().map(rowToSession);
  }

  close() {
    this.database.close();
  }

  _assertCapacity() {
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count FROM pairing_sessions
      WHERE status NOT IN ('completed', 'cancelled', 'expired')
    `).get().count;
    if (count >= MAX_ACTIVE_SESSIONS) {
      throw new Error('Too many active pairing sessions');
    }
  }

  _requireActiveSession(pairingId, now) {
    this._expireSessions(now);
    const session = this.get(pairingId, { includeTerminal: true });
    if (!session || isTerminal(session.status)) {
      throw new Error('Pairing session is not active');
    }
    return session;
  }

  _expireSessions(now) {
    this.database.prepare(`
      UPDATE pairing_sessions
      SET status = ?, updated_at = ?
      WHERE status NOT IN ('completed', 'cancelled', 'expired') AND expires_at <= ?
    `).run(SESSION_STATUS.EXPIRED, now, now);
  }

  _setStatus(pairingId, status, now) {
    this.database.prepare('UPDATE pairing_sessions SET status = ?, updated_at = ? WHERE pairing_id = ?')
      .run(status, now, pairingId);
  }

  _migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        pairing_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('initiator', 'responder')),
        status TEXT NOT NULL,
        peer_device_id TEXT,
        peer_offer_json TEXT,
        peer_signature TEXT,
        pairing_code TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        local_confirmed_at INTEGER,
        remote_confirmed_at INTEGER,
        completed_at INTEGER,
        cancellation_reason TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pairing_sessions_active_expiry
        ON pairing_sessions(status, expires_at);
    `);
    this.database.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)
    `).run(Date.now());
  }
}

function assertFreshVerifiedOffer(offer, signature, now) {
  assertValidPairingOffer(offer);
  if (!verifyPairingOffer(offer, signature)) {
    throw new TypeError('Pairing offer signature is invalid');
  }
  if (offer.issuedAt > now + MAX_CLOCK_SKEW_MS || now - offer.issuedAt > PAIRING_SESSION_TTL_MS) {
    throw new Error('Pairing offer expired or has an invalid clock');
  }
}

function assertPairingId(pairingId) {
  if (typeof pairingId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(pairingId)) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
}

function normalizeReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 128) {
    throw new TypeError('Pairing cancellation reason is invalid');
  }
  return reason.trim();
}

function isTerminal(status) {
  return [SESSION_STATUS.COMPLETED, SESSION_STATUS.CANCELLED, SESSION_STATUS.EXPIRED].includes(status);
}

function rowToSession(row) {
  const peerOffer = row.peer_offer_json ? JSON.parse(row.peer_offer_json) : null;
  return {
    pairingId: row.pairing_id,
    role: row.role,
    status: row.status,
    peer: peerOffer ? { identity: publicIdentity(peerOffer.identity), offer: peerOffer, signature: row.peer_signature } : null,
    pairingCode: row.pairing_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    localConfirmedAt: row.local_confirmed_at,
    remoteConfirmedAt: row.remote_confirmed_at,
    completedAt: row.completed_at,
    cancellationReason: row.cancellation_reason,
    updatedAt: row.updated_at
  };
}

module.exports = {
  MAX_ACTIVE_SESSIONS,
  PAIRING_SESSION_TTL_MS,
  PairingSessionStore,
  SESSION_STATUS
};
