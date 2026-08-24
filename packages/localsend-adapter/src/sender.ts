/**
 * LocalSend HTTP send client: sends files to a LocalSend receiver.
 *
 * Flow: POST /prepare-upload (metadata) → POST /upload (binary, per file) → POST /cancel (on error)
 */

import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
}

export interface SendResult {
  sessionId: string;
  filesSent: number;
}

export async function sendFiles(opts: SendOptions): Promise<SendResult> {
  const { device, files, senderInfo, pin, onProgress } = opts;

  // 1. Prepare upload
  const fileMap: Record<string, LocalSendFileMetadata> = {};
  for (const file of files) {
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

  const prepareRes = await httpPost(prepareUrl, JSON.stringify(prepareReq), device.protocol);
  if (prepareRes.status !== 200) {
    throw new Error(`prepare-upload failed: ${prepareRes.status} ${prepareRes.body}`);
  }

  const prepareData = JSON.parse(prepareRes.body) as LocalSendPrepareUploadResponse;
  const sessionId = prepareData.sessionId;
  const tokens = prepareData.files;

  // 2. Upload each file
  let filesSent = 0;
  for (const file of files) {
    const token = tokens[file.id];
    if (!token) throw new Error(`No token for file ${file.id}`);

    const uploadUrl = `${device.protocol}://${device.host}:${device.port}${LOCALSEND_API_PREFIX}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(file.id)}&token=${encodeURIComponent(token)}`;
    const fileData = readFileSync(file.filePath);
    const uploadRes = await httpPost(uploadUrl, fileData, device.protocol, 'application/octet-stream');

    if (uploadRes.status !== 200) {
      // Cancel on failure
      const cancelUrl = `${device.protocol}://${device.host}:${device.port}${LOCALSEND_API_PREFIX}/cancel?sessionId=${encodeURIComponent(sessionId)}`;
      await httpPost(cancelUrl, '', device.protocol).catch(() => {});
      throw new Error(`upload failed for ${file.fileName}: ${uploadRes.status} ${uploadRes.body}`);
    }

    filesSent += 1;
    if (onProgress) onProgress(file.id, file.fileName, file.size, file.size);
  }

  return { sessionId, filesSent };
}

/** Build a SendFileSpec from a local file path. */
export function buildFileSpec(filePath: string, id?: string): SendFileSpec {
  const stat = statSync(filePath);
  const fileName = filePath.split('/').pop()!.split('\\').pop()!;
  const data = readFileSync(filePath);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return {
    id: id ?? randomUUID(),
    fileName,
    filePath,
    size: stat.size,
    sha256,
    fileType: 'file',
  };
}

interface HttpResponse {
  status: number;
  body: string;
}

function httpPost(url: string, body: string | Buffer, protocol: 'http' | 'https', contentType?: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Length': bodyBuffer.length.toString(),
        ...(contentType ? { 'Content-Type': contentType } : { 'Content-Type': 'application/json' }),
      },
      ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
    };

    const transport = protocol === 'https' ? https : http;
    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });

    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}
