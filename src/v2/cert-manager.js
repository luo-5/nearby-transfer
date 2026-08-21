'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { app } = require('electron');

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
    console.log('Generating new self-signed certificate for local WebDAV server...');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(19));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    
    const attrs = [{
      name: 'commonName',
      value: 'NearbyTransferLocal'
    }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    
    // sign the certificate
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    const pemCert = forge.pki.certificateToPem(cert);
    const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
    
    fs.writeFileSync(this.certPath, pemCert, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(this.keyPath, pemKey, { encoding: 'utf8', mode: 0o600 });
    
    return { cert: pemCert, key: pemKey };
  }
}

module.exports = new CertManager();
