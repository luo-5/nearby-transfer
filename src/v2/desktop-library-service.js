'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const certManager = require('./cert-manager');

const HANDSHAKE_RATE_LIMIT = 10;
const HANDSHAKE_RATE_WINDOW_MS = 60 * 1000;
const HANDSHAKE_TIMESTAMP_TOLERANCE_MS = 60 * 1000;
const HANDSHAKE_NONCE_TTL_MS = 120 * 1000;
const HANDSHAKE_MAX_BODY_BYTES = 64 * 1024;
const HANDSHAKE_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

class DesktopLibraryService {
  constructor({
    trustedPeerStore,
    shares = [],
    logger = console,
    authHeader = 'authorization'
  } = {}) {
    this.trustedPeerStore = trustedPeerStore || null;
    this.shares = new Map();
    this.logger = logger;
    this.authHeader = authHeader.toLowerCase();
    this.server = null;
    this.port = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.sockets = new Set();
    this.sessionTokens = new Map(); // token -> { deviceId, permissions, expiresAt }
    this.usedAuthNonces = new Map(); // deviceId -> Map<nonce, expiresAt>
    this.handshakeWindows = new Map(); // remoteAddress -> { startedAt, count }
    this.sseClients = new Set();
    this.watchers = new Map();
    this.debounceTimers = new Map();

    for (const share of shares) {
      this.addShare(share);
    }
  }

  addShare({ id, name, localPath, readOnly = true }) {
    if (!id || typeof id !== 'string') throw new TypeError('Share ID is required');
    if (!name || typeof name !== 'string') throw new TypeError('Share name is required');
    if (!localPath || typeof localPath !== 'string') throw new TypeError('Share localPath is required');
    
    const resolvedPath = path.resolve(localPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Share path does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Share path must be a directory: ${resolvedPath}`);
    }

    this._unwatchShare(id);
    this.shares.set(id, {
      id,
      name,
      localPath: resolvedPath,
      readOnly: readOnly === true
    });
    this._watchShare(id, resolvedPath);
    this._broadcastEvent('share-updated', { type: 'share-updated', shareId: id });
  }

  removeShare(id) {
    this._unwatchShare(id);
    return this.shares.delete(id);
  }

  listShares() {
    return Array.from(this.shares.values()).map((s) => ({
      id: s.id,
      name: s.name,
      localPath: s.localPath,
      readOnly: s.readOnly
    }));
  }

  _listRemoteShares() {
    return Array.from(this.shares.values()).map((share) => ({
      id: share.id,
      name: share.name,
      readOnly: share.readOnly
    }));
  }

  createSessionToken(peerDeviceId, ttlMs = 3600 * 1000) {
    if (!this.trustedPeerStore) throw new Error('TrustedPeerStore not configured');
    const peer = typeof this.trustedPeerStore.getTrustedPeer === 'function'
      ? this.trustedPeerStore.getTrustedPeer(peerDeviceId)
      : (typeof this.trustedPeerStore.getPeer === 'function' ? this.trustedPeerStore.getPeer(peerDeviceId) : null);
    const isTrusted = peer && (typeof peer.isTrusted === 'function' ? peer.isTrusted() : peer.revokedAt === null);
    if (!isTrusted) {
      throw new Error(`Device ${peerDeviceId} is not a trusted peer`);
    }

    const token = require('crypto').randomBytes(24).toString('hex');
    this.sessionTokens.set(token, {
      deviceId: peerDeviceId,
      permissions: Object.assign({}, peer.permissions),
      expiresAt: Date.now() + ttlMs
    });
    return token;
  }

  revokeSessionToken(token) {
    this.sessionTokens.delete(token);
  }

  _authenticateRequest(req) {
    const authHeaderVal = req.headers[this.authHeader];
    let token = null;

    if (authHeaderVal && authHeaderVal.startsWith('Bearer ')) {
      token = authHeaderVal.slice(7).trim();
    }

    if (!token) return null;

    const session = this.sessionTokens.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessionTokens.delete(token);
      return null;
    }

    // Verify the peer is still trusted
    if (this.trustedPeerStore) {
      const peer = typeof this.trustedPeerStore.getTrustedPeer === 'function'
        ? this.trustedPeerStore.getTrustedPeer(session.deviceId)
        : (typeof this.trustedPeerStore.getPeer === 'function' ? this.trustedPeerStore.getPeer(session.deviceId) : null);
      const isTrusted = peer && (typeof peer.isTrusted === 'function' ? peer.isTrusted() : peer.revokedAt === null);
      if (!isTrusted) {
        this.sessionTokens.delete(token);
        return null;
      }
      return Object.assign({}, session, { permissions: Object.assign({}, peer.permissions) });
    }

    return session;
  }

  _consumeHandshakeRequest(remoteAddress) {
    const now = Date.now();
    let window = this.handshakeWindows.get(remoteAddress);
    if (!window || now - window.startedAt >= HANDSHAKE_RATE_WINDOW_MS) {
      window = { startedAt: now, count: 0 };
      this.handshakeWindows.set(remoteAddress, window);
    }
    if (window.count >= HANDSHAKE_RATE_LIMIT) {
      const remainingMs = Math.max(1, HANDSHAKE_RATE_WINDOW_MS - (now - window.startedAt));
      return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  _hasUsedAuthNonce(deviceId, nonce) {
    const nonces = this.usedAuthNonces.get(deviceId);
    if (!nonces) return false;
    const expiresAt = nonces.get(nonce);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      nonces.delete(nonce);
      return false;
    }
    return true;
  }

  _rememberAuthNonce(deviceId, nonce) {
    let nonces = this.usedAuthNonces.get(deviceId);
    if (!nonces) {
      nonces = new Map();
      this.usedAuthNonces.set(deviceId, nonces);
    }
    // Lazy eviction keeps the replay cache bounded without a timer.
    const now = Date.now();
    for (const [key, expiresAt] of nonces) {
      if (now > expiresAt) nonces.delete(key);
    }
    nonces.set(nonce, now + HANDSHAKE_NONCE_TTL_MS);
  }

  async start(port = 0) {
    if (this.stopPromise) await this.stopPromise;
    if (this.server && this.port !== null) return this.port;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const { cert, key } = certManager.getOrCreateCert();
      const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => this._handleRequest(req, res));
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      this.server = server;
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '0.0.0.0');
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Library service did not expose a TCP port');
        this.port = address.port;
        for (const share of this.shares.values()) this._watchShare(share.id, share.localPath);
        return this.port;
      } catch (error) {
        if (this.server === server) {
          this.server = null;
          this.port = null;
        }
        try { server.close(); } catch (_) {}
        throw error;
      }
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startPromise) {
        try { await this.startPromise; } catch (_) {}
      }
      const server = this.server;
      this.server = null;
      this.port = null;
      this.sessionTokens.clear();
      this.usedAuthNonces.clear();
      this.handshakeWindows.clear();
      this._stopWatchers();
      for (const res of this.sseClients) {
        try { res.end(); } catch (_) {}
      }
      this.sseClients.clear();
      for (const socket of this.sockets) {
        try { socket.destroy(); } catch (_) {}
      }
      this.sockets.clear();
      if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  _watchShare(shareId, localPath) {
    if (this.watchers.has(shareId)) return;
    try {
      // Windows temporary paths may contain an 8.3 alias (for example RUNNER~1)
      // while libuv reports recursive events with the long path. Watching the
      // canonical path prevents Node's Windows fs-event prefix assertion.
      const watchPath = fs.realpathSync.native(localPath);
      const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        this._onLocalFileChanged(shareId, eventType, filename);
      });
      watcher.on('error', (error) => {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`Share watcher failed for ${shareId}`, error);
        }
      });
      this.watchers.set(shareId, watcher);
    } catch (error) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`Unable to watch share ${shareId}`, error);
      }
    }
  }

  _unwatchShare(shareId) {
    const watcher = this.watchers.get(shareId);
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      this.watchers.delete(shareId);
    }
  }

  _stopWatchers() {
    for (const [shareId, watcher] of this.watchers.entries()) {
      try { watcher.close(); } catch (_) {}
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  _onLocalFileChanged(shareId, eventType, filename) {
    const key = shareId;
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this._broadcastEvent('change', {
        type: 'change',
        shareId,
        eventType,
        filename: filename || '',
        timestamp: Date.now()
      });
    }, 300);
    this.debounceTimers.set(key, timer);
  }

  _broadcastEvent(eventName, payload) {
    const payloadStr = JSON.stringify(payload);
    for (const res of this.sseClients) {
      try {
        res.write(`event: ${eventName}\ndata: ${payloadStr}\n\n`);
      } catch (_e) {
        this.sseClients.delete(res);
      }
    }
  }

  _handleEventsStream(req, res, session) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.write(': sse-init\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', deviceId: session.deviceId, timestamp: Date.now() })}\n\n`);

    this.sseClients.add(res);

    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_e) {
        clearInterval(pingInterval);
        this.sseClients.delete(res);
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(pingInterval);
      this.sseClients.delete(res);
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
  }

  getStatus() {
    return {
      running: this.server !== null,
      port: this.port,
      shareCount: this.shares.size,
      activeTokens: this.sessionTokens.size
    };
  }

  _handleRequest(req, res) {
    const method = req.method.toUpperCase();
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname || '/');
    } catch (_err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request path' }));
      return;
    }

    if (req.url.includes('..') || req.url.includes('%2e%2e') || req.url.includes('%2E%2E')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal forbidden' }));
      return;
    }

    // Signed handshake for trusted peers to exchange session tokens. Every
    // request must prove possession of the device's Ed25519 signing key; the
    // timestamp bounds replay and the nonce makes each handshake single-use.
    if (pathname === '/api/session' || pathname === '/api/auth') {
      if (method === 'POST') {
        const rate = this._consumeHandshakeRequest(req.socket.remoteAddress || 'unknown');
        if (!rate.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSeconds) });
          res.end(JSON.stringify({ ok: false, error: 'Too many handshake requests' }));
          return;
        }
        let body = '';
        let oversized = false;
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > HANDSHAKE_MAX_BODY_BYTES) {
            oversized = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (oversized) return;
          try {
            const data = JSON.parse(body || '{}');
            const deviceId = typeof data.deviceId === 'string' ? data.deviceId : '';
            const timestamp = data.timestamp;
            const nonce = typeof data.nonce === 'string' ? data.nonce : '';
            const signature = typeof data.signature === 'string' ? data.signature : '';
            if (!deviceId || !Number.isSafeInteger(timestamp) || !HANDSHAKE_NONCE_PATTERN.test(nonce) || !signature) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'deviceId, timestamp, nonce, and signature are required' }));
              return;
            }
            if (!this.trustedPeerStore) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'TrustedPeerStore not configured' }));
              return;
            }
            const peer = typeof this.trustedPeerStore.getTrustedPeer === 'function'
              ? this.trustedPeerStore.getTrustedPeer(deviceId)
              : (typeof this.trustedPeerStore.getPeer === 'function' ? this.trustedPeerStore.getPeer(deviceId) : null);
            const isTrusted = peer && (typeof peer.isTrusted === 'function' ? peer.isTrusted() : peer.revokedAt === null);
            if (!isTrusted) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Device ${deviceId} is not paired or trusted` }));
              return;
            }
            const signingKeyPem = (peer.identity && peer.identity.signingPublicKey) || peer.signingPublicKey || peer.signing_public_key;
            if (!signingKeyPem) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Trusted peer has no signing public key' }));
              return;
            }
            if (Math.abs(Date.now() - timestamp) > HANDSHAKE_TIMESTAMP_TOLERANCE_MS) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Handshake timestamp is outside the accepted window' }));
              return;
            }
            if (this._hasUsedAuthNonce(deviceId, nonce)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Handshake nonce has already been used' }));
              return;
            }
            const authPayload = `nearby-transfer:library-auth:${deviceId}:${timestamp}:${nonce}`;
            let isValid = false;
            try {
              isValid = require('crypto').verify(
                null,
                Buffer.from(authPayload, 'utf8'),
                require('crypto').createPublicKey(signingKeyPem),
                Buffer.from(signature, 'base64')
              );
            } catch (_sigErr) {
              isValid = false;
            }
            if (!isValid) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Invalid digital signature for device authentication' }));
              return;
            }
            this._rememberAuthNonce(deviceId, nonce);
            const token = this.createSessionToken(deviceId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              token,
              expiresIn: 3600,
              shares: peer.permissions && peer.permissions.libraryRead ? this._listRemoteShares() : []
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }
    }

    const session = this._authenticateRequest(req);
    if (!session) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="NearbyTransferLibrary"'
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Valid peer session token required' }));
      return;
    }

    if (!session.permissions || !session.permissions.libraryRead) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Missing libraryRead permission' }));
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(200, {
        'Allow': 'OPTIONS, GET, HEAD, PROPFIND, PUT, DELETE, MKCOL, COPY, MOVE',
        'MS-Author-Via': 'DAV'
      });
      res.end();
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      this._handleEventsStream(req, res, session);
      return;
    }

    if (pathname === '/api/shares' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shares: this._listRemoteShares() }));
      return;
    }

    if (pathname === '/api/list' && method === 'GET') {
      const shareId = url.searchParams.get('shareId') || (this.shares.keys().next().value || 'default-share');
      const subPath = url.searchParams.get('path') || '';
      const share = this.shares.get(shareId);
      if (!share) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Share not found' }));
        return;
      }
      const targetPath = path.resolve(share.localPath, subPath);
      const relative = path.relative(share.localPath, targetPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Path traversal forbidden' }));
        return;
      }
      // Verify the resolved path is within the share root (prevent symlink traversal)
      if (!this._isPathWithinShare(targetPath, share.localPath)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Path traversal forbidden: symlink escape detected' }));
        return;
      }
      if (!fs.existsSync(targetPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Directory not found' }));
        return;
      }
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const items = entries.map((entry) => {
        const itemPath = path.join(targetPath, entry.name);
        try {
          const s = fs.statSync(itemPath);
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: s.size,
            mtime: s.mtimeMs,
            downloadUrl: `/webdav/${encodeURIComponent(shareId)}/${subPath ? subPath.split('/').map(encodeURIComponent).join('/') + '/' : ''}${encodeURIComponent(entry.name)}`
          };
        } catch (_e) {
          return null;
        }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shareId, path: subPath, items }));
      return;
    }

    // Strip optional /webdav prefix
    let urlPrefix = '';
    if (pathname.startsWith('/webdav/')) {
      pathname = pathname.slice(7);
      urlPrefix = '/webdav';
    } else if (pathname === '/webdav') {
      pathname = '/';
      urlPrefix = '/webdav';
    }

    // Root list of shares
    if (pathname === '/' || pathname === '') {
      if (method === 'PROPFIND') {
        return this._handleRootPropfind(req, res, urlPrefix);
      } else if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ shares: this._listRemoteShares() }));
        return;
      } else {
        res.writeHead(405, { 'Allow': 'PROPFIND, GET, OPTIONS' });
        res.end();
        return;
      }
    }

    // Path segments: /shareId/path/to/file
    const parts = pathname.slice(1).split('/');
    const shareId = parts[0];
    const subPath = parts.slice(1).join('/');

    const share = this.shares.get(shareId);
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Share not found' }));
      return;
    }

    // Resolve target path safely
    const targetPath = path.resolve(share.localPath, subPath);
    const relative = path.relative(share.localPath, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal forbidden' }));
      return;
    }

    // Verify the resolved path is within the share root (prevent symlink traversal)
    if (!this._isPathWithinShare(targetPath, share.localPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal forbidden: symlink escape detected' }));
      return;
    }

    switch (method) {
      case 'PROPFIND':
        return this._handlePropfind(req, targetPath, shareId, subPath, res, urlPrefix);
      case 'GET':
      case 'HEAD':
        return this._handleGet(req, targetPath, method === 'HEAD', res);
      case 'PUT':
        return this._handlePut(targetPath, share, session, req, res);
      case 'MKCOL':
        return this._handleMkcol(targetPath, share, session, res);
      case 'DELETE':
        return this._handleDelete(targetPath, share, session, res);
      case 'COPY':
        return this._handleCopy(targetPath, share, session, req, res);
      case 'MOVE':
        return this._handleMove(targetPath, share, session, req, res);
      default:
        res.writeHead(405, { 'Allow': 'OPTIONS, GET, HEAD, PROPFIND, PUT, DELETE, MKCOL, COPY, MOVE' });
        res.end(JSON.stringify({ error: `Method ${method} not permitted` }));
        return;
    }
  }

  _handleRootPropfind(req, res, urlPrefix = '') {
    const depth = (req.headers['depth'] || '1').toString();
    const xmlItems = depth === '0' ? '' : this.listShares().map((s) => {
      const sStat = { size: 0, mtime: new Date(0) };
      try {
        const real = fs.realpathSync(this.shares.get(s.id).localPath);
        Object.assign(sStat, fs.statSync(real));
      } catch (_) {}
      return `
      <D:response>
        <D:href>${urlPrefix}/${encodeURIComponent(s.id)}/</D:href>
        <D:propstat>
          <D:prop>
            <D:displayname>${escapeXml(s.name)}</D:displayname>
            <D:getcontentlength>${sStat.size}</D:getcontentlength>
            <D:getlastmodified>${sStat.mtime.toUTCString()}</D:getlastmodified>
            <D:getetag>"${sStat.mtimeMs}-${sStat.size}"</D:getetag>
            <D:resourcetype><D:collection/></D:resourcetype>
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>
    `;
    }).join('');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${urlPrefix || '/'}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>root</D:displayname>
        <D:getcontentlength>0</D:getcontentlength>
        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  ${xmlItems}
</D:multistatus>`;

    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
  }

  _handlePropfind(req, targetPath, shareId, subPath, res, urlPrefix = '') {
    const share = this.shares.get(shareId);
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Share not found' }));
      return;
    }

    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Resource not found' }));
      return;
    }

    const depth = (req.headers['depth'] || '1').toString();
    const stat = fs.statSync(targetPath);
    const isDir = stat.isDirectory();
    // Normalize and clean subPath
    const cleanSubPath = (subPath || '').replace(/^\/+|\/+$/g, '');
    const encodedSubPath = cleanSubPath ? cleanSubPath.split('/').filter(Boolean).map(encodeURIComponent).join('/') : '';
    const hrefBase = `${urlPrefix}/${encodeURIComponent(shareId)}${encodedSubPath ? '/' + encodedSubPath : ''}`;
    const selfHref = `${hrefBase}${isDir ? '/' : ''}`;

    let childrenXml = '';
    if (isDir && depth !== '0') {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      childrenXml = entries.map((entry) => {
        const entryPath = path.join(targetPath, entry.name);
        try {
          // Verify entry is not a symlink escaping the share root
          if (!this._isPathWithinShare(entryPath, share.localPath)) {
            return '';
          }
          const entryStat = fs.statSync(entryPath);
          const childHref = `${hrefBase}/${encodeURIComponent(entry.name)}${entryStat.isDirectory() ? '/' : ''}`;
          return `
            <D:response>
              <D:href>${childHref}</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>${escapeXml(entry.name)}</D:displayname>
                  <D:getcontentlength>${entryStat.size}</D:getcontentlength>
                  <D:getlastmodified>${entryStat.mtime.toUTCString()}</D:getlastmodified>
                  <D:getetag>"${entryStat.mtimeMs}-${entryStat.size}"</D:getetag>
                  <D:resourcetype>${entryStat.isDirectory() ? '<D:collection/>' : ''}</D:resourcetype>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          `;
        } catch (_err) {
          return '';
        }
      }).join('');
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${selfHref}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(path.basename(targetPath) || shareId)}</D:displayname>
        <D:getcontentlength>${stat.size}</D:getcontentlength>
        <D:getlastmodified>${stat.mtime.toUTCString()}</D:getlastmodified>
        <D:getetag>"${stat.mtimeMs}-${stat.size}"</D:getetag>
        <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  ${childrenXml}
</D:multistatus>`;

    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
  }

  _isPathWithinShare(targetPath, shareLocalPath) {
    try {
      const realShare = fs.realpathSync(shareLocalPath);
      // For paths that don't exist yet (e.g., PUT/MKCOL), check the nearest existing ancestor
      let checkPath = targetPath;
      while (!fs.existsSync(checkPath)) {
        const parent = path.dirname(checkPath);
        if (parent === checkPath) break; // reached root
        checkPath = parent;
      }
      const realTarget = fs.realpathSync(checkPath);
      const relative = path.relative(realShare, realTarget);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (_e) {
      return false;
    }
  }

  _isShareRoot(targetPath, shareLocalPath) {
    return path.resolve(targetPath) === path.resolve(shareLocalPath);
  }

  _isStrictDescendant(candidatePath, parentPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  _handleGet(req, targetPath, isHeadOnly, res) {
    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot download a directory directly. Use PROPFIND.' }));
      return;
    }

    const rangeHeader = req && req.headers ? req.headers['range'] : null;
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.slice(6).split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] && parts[1].length > 0 ? parseInt(parts[1], 10) : stat.size - 1;

      if (!isNaN(start) && start >= 0 && start <= end && end < stat.size) {
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'application/octet-stream',
          'ETag': `"${stat.mtimeMs}-${stat.size}"`,
          'Last-Modified': stat.mtime.toUTCString()
        });

        if (isHeadOnly) {
          res.end();
          return;
        }

        const stream = fs.createReadStream(targetPath, { start, end });
        void pipeline(stream, res).catch((error) => {
          if (!res.destroyed) res.destroy(error);
        });
        return;
      } else {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ error: 'Requested range not satisfiable' }));
        return;
      }
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      'ETag': `"${stat.mtimeMs}-${stat.size}"`,
      'Content-Type': 'application/octet-stream'
    });

    if (isHeadOnly) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetPath);
    void pipeline(stream, res).catch((error) => {
      if (!res.destroyed) res.destroy(error);
    });
  }

  _handlePut(targetPath, share, session, req, res) {
    if (share.readOnly) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Share is read-only' }));
      return;
    }

    if (!session.permissions || !session.permissions.libraryUpload) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Peer lacks libraryUpload permission' }));
      return;
    }

    // Enforce maximum upload size (50 GiB)
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader !== undefined && !/^(0|[1-9][0-9]*)$/.test(String(contentLengthHeader))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Content-Length' }));
      return;
    }
    const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength > MAX_UPLOAD_BYTES)) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: Upload exceeds maximum size limit' }));
      return;
    }

    if (portableLibraryPathError(share.localPath, targetPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or reserved filename' }));
      return;
    }

    // Do not allow overwriting existing files (Append-only / New-file-only policy)
    if (fs.existsSync(targetPath)) {
      res.writeHead(412, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Precondition Failed: Overwriting existing files is not permitted' }));
      return;
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to create parent directory: ${err.message}` }));
        return;
      }
    }

    let stagingDir;
    try {
      stagingDir = fs.mkdtempSync(path.join(dir, '.nearby-upload-'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to create upload staging directory: ${err.message}` }));
      return;
    }
    const stagingPath = path.join(stagingDir, 'payload.part');
    let totalBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          const error = new Error('Payload Too Large: Upload exceeds maximum size limit');
          error.code = 'UPLOAD_TOO_LARGE';
          callback(error);
          return;
        }
        callback(null, chunk);
      }
    });
    const writeStream = fs.createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 });

    void pipeline(req, limiter, writeStream).then(() => {
      try {
        publishFileNoOverwrite(stagingPath, targetPath);
        this._cleanupPublishedStaging(stagingDir);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'created' }));
      } catch (err) {
        this._removeOwnedStaging(stagingDir);
        if (err && err.code === 'EEXIST') {
          res.writeHead(412, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Precondition Failed: Overwriting existing files is not permitted' }));
          return;
        }
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Failed to publish file: ${err.message}` }));
        }
      }
    }).catch((err) => {
      this._removeOwnedStaging(stagingDir);
      if (res.destroyed || res.writableEnded) return;
      const status = err && err.code === 'UPLOAD_TOO_LARGE' ? 413 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 413 ? err.message : 'Upload was interrupted' }));
    });
  }

  _handleMkcol(targetPath, share, session, res) {
    if (share.readOnly) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Share is read-only' }));
      return;
    }
    if (!session.permissions || !session.permissions.libraryUpload) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Peer lacks libraryUpload permission' }));
      return;
    }
    if (portableLibraryPathError(share.localPath, targetPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or reserved directory name' }));
      return;
    }
    if (fs.existsSync(targetPath)) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Directory or resource already exists' }));
      return;
    }
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'created' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to create directory: ${err.message}` }));
    }
  }

  _handleDelete(targetPath, share, session, res) {
    if (share.readOnly) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Share is read-only' }));
      return;
    }
    if (!session.permissions || !session.permissions.libraryUpload) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Peer lacks libraryUpload permission' }));
      return;
    }
    if (this._isShareRoot(targetPath, share.localPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: The share root cannot be deleted' }));
      return;
    }
    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Resource not found' }));
      return;
    }
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to delete resource: ${err.message}` }));
    }
  }

  _resolveDestination(req, share) {
    const destination = req.headers['destination'];
    if (!destination) return null;
    let destUrl;
    try { destUrl = new URL(destination, 'http://127.0.0.1'); } catch { return null; }
    let destPathname;
    try {
      destPathname = decodeURIComponent(destUrl.pathname || '/');
    } catch {
      return { error: 'Destination path has invalid percent-encoding', status: 400 };
    }
    if (destPathname.startsWith('/webdav/')) destPathname = destPathname.slice(7);
    else if (destPathname === '/webdav') destPathname = '/';
    const parts = destPathname.slice(1).split('/');
    const destShareId = parts[0];
    const destSubPath = parts.slice(1).join('/');
    const destShare = this.shares.get(destShareId);
    if (!destShare) return { error: 'Destination share not found', status: 404 };
    if (destShare !== share) return { error: 'Cross-share copy/move is not supported', status: 403 };
    const destPath = path.resolve(destShare.localPath, destSubPath);
    const relative = path.relative(destShare.localPath, destPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: 'Path traversal forbidden', status: 403 };
    if (!this._isPathWithinShare(destPath, destShare.localPath)) return { error: 'Path traversal forbidden: symlink escape detected', status: 403 };
    if (this._isShareRoot(destPath, destShare.localPath)) return { error: 'The share root cannot be replaced', status: 403 };
    if (portableLibraryPathError(destShare.localPath, destPath)) return { error: 'Destination contains an invalid or non-portable name', status: 400 };
    return { destPath, destShare };
  }

  _handleCopy(targetPath, share, session, req, res) {
    if (share.readOnly) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Share is read-only' }));
      return;
    }
    if (!session.permissions || !session.permissions.libraryUpload) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Peer lacks libraryUpload permission' }));
      return;
    }
    if (this._isShareRoot(targetPath, share.localPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: The share root cannot be copied' }));
      return;
    }
    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Source resource not found' }));
      return;
    }
    const dest = this._resolveDestination(req, share);
    if (!dest) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Destination header is required for COPY' }));
      return;
    }
    if (dest.error) {
      res.writeHead(dest.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: dest.error }));
      return;
    }
    const { destPath } = dest;
    if (this._isStrictDescendant(destPath, targetPath)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A resource cannot be copied into itself' }));
      return;
    }
    if (fs.existsSync(destPath)) {
      res.writeHead(412, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Precondition Failed: Overwriting existing resources is not permitted' }));
      return;
    }
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(targetPath);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to inspect copy source: ${err.message}` }));
      return;
    }
    if (sourceStat.isDirectory()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Directory COPY is not supported; create the destination directory and copy files individually' }));
      return;
    }
    if (!sourceStat.isFile()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only regular files can be copied' }));
      return;
    }
    if (!fs.existsSync(path.dirname(destPath))) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Destination parent directory does not exist' }));
      return;
    }

    let stagingDir;
    try {
      stagingDir = fs.mkdtempSync(path.join(path.dirname(destPath), '.nearby-copy-'));
      const stagingPath = path.join(stagingDir, 'payload.part');
      fs.copyFileSync(targetPath, stagingPath, fs.constants.COPYFILE_EXCL);
      publishFileNoOverwrite(stagingPath, destPath);
      this._cleanupPublishedStaging(stagingDir);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end();
    } catch (err) {
      if (stagingDir) this._removeOwnedStaging(stagingDir);
      const status = err && err.code === 'EEXIST' ? 412 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 412
        ? 'Precondition Failed: Overwriting existing resources is not permitted'
        : `Failed to copy resource: ${err.message}` }));
    }
  }

  _handleMove(targetPath, share, session, req, res) {
    if (share.readOnly) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Share is read-only' }));
      return;
    }
    if (!session.permissions || !session.permissions.libraryUpload) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Peer lacks libraryUpload permission' }));
      return;
    }
    if (this._isShareRoot(targetPath, share.localPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: The share root cannot be moved' }));
      return;
    }
    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Source resource not found' }));
      return;
    }
    const dest = this._resolveDestination(req, share);
    if (!dest) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Destination header is required for MOVE' }));
      return;
    }
    if (dest.error) {
      res.writeHead(dest.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: dest.error }));
      return;
    }
    const { destPath } = dest;
    if (path.resolve(targetPath) === path.resolve(destPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Source and destination are identical' }));
      return;
    }
    if (this._isStrictDescendant(destPath, targetPath)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A resource cannot be moved into itself' }));
      return;
    }
    if (fs.existsSync(destPath)) {
      res.writeHead(412, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Precondition Failed: Overwriting existing resources is not permitted' }));
      return;
    }
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(targetPath);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to inspect move source: ${err.message}` }));
      return;
    }
    if (sourceStat.isDirectory()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Directory MOVE is not supported; move files individually and remove the source directory after verification' }));
      return;
    }
    if (!sourceStat.isFile()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only regular files can be moved' }));
      return;
    }
    if (!fs.existsSync(path.dirname(destPath))) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Destination parent directory does not exist' }));
      return;
    }

    let published = false;
    let tombstoneDir = null;
    let tombstonePath = null;
    let sourceRenamed = false;
    try {
      tombstoneDir = fs.mkdtempSync(path.join(path.dirname(targetPath), '.nearby-move-cleanup-'));
      tombstonePath = path.join(tombstoneDir, 'source');
      publishFileNoOverwrite(targetPath, destPath);
      published = true;
      fs.renameSync(targetPath, tombstonePath);
      sourceRenamed = true;
      const destinationStat = fs.lstatSync(destPath);
      const movedSourceStat = fs.lstatSync(tombstonePath);
      if (!sameFileIdentity(destinationStat, movedSourceStat)) {
        const error = new Error('Move source changed while the destination was being published');
        error.code = 'MOVE_SOURCE_CHANGED';
        throw error;
      }
      this._cleanupPublishedStaging(tombstoneDir);
      sourceRenamed = false;
      res.writeHead(201);
      res.end();
    } catch (err) {
      if (sourceRenamed && tombstonePath && fs.existsSync(tombstonePath)) {
        try {
          fs.linkSync(tombstonePath, targetPath);
          fs.unlinkSync(tombstonePath);
          sourceRenamed = false;
        } catch (_) {
          // Keep the owned recovery directory when the original path cannot be restored.
        }
      }
      if (tombstoneDir && !sourceRenamed) this._removeOwnedStaging(tombstoneDir);
      const status = !published && err && err.code === 'EEXIST'
        ? 412
        : err && err.code === 'MOVE_SOURCE_CHANGED' ? 409 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: status === 412
          ? 'Precondition Failed: Overwriting existing resources is not permitted'
          : `Failed to move resource: ${err.message}`,
        state: published
          ? sourceRenamed
            ? 'destination-published-source-recovery-pending'
            : fs.existsSync(targetPath)
              ? 'destination-published-source-retained'
              : 'destination-published-source-changed'
          : 'source-retained-destination-absent'
      }));
    }
  }

  _removeOwnedStaging(stagingPath) {
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch (_) {}
  }

  _cleanupPublishedStaging(stagingPath) {
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch (error) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`Published copy left cleanup-pending staging file ${path.basename(stagingPath)}`, error);
      }
    }
  }

  close() {
    return this.stop();
  }
}

function isPublicationFallbackError(error) {
  return Boolean(error && ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EXDEV'].includes(error.code));
}

function publishFileNoOverwrite(sourcePath, destinationPath) {
  try {
    fs.linkSync(sourcePath, destinationPath);
  } catch (error) {
    if (!isPublicationFallbackError(error)) throw error;
    const unsupported = new Error('Atomic publication requires hard-link support on the destination filesystem');
    unsupported.code = 'ATOMIC_PUBLICATION_UNSUPPORTED';
    unsupported.cause = error;
    throw unsupported;
  }
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.birthtimeMs === right.birthtimeMs;
}

function portableLibraryPathError(shareRoot, targetPath) {
  const relative = path.relative(shareRoot, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 'outside-share';
  for (const segment of relative.split(path.sep)) {
    if (!segment || !segment.isWellFormed() || segment !== segment.normalize('NFC')) return 'unicode';
    if (Buffer.byteLength(segment, 'utf8') > 255 || /[<>:"|?*\x00-\x1F]/u.test(segment) || /[. ]$/u.test(segment)) return 'characters';
    const base = segment.split('.')[0];
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(base)) return 'reserved';
  }
  return null;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  DesktopLibraryService
};
