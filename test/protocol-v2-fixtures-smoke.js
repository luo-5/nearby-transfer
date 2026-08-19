'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('../src/v2/canonical-json');
const { parseDiscoveryDatagram, verifyDiscoveryAnnouncement, discoveryAnnouncementSigningPayload } = require('../src/v2/discovery');
const { pairingOfferSigningPayload, verifyPairingOffer } = require('../src/v2/pairing');
const { decodeControlMessage } = require('../src/v2/message-codec');
const { decodeWireFrame, encodeWireFrame, WireFrameDecoder } = require('../src/v2/wire-frame');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'protocol-v2-discovery-and-wire.json'), 'utf8'));
assert.strictEqual(fixture.fixtureVersion, 1);

const discovery = fixture.discovery;
const discoveryWire = Buffer.from(discovery.canonicalSigned, 'utf8');
assert.ok(discoveryWire.length <= 16 * 1024);
assert.strictEqual(canonicalJson(discovery.announcement), discovery.canonicalSigned);
assert.strictEqual(discoveryAnnouncementSigningPayload(discovery.announcement), discovery.canonicalUnsigned);
assert.strictEqual(verifyDiscoveryAnnouncement(discovery.announcement, discovery.signatureBase64), true);
assert.deepStrictEqual(parseDiscoveryDatagram(discoveryWire), discovery.announcement);

const pairing = fixture.pairingOffer;
assert.strictEqual(pairingOfferSigningPayload(pairing.offer), pairing.canonicalSigningPayload);
assert.strictEqual(verifyPairingOffer(pairing.offer, pairing.signatureBase64), true);

const wire = fixture.wireFrame;
const encoded = Buffer.from(wire.encodedHex, 'hex');
const decoded = decodeWireFrame(encoded);
assert.deepStrictEqual(decoded.header, wire.header);
assert.strictEqual(decoded.payload.toString('utf8'), wire.payloadUtf8);
assert.deepStrictEqual(encodeWireFrame(decoded), encoded);
assert.deepStrictEqual(decodeControlMessage('pairing-offer', decoded.payload), {
  offer: pairing.offer,
  signature: pairing.signatureBase64
});

const incremental = new WireFrameDecoder();
const chunks = [encoded.subarray(0, 1), encoded.subarray(1, 6), encoded.subarray(6, 81), encoded.subarray(81)];
const frames = chunks.flatMap((chunk) => incremental.push(chunk));
incremental.finish();
assert.strictEqual(frames.length, 1);
assert.deepStrictEqual(frames[0], decoded);

console.log('protocol v2 discovery and wire fixture smoke tests passed');
