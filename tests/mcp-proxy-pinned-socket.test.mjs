// RUN WITH: `npm run test:data` OR `npx tsx --test tests/mcp-proxy-pinned-socket.test.mjs`.
//
// Real-socket proof for the GHSA-887j pin. tests/mcp-proxy.test.mjs shows
// (through a fake transport) that api/mcp-proxy.ts hands node:https a
// `lookup` hook answering the vetted address, a forced address family and a
// no-keepalive agent. This file shows Node honours exactly those options on
// a real TLS connection: the socket goes to the pinned address for a
// hostname that does not resolve at all, the hostname still drives SNI and
// certificate validation, and the connection is not kept alive for reuse.
//
// A throwaway self-signed certificate is generated with `openssl` (present
// on the CI runners and on every macOS/Linux dev box); the suite skips —
// loudly — only when the binary is missing.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTempDir } from './helpers/temp-dir.mjs';

process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';

// RFC 6761 reserves .test; nothing on the public DNS answers for it, so the
// only way a request for this name can reach our server is the pinned lookup.
const PINNED_HOSTNAME = 'pinned.example.test';

function generateSelfSignedCert(dir, hostname) {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', `/CN=${hostname}`,
    '-addext', `subjectAltName=DNS:${hostname}`,
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { error: result.error?.message ?? result.stderr };
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('api/mcp-proxy pinned upstream socket (real TLS)', () => {
  let tls = null;
  let skipReason = null;
  let server = null;
  let port = 0;
  let proxyTesting;
  const seen = [];

  before(async () => {
    proxyTesting = (await import('../api/mcp-proxy.ts')).__testing__;
    const dir = createTempDir('wm-mcp-proxy-pin-');
    const generated = generateSelfSignedCert(dir, PINNED_HOSTNAME);
    if (generated.error) {
      skipReason = `openssl could not generate the fixture certificate: ${generated.error}`;
      return;
    }
    tls = generated;
    server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      seen.push({
        remoteAddress: req.socket.remoteAddress,
        servername: req.socket.servername,
        host: req.headers.host,
        connection: req.headers.connection,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function pinnedOptions(overrides = {}) {
    return {
      hostname: PINNED_HOSTNAME,
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      family: 4,
      lookup: proxyTesting.pinnedLookup('127.0.0.1', 4),
      agent: proxyTesting.PINNED_UPSTREAM_AGENT,
      ca: tls?.cert,
      ...overrides,
    };
  }

  it('connects the TCP socket to the pinned address while SNI and certificate validation use the hostname', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const before = seen.length;

    const res = await request(pinnedOptions(), '{}');

    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":true}');
    const hit = seen[before];
    assert.ok(hit, 'the pinned request must have reached the local server');
    assert.equal(hit.remoteAddress, '127.0.0.1', 'socket must connect to the pinned address');
    assert.equal(hit.servername, PINNED_HOSTNAME, 'SNI must carry the original hostname, not the IP');
    assert.equal(hit.host, `${PINNED_HOSTNAME}:${port}`, 'Host header must be the original authority');
    assert.equal(hit.connection, 'close', 'PINNED_UPSTREAM_AGENT must not keep the socket alive for reuse');
  });

  it('cannot reach the server without the lookup hook — the address came from the pin, not from DNS', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const before = seen.length;

    await assert.rejects(request(pinnedOptions({
      lookup: undefined,
      family: undefined,
      signal: AbortSignal.timeout(5_000),
    }), '{}'));
    assert.equal(seen.length, before, 'an unpinned request for the reserved name must never arrive');
  });

  it('still rejects a certificate that does not match the hostname on a pinned socket', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const before = seen.length;

    await assert.rejects(
      request(pinnedOptions({ hostname: 'mismatch.example.test' }), '{}'),
      (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
    );
    assert.equal(seen.length, before, 'the handshake must fail before any request is served');
  });

  it('answers both net.connect lookup shapes with the pinned address only', () => {
    const lookup = proxyTesting.pinnedLookup('203.0.113.9', 4);
    let single;
    lookup('ignored.example', { family: 4 }, (error, address, family) => { single = { error, address, family }; });
    assert.deepEqual(single, { error: null, address: '203.0.113.9', family: 4 });

    let all;
    lookup('ignored.example', { all: true }, (error, addresses) => { all = { error, addresses }; });
    assert.deepEqual(all, { error: null, addresses: [{ address: '203.0.113.9', family: 4 }] });

    let bare;
    lookup('ignored.example', (error, address, family) => { bare = { error, address, family }; });
    assert.deepEqual(bare, { error: null, address: '203.0.113.9', family: 4 });
  });
});
