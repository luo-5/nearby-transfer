'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

class CertManager {
  constructor() {
    let userDataPath = '';
    try {
      userDataPath = app && app.getPath ? app.getPath('userData') : require('os').tmpdir();
    } catch (e) {
      userDataPath = require('os').tmpdir();
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
      publicKey // spki
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
