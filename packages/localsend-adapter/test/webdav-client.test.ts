import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { WebDavClient } from '../src/webdav/webdav-client.js';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

test('WebDAV PUT does not report success before its source stream finishes', async () => {
  let responseSent = false;
  const server = http.createServer((request, response) => {
    request.once('data', () => {
      responseSent = true;
      response.writeHead(200).end();
    });
  });
  const port = await listen(server);
  const source = Readable.from((async function* () {
    for (let index = 0; index < 128; index += 1) {
      yield Buffer.alloc(64 * 1024, index);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })());
  try {
    const client = new WebDavClient({ baseUrl: `http://127.0.0.1:${port}/` });
    await assert.rejects(() => client.put('/early.bin', source));
    assert.equal(responseSent, true);
    assert.equal(source.destroyed, true);
  } finally {
    await close(server);
  }
});

test('WebDAV client enforces its configured response limit', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.alloc(1025));
  });
  const port = await listen(server);
  try {
    const client = new WebDavClient({ baseUrl: `http://127.0.0.1:${port}/`, maxResponseBytes: 1024 });
    await assert.rejects(() => client.get('/large.bin'), /exceeds 1024 bytes/);
  } finally {
    await close(server);
  }
});
