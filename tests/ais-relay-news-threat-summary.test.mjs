// Drives one real relay classify cycle (scripts/ais-relay.cjs seedClassify via
// the RELAY_TEST_MODE /__test/seed-classify seam) against local stand-ins for
// Upstash, the list-feed-digest API and the LLM, and checks how it publishes
// news:threat:summary:v1, the CII Information input.
//
// 2026-10-21: the key expired twice in one morning. A classify cycle takes
// about 12 minutes (four 3-minute variant staggers) and publishes only at its
// end, so every relay restart left at least 27 minutes between writes against
// a 20-minute TTL; three deploys in 40 minutes stretched one gap to 48 minutes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ as healthTesting } from '../api/health.js';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const SUMMARY_KEY = 'news:threat:summary:v1';
const SUMMARY_META_KEY = 'seed-meta:news:threat-summary';
const HEADLINE = 'Military clashes reported in Israel';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('relay did not answer')));
    req.on('error', reject);
  });
}

// Upstash REST stand-in. By default every classify-cache lookup is a hit
// labelled `high`, so the cycle never needs the LLM; `cachedLabel` overrides
// that (null = cache miss, `_skip` = an earlier cycle the LLM could not label).
// `failSetKeys` answers a SET with an error.
async function startUpstash(t, { failSetKeys = [], cachedLabel = 'high' } = {}) {
  const commands = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let command = null;
      try { command = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* GET /get/<key> */ }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/pipeline') {
        const rows = Array.isArray(command) ? command : [];
        return res.end(JSON.stringify(rows.map(([, key]) => ({
          result: String(key).startsWith('classify:') && cachedLabel ? JSON.stringify({ level: cachedLabel, category: 'conflict' }) : null,
        }))));
      }
      if (!Array.isArray(command)) return res.end(JSON.stringify({ result: null }));
      commands.push(command);
      if (command[0] === 'SET' && failSetKeys.includes(command[1])) {
        return res.end(JSON.stringify({ error: 'ERR simulated write failure' }));
      }
      return res.end(JSON.stringify({ result: command[0] === 'EVAL' ? 1 : 'OK' }));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    commands,
    sets: (key) => commands.filter((c) => c[0] === 'SET' && c[1] === key),
    setIndex: (key) => commands.findIndex((c) => c[0] === 'SET' && c[1] === key),
    url: `http://127.0.0.1:${port}`,
  };
}

// list-feed-digest stand-in. `busy` serves one country-naming headline per
// variant, `quiet` serves an empty digest, `stale` serves that headline as a
// stale replay (coverage.servedStale), `down` answers 500 (not retried),
// `malformed` serves a digest whose items are not a list, so the variant throws,
// `unavailable` serves the handler's no-digest body (coverage.state
// 'unavailable', empty categories, servedStale false).
// An object maps a variant to its mode, with `default` for the rest.
async function startDigestApi(t, modes) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/news/v1/list-feed-digest')) {
      res.writeHead(404);
      return res.end();
    }
    const variant = new URL(req.url, 'http://digest.test').searchParams.get('variant');
    const mode = typeof modes === 'string' ? modes : (modes[variant] ?? modes.default);
    if (mode === 'down') {
      res.writeHead(500);
      return res.end();
    }
    if (mode === 'unavailable') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ categories: {}, coverage: { state: 'unavailable', itemsServed: 0, servedStale: false, staleAgeSeconds: 0, staleReason: 'digest-build-failed' } }));
    }
    const title = mode === 'nocountry' ? 'Markets rally after earnings beat forecasts' : HEADLINE;
    const items = mode === 'quiet' ? [] : mode === 'malformed' ? 5 : [{ title, publishedAt: Date.now(), source: 'Reuters' }];
    const coverage = mode === 'stale' ? { servedStale: true, staleReason: 'feeds-unavailable', staleAgeSeconds: 1800 } : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ categories: { world: { items } }, ...(coverage ? { coverage } : {}) }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

async function runClassifyCycle(t, { digest, failSetKeys, cachedLabel } = {}) {
  const upstash = await startUpstash(t, { failSetKeys, cachedLabel });
  const apiBase = await startDigestApi(t, digest);
  // Any configured provider satisfies the loop's provider guard. It is only
  // called on a cache miss, and it is down.
  const llm = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  const llmPort = await listen(llm);
  t.after(() => new Promise((resolve) => llm.close(resolve)));

  const child = spawn(process.execPath, [relayScript], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      UPSTASH_REDIS_REST_URL: upstash.url,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
      API_BASE_URL: apiBase,
      OLLAMA_API_URL: `http://127.0.0.1:${llmPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  while (!output.includes('Test mode enabled')) {
    if (child.exitCode != null) throw new Error(`relay exited ${child.exitCode}: ${output}`);
    if (Date.now() - started > 20_000) throw new Error(`relay did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const port = Number(output.match(/WebSocket relay on port (\d+)/)[1]);
  const trigger = await get(port, '/__test/seed-classify');
  assert.equal(trigger.status, 200, `classify seam failed: ${trigger.body}\n${output}`);
  return { upstash, output: () => output };
}

const envelopeOf = (setCommand) => JSON.parse(setCommand[2]);
const ttlOf = (setCommand) => Number(setCommand[setCommand.indexOf('EX') + 1]);
const healthBudgetSeconds = () => healthTesting.SEED_META.newsThreatSummary.maxStaleMin * 60;

test('a classify cycle publishes the threat summary with a TTL that outlives the health staleness budget', async (t) => {
  const { upstash, output } = await runClassifyCycle(t, { digest: 'busy' });
  const writes = upstash.sets(SUMMARY_KEY);
  assert.equal(writes.length, 1, `one summary write per cycle\n${output()}`);

  const { _seed, data } = envelopeOf(writes[0]);
  // The headline is served on all five variants and counted once.
  assert.deepEqual(data.byCountry, { IL: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } });
  assert.equal(_seed.recordCount, Object.keys(data.byCountry).length);
  assert.equal(_seed.state, 'OK');

  // A restart costs one full cycle, and back-to-back deploys several. Health
  // must go STALE_SEED before the payload expires, never the other way round.
  const ttl = ttlOf(writes[0]);
  assert.ok(
    ttl > healthBudgetSeconds(),
    `TTL ${ttl}s must exceed the ${healthBudgetSeconds()}s health budget so the key cannot vanish while health reads fresh`,
  );
  assert.ok(ttl >= 2 * 48 * 60, `TTL ${ttl}s must cover twice the worst measured restart gap (48 min)`);

  const meta = upstash.sets(SUMMARY_META_KEY);
  assert.equal(meta.length, 1);
  assert.equal(JSON.parse(meta[0][2]).recordCount, Object.keys(data.byCountry).length);
  assert.ok(
    upstash.setIndex(SUMMARY_KEY) < upstash.setIndex(SUMMARY_META_KEY),
    'seed-meta advances only after the payload it describes is written',
  );
});

test('a quiet cycle still publishes a valid empty summary instead of letting the key expire', async (t) => {
  const { upstash, output } = await runClassifyCycle(t, { digest: 'quiet' });
  const writes = upstash.sets(SUMMARY_KEY);
  assert.equal(writes.length, 1, `a quiet cycle must still write the summary\n${output()}`);

  const { _seed, data } = envelopeOf(writes[0]);
  assert.deepEqual(data.byCountry, {});
  assert.equal(typeof data.generatedAt, 'number');
  assert.equal(_seed.recordCount, 0);
  assert.equal(_seed.state, 'OK_ZERO');
  assert.ok(ttlOf(writes[0]) > healthBudgetSeconds());

  const meta = upstash.sets(SUMMARY_META_KEY);
  assert.equal(meta.length, 1);
  assert.equal(JSON.parse(meta[0][2]).recordCount, 0);
});

test('an empty result from stale digest replays keeps the last summary instead of blanking it', async (t) => {
  // The relay skips stale-replay headlines, so an empty result there says the
  // news pipeline is degraded, not that the world is quiet. Overwriting with
  // `byCountry: {}` would zero every score and read as a healthy quiet input.
  const { upstash, output } = await runClassifyCycle(t, { digest: 'stale' });
  assert.match(output(), /stale replay/);
  assert.equal(upstash.sets(SUMMARY_KEY).length, 0, 'no summary from a degraded cycle');
  assert.equal(upstash.sets(SUMMARY_META_KEY).length, 0, 'seed-meta ages so health shows STALE_SEED');
});

// An empty result counts as quiet only when every headline was fetched and
// labelled. Otherwise the countries it would have named are unknown, and
// `byCountry: {}` would zero their scores behind a healthy-looking quiet input.
for (const [name, cycle] of [
  ['a digest fetch failed', { digest: { full: 'down', default: 'quiet' } }],
  ['a variant threw', { digest: { full: 'malformed', default: 'quiet' } }],
  ['the digest API had no digest to serve', { digest: { full: 'unavailable', default: 'quiet' } }],
  ['the LLM could not label fresh headlines', { digest: 'busy', cachedLabel: null }],
  ['the headlines carry an earlier unlabelled verdict', { digest: 'busy', cachedLabel: '_skip' }],
]) {
  test(`an empty result keeps the last summary when ${name}`, async (t) => {
    const { upstash, output } = await runClassifyCycle(t, cycle);
    assert.equal(upstash.sets(SUMMARY_KEY).length, 0, `no summary from a degraded cycle\n${output()}`);
    assert.equal(upstash.sets(SUMMARY_META_KEY).length, 0, 'seed-meta ages so health shows STALE_SEED');
  });
}

test('an unlabelled headline that names no country does not block the quiet write', async (t) => {
  // Its label could not have added a country, so the empty result is still quiet.
  const { upstash, output } = await runClassifyCycle(t, { digest: 'nocountry', cachedLabel: '_skip' });
  const writes = upstash.sets(SUMMARY_KEY);
  assert.equal(writes.length, 1, `a country-less skip must not hold the summary\n${output()}`);
  assert.equal(envelopeOf(writes[0])._seed.state, 'OK_ZERO');
});

test('a degraded cycle that still names countries publishes those counts', async (t) => {
  // Holding the last summary through every partial outage would let the key
  // expire again once the outage outlasts the TTL; only an empty result from a
  // degraded cycle keeps it.
  const { upstash, output } = await runClassifyCycle(t, { digest: { full: 'down', default: 'busy' } });
  const writes = upstash.sets(SUMMARY_KEY);
  assert.equal(writes.length, 1, `partial cycles with matches still publish\n${output()}`);
  assert.deepEqual(envelopeOf(writes[0]).data.byCountry, { IL: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } });
  assert.equal(upstash.sets(SUMMARY_META_KEY).length, 1);
});

test('a rejected summary write leaves the seed-meta untouched so health ages it', async (t) => {
  const { upstash } = await runClassifyCycle(t, { digest: 'busy', failSetKeys: [SUMMARY_KEY] });
  assert.equal(upstash.sets(SUMMARY_KEY).length, 1, 'the write was attempted');
  assert.equal(upstash.sets(SUMMARY_META_KEY).length, 0, 'seed-meta must not claim a publish that failed');
});

test('a cycle whose every digest fetch failed publishes nothing', async (t) => {
  const { upstash } = await runClassifyCycle(t, { digest: 'down' });
  assert.equal(upstash.sets(SUMMARY_KEY).length, 0);
  assert.equal(upstash.sets(SUMMARY_META_KEY).length, 0);
});
