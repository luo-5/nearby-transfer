'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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
    this.sessionTokens = new Map(); // token -> { deviceId, permissions, expiresAt }
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

    this.shares.set(id, {
      id,
      name,
      localPath: resolvedPath,
      readOnly: readOnly === true
    });
    this._watchShare(id, resolvedPath);
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
    } else {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.has('token')) {
        token = url.searchParams.get('token');
      }
    }

    if (!token) return null;

    const session = this.sessionTokens.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessionTokens.delete(token);
      return null;
    }

    return session;
  }

  async start(port = 0) {
    if (this.server) return this.port;

    const server = http.createServer((req, res) => this._handleRequest(req, res));
    this.server = server;

    await new Promise((resolve, reject) => {
      server.listen(port, '0.0.0.0', () => {
        this.port = server.address().port;
        resolve();
      });
      server.once('error', reject);
    });

    return this.port;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    this.sessionTokens.clear();

    await new Promise((resolve) => server.close(resolve));
    this._stopWatchers();
    for (const res of this.sseClients) {
      try { res.end(); } catch (_) {}
    }
    this.sseClients.clear();
  }

  _watchShare(shareId, localPath) {
    if (this.watchers.has(shareId)) return;
    try {
      const watcher = fs.watch(localPath, { recursive: true }, (eventType, filename) => {
        this._onLocalFileChanged(shareId, eventType, filename);
      });
      watcher.on('error', () => {});
      this.watchers.set(shareId, watcher);
    } catch (_e) {}
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
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
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
    let pathname = decodeURIComponent(url.pathname || '/');

    if (req.url.includes('..') || req.url.includes('%2e%2e') || req.url.includes('%2E%2E')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal forbidden' }));
      return;
    }

    // Unauthenticated handshake for trusted peers to exchange session tokens
    if (pathname === '/api/session' || pathname === '/api/auth') {
      if (method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const deviceId = data.deviceId;
            if (!deviceId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'deviceId is required' }));
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
            const token = this.createSessionToken(deviceId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              token,
              expiresIn: 3600,
              shares: this.listShares()
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
        'DAV': '1, 2',
        'Allow': 'OPTIONS, GET, HEAD, PROPFIND, PUT',
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
      res.end(JSON.stringify({ ok: true, shares: this.listShares() }));
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
            downloadUrl: `/webdav/${encodeURIComponent(shareId)}/${subPath ? encodeURIComponent(subPath) + '/' : ''}${encodeURIComponent(entry.name)}`
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
    if (pathname.startsWith('/webdav/')) {
      pathname = pathname.slice(7);
    } else if (pathname === '/webdav') {
      pathname = '/';
    }

    // Root list of shares
    if (pathname === '/' || pathname === '') {
      if (method === 'PROPFIND') {
        return this._handleRootPropfind(res);
      } else if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ shares: this.listShares() }));
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

    switch (method) {
      case 'PROPFIND':
        return this._handlePropfind(targetPath, shareId, subPath, res);
      case 'GET':
      case 'HEAD':
        return this._handleGet(targetPath, method === 'HEAD', res);
      case 'PUT':
        return this._handlePut(targetPath, share, session, req, res);
      case 'MKCOL':
        return this._handleMkcol(targetPath, share, session, res);
      case 'DELETE':
        return this._handleDelete(targetPath, share, session, res);
      default:
        res.writeHead(405, { 'Allow': 'PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, OPTIONS' });
        res.end(JSON.stringify({ error: `Method ${method} not permitted` }));
        return;
    }
  }

  _handleRootPropfind(res) {
    const xmlItems = this.listShares().map((s) => `
      <D:response>
        <D:href>/${encodeURIComponent(s.id)}/</D:href>
        <D:propstat>
          <D:prop>
            <D:displayname>${escapeXml(s.name)}</D:displayname>
            <D:resourcetype><D:collection/></D:resourcetype>
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>
    `).join('');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop>
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

  _handlePropfind(targetPath, shareId, subPath, res) {
    if (!fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Resource not found' }));
      return;
    }

    const stat = fs.statSync(targetPath);
    const isDir = stat.isDirectory();
    const hrefPrefix = `/${encodeURIComponent(shareId)}/${subPath ? encodeURIComponent(subPath) : ''}`;

    let childrenXml = '';
    if (isDir) {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      childrenXml = entries.map((entry) => {
        const entryPath = path.join(targetPath, entry.name);
        try {
          const entryStat = fs.statSync(entryPath);
          const childHref = `/${encodeURIComponent(shareId)}/${subPath ? subPath + '/' : ''}${encodeURIComponent(entry.name)}${entryStat.isDirectory() ? '/' : ''}`;
          return `
            <D:response>
              <D:href>${childHref}</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>${escapeXml(entry.name)}</D:displayname>
                  <D:getcontentlength>${entryStat.size}</D:getcontentlength>
                  <D:getlastmodified>${entryStat.mtime.toUTCString()}</D:getlastmodified>
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
    <D:href>${hrefPrefix}${isDir && !hrefPrefix.endsWith('/') ? '/' : ''}</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>${stat.size}</D:getcontentlength>
        <D:getlastmodified>${stat.mtime.toUTCString()}</D:getlastmodified>
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

  _handleGet(targetPath, isHeadOnly, res) {
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

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
      'Content-Type': 'application/octet-stream'
    });

    if (isHeadOnly) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(targetPath);
    stream.pipe(res);
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

    const writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'created', path: targetPath }));
    });

    writeStream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to write file: ${err.message}` }));
      }
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
    if (fs.existsSync(targetPath)) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Directory or resource already exists' }));
      return;
    }
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'created', path: targetPath }));
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
