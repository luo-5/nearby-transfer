/**
 * LocalSend HTTP receive server: accepts incoming file transfers from LocalSend senders.
 *
 * Implements the LocalSend v2 receive API:
 * - POST /api/localsend/v2/register — device registration
 * - POST /api/localsend/v2/prepare-upload — metadata, returns sessionId + tokens
 * - POST /api/localsend/v2/upload — binary file data
 * - POST /api/localsend/v2/cancel — cancel session
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Buffer } from 'node:buffer';
import {
  LOCALSEND_API_PREFIX,
  type LocalSendDeviceInfo,
  type LocalSendFileMetadata,
  type LocalSendPrepareUploadResponse,
} from './types.js';

const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES_PER_SESSION = 1000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 ** 4;
const DEFAULT_MAX_SESSION_SIZE_BYTES = 1024 ** 4;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 8;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionFile {
  meta: LocalSendFileMetadata;
  token: string;
  tempName: string;
  received: boolean;
  active: boolean;
  request: http.IncomingMessage | null;
  writeStream: WriteStream | null;
}

interface ActiveSession {
  sessionId: string;
  files: Map<string, SessionFile>;
  tempDir: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LocalSendReceiverOptions {
  port: number;
  alias: string;
  fingerprint: string;
  receiveDir: string;
  deviceModel?: string;
  requestBodyLimitBytes?: number;
  maxFilesPerSession?: number;
  maxFileSizeBytes?: number;
  maxSessionSizeBytes?: number;
  maxSessions?: number;
  maxConcurrentUploads?: number;
  sessionTimeoutMs?: number;
}

class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class LocalSendReceiver extends EventEmitter {
  private server: http.Server | null = null;
  private sessions = new Map<string, ActiveSession>();
  private activeUploads = 0;
  private opts: LocalSendReceiverOptions;
  private receiveDir: string;
  private requestBodyLimitBytes: number;
  private maxFilesPerSession: number;
  private maxFileSizeBytes: number;
  private maxSessionSizeBytes: number;
  private maxSessions: number;
  private maxConcurrentUploads: number;
  private sessionTimeoutMs: number;

  constructor(opts: LocalSendReceiverOptions) {
    super();
    this.opts = opts;
    mkdirSync(opts.receiveDir, { recursive: true });
    const rootStat = lstatSync(opts.receiveDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('LocalSend receiveDir must be a real directory');
    }
    this.receiveDir = realpathSync.native(opts.receiveDir);
    this.requestBodyLimitBytes = positiveIntegerOption(
      opts.requestBodyLimitBytes,
      DEFAULT_REQUEST_BODY_LIMIT_BYTES,
      'requestBodyLimitBytes',
    );
    this.maxFilesPerSession = positiveIntegerOption(
      opts.maxFilesPerSession,
      DEFAULT_MAX_FILES_PER_SESSION,
      'maxFilesPerSession',
    );
    this.maxFileSizeBytes = positiveIntegerOption(
      opts.maxFileSizeBytes,
      DEFAULT_MAX_FILE_SIZE_BYTES,
      'maxFileSizeBytes',
    );
    this.maxSessionSizeBytes = positiveIntegerOption(
      opts.maxSessionSizeBytes,
      DEFAULT_MAX_SESSION_SIZE_BYTES,
      'maxSessionSizeBytes',
    );
    this.maxSessions = positiveIntegerOption(opts.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions');
    this.maxConcurrentUploads = positiveIntegerOption(
      opts.maxConcurrentUploads,
      DEFAULT_MAX_CONCURRENT_UPLOADS,
      'maxConcurrentUploads',
    );
    this.sessionTimeoutMs = positiveIntegerOption(
      opts.sessionTimeoutMs,
      DEFAULT_SESSION_TIMEOUT_MS,
      'sessionTimeoutMs',
    );
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((error: unknown) => this.handleRequestError(res, error));
      });
      this.server = server;
      const onListenError = (error: Error) => {
        if (this.server === server) this.server = null;
        reject(error);
      };
      server.once('error', onListenError);
      server.listen(this.opts.port, '0.0.0.0', () => {
        server.removeListener('error', onListenError);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.cleanupSession(sessionId, true);
    }
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private getDeviceInfo(): LocalSendDeviceInfo {
    return {
      alias: this.opts.alias,
      version: '2.0',
      deviceModel: this.opts.deviceModel ?? 'Nearby Transfer',
      deviceType: 'headless',
      fingerprint: this.opts.fingerprint,
      port: this.opts.port,
      protocol: 'http',
      download: false,
      announce: true,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? '';

    if (pathname === `${LOCALSEND_API_PREFIX}/register` && method === 'POST') {
      await this.handleRegister(req, res);
    } else if (pathname === `${LOCALSEND_API_PREFIX}/prepare-upload` && method === 'POST') {
      await this.handlePrepareUpload(req, res);
    } else if (pathname === `${LOCALSEND_API_PREFIX}/upload` && method === 'POST') {
      await this.handleUpload(req, res, url);
    } else if (pathname === `${LOCALSEND_API_PREFIX}/cancel` && method === 'POST') {
      this.handleCancel(res, url);
    } else if (pathname === `${LOCALSEND_API_PREFIX}/info` && method === 'GET') {
      this.sendJson(res, 200, this.getDeviceInfo());
    } else {
      this.sendJson(res, 404, { error: 'Not found' });
    }
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    let info: unknown;
    try {
      info = JSON.parse(body.toString());
    } catch {
      throw new RequestError(400, 'Invalid JSON');
    }
    if (!isRecord(info)) throw new RequestError(400, 'Invalid device information');
    this.emit('register', info);
    this.sendJson(res, 200, this.getDeviceInfo());
  }

  private async handlePrepareUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.sessions.size >= this.maxSessions) {
      throw new RequestError(503, 'Too many pending upload sessions');
    }

    const body = await this.readBody(req);
    let value: unknown;
    try {
      value = JSON.parse(body.toString());
    } catch {
      throw new RequestError(400, 'Invalid JSON');
    }
    const entries = this.validatePrepareUpload(value);
    const sessionId = randomUUID();
    const tempDir = join(this.receiveDir, `.localsend-tmp-${sessionId}`);
    mkdirSync(tempDir, { recursive: false });

    const files = new Map<string, SessionFile>();
    const tokenMap = Object.create(null) as Record<string, string>;
    for (const [fileId, meta] of entries) {
      const token = randomUUID();
      files.set(fileId, {
        meta,
        token,
        tempName: `${randomUUID()}.part`,
        received: false,
        active: false,
        request: null,
        writeStream: null,
      });
      tokenMap[fileId] = token;
    }

    const expiresAt = Date.now() + this.sessionTimeoutMs;
    const timer = setTimeout(() => this.cleanupSession(sessionId, true), this.sessionTimeoutMs);
    timer.unref?.();
    this.sessions.set(sessionId, { sessionId, files, tempDir, expiresAt, timer });

    const response: LocalSendPrepareUploadResponse = { sessionId, files: tokenMap };
    this.emit('prepare-upload', { sessionId, fileCount: files.size });
    this.sendJson(res, 200, response);
  }

  private async handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');
    const fileId = url.searchParams.get('fileId');
    const token = url.searchParams.get('token');

    if (!sessionId || !fileId || !token) {
      throw new RequestError(400, 'Missing sessionId, fileId, or token');
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.cleanupSession(sessionId, true);
      throw new RequestError(403, 'Invalid or expired session');
    }

    const fileEntry = session.files.get(fileId);
    if (!fileEntry || fileEntry.token !== token) throw new RequestError(403, 'Invalid file token');
    if (fileEntry.received || fileEntry.active) throw new RequestError(409, 'File upload is already active or complete');
    if (this.activeUploads >= this.maxConcurrentUploads) {
      throw new RequestError(503, 'Too many concurrent uploads');
    }

    const contentLength = parseContentLength(req.headers['content-length']);
    if (contentLength !== null && contentLength > fileEntry.meta.size) {
      throw new RequestError(413, 'Upload exceeds the declared file size');
    }

    const tempPath = join(session.tempDir, fileEntry.tempName);
    const finalPath = join(this.receiveDir, fileEntry.meta.fileName);
    const hasher = createHash('sha256');
    let received = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > fileEntry.meta.size) {
          callback(new RequestError(413, 'Upload exceeds the declared file size'));
          return;
        }
        hasher.update(chunk);
        callback(null, chunk);
      },
    });
    const writeStream = createWriteStream(tempPath, { flags: 'wx' });
    fileEntry.active = true;
    fileEntry.request = req;
    fileEntry.writeStream = writeStream;
    this.activeUploads += 1;

    try {
      await pipeline(req, limiter, writeStream);
      if (received !== fileEntry.meta.size) {
        throw new RequestError(422, 'Upload size does not match the declared file size');
      }
      const hash = hasher.digest('hex');
      if (fileEntry.meta.sha256 && hash !== fileEntry.meta.sha256) {
        throw new RequestError(422, 'SHA-256 mismatch');
      }

      try {
        linkSync(tempPath, finalPath);
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new RequestError(409, 'A file with this name already exists');
        }
        throw error;
      }
      rmSync(tempPath, { force: true });
      fileEntry.received = true;
      this.emit('file-received', { sessionId, fileId, fileName: fileEntry.meta.fileName, path: finalPath });
      this.sendJson(res, 200, { success: true });

      const allReceived = Array.from(session.files.values()).every((file) => file.received);
      if (allReceived) {
        this.emit('session-complete', { sessionId });
        this.cleanupSession(sessionId, false);
      }
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    } finally {
      fileEntry.active = false;
      fileEntry.request = null;
      fileEntry.writeStream = null;
      this.activeUploads -= 1;
    }
  }

  private handleCancel(res: http.ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      this.cleanupSession(sessionId, true);
      this.emit('cancel', { sessionId });
    }
    this.sendJson(res, 200, {});
  }

  private validatePrepareUpload(value: unknown): Array<[string, LocalSendFileMetadata]> {
    if (!isRecord(value) || !isRecord(value.files) || Array.isArray(value.files)) {
      throw new RequestError(400, 'Invalid upload manifest');
    }
    const rawEntries = Object.entries(value.files);
    if (rawEntries.length === 0 || rawEntries.length > this.maxFilesPerSession) {
      throw new RequestError(400, 'Upload manifest has an invalid file count');
    }

    let totalSize = 0;
    const entries: Array<[string, LocalSendFileMetadata]> = [];
    for (const [fileId, rawMeta] of rawEntries) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(fileId) || !isRecord(rawMeta)) {
        throw new RequestError(400, 'Upload manifest contains an invalid file ID');
      }
      if (rawMeta.id !== fileId) throw new RequestError(400, 'File metadata ID does not match its key');
      const fileName = validateFileName(rawMeta.fileName);
      const size = rawMeta.size;
      if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > this.maxFileSizeBytes) {
        throw new RequestError(400, 'Upload manifest contains an invalid file size');
      }
      totalSize += size as number;
      if (!Number.isSafeInteger(totalSize) || totalSize > this.maxSessionSizeBytes) {
        throw new RequestError(400, 'Upload session exceeds the accepted size');
      }
      if (typeof rawMeta.fileType !== 'string' || rawMeta.fileType.length === 0 || rawMeta.fileType.length > 128) {
        throw new RequestError(400, 'Upload manifest contains an invalid file type');
      }
      if (rawMeta.sha256 !== undefined
        && (typeof rawMeta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(rawMeta.sha256))) {
        throw new RequestError(400, 'Upload manifest contains an invalid SHA-256');
      }
      entries.push([fileId, {
        id: fileId,
        fileName,
        size: size as number,
        fileType: rawMeta.fileType,
        ...(typeof rawMeta.sha256 === 'string' ? { sha256: rawMeta.sha256.toLowerCase() } : {}),
      }]);
    }
    return entries;
  }

  private cleanupSession(sessionId: string, abortActive: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    if (abortActive) {
      for (const file of session.files.values()) {
        file.request?.destroy(new Error('LocalSend upload session ended'));
        file.writeStream?.destroy(new Error('LocalSend upload session ended'));
      }
    }
    try {
      rmSync(session.tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error: unknown) {
      this.emit('cleanup-error', { sessionId, path: session.tempDir, error });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const declaredLength = parseContentLength(req.headers['content-length']);
      if (declaredLength !== null && declaredLength > this.requestBodyLimitBytes) {
        req.resume();
        reject(new RequestError(413, 'Request body exceeds the accepted limit'));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const onData = (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > this.requestBodyLimitBytes) {
          settled = true;
          req.removeListener('data', onData);
          req.resume();
          reject(new RequestError(413, 'Request body exceeds the accepted limit'));
          return;
        }
        chunks.push(chunk);
      };
      req.on('data', onData);
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, received));
      });
      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private handleRequestError(res: http.ServerResponse, error: unknown): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    const statusCode = error instanceof RequestError ? error.statusCode : 500;
    const message = error instanceof RequestError ? error.message : 'Request failed';
    this.sendJson(res, statusCode, { error: message });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

function validateFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new RequestError(400, 'Upload manifest contains an invalid file name');
  }
  if (value === '.' || value === '..' || isAbsolute(value) || win32.isAbsolute(value)
    || value.includes('/') || value.includes('\\') || /[\x00-\x1f<>:"|?*]/u.test(value)
    || value.endsWith('.') || value.endsWith(' ')) {
    throw new RequestError(400, 'Upload manifest contains an unsafe file name');
  }
  const windowsBaseName = value.split('.')[0]?.toUpperCase();
  if (windowsBaseName && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsBaseName)) {
    throw new RequestError(400, 'Upload manifest contains an unsafe file name');
  }
  return value;
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RequestError(400, 'Invalid Content-Length');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RequestError(400, 'Invalid Content-Length');
  return parsed;
}

function positiveIntegerOption(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
