import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

// Execute the full startup and request handler with only external I/O mocked.
const source = readFileSync(new URL('../docker/redis-rest-proxy.mjs', import.meta.url), 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('process', 'http', 'crypto', 'createClient', 'console', source);

async function boot(token) {
  const calls = [];
  let handler;
  const env = token === undefined ? {} : { SRH_TOKEN: token };
  const client = {
    on() {},
    async connect() { calls.push('connect'); },
    async sendCommand(command) { calls.push(command); return 'PONG'; },
    // node-redis v4's transaction chain queues with addCommand and has NO
    // sendCommand — that is a client method. This stub used to answer both, so
    // it certified a /multi-exec call site that threw on every real request
    // (#8265). Mirror the real surface: a stub richer than the library hides
    // exactly this class of defect.
    multi() {
      const multi = {
        addCommand(command) { calls.push(command); return multi; },
        async exec() { calls.push('exec'); return []; },
      };
      return multi;
    },
  };
  const started = run({ env }, {
    createServer(callback) {
      handler = callback;
      return { listen(port, host) { calls.push(['listen', port, host]); } };
    },
  }, crypto, () => { calls.push('createClient'); return client; }, { log() {}, error() {}, warn() {} });
  return { calls, started, request: async (url, authorization) => {
    const response = { status: 200, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ method: 'GET', url, headers: { authorization } }, response);
    return response;
  } };
}

for (const token of [undefined, '', ' ', '\t', ' token', 'token ', 'to ken', 'token\n', 'token\r', 'token\x7f', '秘密']) {
  it(`rejects unusable configuration ${JSON.stringify(token)} before external I/O`, async () => {
    const app = await boot(token);
    await assert.rejects(app.started, /SRH_TOKEN must contain only visible ASCII/);
    assert.deepEqual(app.calls, []);
  });
}

it('requires authentication for welcome and health requests and keeps container binding', async () => {
  const token = 'a'.repeat(64);
  const app = await boot(token);
  await app.started;
  assert.deepEqual(app.calls, ['createClient', 'connect', ['listen', 80, '0.0.0.0']]);
  for (const path of ['/', '/ping']) {
    for (const header of [undefined, '', 'Basic abc', 'Bearer wrong', `Bearer ${'a'.repeat(63)}ÿ`]) {
      assert.equal((await app.request(path, header)).status, 401);
    }
    assert.equal((await app.request(path, `Bearer ${token}`)).status, 200);
  }
  assert.deepEqual(app.calls.filter(Array.isArray).slice(1), [['PING']]);
  for (const path of ['/FLUSHALL', '/CONFIG/GET/*', '/EVAL/return%201/0', '/EVALSHA/abc/0']) {
    assert.match((await app.request(path, `Bearer ${token}`)).body, /Command not allowed/);
  }
  assert.deepEqual(app.calls.filter(Array.isArray).slice(1), [['PING']]);
});

it('ships a required token and loopback-only host exposure', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const service = compose.slice(compose.indexOf('\n  redis-rest:\n'));
  assert.match(service, /SRH_TOKEN: "\$\{REDIS_TOKEN:\?/);
  assert.match(service, /ports:\s*\n\s*- "127\.0\.0\.1:8079:80"/);
  assert.match(compose, /UPSTASH_REDIS_REST_URL: "http:\/\/redis-rest:80"/);
});
