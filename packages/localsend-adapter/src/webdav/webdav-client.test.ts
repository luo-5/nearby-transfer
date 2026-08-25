import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { WebDavClient } from './webdav-client.ts';

describe('WebDavClient', () => {
  let server: http.Server;
  let port: number;
  let lastRequest: { method?: string; url?: string; headers?: http.IncomingHttpHeaders; body?: string };

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        if (req.method === 'PROPFIND') {
          res.writeHead(207, { 'Content-Type': 'application/xml; charset="utf-8"' });
          res.end(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/remote.php/dav/files/user/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/remote.php/dav/files/user/test.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>1024</D:getcontentlength>
        <D:getcontenttype>text/plain</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`);
          return;
        }

        if (req.method === 'GET') {
          if (req.headers.range) {
            res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-4/10' });
            res.end('hello');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('full content');
          }
          return;
        }

        if (req.method === 'PUT' || req.method === 'MKCOL' || req.method === 'DELETE' || req.method === 'MOVE' || req.method === 'COPY') {
          res.writeHead(201, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as import('node:net').AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('performs PROPFIND and parses multi-status response', async () => {
    const client = new WebDavClient({
      baseUrl: `http://127.0.0.1:${port}/remote.php/dav/files/user/`,
      auth: { username: 'admin', password: 'password123' },
    });

    const res = await client.propfind('/', '1');
    assert.equal(res.statusCode, 207);
    assert.equal(lastRequest.method, 'PROPFIND');
    assert.equal(lastRequest.headers!['depth'], '1');
    assert.ok(lastRequest.headers!['authorization']?.startsWith('Basic '));

    assert.equal(res.data.length, 2);
    assert.equal(res.data[0]!.isCollection, true);
    assert.equal(res.data[1]!.isCollection, false);
    assert.equal(res.data[1]!.contentLength, 1024);
    assert.equal(res.data[1]!.contentType, 'text/plain');
  });

  it('supports GET with Range header', async () => {
    const client = new WebDavClient({
      baseUrl: `http://127.0.0.1:${port}/`,
    });

    const res = await client.get('/test.txt', { start: 0, end: 4 });
    assert.equal(res.statusCode, 206);
    assert.equal(lastRequest.headers!['range'], 'bytes=0-4');
    assert.equal(res.data.toString('utf8'), 'hello');
  });

  it('supports PUT, MKCOL, MOVE, DELETE', async () => {
    const client = new WebDavClient({
      baseUrl: `http://127.0.0.1:${port}/`,
      auth: { bearerToken: 'my-token' },
    });

    await client.mkcol('/newdir');
    assert.equal(lastRequest.method, 'MKCOL');
    assert.equal(lastRequest.headers!['authorization'], 'Bearer my-token');

    await client.put('/newdir/file.txt', Buffer.from('data'));
    assert.equal(lastRequest.method, 'PUT');
    assert.equal(lastRequest.body, 'data');

    await client.move('/newdir/file.txt', '/newdir/renamed.txt');
    assert.equal(lastRequest.method, 'MOVE');
    assert.ok(lastRequest.headers!['destination']?.includes('/newdir/renamed.txt'));

    await client.delete('/newdir');
    assert.equal(lastRequest.method, 'DELETE');
  });
});
