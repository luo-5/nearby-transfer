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
import { mkdirSync, writeFileSync, existsSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  LOCALSEND_API_PREFIX,
  type LocalSendDeviceInfo,
  type LocalSendFileMetadata,
  type LocalSendPrepareUploadRequest,
  type LocalSendPrepareUploadResponse,
} from './types.js';

interface ActiveSession {
  sessionId: string;
  files: Map<string, { meta: LocalSendFileMetadata; token: string; received: boolean }>;
  tempDir: string;
}

export interface LocalSendReceiverOptions {
  port: number;
  alias: string;
  fingerprint: string;
  receiveDir: string;
  deviceModel?: string;
}

export class LocalSendReceiver extends EventEmitter {
  private server: http.Server | null = null;
  private sessions = new Map<string, ActiveSession>();
  private opts: LocalSendReceiverOptions;

  constructor(opts: LocalSendReceiverOptions) {
    super();
    this.opts = opts;
    mkdirSync(opts.receiveDir, { recursive: true });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.opts.port, '0.0.0.0', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
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

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    const method = req.method ?? '';

    if (url === `${LOCALSEND_API_PREFIX}/register` && method === 'POST') {
      this.handleRegister(req, res);
    } else if (url === `${LOCALSEND_API_PREFIX}/prepare-upload` && method === 'POST') {
      this.handlePrepareUpload(req, res);
    } else if (url.startsWith(`${LOCALSEND_API_PREFIX}/upload`) && method === 'POST') {
      this.handleUpload(req, res);
    } else if (url.startsWith(`${LOCALSEND_API_PREFIX}/cancel`) && method === 'POST') {
      this.handleCancel(req, res);
    } else if (url === `${LOCALSEND_API_PREFIX}/info` && method === 'GET') {
      this.sendJson(res, 200, this.getDeviceInfo());
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleRegister(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req).then((body) => {
      try {
        const info = JSON.parse(body.toString()) as LocalSendDeviceInfo;
        this.emit('register', info);
        this.sendJson(res, 200, this.getDeviceInfo());
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handlePrepareUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req).then((body) => {
      try {
        const request = JSON.parse(body.toString()) as LocalSendPrepareUploadRequest;
        const sessionId = randomUUID();
        const tempDir = join(this.opts.receiveDir, `.localsend-tmp-${sessionId}`);
        mkdirSync(tempDir, { recursive: true });

        const files = new Map<string, { meta: LocalSendFileMetadata; token: string; received: boolean }>();
        const tokenMap: Record<string, string> = {};
        for (const [fileId, meta] of Object.entries(request.files)) {
          const token = randomUUID();
          files.set(fileId, { meta, token, received: false });
          tokenMap[fileId] = token;
        }

        const session: ActiveSession = { sessionId, files, tempDir };
        this.sessions.set(sessionId, session);

        const response: LocalSendPrepareUploadResponse = { sessionId, files: tokenMap };
        this.emit('prepare-upload', { sessionId, fileCount: files.size });
        this.sendJson(res, 200, response);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  private handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');
    const fileId = url.searchParams.get('fileId');
    const token = url.searchParams.get('token');

    if (!sessionId || !fileId || !token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId, fileId, or token' }));
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }

    const fileEntry = session.files.get(fileId);
    if (!fileEntry || fileEntry.token !== token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid file token' }));
      return;
    }

    const tempPath = join(session.tempDir, fileId);
    const writeStream = createWriteStream(tempPath);
    const hasher = createHash('sha256');

    req.pipe(writeStream);
    req.on('data', (chunk: Buffer) => hasher.update(chunk));

    writeStream.on('close', () => {
      const hash = hasher.digest('hex');
      if (fileEntry.meta.sha256 && hash !== fileEntry.meta.sha256) {
        unlinkSync(tempPath);
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SHA-256 mismatch' }));
        return;
      }

      // Move to final destination
      const finalPath = join(this.opts.receiveDir, fileEntry.meta.fileName);
      renameSync(tempPath, finalPath);
      fileEntry.received = true;

      this.emit('file-received', { sessionId, fileId, fileName: fileEntry.meta.fileName, path: finalPath });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

      // Check if all files received
      const allReceived = Array.from(session.files.values()).every((f) => f.received);
      if (allReceived) {
        this.emit('session-complete', { sessionId });
        this.sessions.delete(sessionId);
      }
    });

    writeStream.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Write failed' }));
    });
  }

  private handleCancel(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(_req.url ?? '', `http://${_req.headers.host ?? 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.emit('cancel', { sessionId });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
