'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { app } = require('electron');

function derLen(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLen(c.length), c]);
}

function derSeq(...items) { return derTag(0x30, Buffer.concat(items)); }
function derSet(...items) { return derTag(0x31, Buffer.concat(items)); }
function derBool(v) { return derTag(0x01, Buffer.from([v ? 0xff : 0x00])); }

function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const b = [];
    b.push(v & 0x7f);
    while (v >= 0x80) { v >>= 7; b.unshift(0x80 | (v & 0x7f)); }
    bytes.push(...b);
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derUTCTime(d) {
  const s = d.getUTCFullYear().toString().slice(2) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0') + 'Z';
  return derTag(0x17, Buffer.from(s, 'ascii'));
}

// Build the [3] EXPLICIT extensions wrapper for a v3 certificate.
function buildExtensions() {
  // basicConstraints: CA:FALSE (critical)
  const basicConstraints = derSeq(
    derOid('2.5.29.19'),
    derBool(true), // critical
    derTag(0x04, derSeq()) // extnValue: SEQUENCE{} = CA:FALSE
  );

  // keyUsage: digitalSignature + keyEncipherment (critical)
  // Bit 0 = digitalSignature (0x80), bit 2 = keyEncipherment (0x20) → 0xa0
  // 5 unused bits in the trailing byte
  const keyUsage = derSeq(
    derOid('2.5.29.15'),
    derBool(true), // critical
    derTag(0x04, derTag(0x03, Buffer.from([0x05, 0xa0])))
  );

  // extendedKeyUsage: TLS WWW server auth (1.3.6.1.5.5.7.3.1)
  const extKeyUsage = derSeq(
    derOid('2.5.29.37'),
    derTag(0x04, derSeq(derOid('1.3.6.1.5.5.7.3.1')))
  );

  // subjectAltName: DNS + IP entries for hostname-verifying clients
  const sanEntries = [];
  sanEntries.push(derTag(0x82, Buffer.from('localhost', 'ascii'))); // DNS:localhost
  sanEntries.push(derTag(0x87, Buffer.from([127, 0, 0, 1])));      // IP:127.0.0.1
  try {
    const hostname = os.hostname();
    if (hostname && hostname !== 'localhost') {
      sanEntries.push(derTag(0x82, Buffer.from(hostname, 'ascii')));
    }
  } catch (_) { /* hostname unavailable */ }
  // Enumerate non-internal IPv4 addresses for LAN access
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const octets = iface.address.split('.').map(Number);
          if (octets.length === 4 && octets.every((o) => o >= 0 && o <= 255)) {
            sanEntries.push(derTag(0x87, Buffer.from(octets)));
          }
        }
      }
    }
  } catch (_) { /* networkInterfaces unavailable */ }

  const subjectAltName = derSeq(
    derOid('2.5.29.17'),
    derTag(0x04, derSeq(...sanEntries))
  );

  // [3] EXPLICIT wrapper around the SEQUENCE OF Extension
  return derTag(0xa3, derSeq(basicConstraints, keyUsage, extKeyUsage, subjectAltName));
}

class CertManager {
  constructor() {
    let userDataPath = '';
    try {
      userDataPath = app && app.getPath ? app.getPath('userData') : os.tmpdir();
    } catch (e) {
      userDataPath = os.tmpdir();
    }
    this.certPath = path.join(userDataPath, 'webdav-cert.pem');
    this.keyPath = path.join(userDataPath, 'webdav-key.pem');
  }

  getOrCreateCert() {
    if (fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)) {
      try {
        const cert = fs.readFileSync(this.certPath, 'utf8');
        const key = fs.readFileSync(this.keyPath, 'utf8');
        return { cert, key };
      } catch (err) {
        console.error('Failed to read existing certs, generating new ones...', err);
      }
    }

    return this.generateCert();
  }

  /** SHA-256 of the DER certificate, hex-encoded. Clients pin this fingerprint. */
  getCertFingerprint() {
    const { cert } = this.getOrCreateCert();
    const der = Buffer.from(
      cert.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, ''),
      'base64'
    );
    return crypto.createHash('sha256').update(der).digest('hex');
  }

  generateCert() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const sha256WithRSA = derSeq(derOid('1.2.840.113549.1.1.11'), derTag(0x05, Buffer.alloc(0)));
    const serial = derTag(0x02, crypto.randomBytes(16));
    const now = new Date();
    const exp = new Date();
    exp.setFullYear(now.getFullYear() + 10);
    const validity = derSeq(derUTCTime(now), derUTCTime(exp));
    const name = derSeq(derSet(derSeq(derOid('2.5.4.3'), derTag(0x0c, Buffer.from('NearbyTransferLocal')))));

    const tbs = derSeq(
      derTag(0xa0, derTag(0x02, Buffer.from([0x02]))), // version v3
      serial,
      sha256WithRSA,
      name, // issuer
      validity,
      name, // subject
      publicKey, // spki
      buildExtensions() // [3] EXPLICIT extensions
    );

    const sig = crypto.sign('sha256', tbs, privateKey);
    const sigBitString = derTag(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
    const certDer = derSeq(tbs, sha256WithRSA, sigBitString);
    const certPem = '-----BEGIN CERTIFICATE-----\n' +
      certDer.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END CERTIFICATE-----\n';

    fs.writeFileSync(this.certPath, certPem, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(this.keyPath, privateKey, { encoding: 'utf8', mode: 0o600 });

    return { cert: certPem, key: privateKey };
  }
}

module.exports = new CertManager();
