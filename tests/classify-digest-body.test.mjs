import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../scripts/lib/classify-digest-request.cjs');
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const start = source.indexOf('async function seedClassifyForVariant');
const end = source.indexOf('\nasync function seedClassify()', start);

function loadVariant(url, observedErrors, { timeoutMs, digests = [] } = {}) {
  const transport = { get(url, options, callback) {
    return http.get(url, { ...options, ...(timeoutMs ? { timeout: timeoutMs } : {}) }, response => {
      // Observe the transport error without letting the old reader crash the test process.
      response.on('error', error => observedErrors.push(error.code));
      callback(response);
    });
  } };
  const context = vm.createContext({
    ...helpers, http: transport, https: transport,
    buildClassifyDigestUrl: () => url,
    CLASSIFY_DIGEST_RETRY_DELAYS_MS: [],
    classifyDigestRetryDecision: () => ({ retry: false }),
    CHROME_UA: 'fixture', RELAY_API_KEY: '', console: { log() {}, warn() {} },
    setTimeout, clearTimeout,
    isStaleDigestReplay: () => false,
    xNewsAccounts: { collectXAlertCandidates: () => [] }, xState: { items: [] },
    RELAY_SOURCE_TIERS: {}, buildClassifyCandidateMap: digest => { digests.push(digest); return new Map(); },
  });
  vm.runInContext(source.slice(start, end), context);
  return context.seedClassifyForVariant;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('digest body did not settle')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

test('a truncated digest body settles as failure and a later invocation can succeed', async t => {
  let requests = 0;
  const server = http.createServer((_req, response) => {
    if (++requests === 1) {
      response.writeHead(200, { 'Content-Length': '1000' });
      response.write('{"categories":');
      setTimeout(() => response.destroy(), 20);
    } else {
      const body = Buffer.from('{"categories":{},"title":"Montréal"}');
      const split = body.indexOf(Buffer.from('é')) + 1;
      response.write(body.subarray(0, split));
      setTimeout(() => response.end(body.subarray(split)), 10);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const errors = [];
  const digests = [];
  const classify = loadVariant(`http://127.0.0.1:${server.address().port}/digest`, errors, { digests });
  const failed = await bounded(classify('full', new Set()));
  assert.equal(failed.fetchFailed, true);
  assert.ok(errors.includes('ECONNRESET'));
  const next = await bounded(classify('full', new Set()));
  assert.equal(next.fetchFailed, undefined);
  assert.equal(next.total, 0);
  assert.equal(requests, 2);
  assert.equal(digests[0].title, 'Montréal');
});

test('an idle body settles when the existing request timeout destroys the stream', async t => {
  const server = http.createServer((_req, response) => {
    response.writeHead(200);
    response.write('{"categories":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const errors = [];
  const classify = loadVariant(`http://127.0.0.1:${server.address().port}/digest`, errors, { timeoutMs: 30 });
  assert.equal((await bounded(classify('full', new Set()))).fetchFailed, true);
  assert.ok(errors.includes('ECONNRESET'));
});
