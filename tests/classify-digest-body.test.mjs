import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../scripts/lib/classify-digest-request.cjs');
const { reachesRealtimeRules, reachesLocalRules } = require('../scripts/lib/news-story-key.cjs');
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const start = source.indexOf('async function seedClassifyForVariant');
const end = source.indexOf('\nasync function seedClassify()', start);

function loadVariant(url, observedErrors, { timeoutMs, digests = [], pools = [], upstashGet = async () => null, upstashPipeline = async () => null, extra = {} } = {}) {
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
    AbortSignal, setTimeout, clearTimeout,
    isStaleDigestReplay: () => false,
    xNewsAccounts: { collectXAlertCandidates: () => [] }, xState: { items: [] },
    upstashGet, upstashPipeline,
    // #10977: publisher coverage and cross-wording checks add nothing here.
    readObservedPublishers: async () => new Map(), crossWordingFamilies: async () => new Map(),
    // #10976: a cached critical label goes through the publish path; by
    // default it scores 0 and publishes nothing.
    reachesRealtimeRules, reachesLocalRules, upstashSetNx: async () => true,
    shouldDropRelaySourceForTier: () => false, RELAY_GATES_READY: false, RELAY_TIER4_SOURCES: new Set(),
    relayComputeImportanceScore: () => 0, newsAlertClaimKey: () => '', NEWS_STORY_DEDUP_TTL_SECONDS: 86_400,
    matchCountryNamesInText: () => [], countriesNamedInHeadline: () => [],
    notifyPolicy: { primaryNewsCountryCode: () => null }, publishNotificationEvent: async () => {},
    RELAY_SOURCE_TIERS: {}, buildClassifyCandidateMap: (digest, _x, _v, _n, _r, _f, pool) => { digests.push(digest); pools.push(pool); return new Map(); },
    ...extra,
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

test('the alert pool drops operator-revoked URLs and is skipped when the set is unreadable (#10978)', async t => {
  const server = http.createServer((_req, response) => response.end('{"categories":{}}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/digest`;
  const pool = { items: [{ title: 'kept', link: 'https://example.com/a' }, { title: 'revoked', link: 'https://example.com/revoked' }] };
  const pools = [];
  const readable = loadVariant(url, [], { pools, upstashGet: async () => pool, upstashPipeline: async () => [{ result: ['https://example.com/revoked'] }, { result: null }] });
  await bounded(readable('full', new Set()));
  assert.deepEqual(Array.from(pools[0], item => item.title), ['kept']);
  const unreadable = loadVariant(url, [], { pools, upstashGet: async () => pool, upstashPipeline: async () => null });
  await bounded(unreadable('full', new Set()));
  assert.equal(pools[1].length, 0);
});

test('a pool headline keeps its own label per edition and stays out of the country threat summary (#10978)', async t => {
  const server = http.createServer((_req, response) => response.end('{"categories":{}}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/digest`;
  const candidates = () => new Map([
    ['Strike hits Iran port', {}],
    ['Tanker attacked off Oman', { fromPool: true }],
    ['Blast reported in Yemen', { fromPool: true }],
  ]);
  const labels = {
    'label:Strike hits Iran port': { level: 'critical', category: 'conflict' },
    'label:Tanker attacked off Oman:pool:full': { level: 'critical', category: 'conflict' },
    'label:Blast reported in Yemen:pool:full': { level: '_skip' },
  };
  const read = [];
  const written = [];
  const run = (stored) => loadVariant(url, [], { upstashPipeline: async commands => commands.map(() => ({ result: 'OK' })), extra: {
    buildClassifyCandidateMap: candidates,
    classifyCacheKey: title => `label:${title}`,
    upstashMGet: async keys => { read.push(...keys); return keys.map(key => stored[key] ?? null); },
    upstashSet: async key => { written.push(key); },
    upstashSetNx: async key => { written.push(key); },
    classifyFetchLlm: async () => null,
    threatSummaryCountries: title => [title.split(' ').at(-1)],
    CLASSIFY_VALID_LEVELS: ['critical', 'high', 'medium', 'low', 'info'],
    CLASSIFY_BATCH_SIZE: 50, CLASSIFY_SKIP_TTL: 1800,
  } })('full', new Set());

  const cachedPass = await bounded(run(labels));
  assert.deepEqual(read, ['label:Strike hits Iran port', 'label:Tanker attacked off Oman:pool:full', 'label:Blast reported in Yemen:pool:full']);
  assert.deepEqual(Object.keys(cachedPass.byCountry), ['port']);
  assert.equal(cachedPass.unlabelled, 0);

  const unansweredPass = await bounded(run({}));
  assert.deepEqual(written, read.slice(0, 3));
  assert.equal(unansweredPass.unlabelled, 1);
});

test('the first read of an edition\'s pool is a backlog that never alerts, and headlines after it do (#10978)', async t => {
  const server = http.createServer((_req, response) => response.end('{"categories":{}}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/digest`;
  const warmKey = 'classify:alert-pool-warm:v2:full';
  const critical = async chunk => chunk.map((_t, i) => ({ i, l: 'critical', c: 'conflict' }));
  const pass = async (store, titles, { classifyFetchLlm = critical, markerWrites = true, labelWrites = true } = {}) => {
    const published = [];
    await bounded(loadVariant(url, [], {
      upstashGet: async () => ({ items: titles.map(title => ({ title })) }),
      upstashPipeline: async commands => commands.map(([command, key, value]) => {
        if (command === 'SMEMBERS') return { result: [] };
        if (command === 'GET') return { result: store.get(key) ?? null };
        if (!markerWrites) return { error: 'ERR write refused' };
        store.set(key, value);
        return { result: 'OK' };
      }),
      extra: {
        buildClassifyCandidateMap: () => new Map(titles.map(title => [title, { source: 'Reuters', publishedAt: Date.now(), corroborationCount: 1, link: '', fromPool: true }])),
        classifyCacheKey: title => `label:${title}`,
        upstashMGet: async keys => keys.map(key => store.get(key) ?? null),
        upstashSet: async (key, value) => { if (labelWrites) store.set(key, JSON.stringify(value)); return labelWrites; },
        upstashSetNx: async (key, value) => { if (!labelWrites || store.has(key)) return false; store.set(key, JSON.stringify(value)); return true; },
        classifyFetchLlm,
        publishNotificationEvent: async event => { published.push(event.payload.title); },
        threatSummaryCountries: () => [], matchCountryNamesInText: () => [], countriesNamedInHeadline: () => [],
        notifyPolicy: { primaryNewsCountryCode: () => null },
        shouldDropRelaySourceForTier: () => false, RELAY_GATES_READY: false, RELAY_TIER4_SOURCES: new Set(), RELAY_RECENCY_MS: 900_000,
        // A story key, so a cached critical label re-publishes unless it is backlog (#10976).
        relayComputeImportanceScore: () => 88, newsAlertClaimKey: () => 'news-story:realtime:x', NEWS_STORY_DEDUP_TTL_SECONDS: 86_400,
        recordAlertLatency() {}, alertLatency: () => ({}), observeJevShadow: async () => null,
        CLASSIFY_VALID_LEVELS: ['critical', 'high', 'medium', 'low', 'info'], CLASSIFY_VALID_CATEGORIES: ['conflict'],
        CLASSIFY_BATCH_SIZE: 50, CLASSIFY_SKIP_TTL: 1800, CLASSIFY_CACHE_TTL: 86_400,
      },
    })('full', new Set()));
    return published;
  };
  const backlog = 'Backlog strike closes strait';
  const fresh = 'New strike closes strait';

  const store = new Map();
  assert.deepEqual(await pass(store, [backlog]), []);
  assert.ok(store.has(`label:${backlog}:pool:full`));
  assert.ok(store.has(warmKey));
  assert.deepEqual(await pass(store, [backlog, fresh]), [fresh]);
  const aged = JSON.parse(store.get(warmKey));
  aged.recordedAt -= 7 * 3_600_000;
  store.set(warmKey, JSON.stringify(aged));
  store.delete(`label:${backlog}:pool:full`);
  assert.deepEqual(await pass(store, [backlog]), [backlog], 'a backlog headline reused after the pool window alerts');

  const unanswered = new Map();
  assert.deepEqual(await pass(unanswered, [backlog], { classifyFetchLlm: async () => null }), []);
  unanswered.delete(`label:${backlog}:pool:full`);
  assert.deepEqual(await pass(unanswered, [backlog, fresh]), [fresh], 'a backlog headline labelled late stays silent, a new one alerts');

  const lostLabel = new Map();
  assert.deepEqual(await pass(lostLabel, [backlog], { labelWrites: false }), []);
  assert.deepEqual(await pass(lostLabel, [backlog, fresh]), [fresh], 'a backlog headline whose label was not stored stays silent');

  const refused = new Map();
  assert.deepEqual(await pass(refused, [backlog], { markerWrites: false }), []);
  assert.equal(refused.size, 0, 'nothing from the pool is labelled until the backlog is recorded');
  assert.deepEqual(await pass(refused, [backlog, fresh]), []);
  assert.deepEqual(await pass(refused, [backlog, fresh, 'Third strike closes strait']), ['Third strike closes strait']);
});

test('the revocation read keeps a multi-byte URL whole when the network splits it (#10978)', async t => {
  const revokedUrl = 'https://example.com/caf\u00e9';
  const body = Buffer.from(JSON.stringify([{ result: [revokedUrl] }]));
  const split = body.indexOf(0xc3) + 1;
  const server = http.createServer((_req, response) => {
    response.write(body.subarray(0, split));
    setTimeout(() => response.end(body.subarray(split)), 25);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const from = source.indexOf('function upstashPipeline(commands');
  const context = vm.createContext({
    URL, setTimeout, clearTimeout, UPSTASH_ENABLED: true, UPSTASH_HTTP_MODULE: http, UPSTASH_REDIS_REST_TOKEN: 'fixture',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
  });
  vm.runInContext(source.slice(from, source.indexOf('\n}\n', from) + 2), context);
  const rows = await bounded(context.upstashPipeline([['SMEMBERS', 'news:digest:revoked-urls:v1']]));
  assert.equal(rows[0].result[0], revokedUrl);
});

test('a label write settles when Redis breaks off mid-response (#10978)', async t => {
  const server = http.createServer((_req, response) => {
    response.writeHead(200, { 'Content-Length': 64 });
    response.write('{"result":');
    setTimeout(() => response.socket.destroy(), 25);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const from = source.indexOf('function upstashSet(key, value, ttlSeconds)');
  const context = vm.createContext({
    URL, UPSTASH_ENABLED: true, UPSTASH_HTTP_MODULE: http, UPSTASH_REDIS_REST_TOKEN: 'fixture',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
  });
  vm.runInContext(source.slice(from, source.indexOf('\n}\n', from) + 2), context);
  assert.equal(await bounded(context.upstashSet('classify:sebuf:v6:fixture', { level: 'high' }, 60)), false);
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
