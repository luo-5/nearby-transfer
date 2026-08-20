'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fixture = require('./fixtures/protocol-v2-transfer-messages.json');
const authFixture = require('./fixtures/protocol-v2-transfer-auth.json');
const { canonicalJson } = require('../src/v2/canonical-json');
const {
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint
} = require('../src/v2/transfer-message-codec');
const {
  signTransferMessage,
  verifyTransferMessage
} = require('../src/v2/transfer-message-auth');

function createPemKeyPair(type) {
  return crypto.generateKeyPairSync(type, {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unsigned(message) {
  const copy = clone(message);
  delete copy.signature;
  return copy;
}

const signer = createPemKeyPair('ed25519');
const wrongSigner = createPemKeyPair('ed25519');
const wrongType = createPemKeyPair('x25519');

function testFixtureVectorsAndCanonicalSignatures() {
  for (const vector of Object.values(fixture.vectors)) {
    const input = unsigned(vector.message);
    const before = clone(input);
    const signed = signTransferMessage(vector.type, input, signer.privateKey, {
      now: fixture.validationNow
    });

    assert.deepStrictEqual(input, before);
    assert.deepStrictEqual(unsigned(signed), before);
    assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
    assert.strictEqual(Buffer.from(signed.signature, 'base64url').length, 64);
    assert.strictEqual(Buffer.from(signed.signature, 'base64url').toString('base64url'), signed.signature);
    assert.strictEqual(verifyTransferMessage(
      vector.type,
      signed,
      signer.publicKey,
      { now: fixture.validationNow }
    ), true);
    assert.deepStrictEqual(input, before);
  }
}

function testSharedCrossPlatformVector() {
  const { receiver, transferDecision, validationNow } = authFixture;
  const signed = signTransferMessage(
    transferDecision.type,
    transferDecision.unsigned,
    receiver.signingPrivateKey,
    { now: validationNow }
  );
  assert.strictEqual(canonicalJson(signed), transferDecision.canonicalSigned);
  assert.strictEqual(verifyTransferMessage(
    transferDecision.type,
    JSON.parse(transferDecision.canonicalSigned),
    receiver.signingPublicKey,
    { now: validationNow }
  ), true);
}

function testTamperingAndUnsignedInput() {
  const vector = fixture.vectors.transferDecision;
  const input = unsigned(vector.message);
  const signed = signTransferMessage(vector.type, input, signer.privateKey, {
    now: fixture.validationNow
  });

  assert.strictEqual(verifyTransferMessage(vector.type, input, signer.publicKey, {
    now: fixture.validationNow
  }), false);
  assert.throws(
    () => signTransferMessage(vector.type, signed, signer.privateKey, { now: fixture.validationNow }),
    /must not contain a signature/
  );

  const changedField = { ...signed, decision: 'rejected' };
  assert.strictEqual(verifyTransferMessage(vector.type, changedField, signer.publicKey, {
    now: fixture.validationNow
  }), false);

  const changedSession = {
    ...signed,
    sessionId: Buffer.alloc(16, 0x7f).toString('base64url')
  };
  assert.strictEqual(verifyTransferMessage(vector.type, changedSession, signer.publicKey, {
    now: fixture.validationNow
  }), false);

  const changedSignature = Buffer.from(signed.signature, 'base64url');
  changedSignature[0] ^= 0x01;
  assert.strictEqual(verifyTransferMessage(vector.type, {
    ...signed,
    signature: changedSignature.toString('base64url')
  }, signer.publicKey, { now: fixture.validationNow }), false);
  assert.strictEqual(verifyTransferMessage(vector.type, signed, wrongSigner.publicKey, {
    now: fixture.validationNow
  }), false);
}

function testValidationRemainsEnforced() {
  const vector = fixture.vectors.transferDecision;
  const decision = unsigned(vector.message);

  const unknown = { ...decision, debug: true };
  assert.throws(
    () => signTransferMessage(TYPE_TRANSFER_DECISION, unknown, signer.privateKey, {
      now: fixture.validationNow
    }),
    /unknown field/
  );

  const signed = signTransferMessage(TYPE_TRANSFER_DECISION, decision, signer.privateKey, {
    now: fixture.validationNow
  });
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_DECISION, {
    ...signed,
    debug: true
  }, signer.publicKey, { now: fixture.validationNow }), false);

  const invalidRoute = {
    ...decision,
    receiverDeviceId: decision.senderDeviceId
  };
  assert.throws(
    () => signTransferMessage(TYPE_TRANSFER_DECISION, invalidRoute, signer.privateKey, {
      now: fixture.validationNow
    }),
    /sender and receiver must differ/
  );
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_DECISION, {
    ...signed,
    receiverDeviceId: signed.senderDeviceId
  }, signer.publicKey, { now: fixture.validationNow }), false);

  assert.throws(
    () => signTransferMessage(TYPE_TRANSFER_DECISION, decision, signer.privateKey, {
      now: decision.expiresAt + 1
    }),
    /expired/
  );
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_DECISION, signed, signer.publicKey, {
    now: signed.expiresAt + 1
  }), false);
}

function testControlCheckpointsRemainEnforced() {
  const resume = signTransferMessage(
    TYPE_TRANSFER_RESUME,
    unsigned(fixture.vectors.transferResume.message),
    signer.privateKey,
    { now: fixture.validationNow }
  );
  const checkpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_RESUME, resume, {
    now: fixture.validationNow
  });
  const progressInput = unsigned(fixture.vectors.transferProgress.message);
  const progress = signTransferMessage(TYPE_TRANSFER_PROGRESS, progressInput, signer.privateKey, {
    now: fixture.validationNow,
    checkpoint
  });
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_PROGRESS, progress, signer.publicKey, {
    now: fixture.validationNow,
    checkpoint
  }), true);

  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_PROGRESS, {
    ...progress,
    sessionId: Buffer.alloc(16, 0x33).toString('base64url')
  }, signer.publicKey, { now: fixture.validationNow, checkpoint }), false);

  const zeroProgress = signTransferMessage(TYPE_TRANSFER_PROGRESS, {
    ...progressInput,
    path: '资料/empty.bin',
    fileSize: 0,
    committedOffset: 0,
    completed: true,
    totalTransferred: 0
  }, signer.privateKey, { now: fixture.validationNow });
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_PROGRESS, zeroProgress, signer.publicKey, {
    now: fixture.validationNow
  }), true);
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_PROGRESS, {
    ...zeroProgress,
    completed: false
  }, signer.publicKey, { now: fixture.validationNow }), false);

  const regressedInput = {
    ...progressInput,
    committedOffset: 4,
    completed: false,
    totalTransferred: 4
  };
  const regressed = signTransferMessage(TYPE_TRANSFER_PROGRESS, regressedInput, signer.privateKey, {
    now: fixture.validationNow
  });
  assert.throws(
    () => signTransferMessage(TYPE_TRANSFER_PROGRESS, regressedInput, signer.privateKey, {
      now: fixture.validationNow,
      checkpoint
    }),
    /backwards/
  );
  assert.strictEqual(verifyTransferMessage(TYPE_TRANSFER_PROGRESS, regressed, signer.publicKey, {
    now: fixture.validationNow,
    checkpoint
  }), false);
}

function testStrictKeyHandlingAndProgrammerErrors() {
  const vector = fixture.vectors.transferDecision;
  const input = unsigned(vector.message);
  const signed = signTransferMessage(vector.type, input, signer.privateKey, {
    now: fixture.validationNow
  });

  assert.throws(
    () => signTransferMessage(vector.type, input, wrongType.privateKey, { now: fixture.validationNow }),
    /must be Ed25519/
  );
  assert.throws(
    () => signTransferMessage(vector.type, input, 'not a private key', { now: fixture.validationNow }),
    /PRIVATE KEY PEM framing/
  );
  assert.strictEqual(verifyTransferMessage(vector.type, signed, wrongType.publicKey, {
    now: fixture.validationNow
  }), false);
  assert.strictEqual(verifyTransferMessage(vector.type, signed, 'not a public key', {
    now: fixture.validationNow
  }), false);
  assert.strictEqual(verifyTransferMessage(vector.type, signed, signer.privateKey, {
    now: fixture.validationNow
  }), false);
  assert.strictEqual(verifyTransferMessage(vector.type, null, signer.publicKey, {
    now: fixture.validationNow
  }), false);

  assert.throws(
    () => verifyTransferMessage('unsupported', signed, signer.publicKey),
    /Unsupported transfer message type/
  );
  assert.throws(
    () => verifyTransferMessage(vector.type, signed, signer.publicKey, { previous: {} }),
    /complete checkpoint/
  );
  assert.throws(
    () => verifyTransferMessage(vector.type, signed, signer.publicKey, { now: 0 }),
    /positive safe integer/
  );
}

testSharedCrossPlatformVector();
testFixtureVectorsAndCanonicalSignatures();
testTamperingAndUnsignedInput();
testValidationRemainsEnforced();
testControlCheckpointsRemainEnforced();
testStrictKeyHandlingAndProgrammerErrors();
console.log('transfer message authentication smoke tests passed');
