// Drives the real relay process: an allowlisted feed host whose DNS flips to a
// private address after a good body was cached, concurrent followers, the
// negative cache, a mixed public/private answer set, the body cap, every
// redirect hop shape, and the request headers an edge requires before it
// answers. The relay is spawned with a transport shim
// (tests/_lib/ais-relay-rss-ssrf-preload.cjs) so no real DNS or network is used.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const preload = fileURLToPath(new URL('./_lib/ais-relay-rss-ssrf-preload.cjs', import.meta.url));
const TARGET = 'feeds.bbci.co.uk';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('relay did not answer')); });
    req.on('error', reject);
  });
}

function waitFor(predicate, description, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout: ${description}`)); }
    }, 20);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startRelay(t, upstreamPort, ctl) {
  const ws = http.createServer((_req, res) => { res.writeHead(429); res.end(); });
  const wsPort = await listen(ws);
  t.after(() => new Promise((resolve) => ws.close(resolve)));

  const child = spawn(process.execPath, ['--require', preload, relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${wsPort}/stream`,
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
      RELAY_TEST_RSS_CACHE_TTL_MS: '50',
      RSS_TEST_TARGET: TARGET,
      RSS_TEST_LOCAL_PORT: String(upstreamPort),
      RSS_TEST_CTL: ctl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const log = { text: '' };
  child.stdout.on('data', (chunk) => { log.text += chunk; });
  child.stderr.on('data', (chunk) => { log.text += chunk; });
  await waitFor(() => log.text.includes('WebSocket relay on port'), 'relay startup');
  const port = Number(log.text.match(/WebSocket relay on port (\d+)/)[1]);
  return { child, port, log };
}

const feed = (pathname) => `/rss?url=${encodeURIComponent(`http://${TARGET}${pathname}`)}`;

test('relay /rss: a blocked DNS answer is a terminal 403 for every caller and nothing stale leaks', async (t) => {
  const ctl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rss-ssrf-')), 'mode');
  fs.writeFileSync(ctl, 'reroute');
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    if (req.url === '/good') {
      res.writeHead(200, { 'Content-Type': 'application/xml', Connection: 'close' });
      return res.end('<rss><channel><title>ok</title></channel></rss>');
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      const chunk = Buffer.alloc(256 * 1024, 'a');
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => {});
      return pump();
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { child, port, log } = await startRelay(t, upstreamPort, ctl);

  const seed = await get(port, feed('/good'));
  assert.equal(seed.status, 200);
  assert.equal(seed.headers['x-cache'], 'MISS');
  const hitsAfterSeed = upstreamHits;
  await sleep(120);

  fs.writeFileSync(ctl, 'private');
  const [first, follower] = await Promise.all([get(port, feed('/good')), get(port, feed('/good'))]);
  assert.equal(first.status, 403);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['cdn-cache-control'], 'no-store');
  assert.equal(follower.status, 403);
  assert.ok(!first.body.includes('<rss') && !follower.body.includes('<rss'), 'the cached body must not leak');

  const later = await get(port, feed('/good'));
  assert.equal(later.status, 403, 'a caller inside the negative TTL gets the 403 without a lookup');
  assert.ok(!later.body.includes('<rss'));
  assert.ok(!log.text.includes('BACKOFF-STALE'), 'a block must not enter backoff');
  assert.equal(upstreamHits, hitsAfterSeed, 'the upstream is never contacted on a blocked answer');

  fs.writeFileSync(ctl, 'mixed');
  const mixed = await get(port, feed('/good?v=2'));
  assert.equal(mixed.status, 403, 'one private answer in a mixed set blocks the fetch');

  fs.writeFileSync(ctl, 'reroute');
  const big = await get(port, feed('/big'));
  assert.equal(big.status, 502);
  assert.match(big.body, /Feed too large/);
  const health = await get(port, '/health');
  assert.equal(child.exitCode, null, 'the relay survives the body cap');
  assert.equal(health.status, 200);
  const suspicious = log.text.split('\n').filter((line) => /ERR_HTTP_HEADERS_SENT|Unhandled|uncaught|TypeError|write after end/i.test(line));
  assert.deepEqual(suspicious, []);
});

test('relay /rss: redirect hops are gated and a malformed Location cannot exit the relay', async (t) => {
  const ctl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rss-ssrf-')), 'mode');
  fs.writeFileSync(ctl, 'reroute');
  const upstream = http.createServer((req, res) => {
    const headers = { Connection: 'close' };
    if (req.url === '/ftp') { res.writeHead(302, { ...headers, Location: `ftp://${TARGET}/x` }); return res.end(); }
    if (req.url === '/js') { res.writeHead(302, { ...headers, Location: 'javascript:alert(1)' }); return res.end(); }
    if (req.url === '/httpx') { res.writeHead(302, { ...headers, Location: 'httpx://10.0.0.5/x' }); return res.end(); }
    if (req.url === '/elsewhere') { res.writeHead(302, { ...headers, Location: 'http://169.254.169.254/latest' }); return res.end(); }
    if (req.url === '/rel') { res.writeHead(302, { ...headers, Location: '/good' }); return res.end(); }
    if (req.url === '/bad') { res.writeHead(302, { ...headers, Location: 'http://[bad' }); return res.end(); }
    if (req.url === '/good') { res.writeHead(200, { ...headers, 'Content-Type': 'application/xml' }); return res.end('<rss/>'); }
    res.writeHead(404, headers);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { child, port, log } = await startRelay(t, upstreamPort, ctl);

  const initialFtp = await get(port, `/rss?url=${encodeURIComponent(`ftp://${TARGET}/x`)}`);
  assert.equal(initialFtp.status, 403, 'the initial URL is protocol gated');

  for (const hop of ['/ftp', '/js', '/httpx', '/elsewhere']) {
    const res = await get(port, feed(hop));
    assert.equal(res.status, 403, `redirect to ${hop} target must be refused`);
    await sleep(80);
  }

  const relative = await get(port, feed('/rel'));
  assert.equal(relative.status, 200, 'a relative Location resolves against the hop and is followed');
  assert.match(relative.body, /<rss\/>/);

  const malformed = await get(port, feed('/bad'));
  assert.equal(malformed.status, 502);
  assert.match(malformed.body, /Malformed redirect/);
  const health = await get(port, '/health');
  assert.equal(child.exitCode, null, 'a malformed Location must not exit the relay');
  assert.equal(health.status, 200);
  assert.ok(!/Invalid URL|uncaught/i.test(log.text));
});

// Smartraveller's Akamai edge completes TLS and then never answers a request
// that carries no Accept-Encoding header (measured 2026-10-23: 100 s with no
// response; any Accept-Encoding value answers in under a second). The relay's
// Railway logs showed `read ETIMEDOUT` about 11 s after every Smartraveller
// miss, and the advisory seed stored no Australian item from at least
// 2026-09-23. This upstream reproduces that edge.
test('relay /rss: an edge that stalls without Accept-Encoding gets one and the gzip body is decoded', async (t) => {
  const ctl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rss-ssrf-')), 'mode');
  fs.writeFileSync(ctl, 'reroute');
  const fixture = fs.readFileSync(new URL('./fixtures/smartraveller-advisories-2026-10-23.rss', import.meta.url));
  const seen = [];
  const stalled = new Set();
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers['accept-encoding']);
    if (!req.headers['accept-encoding']) { stalled.add(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Encoding': 'gzip', Connection: 'close' });
    res.end(zlib.gzipSync(fixture));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => {
    for (const res of stalled) res.destroy();
    upstream.close(resolve);
  }));
  const { port } = await startRelay(t, upstreamPort, ctl);

  const res = await get(port, feed('/countries/documents/index.rss'));
  assert.match(String(seen[0]), /\bgzip\b/, 'the relay must send Accept-Encoding upstream');
  assert.equal(res.status, 200);
  assert.equal(res.body, fixture.toString('utf8'), 'the relay serves the decoded feed');
});
