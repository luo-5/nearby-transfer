'use strict';

const assert = require('assert');
const fixture = require('./fixtures/protocol-v2-transfer-messages.json');
const {
  MAX_CLOCK_SKEW_MS,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_MESSAGE_TTL_MS,
  MAX_RESUME_ENTRIES,
  SESSION_ID_BYTES,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint,
  decodeTransferMessage,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage
} = require('../src/v2/transfer-message-codec');
const { canonicalJson } = require('../src/v2/canonical-json');
const { MAX_SEQUENCE } = require('../src/v2/transfer-session-crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testSharedCanonicalVectors() {
  for (const vector of Object.values(fixture.vectors)) {
    const encoded = encodeTransferMessage(vector.type, vector.message, { now: fixture.validationNow });
    assert.strictEqual(encoded.toString('utf8'), vector.canonicalJson);
    assert.deepStrictEqual(
      decodeTransferMessage(vector.type, Buffer.from(vector.canonicalJson, 'utf8'), { now: fixture.validationNow }),
      vector.message
    );

    const unsigned = clone(vector.message);
    delete unsigned.signature;
    assert.strictEqual(transferMessageSigningPayload(vector.type, vector.message), vector.signingPayload);
    assert.strictEqual(transferMessageSigningPayload(vector.type, unsigned), vector.signingPayload);
  }
}

function testStrictCanonicalJsonAndFieldWhitelists() {
  const vector = fixture.vectors.transferManifest;
  const pretty = Buffer.from(JSON.stringify(vector.message, null, 2), 'utf8');
  assert.throws(
    () => decodeTransferMessage(TYPE_TRANSFER_MANIFEST, pretty, { now: fixture.validationNow }),
    /canonical JSON/
  );
  assert.throws(
    () => decodeTransferMessage(TYPE_TRANSFER_MANIFEST, Buffer.from([0xc3, 0x28]), { now: fixture.validationNow }),
    /encoded data|UTF-8|utf-8/i
  );

  const duplicateType = vector.canonicalJson.replace(
    '{"app":"nearby-transfer",',
    '{"app":"nearby-transfer","app":"nearby-transfer",'
  );
  assert.throws(
    () => decodeTransferMessage(TYPE_TRANSFER_MANIFEST, Buffer.from(duplicateType), { now: fixture.validationNow }),
    /canonical JSON/
  );

  const unknownEnvelope = clone(vector.message);
  unknownEnvelope.debug = true;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, unknownEnvelope, { now: fixture.validationNow }),
    /unknown field/
  );

  const missingEnvelopeField = clone(vector.message);
  delete missingEnvelopeField.receiverDeviceId;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, missingEnvelopeField, { now: fixture.validationNow }),
    /missing receiverDeviceId/
  );

  const missingSessionId = clone(vector.message);
  delete missingSessionId.sessionId;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, missingSessionId, { now: fixture.validationNow }),
    /missing sessionId/
  );

  const unknownManifest = clone(vector.message);
  unknownManifest.manifest.extra = true;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, unknownManifest, { now: fixture.validationNow }),
    /unsupported field/
  );

  const unknownEntry = clone(vector.message);
  unknownEntry.manifest.entries[0].mode = '0755';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, unknownEntry, { now: fixture.validationNow }),
    /unsupported field/
  );
}

function testCanonicalIdentifiersKeysHashesAndSignatures() {
  assert.strictEqual(SESSION_ID_BYTES, 16);
  const manifest = clone(fixture.vectors.transferManifest.message);
  manifest.senderEphemeralPublicKey += '=';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, manifest, { now: fixture.validationNow }),
    /base64url/
  );

  const paddedSessionId = clone(fixture.vectors.transferManifest.message);
  paddedSessionId.sessionId += '=';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, paddedSessionId, { now: fixture.validationNow }),
    /session ID/i
  );

  const shortSessionId = clone(fixture.vectors.transferDecision.message);
  shortSessionId.sessionId = Buffer.alloc(15).toString('base64url');
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, shortSessionId, { now: fixture.validationNow }),
    /16 bytes/
  );

  const decision = clone(fixture.vectors.transferDecision.message);
  decision.taskId = decision.taskId.slice(0, -1) + 'B';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, decision, { now: fixture.validationNow }),
    /canonical.*base64url/
  );

  const paddedTaskId = clone(fixture.vectors.transferDecision.message);
  paddedTaskId.taskId += '=';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, paddedTaskId, { now: fixture.validationNow }),
    /base64url/
  );

  const badSignature = clone(fixture.vectors.transferDecision.message);
  badSignature.signature = Buffer.alloc(63).toString('base64url');
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, badSignature, { now: fixture.validationNow }),
    /64 bytes/
  );

  const completion = clone(fixture.vectors.transferCompleteSuccess.message);
  completion.sha256 = completion.sha256.toUpperCase();
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_COMPLETE, completion, { now: fixture.validationNow }),
    /lowercase hexadecimal/
  );
}

function testExpirationAndIntegerRules() {
  const base = fixture.vectors.transferDecision.message;

  for (const invalidIssuedAt of [0, -1, 1.5, '1760000000100', Number.MAX_SAFE_INTEGER + 1]) {
    const message = clone(base);
    message.issuedAt = invalidIssuedAt;
    assert.throws(
      () => validateTransferMessage(TYPE_TRANSFER_DECISION, message, { now: fixture.validationNow }),
      /positive safe integer/
    );
  }

  const reversed = clone(base);
  reversed.expiresAt = reversed.issuedAt;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, reversed, { now: fixture.validationNow }),
    /expiration window/
  );

  const tooLong = clone(base);
  tooLong.expiresAt = tooLong.issuedAt + MAX_MESSAGE_TTL_MS + 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, tooLong, { now: fixture.validationNow }),
    /expiration window/
  );

  const maxTtl = clone(base);
  maxTtl.expiresAt = maxTtl.issuedAt + MAX_MESSAGE_TTL_MS;
  assert.doesNotThrow(() => validateTransferMessage(TYPE_TRANSFER_DECISION, maxTtl, { now: maxTtl.issuedAt }));

  const futureBoundary = clone(base);
  futureBoundary.issuedAt = fixture.validationNow + MAX_CLOCK_SKEW_MS;
  futureBoundary.expiresAt = futureBoundary.issuedAt + 1;
  assert.doesNotThrow(() => validateTransferMessage(TYPE_TRANSFER_DECISION, futureBoundary, { now: fixture.validationNow }));
  futureBoundary.issuedAt += 1;
  futureBoundary.expiresAt += 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, futureBoundary, { now: fixture.validationNow }),
    /too far in the future/
  );

  const expiryBoundary = clone(base);
  assert.doesNotThrow(() => validateTransferMessage(TYPE_TRANSFER_DECISION, expiryBoundary, { now: expiryBoundary.expiresAt }));
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, expiryBoundary, { now: expiryBoundary.expiresAt + 1 }),
    /expired/
  );

  const safeIntegerBoundary = clone(base);
  safeIntegerBoundary.expiresAt = Number.MAX_SAFE_INTEGER;
  safeIntegerBoundary.issuedAt = safeIntegerBoundary.expiresAt - MAX_MESSAGE_TTL_MS;
  assert.doesNotThrow(() => validateTransferMessage(
    TYPE_TRANSFER_DECISION,
    safeIntegerBoundary,
    { now: safeIntegerBoundary.issuedAt }
  ));
}

function testManifestSortingAndSummaries() {
  const vector = fixture.vectors.transferManifest;
  const unsorted = clone(vector.message);
  unsorted.manifest.entries.reverse();
  assert.strictEqual(
    encodeTransferMessage(TYPE_TRANSFER_MANIFEST, unsorted, { now: fixture.validationNow }).toString('utf8'),
    vector.canonicalJson
  );
  assert.throws(
    () => decodeTransferMessage(
      TYPE_TRANSFER_MANIFEST,
      Buffer.from(canonicalJson(unsorted)),
      { now: fixture.validationNow }
    ),
    /normalized canonical form/
  );

  const wrongFiles = clone(vector.message);
  wrongFiles.manifest.totalFiles = 2;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, wrongFiles, { now: fixture.validationNow }),
    /totalFiles does not match/
  );

  const wrongBytes = clone(vector.message);
  wrongBytes.manifest.totalBytes = 13;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, wrongBytes, { now: fixture.validationNow }),
    /totalBytes does not match/
  );

  const omittedSummaries = clone(vector.message);
  delete omittedSummaries.manifest.totalFiles;
  delete omittedSummaries.manifest.totalBytes;
  assert.strictEqual(
    encodeTransferMessage(TYPE_TRANSFER_MANIFEST, omittedSummaries, { now: fixture.validationNow }).toString('utf8'),
    vector.canonicalJson
  );
  assert.throws(
    () => decodeTransferMessage(
      TYPE_TRANSFER_MANIFEST,
      Buffer.from(canonicalJson(omittedSummaries)),
      { now: fixture.validationNow }
    ),
    /normalized canonical form/
  );
}

function testSigningPayloadStability() {
  for (const vector of Object.values(fixture.vectors)) {
    const changedSignature = clone(vector.message);
    changedSignature.signature = Buffer.alloc(64, 0x5a).toString('base64url');
    assert.strictEqual(transferMessageSigningPayload(vector.type, changedSignature), vector.signingPayload);
  }

  const changedDecision = clone(fixture.vectors.transferDecision.message);
  changedDecision.decision = 'rejected';
  assert.notStrictEqual(
    transferMessageSigningPayload(TYPE_TRANSFER_DECISION, changedDecision),
    fixture.vectors.transferDecision.signingPayload
  );

  const expired = clone(fixture.vectors.transferDecision.message);
  assert.strictEqual(
    transferMessageSigningPayload(TYPE_TRANSFER_DECISION, expired),
    fixture.vectors.transferDecision.signingPayload
  );

  const unknown = clone(fixture.vectors.transferDecision.message);
  delete unknown.signature;
  unknown.debug = true;
  assert.throws(() => transferMessageSigningPayload(TYPE_TRANSFER_DECISION, unknown), /unknown field/);
}

function testRestrictedDecisionAndCompletionModels() {
  const decision = clone(fixture.vectors.transferDecision.message);
  decision.decision = 'ask-user-to-retry-later';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, decision, { now: fixture.validationNow }),
    /unsupported/
  );

  const success = clone(fixture.vectors.transferCompleteSuccess.message);
  success.diagnostic = 'hash-mismatch';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_COMPLETE, success, { now: fixture.validationNow }),
    /success diagnostic/
  );

  const failure = clone(fixture.vectors.transferCompleteFailure.message);
  failure.sha256 = 'c'.repeat(64);
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_COMPLETE, failure, { now: fixture.validationNow }),
    /must not claim/
  );

  const fractionalBytes = clone(fixture.vectors.transferCompleteSuccess.message);
  fractionalBytes.bytes = 0.5;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_COMPLETE, fractionalBytes, { now: fixture.validationNow }),
    /non-negative safe integer/
  );

  const wrongType = clone(fixture.vectors.transferDecision.message);
  wrongType.type = TYPE_TRANSFER_COMPLETE;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_DECISION, wrongType, { now: fixture.validationNow }),
    /protocol envelope/
  );
}


function testResumeAndProgressModels() {
  const resumeVector = fixture.vectors.transferResume;
  const progressVector = fixture.vectors.transferProgress;
  const resume = clone(resumeVector.message);

  const second = { path: '资料/empty.txt', size: 0, committedOffset: 0, completed: false };
  resume.files = [resume.files[0], second].reverse();
  const normalized = validateTransferMessage(TYPE_TRANSFER_RESUME, resume, { now: fixture.validationNow });
  assert.deepStrictEqual(normalized.files.map((file) => file.path), ['资料/empty.txt', '资料/hello.txt']);

  const duplicate = clone(resumeVector.message);
  duplicate.files.push(clone(duplicate.files[0]));
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_RESUME, duplicate, { now: fixture.validationNow }),
    /duplicate path/
  );

  const windowsDuplicate = clone(resumeVector.message);
  windowsDuplicate.files = [
    { path: 'Folder/File.txt', size: 5, committedOffset: 0, completed: false },
    { path: 'folder/file.TXT', size: 5, committedOffset: 0, completed: false }
  ];
  windowsDuplicate.totalTransferred = 0;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_RESUME, windowsDuplicate, { now: fixture.validationNow }),
    /duplicate path/
  );

  const emptyFiles = clone(resumeVector.message);
  emptyFiles.files = [];
  emptyFiles.totalTransferred = 0;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_RESUME, emptyFiles, { now: fixture.validationNow }),
    /bounded array/
  );

  const oldResumeSchema = clone(resumeVector.message);
  delete oldResumeSchema.files[0].completed;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_RESUME, oldResumeSchema, { now: fixture.validationNow }),
    /missing completed/
  );

  const tooManyFiles = clone(resumeVector.message);
  tooManyFiles.files = new Array(MAX_RESUME_ENTRIES + 1).fill(resumeVector.message.files[0]);
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_RESUME, tooManyFiles, { now: fixture.validationNow }),
    /bounded array/
  );

  for (const mutate of [
    (message) => { message.files[0].committedOffset = message.files[0].size + 1; },
    (message) => { message.totalTransferred += 1; },
    (message) => { message.manifestHash = message.manifestHash.toUpperCase(); },
    (message) => { message.files[0].path = 'C:/secret.txt'; },
    (message) => { message.sessionKey = 'forbidden'; },
    (message) => { message.signature = Buffer.alloc(63).toString('base64url'); }
  ]) {
    const invalid = clone(resumeVector.message);
    mutate(invalid);
    assert.throws(
      () => validateTransferMessage(TYPE_TRANSFER_RESUME, invalid, { now: fixture.validationNow })
    );
  }

  const progress = clone(progressVector.message);
  progress.nextSequence = MAX_SEQUENCE;
  validateTransferMessage(TYPE_TRANSFER_PROGRESS, progress, { now: fixture.validationNow });
  progress.nextSequence = MAX_SEQUENCE + 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, progress, { now: fixture.validationNow }),
    /maximum sequence/
  );

  const overOffset = clone(progressVector.message);
  overOffset.committedOffset = overOffset.fileSize + 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, overOffset, { now: fixture.validationNow }),
    /exceeds the file size/
  );

  const incompleteCompletion = clone(progressVector.message);
  incompleteCompletion.committedOffset -= 1;
  incompleteCompletion.totalTransferred -= 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, incompleteCompletion, { now: fixture.validationNow }),
    /commit the entire file/
  );

  const nonBooleanCompletion = clone(progressVector.message);
  nonBooleanCompletion.completed = 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, nonBooleanCompletion, { now: fixture.validationNow }),
    /must be a boolean/
  );

  const fullyCommittedIncomplete = clone(progressVector.message);
  fullyCommittedIncomplete.completed = false;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, fullyCommittedIncomplete, { now: fixture.validationNow }),
    /must be completed/
  );

  const oldProgressSchema = clone(progressVector.message);
  delete oldProgressSchema.completed;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, oldProgressSchema, { now: fixture.validationNow }),
    /missing completed/
  );

  const missingSession = clone(progressVector.message);
  delete missingSession.sessionId;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, missingSession, { now: fixture.validationNow }),
    /missing sessionId/
  );

  const tooSmallTotal = clone(progressVector.message);
  tooSmallTotal.totalTransferred = tooSmallTotal.committedOffset - 1;
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, tooSmallTotal, { now: fixture.validationNow }),
    /outside the accepted bounds/
  );

  const pretty = Buffer.from(JSON.stringify(progressVector.message, null, 2));
  assert.throws(
    () => decodeTransferMessage(TYPE_TRANSFER_PROGRESS, pretty, { now: fixture.validationNow }),
    /canonical JSON/
  );
  assert.throws(
    () => decodeTransferMessage(
      TYPE_TRANSFER_PROGRESS,
      Buffer.alloc(MAX_CONTROL_MESSAGE_BYTES + 1),
      { now: fixture.validationNow }
    ),
    /payload exceeds/
  );
}

function testControlMonotonicityAndStableSigning() {
  const sequence = fixture.monotonicity;
  let checkpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_RESUME,
    clone(sequence.initialResume),
    { now: fixture.validationNow }
  );
  assert.deepStrictEqual(checkpoint.files.map((file) => file.committedOffset), [10, 0]);

  checkpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_PROGRESS,
    clone(sequence.progressA),
    { now: fixture.validationNow, checkpoint }
  );
  checkpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_PROGRESS,
    clone(sequence.progressB),
    { now: fixture.validationNow, checkpoint }
  );
  assert.deepStrictEqual(checkpoint.files.map((file) => file.committedOffset), [40, 30]);

  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      clone(sequence.regressedAAfterB),
      { now: fixture.validationNow, checkpoint }
    ),
    /committed offset moved backwards/
  );

  const changedSize = clone(sequence.progressAAfterB);
  changedSize.fileSize += 1;
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      changedSize,
      { now: fixture.validationNow, checkpoint }
    ),
    /file size changed/
  );

  const wrongTotal = clone(sequence.progressAAfterB);
  wrongTotal.totalTransferred -= 1;
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      wrongTotal,
      { now: fixture.validationNow, checkpoint }
    ),
    /checkpoint plus committed offset delta/
  );

  const insufficientSequence = clone(sequence.progressAAfterB);
  insufficientSequence.nextSequence = checkpoint.nextSequence;
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      insufficientSequence,
      { now: fixture.validationNow, checkpoint }
    ),
    /sequence delta is too small/
  );

  checkpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_PROGRESS,
    clone(sequence.progressAAfterB),
    { now: fixture.validationNow, checkpoint }
  );
  assert.deepStrictEqual(checkpoint.files.map((file) => file.committedOffset), [50, 30]);
  assert.strictEqual(checkpoint.totalTransferred, 80);
  assert.strictEqual(checkpoint.nextSequence, 5);

  const zeroResume = {
    ...clone(sequence.initialResume),
    files: [{ path: '资料/empty.bin', size: 0, committedOffset: 0, completed: false }],
    nextSequence: 0,
    totalTransferred: 0,
    issuedAt: sequence.progressAAfterB.issuedAt + 100,
    expiresAt: sequence.progressAAfterB.expiresAt + 100
  };
  let zeroCheckpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_RESUME,
    zeroResume,
    { now: fixture.validationNow }
  );
  assert.strictEqual(Object.hasOwn(zeroCheckpoint, 'sessionId'), false);

  const resumedInNewSession = {
    ...zeroResume,
    sessionId: Buffer.alloc(SESSION_ID_BYTES, 0x33).toString('base64url'),
    issuedAt: zeroResume.issuedAt + 100,
    expiresAt: zeroResume.expiresAt + 100
  };
  zeroCheckpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_RESUME,
    resumedInNewSession,
    { now: fixture.validationNow, checkpoint: zeroCheckpoint }
  );
  assert.strictEqual(Object.hasOwn(zeroCheckpoint, 'sessionId'), false);

  const zeroCompleted = {
    app: resumedInNewSession.app,
    protocolVersion: resumedInNewSession.protocolVersion,
    type: TYPE_TRANSFER_PROGRESS,
    taskId: resumedInNewSession.taskId,
    sessionId: resumedInNewSession.sessionId,
    senderDeviceId: resumedInNewSession.senderDeviceId,
    receiverDeviceId: resumedInNewSession.receiverDeviceId,
    manifestHash: resumedInNewSession.manifestHash,
    path: '资料/empty.bin',
    fileSize: 0,
    committedOffset: 0,
    completed: true,
    nextSequence: 1,
    totalTransferred: 0,
    issuedAt: resumedInNewSession.issuedAt + 100,
    expiresAt: resumedInNewSession.expiresAt + 100,
    signature: resumedInNewSession.signature
  };
  const completedCheckpoint = advanceTransferControlCheckpoint(
    TYPE_TRANSFER_PROGRESS,
    zeroCompleted,
    { now: fixture.validationNow, checkpoint: zeroCheckpoint }
  );
  assert.strictEqual(completedCheckpoint.files[0].completed, true);
  assert.strictEqual(completedCheckpoint.totalTransferred, 0);
  assert.strictEqual(completedCheckpoint.nextSequence, 1);

  const completionWithoutSequence = { ...zeroCompleted, nextSequence: 0 };
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      completionWithoutSequence,
      { now: fixture.validationNow, checkpoint: zeroCheckpoint }
    ),
    /sequence delta is too small/
  );

  const regressedCompletion = {
    ...zeroCompleted,
    completed: false,
    nextSequence: 2,
    issuedAt: zeroCompleted.issuedAt + 100,
    expiresAt: zeroCompleted.expiresAt + 100
  };
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      regressedCompletion,
      { now: fixture.validationNow, checkpoint: completedCheckpoint }
    ),
    /completion moved backwards/
  );

  const sparsePrevious = clone(sequence.progressB);
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_PROGRESS, sequence.progressAAfterB, {
      now: fixture.validationNow,
      previous: sparsePrevious
    }),
    /complete checkpoint/
  );

  const unknownProgress = clone(sequence.progressAAfterB);
  unknownProgress.path = '资料/not-in-manifest.txt';
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      unknownProgress,
      { now: fixture.validationNow, checkpoint }
    ),
    /outside the resume set/
  );

  const olderProgress = clone(sequence.progressAAfterB);
  olderProgress.issuedAt = checkpoint.issuedAt - 1;
  olderProgress.expiresAt = olderProgress.issuedAt + MAX_MESSAGE_TTL_MS;
  assert.throws(
    () => advanceTransferControlCheckpoint(
      TYPE_TRANSFER_PROGRESS,
      olderProgress,
      { now: olderProgress.issuedAt, checkpoint }
    ),
    /issue time must not move backwards/
  );

  const lateProgress = clone(sequence.progressAAfterB);
  const lateNow = sequence.initialResume.expiresAt + 10_000;
  lateProgress.committedOffset = 60;
  lateProgress.totalTransferred = 90;
  lateProgress.nextSequence = 6;
  lateProgress.issuedAt = lateNow;
  lateProgress.expiresAt = lateNow + MAX_MESSAGE_TTL_MS;
  advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, lateProgress, { now: lateNow, checkpoint });

  const changedProgress = clone(fixture.vectors.transferProgress.message);
  changedProgress.totalTransferred += 1;
  assert.notStrictEqual(
    transferMessageSigningPayload(TYPE_TRANSFER_PROGRESS, changedProgress),
    fixture.vectors.transferProgress.signingPayload
  );
  changedProgress.totalTransferred -= 1;
  changedProgress.sessionId = Buffer.alloc(SESSION_ID_BYTES, 0x55).toString('base64url');
  assert.notStrictEqual(
    transferMessageSigningPayload(TYPE_TRANSFER_PROGRESS, changedProgress),
    fixture.vectors.transferProgress.signingPayload
  );
  const unsigned = clone(fixture.vectors.transferResume.message);
  delete unsigned.signature;
  assert.strictEqual(
    transferMessageSigningPayload(TYPE_TRANSFER_RESUME, unsigned),
    fixture.vectors.transferResume.signingPayload
  );
}

function main() {
  testSharedCanonicalVectors();
  testStrictCanonicalJsonAndFieldWhitelists();
  testCanonicalIdentifiersKeysHashesAndSignatures();
  testExpirationAndIntegerRules();
  testManifestSortingAndSummaries();
  testSigningPayloadStability();
  testRestrictedDecisionAndCompletionModels();
  testResumeAndProgressModels();
  testControlMonotonicityAndStableSigning();
  console.log('Protocol v2 transfer message codec smoke test passed');
}

main();
