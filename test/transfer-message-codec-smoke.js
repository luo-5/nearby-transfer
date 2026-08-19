'use strict';

const assert = require('assert');
const fixture = require('./fixtures/protocol-v2-transfer-messages.json');
const {
  MAX_CLOCK_SKEW_MS,
  MAX_MESSAGE_TTL_MS,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  decodeTransferMessage,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage
} = require('../src/v2/transfer-message-codec');
const { canonicalJson } = require('../src/v2/canonical-json');

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
  const manifest = clone(fixture.vectors.transferManifest.message);
  manifest.senderEphemeralPublicKey += '=';
  assert.throws(
    () => validateTransferMessage(TYPE_TRANSFER_MANIFEST, manifest, { now: fixture.validationNow }),
    /base64url/
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

function main() {
  testSharedCanonicalVectors();
  testStrictCanonicalJsonAndFieldWhitelists();
  testCanonicalIdentifiersKeysHashesAndSignatures();
  testExpirationAndIntegerRules();
  testManifestSortingAndSummaries();
  testSigningPayloadStability();
  testRestrictedDecisionAndCompletionModels();
  console.log('Protocol v2 transfer message codec smoke test passed');
}

main();
