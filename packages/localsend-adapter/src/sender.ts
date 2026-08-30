/**
 * LocalSend HTTP send client: sends files to a LocalSend receiver.
 *
 * Flow: POST /prepare-upload (metadata) → POST /upload (binary, per file) → POST /cancel (on error)
 */

import http from 'node:http';
import https from 'node:https';
import { closeSync, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  LOCALSEND_API_PREFIX,
  type LocalSendDeviceInfo,
  type LocalSendFileMetadata,
  type LocalSendPrepareUploadRequest,
  type LocalSendPrepareUploadResponse,
  type LocalSendDevice,
} from './types.js';

export interface SendFileSpec {
  id: string;
  fileName: string;
  filePath: string;
  size: number;
  sha256?: string;
  fileType?: string;
}

export interface SendOptions {
  device: LocalSendDevice;
  files: SendFileSpec[];
  senderInfo: LocalSendDeviceInfo;
  pin?: string;
  onProgress?: (fileId: string, fileName: string, transferred: number, total: number) => void;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxResponseBodyBytes?: number;
}

export interface SendResult {
  sessionId: string;
  filesSent: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

export async function sendFiles(opts: SendOptions): Promise<SendResult> {
  const { device, files, senderInfo, pin, onProgress, signal } = opts;
  const requestLimits = {
    connectTimeoutMs: positiveInteger(opts.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
    idleTimeoutMs: positiveInteger(opts.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs'),
    maxResponseBodyBytes: positiveInteger(
      opts.maxResponseBodyBytes,
      DEFAULT_MAX_RESPONSE_BODY_BYTES,
      'maxResponseBodyBytes',
    ),
    signal,
  };
  validateSendTarget(device);
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('At least one file is required');
  const fileIds = new Set<string>();

  // 1. Prepare upload
  const fileMap = Object.create(null) as Record<string, LocalSendFileMetadata>;
  for (const file of files) {
    validateFileSpec(file);
    if (fileIds.has(file.id)) throw new TypeError(`Duplicate file ID: ${file.id}`);
    fileIds.add(file.id);
    fileMap[file.id] = {
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      fileType: file.fileType ?? 'file',
      ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
    };
  }

  const prepareReq: LocalSendPrepareUploadRequest = { info: senderInfo, files: fileMap };
  const pinParam = pin ? `?pin=${encodeURIComponent(pin)}` : '';
  const prepareUrl = `${device.protocol}://${device.host}:${device.port}${LOCALSEND_API_PREFIX}/prepare-upload${pinParam}`;

  const prepareRes = await postBuffer(
    prepareUrl,
    Buffer.from(JSON.stringify(prepareReq), 'utf8'),
    device,
    'application/json',
    requestLimits,
  );
  if (prepareRes.status === 204) return { sessionId: '', filesSent: 0 };
  if (prepareRes.status !== 200) {
    throw new Error(`prepare-upload failed: ${prepareRes.status} ${prepareRes.body}`);
  }

  const prepareData = parsePrepareResponse(prepareRes.body, fileIds);
  const sessionId = prepareData.sessionId;
  const tokens = prepareData.files;

  // 2. Upload each file
  let filesSent = 0;
  try {
    for (const file of files) {
      const token = tokens[file.id];
      // A missing token means this file was not accepted (partial acceptance).
      if (!token) continue;

      const uploadUrl = `${device.protocol}://${device.host}:${device.port}${LOCALSEND_API_PREFIX}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(file.id)}&token=${encodeURIComponent(token)}`;
      const uploadRes = await postFile(uploadUrl, file, device, requestLimits, onProgress);
      if (uploadRes.status !== 200) {
        throw new Error(`upload failed for ${file.fileName}: ${uploadRes.status} ${uploadRes.body}`);
      }
      filesSent += 1;
    }
  } catch (error) {
    const cancelUrl = `${device.protocol}://${device.host}:${device.port}${LOCALSEND_API_PREFIX}/cancel?sessionId=${encodeURIComponent(sessionId)}`;
    await postBuffer(cancelUrl, Buffer.alloc(0), device, 'application/json', requestLimits).catch(() => {});
    throw error;
  }

  return { sessionId, filesSent };
}

/** Build a SendFileSpec from a local file path. */
export function buildFileSpec(filePath: string, id?: string): SendFileSpec {
  const descriptor = openSync(filePath, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new TypeError('LocalSend source must be a regular file');
    const hasher = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytesReadTotal = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal !== stat.size) throw new Error('LocalSend source changed while it was hashed');
    return {
      id: id ?? randomUUID(),
      fileName: basename(filePath),
      filePath,
      size: stat.size,
      sha256: hasher.digest('hex'),
      fileType: 'file',
    };
  } finally {
    closeSync(descriptor);
  }
}

interface HttpResponse {
  status: number;
  body: string;
}

interface RequestLimits {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxResponseBodyBytes: number;
  signal: AbortSignal | undefined;
}

function postBuffer(
  url: string,
  body: Buffer,
  device: LocalSendDevice,
  contentType: string,
  limits: RequestLimits,
): Promise<HttpResponse> {
  return performPost(url, body.length, contentType, device, limits, (req) => {
    req.end(body);
  });
}

function postFile(
  url: string,
  file: SendFileSpec,
  device: LocalSendDevice,
  limits: RequestLimits,
  onProgress?: SendOptions['onProgress'],
): Promise<HttpResponse> {
  const stat = statSync(file.filePath);
  if (!stat.isFile() || stat.size !== file.size) {
    throw new Error(`LocalSend source changed before upload: ${file.fileName}`);
  }
  return performPost(url, file.size, 'application/octet-stream', device, limits, async (req) => {
    let transferred = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > file.size) {
          callback(new Error(`LocalSend source grew during upload: ${file.fileName}`));
          return;
        }
        onProgress?.(file.id, file.fileName, transferred, file.size);
        callback(null, chunk);
      },
    });
    await pipeline(createReadStream(file.filePath), progress, req);
    if (transferred !== file.size) {
      throw new Error(`LocalSend source changed during upload: ${file.fileName}`);
    }
  });
}

function performPost(
  url: string,
  contentLength: number,
  contentType: string,
  device: LocalSendDevice,
  limits: RequestLimits,
  writeBody: (req: http.ClientRequest) => void | Promise<void>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const expectedFingerprint = device.protocol === 'https'
      ? normalizeCertificateFingerprint(device.fingerprint)
      : null;
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Length': contentLength.toString(),
        'Content-Type': contentType,
      },
      agent: false,
      ...(device.protocol === 'https' ? { rejectUnauthorized: false } : {}),
    };

    const transport = device.protocol === 'https' ? https : http;
    let settled = false;
    let bodyStarted = false;
    let bodyWriterDone = false;
    let requestFinished = false;
    let responseResult: HttpResponse | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    const abortHandler = () => req.destroy(abortReason(limits.signal));
    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      limits.signal?.removeEventListener('abort', abortHandler);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const normalized = error instanceof Error ? error : new Error(String(error));
      req.destroy(normalized);
      reject(normalized);
    };
    const maybeResolve = () => {
      if (settled || !responseResult || !bodyWriterDone || !requestFinished) return;
      settled = true;
      cleanup();
      resolve(responseResult);
    };
    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      res.on('data', (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes > limits.maxResponseBodyBytes) {
          const error = new Error('LocalSend response exceeds the accepted limit');
          fail(error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('LocalSend response was aborted')));
      res.on('end', () => {
        if (settled) return;
        responseResult = { status: res.statusCode ?? 0, body: Buffer.concat(chunks, responseBytes).toString('utf8') };
        if (!requestFinished) {
          fail(new Error('LocalSend peer responded before the request body was fully sent'));
          return;
        }
        maybeResolve();
      });
    });

    req.on('error', fail);
    req.once('finish', () => {
      requestFinished = true;
      maybeResolve();
    });
    connectTimer = setTimeout(
      () => req.destroy(new Error('LocalSend connection timed out')),
      limits.connectTimeoutMs,
    );
    connectTimer.unref?.();
    if (limits.signal?.aborted) {
      req.destroy(abortReason(limits.signal));
      return;
    }
    limits.signal?.addEventListener('abort', abortHandler, { once: true });

    req.on('socket', (socket) => {
      const ready = () => {
        if (bodyStarted || settled) return;
        if (device.protocol === 'https') {
          try {
            assertPinnedCertificate(socket as import('node:tls').TLSSocket, expectedFingerprint!);
          } catch (error) {
            req.destroy(error as Error);
            return;
          }
        }
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        socket.setTimeout(limits.idleTimeoutMs, () => {
          req.destroy(new Error('LocalSend request was idle for too long'));
        });
        bodyStarted = true;
        Promise.resolve()
          .then(() => writeBody(req))
          .then(() => {
            bodyWriterDone = true;
            maybeResolve();
          })
          .catch(fail);
      };
      const event = device.protocol === 'https' ? 'secureConnect' : 'connect';
      if (!socket.connecting) queueMicrotask(ready);
      else socket.once(event, ready);
    });
  });
}

function parsePrepareResponse(body: string, requestedFileIds: Set<string>): LocalSendPrepareUploadResponse {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('prepare-upload returned invalid JSON');
  }
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || value.sessionId.length > 256 || !isRecord(value.files) || Array.isArray(value.files)) {
    throw new Error('prepare-upload returned an invalid response');
  }
  const files = Object.create(null) as Record<string, string>;
  for (const [fileId, token] of Object.entries(value.files)) {
    if (!requestedFileIds.has(fileId) || typeof token !== 'string' || token.length === 0 || token.length > 512) {
      throw new Error('prepare-upload returned an invalid file token map');
    }
    files[fileId] = token;
  }
  return { sessionId: value.sessionId, files };
}

function validateSendTarget(device: LocalSendDevice): void {
  if (!device || typeof device !== 'object') throw new TypeError('A LocalSend target device is required');
  if (device.protocol !== 'http' && device.protocol !== 'https') throw new TypeError('LocalSend protocol is invalid');
  if (typeof device.host !== 'string' || device.host.length === 0 || device.host.includes('\0')) {
    throw new TypeError('LocalSend host is invalid');
  }
  if (!Number.isSafeInteger(device.port) || device.port < 1 || device.port > 65535) {
    throw new TypeError('LocalSend port is invalid');
  }
  if (device.protocol === 'https') normalizeCertificateFingerprint(device.fingerprint);
}

function validateFileSpec(file: SendFileSpec): void {
  if (!file || typeof file !== 'object' || typeof file.id !== 'string' || file.id.length === 0
    || file.id.length > 256 || typeof file.fileName !== 'string' || file.fileName.length === 0
    || typeof file.filePath !== 'string' || file.filePath.length === 0
    || !Number.isSafeInteger(file.size) || file.size < 0
    || (file.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(file.sha256))) {
    throw new TypeError('LocalSend file specification is invalid');
  }
}

function normalizeCertificateFingerprint(value: string): string {
  if (typeof value !== 'string') throw new TypeError('LocalSend HTTPS certificate fingerprint is invalid');
  const normalized = value.replace(/[\s:-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError('LocalSend HTTPS certificate fingerprint is invalid');
  }
  return normalized;
}

function assertPinnedCertificate(socket: import('node:tls').TLSSocket, expectedFingerprint: string): void {
  const certificate = socket.getPeerCertificate();
  if (!certificate || !certificate.raw) throw new Error('LocalSend HTTPS peer did not provide a certificate');
  const actual = createHash('sha256').update(certificate.raw).digest();
  const expected = Buffer.from(expectedFingerprint, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('LocalSend HTTPS certificate fingerprint mismatch');
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${label} must be a positive integer`);
  return normalized;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('LocalSend request aborted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
