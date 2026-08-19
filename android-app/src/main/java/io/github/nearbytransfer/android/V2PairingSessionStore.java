package io.github.nearbytransfer.android;

import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * In-memory state machine for the authenticated Protocol v2 pairing bootstrap.
 *
 * <p>This class deliberately owns no sockets, UI, or trusted-peer persistence. A future
 * {@code V2LanService} can feed it validated control messages, render the returned immutable
 * sessions to the UI, and only persist a peer after both sides have confirmed the same SAS.</p>
 */
final class V2PairingSessionStore {
    static final int MAX_ACTIVE_SESSIONS = 32;
    static final long PAIRING_SESSION_TTL_MS = V2Pairing.PAIRING_SESSION_TTL_MS;

    enum Role {
        INITIATOR,
        RESPONDER
    }

    enum Status {
        AWAITING_REMOTE_OFFER,
        AWAITING_LOCAL_CONFIRMATION,
        AWAITING_REMOTE_CONFIRMATION,
        READY_TO_TRUST,
        COMPLETED,
        CANCELLED,
        EXPIRED
    }

    static final class Session {
        final String pairingId;
        final Role role;
        final Status status;
        final V2Pairing.Offer peerOffer;
        final String peerSignature;
        final String pairingCode;
        final long createdAt;
        final long expiresAt;
        final Long localConfirmedAt;
        final Long remoteConfirmedAt;
        final Long completedAt;
        final String cancellationReason;
        final long updatedAt;

        private Session(
            String pairingId,
            Role role,
            Status status,
            V2Pairing.Offer peerOffer,
            String peerSignature,
            String pairingCode,
            long createdAt,
            long expiresAt,
            Long localConfirmedAt,
            Long remoteConfirmedAt,
            Long completedAt,
            String cancellationReason,
            long updatedAt
        ) {
            this.pairingId = pairingId;
            this.role = role;
            this.status = status;
            this.peerOffer = peerOffer;
            this.peerSignature = peerSignature;
            this.pairingCode = pairingCode;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.localConfirmedAt = localConfirmedAt;
            this.remoteConfirmedAt = remoteConfirmedAt;
            this.completedAt = completedAt;
            this.cancellationReason = cancellationReason;
            this.updatedAt = updatedAt;
        }

        boolean isTerminal() {
            return isTerminalStatus(status);
        }
    }

    static final class SignedOffer {
        final V2Pairing.Offer offer;
        final String signature;
        final Session session;

        private SignedOffer(V2Pairing.Offer offer, String signature, Session session) {
            this.offer = offer;
            this.signature = signature;
            this.session = session;
        }
    }

    static final class SignedConfirmation {
        final V2Pairing.Confirmation confirmation;
        final String signature;
        final Session session;

        private SignedConfirmation(V2Pairing.Confirmation confirmation, String signature, Session session) {
            this.confirmation = confirmation;
            this.signature = signature;
            this.session = session;
        }
    }

    static final class SignedCancellation {
        final V2Pairing.Cancellation cancellation;
        final String signature;
        final Session session;

        private SignedCancellation(V2Pairing.Cancellation cancellation, String signature, Session session) {
            this.cancellation = cancellation;
            this.signature = signature;
            this.session = session;
        }
    }

    private static final class MutableSession {
        final String pairingId;
        final Role role;
        final long createdAt;
        V2Pairing.Offer peerOffer;
        String peerSignature;
        String pairingCode;
        long expiresAt;
        Status status;
        Long localConfirmedAt;
        Long remoteConfirmedAt;
        Long completedAt;
        String cancellationReason;
        long updatedAt;

        MutableSession(String pairingId, Role role, long createdAt, long expiresAt) {
            this.pairingId = pairingId;
            this.role = role;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.status = role == Role.INITIATOR
                ? Status.AWAITING_REMOTE_OFFER
                : Status.AWAITING_LOCAL_CONFIRMATION;
            this.updatedAt = createdAt;
        }

        Session snapshot() {
            return new Session(
                pairingId, role, status, peerOffer, peerSignature, pairingCode, createdAt, expiresAt,
                localConfirmedAt, remoteConfirmedAt, completedAt, cancellationReason, updatedAt
            );
        }
    }

    private final V2Identity localIdentity;
    private final String localSigningPrivateKey;
    private final Map<String, MutableSession> sessions = new HashMap<>();

    V2PairingSessionStore(DeviceConfig localDevice) throws GeneralSecurityException {
        this(V2Identity.fromDevice(requireDevice(localDevice)), localDevice.signingPrivateKey);
    }

    V2PairingSessionStore(V2Identity localIdentity, String localSigningPrivateKey) {
        if (localIdentity == null) {
            throw new IllegalArgumentException("Local pairing identity is required");
        }
        if (localSigningPrivateKey == null || localSigningPrivateKey.trim().isEmpty()) {
            throw new IllegalArgumentException("Local pairing signing key is required");
        }
        this.localIdentity = localIdentity;
        this.localSigningPrivateKey = localSigningPrivateKey;
    }

    synchronized SignedOffer startOutgoing(List<String> capabilities, long now) throws Exception {
        assertNow(now);
        expireSessions(now);
        assertCapacity();
        V2Pairing.Offer offer = V2Pairing.createOffer(localIdentity, capabilities, V2Pairing.createPairingId(), now);
        MutableSession session = new MutableSession(offer.pairingId, Role.INITIATOR, now, safeAdd(now, PAIRING_SESSION_TTL_MS));
        sessions.put(offer.pairingId, session);
        return new SignedOffer(offer, V2Pairing.signOffer(offer, localSigningPrivateKey), session.snapshot());
    }

    synchronized Session receiveIncomingOffer(V2Pairing.Offer offer, String signature, long now) throws Exception {
        assertNow(now);
        expireSessions(now);
        assertFreshVerifiedOffer(offer, signature, now);
        rejectLocalIdentity(offer.identity);
        MutableSession existing = sessions.get(offer.pairingId);
        if (existing != null) {
            if (existing.role != Role.RESPONDER || existing.status != Status.AWAITING_LOCAL_CONFIRMATION
                || existing.peerOffer == null || !existing.peerOffer.identity.deviceId.equals(offer.identity.deviceId)) {
                throw new IllegalStateException("Pairing ID is already in use");
            }
            return existing.snapshot();
        }

        assertCapacity();
        long expiresAt = Math.min(safeAdd(offer.issuedAt, PAIRING_SESSION_TTL_MS), safeAdd(now, PAIRING_SESSION_TTL_MS));
        if (expiresAt <= now) {
            throw new IllegalStateException("Pairing offer expired");
        }
        MutableSession session = new MutableSession(offer.pairingId, Role.RESPONDER, now, expiresAt);
        session.peerOffer = offer;
        session.peerSignature = signature;
        session.pairingCode = V2Pairing.derivePairingCode(offer.pairingId, offer.identity, localIdentity);
        sessions.put(offer.pairingId, session);
        return session.snapshot();
    }

    synchronized Session receiveRemoteOffer(String pairingId, V2Pairing.Offer offer, String signature, long now) throws Exception {
        assertNow(now);
        expireSessions(now);
        assertFreshVerifiedOffer(offer, signature, now);
        if (pairingId == null || !pairingId.equals(offer.pairingId)) {
            throw new IllegalArgumentException("Remote pairing offer ID does not match the session");
        }
        rejectLocalIdentity(offer.identity);
        MutableSession session = requireActive(pairingId);
        if (session.role != Role.INITIATOR || session.status != Status.AWAITING_REMOTE_OFFER) {
            throw new IllegalStateException("Pairing session is not waiting for a remote offer");
        }
        long expiresAt = Math.min(session.expiresAt, safeAdd(offer.issuedAt, PAIRING_SESSION_TTL_MS));
        if (expiresAt <= now) {
            expire(session, now);
            throw new IllegalStateException("Pairing offer expired");
        }
        session.peerOffer = offer;
        session.peerSignature = signature;
        session.pairingCode = V2Pairing.derivePairingCode(pairingId, localIdentity, offer.identity);
        session.expiresAt = expiresAt;
        session.status = Status.AWAITING_LOCAL_CONFIRMATION;
        session.updatedAt = now;
        return session.snapshot();
    }

    synchronized SignedOffer respondToIncomingOffer(String pairingId, List<String> capabilities, long now) throws Exception {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.role != Role.RESPONDER || session.peerOffer == null) {
            throw new IllegalStateException("Pairing session cannot create a responder offer");
        }
        V2Pairing.Offer offer = V2Pairing.createOffer(localIdentity, capabilities, pairingId, now);
        return new SignedOffer(offer, V2Pairing.signOffer(offer, localSigningPrivateKey), session.snapshot());
    }

    synchronized SignedConfirmation createLocalConfirmation(String pairingId, long now) throws Exception {
        assertNow(now);
        Session session = confirmLocal(pairingId, now);
        V2Pairing.Confirmation confirmation = V2Pairing.createConfirmation(
            pairingId, now, localIdentity.deviceId, session.pairingCode
        );
        return new SignedConfirmation(confirmation, V2Pairing.signConfirmation(confirmation, localSigningPrivateKey), session);
    }

    synchronized Session receiveRemoteConfirmation(
        String pairingId,
        V2Pairing.Confirmation confirmation,
        String signature,
        long now
    ) throws Exception {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.peerOffer == null || session.pairingCode == null) {
            throw new IllegalStateException("A verified remote offer is required before remote confirmation");
        }
        if (confirmation == null || !pairingId.equals(confirmation.pairingId)
            || !session.peerOffer.identity.deviceId.equals(confirmation.deviceId)) {
            throw new IllegalArgumentException("Remote pairing confirmation does not match the session");
        }
        if (!V2Pairing.isFresh(confirmation.issuedAt, now) || confirmation.issuedAt > session.expiresAt) {
            throw new IllegalArgumentException("Pairing confirmation expired or has an invalid clock");
        }
        if (!session.pairingCode.equals(confirmation.pairingCode)
            || !V2Pairing.verifyConfirmation(confirmation, signature, session.peerOffer.identity)) {
            throw new IllegalArgumentException("Pairing confirmation signature or code is invalid");
        }
        return confirmRemote(pairingId, confirmation.deviceId, now);
    }

    synchronized Session confirmLocal(String pairingId, long now) {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.peerOffer == null || session.pairingCode == null) {
            throw new IllegalStateException("A verified remote offer is required before local confirmation");
        }
        if (session.localConfirmedAt != null) {
            return session.snapshot();
        }
        session.localConfirmedAt = now;
        session.status = session.remoteConfirmedAt == null
            ? Status.AWAITING_REMOTE_CONFIRMATION
            : Status.READY_TO_TRUST;
        session.updatedAt = now;
        return session.snapshot();
    }

    synchronized Session confirmRemote(String pairingId, String remoteDeviceId, long now) {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.peerOffer == null || !session.peerOffer.identity.deviceId.equals(remoteDeviceId)) {
            throw new IllegalArgumentException("Remote confirmation identity does not match the session");
        }
        if (session.remoteConfirmedAt != null) {
            return session.snapshot();
        }
        session.remoteConfirmedAt = now;
        session.status = session.localConfirmedAt == null
            ? Status.AWAITING_LOCAL_CONFIRMATION
            : Status.READY_TO_TRUST;
        session.updatedAt = now;
        return session.snapshot();
    }

    synchronized Session complete(String pairingId, long now) {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.status != Status.READY_TO_TRUST || session.localConfirmedAt == null || session.remoteConfirmedAt == null) {
            throw new IllegalStateException("Both pairing confirmations are required before trusting a peer");
        }
        session.status = Status.COMPLETED;
        session.completedAt = now;
        session.updatedAt = now;
        return session.snapshot();
    }

    synchronized SignedCancellation createCancellation(String pairingId, String reason, long now) throws Exception {
        assertNow(now);
        Session session = cancelAndRead(pairingId, reason, now);
        V2Pairing.Cancellation cancellation = V2Pairing.createCancellation(pairingId, now, localIdentity.deviceId, reason);
        return new SignedCancellation(cancellation, V2Pairing.signCancellation(cancellation, localSigningPrivateKey), session);
    }

    synchronized boolean cancel(String pairingId, String reason, long now) {
        assertNow(now);
        V2Pairing.createCancellation(pairingId, now, localIdentity.deviceId, reason);
        MutableSession session = sessions.get(pairingId);
        if (session == null || isTerminalStatus(session.status)) {
            return false;
        }
        session.status = Status.CANCELLED;
        session.cancellationReason = reason;
        session.updatedAt = now;
        return true;
    }

    synchronized Session receiveRemoteCancellation(
        String pairingId,
        V2Pairing.Cancellation cancellation,
        String signature,
        long now
    ) throws Exception {
        assertNow(now);
        MutableSession session = requireActiveAt(pairingId, now);
        if (session.peerOffer == null || cancellation == null || !pairingId.equals(cancellation.pairingId)
            || !session.peerOffer.identity.deviceId.equals(cancellation.deviceId)) {
            throw new IllegalArgumentException("Remote pairing cancellation does not match the session");
        }
        if (!V2Pairing.isFresh(cancellation.issuedAt, now) || cancellation.issuedAt > session.expiresAt
            || !V2Pairing.verifyCancellation(cancellation, signature, session.peerOffer.identity)) {
            throw new IllegalArgumentException("Pairing cancellation signature or clock is invalid");
        }
        session.status = Status.CANCELLED;
        session.cancellationReason = cancellation.reason;
        session.updatedAt = now;
        return session.snapshot();
    }

    synchronized Session get(String pairingId) {
        return get(pairingId, false, System.currentTimeMillis());
    }

    synchronized Session get(String pairingId, boolean includeTerminal, long now) {
        assertNow(now);
        expireSessions(now);
        MutableSession session = sessions.get(pairingId);
        if (session == null || (!includeTerminal && isTerminalStatus(session.status))) {
            return null;
        }
        return session.snapshot();
    }

    synchronized List<Session> listActive(long now) {
        assertNow(now);
        expireSessions(now);
        List<Session> result = new ArrayList<>();
        for (MutableSession session : sessions.values()) {
            if (!isTerminalStatus(session.status)) {
                result.add(session.snapshot());
            }
        }
        Collections.sort(result, (left, right) -> Long.compare(left.createdAt, right.createdAt));
        return Collections.unmodifiableList(result);
    }

    synchronized V2Identity localIdentity() {
        return localIdentity;
    }

    private Session cancelAndRead(String pairingId, String reason, long now) {
        cancel(pairingId, reason, now);
        Session session = get(pairingId, true, now);
        if (session == null) {
            throw new IllegalStateException("Pairing session does not exist");
        }
        return session;
    }

    private MutableSession requireActiveAt(String pairingId, long now) {
        expireSessions(now);
        return requireActive(pairingId);
    }

    private MutableSession requireActive(String pairingId) {
        MutableSession session = sessions.get(pairingId);
        if (session == null || isTerminalStatus(session.status)) {
            throw new IllegalStateException("Pairing session is not active");
        }
        return session;
    }

    private void expireSessions(long now) {
        for (MutableSession session : sessions.values()) {
            if (!isTerminalStatus(session.status) && session.expiresAt <= now) {
                expire(session, now);
            }
        }
    }

    private static void expire(MutableSession session, long now) {
        session.status = Status.EXPIRED;
        session.updatedAt = now;
    }

    private void assertCapacity() {
        int active = 0;
        for (MutableSession session : sessions.values()) {
            if (!isTerminalStatus(session.status)) {
                active += 1;
            }
        }
        if (active >= MAX_ACTIVE_SESSIONS) {
            throw new IllegalStateException("Too many active pairing sessions");
        }
    }

    private void assertFreshVerifiedOffer(V2Pairing.Offer offer, String signature, long now) {
        if (offer == null || !V2Pairing.isFresh(offer.issuedAt, now)) {
            throw new IllegalArgumentException("Pairing offer expired or has an invalid clock");
        }
        if (!V2Pairing.verifyOffer(offer, signature)) {
            throw new IllegalArgumentException("Pairing offer signature is invalid");
        }
    }

    private void rejectLocalIdentity(V2Identity remoteIdentity) {
        if (remoteIdentity == null || localIdentity.deviceId.equals(remoteIdentity.deviceId)
            || localIdentity.signingPublicKey.equals(remoteIdentity.signingPublicKey)) {
            throw new IllegalArgumentException("Pairing offer must identify a different device");
        }
    }

    private static boolean isTerminalStatus(Status status) {
        return status == Status.COMPLETED || status == Status.CANCELLED || status == Status.EXPIRED;
    }

    private static void assertNow(long now) {
        if (now <= 0 || now > 9_007_199_254_740_991L) {
            throw new IllegalArgumentException("Current time must be a positive safe integer");
        }
    }

    private static long safeAdd(long value, long increment) {
        if (value > Long.MAX_VALUE - increment) {
            throw new IllegalArgumentException("Pairing session time overflows");
        }
        return value + increment;
    }

    private static DeviceConfig requireDevice(DeviceConfig localDevice) {
        if (localDevice == null) {
            throw new IllegalArgumentException("Local pairing device is required");
        }
        return localDevice;
    }
}