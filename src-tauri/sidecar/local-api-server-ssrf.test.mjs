import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Keep the local test client outside the sidecar's global fetch interception.
const localFetch = globalThis.fetch;
const { createLocalApiServer } = await import('./local-api-server.mjs');
const blockedAddresses = [
  '::1', '0:0:0:0:0:0:0:1', '0000:0:0::0001', '::0.0.0.1',
  '::', '0:0:0:0:0:0:0:0', '0000::0000', '::0.0.0.0',
  '::ffff:127.0.0.1', '0:0:0:0:0:ffff:127.0.0.1',
  '0000:0000:0000:0000:0000:FFFF:7F00:0001', '::ffff:7f00:1',
  '::ffff:a00:1', '::ffff:ac10:1', '::ffff:c0a8:101',
  '::ffff:a9fe:101', '::ffff:6440:1', '::ffff:c633:6401',
  'FC00::1', 'FDFF:0000:0000:0000:0000:0000:0000:0001',
  'FE80::1', 'FEBF:FFFF::1', 'FF02::1', 'FFFF:0:0:0:0:0:0:1',
];

async function sidecar(t, mode) {
  const apiDir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-ssrf-'));
  const token = 'synthetic-ssrf-test-token';
  const previousToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = token;
  t.after(() => {
    if (previousToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = previousToken;
  });
  const app = await createLocalApiServer({
    port: 0, apiDir, dataDir: apiDir, mode, cloudFallback: false,
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(async () => { await app.close(); await rm(apiDir, { recursive: true, force: true }); });
  const { port } = await app.start();
  return (url) => localFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function denyTransport(t) {
  const calls = [];
  for (const transport of [http, https]) {
    t.mock.method(transport, 'request', (options) => {
      calls.push(options);
      throw new Error('blocked address reached outbound transport');
    });
  }
  return calls;
}

function respondTransport(t, statusCode = 200, headers = {}) {
  const calls = [];
  for (const transport of [http, https]) {
    t.mock.method(transport, 'request', (options, callback) => {
      calls.push(options);
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.end = () => queueMicrotask(() => {
        const res = Object.assign(new EventEmitter(), { statusCode, statusMessage: 'Test', headers });
        callback(res);
        res.emit('data', Buffer.from('<rss/>'));
        res.emit('end');
      });
      return req;
    });
  }
  return calls;
}

for (const surface of ['global fetch', 'desktop-sidecar', 'docker']) {
  test(`${surface} blocks equivalent IPv6 literals and DNS answers before transport`, async (t) => {
    const rss = surface === 'global fetch' ? null : await sidecar(t, surface);
    let answers = [];
    t.mock.method(dns, 'resolve4', async () => []);
    t.mock.method(dns, 'resolve6', async () => answers);
    const calls = denyTransport(t);
    for (const address of blockedAddresses) {
      for (const protocol of ['http:', 'https:']) {
        for (const hostname of [`[${address}]`, 'feed.example']) {
          answers = [address];
          const url = `${protocol}//${hostname}/rss`;
          if (rss) {
            const response = await rss(url);
            assert.equal(response.status, 403, `${address}: ${url}`);
            assert.match((await response.json()).error, /localhost|private\/reserved/);
          } else {
            for (const input of [url, new URL(url), new Request(url)]) {
              await assert.rejects(fetch(input), { code: 'ERR_SSRF_BLOCKED' }, `${address}: ${url}`);
            }
          }
        }
      }
    }
    // One private answer rejects the whole hostname, even when IPv4 is public.
    t.mock.method(dns, 'resolve4', async () => ['93.184.216.34']);
    answers = ['2606:4700:4700::1111', '0:0:0:0:0:0:0:1'];
    if (rss) assert.equal((await rss('https://mixed.example/rss')).status, 403);
    else await assert.rejects(fetch('https://mixed.example/rss'), { code: 'ERR_SSRF_BLOCKED' });
    assert.equal(calls.length, 0);
  });

  test(`${surface} pins public addresses and does not follow redirects`, async (t) => {
    const rss = surface === 'global fetch' ? null : await sidecar(t, surface);
    const request = rss || fetch;
    const resolve4 = t.mock.method(dns, 'resolve4', async () => []);
    let address;
    const resolve6 = t.mock.method(dns, 'resolve6', async () => [address]);
    const calls = respondTransport(t);
    for (address of ['2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111',
      '::ffff:93.184.216.34', '0:0:0:0:0:FFFF:5DB8:D822']) {
      for (const protocol of ['http:', 'https:']) {
        const beforeDns = resolve6.mock.callCount();
        const beforeTransport = calls.length;
        const response = await request(`${protocol}//public.example/rss`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '<rss/>');
        assert.equal(calls.length, beforeTransport + 1);
        assert.equal(resolve6.mock.callCount(), beforeDns + 1);
        const options = calls.at(-1);
        assert.equal(options.family, 6);
        const pinned = await new Promise((resolve, reject) => options.lookup('public.example', { all: true },
          (error, records) => error ? reject(error) : resolve(records)));
        assert.equal(pinned[0].family, 6);
        assert.equal(new URL(`http://[${pinned[0].address}]/`).hostname, new URL(`http://[${address}]/`).hostname);
        if (protocol === 'https:') assert.equal(options.hostname, 'public.example');
        else if (rss) assert.equal(options.headers.Host, 'public.example');
      }
    }
    assert.equal(resolve4.mock.callCount(), resolve6.mock.callCount());
    for (const literal of ['93.184.216.34', '[2606:4700:4700::1111]', '[::ffff:93.184.216.34]']) {
      const beforeDns = resolve6.mock.callCount();
      assert.equal((await request(`https://${literal}/rss`)).status, 200);
      assert.equal(resolve6.mock.callCount(), beforeDns);
      assert.equal(calls.at(-1).family, literal.startsWith('[') ? 6 : 4);
    }
    // Redirect responses are returned, never chased by either transport path.
    const redirects = respondTransport(t, 302, { location: 'http://[0:0:0:0:0:0:0:1]/private' });
    for (const protocol of ['http:', 'https:']) {
      const before = redirects.length;
      assert.equal((await request(`${protocol}//public.example/rss`)).status, 302);
      assert.equal(redirects.length, before + 1);
    }
  });
}
