/**
 * Zero-dependency WebDAV Client built strictly with node:http and node:https.
 * Supports PROPFIND, GET, PUT (with Range), DELETE, MKCOL, MOVE, COPY,
 * Basic / Bearer Auth, and self-signed TLS certificates.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Buffer } from 'node:buffer';

export interface WebDavAuth {
  username?: string | undefined;
  password?: string | undefined;
  bearerToken?: string | undefined;
}

export interface WebDavClientOptions {
  baseUrl: string;
  auth?: WebDavAuth | undefined;
  rejectUnauthorized?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

export interface WebDavItem {
  href: string;
  isCollection: boolean;
  contentLength?: number | undefined;
  lastModified?: string | undefined;
  contentType?: string | undefined;
}

export interface WebDavResponse<T = unknown> {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  data: T;
}

export class WebDavClient {
  readonly baseUrl: URL;
  readonly auth?: WebDavAuth | undefined;
  readonly rejectUnauthorized: boolean;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;

  constructor(options: WebDavClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required');
    this.baseUrl = new URL(options.baseUrl);
    this.auth = options.auth;
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new TypeError('maxResponseBytes must be a positive safe integer');
    }
  }

  async propfind(remotePath = '/', depth: '0' | '1' | 'infinity' = '1'): Promise<WebDavResponse<WebDavItem[]>> {
    const xmlBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`;

    const res = await this.request({
      method: 'PROPFIND',
      path: remotePath,
      headers: {
        Depth: depth,
        'Content-Type': 'application/xml; charset="utf-8"',
      },
      body: xmlBody,
    });

    const items = parseMultiStatusXml(String(res.data));
    return {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      headers: res.headers,
      data: items,
    };
  }

  async get(remotePath: string, range?: { start: number; end?: number }): Promise<WebDavResponse<Buffer>> {
    const headers: Record<string, string> = {};
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end ?? ''}`;
    }

    return this.request<Buffer>({
      method: 'GET',
      path: remotePath,
      headers,
      responseType: 'buffer',
    });
  }

  async put(remotePath: string, data: Buffer | Uint8Array | string | Readable): Promise<WebDavResponse<void>> {
    return this.request<void>({
      method: 'PUT',
      path: remotePath,
      body: data,
    });
  }

  async mkcol(remotePath: string): Promise<WebDavResponse<void>> {
    return this.request<void>({
      method: 'MKCOL',
      path: remotePath,
    });
  }

  async delete(remotePath: string): Promise<WebDavResponse<void>> {
    return this.request<void>({
      method: 'DELETE',
      path: remotePath,
    });
  }

  async move(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse<void>> {
    const destUrl = new URL(destinationPath, this.baseUrl).toString();
    return this.request<void>({
      method: 'MOVE',
      path: sourcePath,
      headers: {
        Destination: destUrl,
        Overwrite: overwrite ? 'T' : 'F',
      },
    });
  }

  async copy(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse<void>> {
    const destUrl = new URL(destinationPath, this.baseUrl).toString();
    return this.request<void>({
      method: 'COPY',
      path: sourcePath,
      headers: {
        Destination: destUrl,
        Overwrite: overwrite ? 'T' : 'F',
      },
    });
  }

  private request<T = string>(options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | Uint8Array | string | Readable;
    responseType?: 'string' | 'buffer';
  }): Promise<WebDavResponse<T>> {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(options.path, this.baseUrl);
      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers: http.OutgoingHttpHeaders = {
        'User-Agent': 'NearbyTransfer-WebDAV/0.2.0',
        ...options.headers,
      };

      if (this.auth) {
        if (this.auth.bearerToken) {
          headers.Authorization = `Bearer ${this.auth.bearerToken}`;
        } else if (this.auth.username && this.auth.password) {
          const creds = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64');
          headers.Authorization = `Basic ${creds}`;
        }
      }

      const reqOptions: https.RequestOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        method: options.method,
        path: targetUrl.pathname + targetUrl.search,
        headers,
        rejectUnauthorized: this.rejectUnauthorized,
        timeout: this.timeoutMs,
      };

      let settled = false;
      let bodyDone = false;
      let responseDone = false;
      let responseResult: WebDavResponse<T> | undefined;
      const bodyStream = options.body instanceof Readable ? options.body : undefined;
      let req: http.ClientRequest;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (bodyStream && !bodyStream.destroyed) bodyStream.destroy(error);
        if (req && !req.destroyed) req.destroy(error);
        reject(error);
      };
      const finish = () => {
        if (!settled && bodyDone && responseDone && responseResult) {
          settled = true;
          resolve(responseResult);
        }
      };

      req = transport.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        res.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > this.maxResponseBytes) {
            const error = new Error(`WebDAV response exceeds ${this.maxResponseBytes} bytes`);
            fail(error);
            res.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('WebDAV response was aborted')));
        res.on('end', () => {
          if (settled) return;
          const fullBuf = Buffer.concat(chunks);
          const data = options.responseType === 'buffer' ? fullBuf : fullBuf.toString('utf8');

          responseResult = {
            statusCode: res.statusCode || 0,
            statusMessage: res.statusMessage || '',
            headers: res.headers,
            data: data as unknown as T,
          };
          responseDone = true;
          finish();
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`WebDAV request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', fail);

      if (bodyStream) {
        pipeline(bodyStream, req).then(() => {
          bodyDone = true;
          finish();
        }, fail);
      } else if (options.body !== undefined) {
        req.end(options.body, () => {
          bodyDone = true;
          finish();
        });
      } else {
        req.end(() => {
          bodyDone = true;
          finish();
        });
      }
    });
  }
}

/**
 * Lightweight XML parser for WebDAV 207 Multi-Status responses.
 */
function parseMultiStatusXml(xml: string): WebDavItem[] {
  const items: WebDavItem[] = [];
  const responseRegex = /<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let match: RegExpExecArray | null;

  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const hrefMatch = /<(?:\w+:)?href>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(block);
    if (!hrefMatch) continue;

    const href = hrefMatch[1]!.trim();
    const isCollection = /<(?:\w+:)?collection\s*\/>/i.test(block) || /<(?:\w+:)?resourcetype>[\s\S]*?<(?:\w+:)?collection[\s\S]*?<\/(?:\w+:)?resourcetype>/i.test(block);

    const lengthMatch = /<(?:\w+:)?getcontentlength>(\d+)<\/(?:\w+:)?getcontentlength>/i.exec(block);
    const lastModifiedMatch = /<(?:\w+:)?getlastmodified>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/i.exec(block);
    const contentTypeMatch = /<(?:\w+:)?getcontenttype>([\s\S]*?)<\/(?:\w+:)?getcontenttype>/i.exec(block);

    items.push({
      href,
      isCollection,
      contentLength: lengthMatch ? parseInt(lengthMatch[1]!, 10) : undefined,
      lastModified: lastModifiedMatch ? lastModifiedMatch[1]!.trim() : undefined,
      contentType: contentTypeMatch ? contentTypeMatch[1]!.trim() : undefined,
    });
  }

  return items;
}
