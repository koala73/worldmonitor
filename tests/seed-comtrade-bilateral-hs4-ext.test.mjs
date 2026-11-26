// Drives the extended-headings seeder's real main() with fetch mocked for both
// Comtrade and Upstash, and asserts what reaches Redis.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  main,
  META_KEY,
  KEY_PREFIX,
  PARTNERS_KEY_PREFIX,
  ACTIVATION_KEY,
  MIN_COUNTRY_COVERAGE,
  __setPaceSleepForTests,
} from '../scripts/seed-comtrade-bilateral-hs4-ext.mjs';
import { __setSleepForTests, reporterRoster, MAX_CONSECUTIVE_RATE_LIMITED_FETCHES } from '../scripts/seed-comtrade-bilateral-hs4.mjs';
import { EXT_HS4_CODES, HS4_CODES } from '../scripts/shared/comtrade.mjs';

const REDIS_URL = 'https://fake-upstash.test';
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, force: process.env.FORCE_RESEED, retry: process.env.WM_SEED_RETRY_DELAY_MS };
const ROSTER_SIZE = reporterRoster().length;

let redisCommands;
let existingKeys;
let priorMeta;
let comtradeUrls;
let comtradeStatus;
/** Keys whose SET the fake Redis refuses; a transaction holding one aborts whole. */
let rejectedKeys;
/** The values the fake Redis holds, so a test can check what survived. */
let stored;

const respond = body => new Response(JSON.stringify(body), { status: 200 });
// Malaysia (458) and Thailand (764) supplying natural rubber, Viet Nam (704) shrimp.
const ROWS = [
  { cmdCode: '4001', partnerCode: '0', primaryValue: 1000, period: 2024 },
  { cmdCode: '4001', partnerCode: '458', primaryValue: 600, netWgt: 300_000, period: 2024 },
  { cmdCode: '4001', partnerCode: '764', primaryValue: 400, period: 2024 },
  { cmdCode: '0306', partnerCode: '0', primaryValue: 500, period: 2024 },
  { cmdCode: '0306', partnerCode: '704', primaryValue: 500, period: 2024 },
];

function runCommand(cmd) {
  redisCommands.push(cmd);
  const [op, key] = cmd;
  if (op === 'GET') return { result: key === META_KEY ? priorMeta : null };
  if (op === 'EXISTS' || op === 'EXPIRE') return { result: existingKeys.has(key) ? 1 : 0 };
  if (op === 'SET' && rejectedKeys.has(key)) return { error: 'OOM command not allowed when used memory > maxmemory' };
  if (op === 'SET') { stored.set(key, cmd[2]); return { result: 'OK' }; }
  if (op === 'EVAL') return { result: 1 };
  return { result: null };
}

beforeEach(() => {
  redisCommands = [];
  existingKeys = new Set();
  priorMeta = null;
  comtradeUrls = [];
  comtradeStatus = null;
  rejectedKeys = new Set();
  stored = new Map();
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.WM_SEED_RETRY_DELAY_MS = '1';
  delete process.env.FORCE_RESEED;
  __setSleepForTests(() => Promise.resolve());
  __setPaceSleepForTests(() => Promise.resolve());
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.startsWith(REDIS_URL)) {
      const body = JSON.parse(String(init?.body ?? '[]'));
      if (href.endsWith('/multi-exec')) {
        // Redis refuses a write at queue time, so EXEC aborts and applies nothing.
        if (body.some(cmd => cmd[0] === 'SET' && rejectedKeys.has(cmd[1]))) {
          return new Response(JSON.stringify({ error: 'EXECABORT Transaction discarded because of previous errors.' }), { status: 400 });
        }
        return respond(body.map(runCommand));
      }
      return respond(href.endsWith('/pipeline') ? body.map(runCommand) : runCommand(body));
    }
    if (href.includes('comtradeapi.un.org')) {
      comtradeUrls.push(href);
      if (comtradeStatus) return new Response('{}', { status: comtradeStatus });
      return respond({ count: ROWS.length, data: ROWS });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  __setSleepForTests(null);
  __setPaceSleepForTests(null);
  for (const [name, value] of [['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url], ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token], ['FORCE_RESEED', ORIGINAL_ENV.force], ['WM_SEED_RETRY_DELAY_MS', ORIGINAL_ENV.retry]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const sets = () => redisCommands.filter(c => c[0] === 'SET' && !String(c[1]).startsWith('seed-lock:'));
const meta = () => JSON.parse(sets().find(c => c[1] === META_KEY)[2]);

test('the extended catalogue is one batch of headings the core catalogue does not hold', () => {
  assert.equal(EXT_HS4_CODES.length, 16);
  assert.deepEqual(EXT_HS4_CODES.filter(code => HS4_CODES.includes(code)), []);
});

test('a full run makes one request per reporter for every extended heading and writes only extended keys', async () => {
  await main();
  assert.equal(comtradeUrls.length, ROSTER_SIZE);
  for (const href of comtradeUrls) {
    const url = new URL(href);
    assert.deepEqual(url.searchParams.get('cmdCode').split(','), EXT_HS4_CODES);
    assert.equal(url.searchParams.get('flowCode'), 'M');
  }
  const written = sets().map(c => c[1]);
  assert.ok(written.every(key => key === META_KEY || key === ACTIVATION_KEY || key.startsWith(KEY_PREFIX) || key.startsWith(PARTNERS_KEY_PREFIX)), 'never touches core keys');
  const my = JSON.parse(sets().find(c => c[1] === `${KEY_PREFIX}MY:v1`)[2]);
  assert.deepEqual(my.requestedHs4s, EXT_HS4_CODES);
  const rubber = my.products.find(p => p.hs4 === '4001');
  assert.equal(rubber.description, 'Natural rubber');
  assert.equal(rubber.topExporters[0].partnerIso2, 'MY');
  assert.ok(sets().some(c => c[1] === `${PARTNERS_KEY_PREFIX}MY:v1`));
  const m = meta();
  assert.equal(m.status, 'ok');
  assert.equal(m.recordCount, ROSTER_SIZE);
  assert.ok(ROSTER_SIZE >= MIN_COUNTRY_COVERAGE);
  assert.equal(m.countryCoverage.MY.state, 'observed');
  // The activation marker is durable: no EX, so it outlives the seed-meta TTL.
  assert.deepEqual(sets().find(c => c[1] === ACTIVATION_KEY), ['SET', ACTIVATION_KEY, '1']);
  assert.ok(m.countryCoverage.MY.missingHs4s.includes('1801'));
});

test('a fresh seed-meta skips the run without calling Comtrade', async () => {
  priorMeta = JSON.stringify({ fetchedAt: Date.now() - 86_400_000 });
  await main();
  assert.equal(comtradeUrls.length, 0);
  assert.equal(sets().length, 0);
});

test('the request budget caps the run and the result is recorded as partial', async () => {
  await main({ requestBudget: 3 });
  assert.equal(comtradeUrls.length, 3);
  assert.equal(meta().status, 'partial');
  assert.equal(meta().recordCount, 3);
});

test('an exhausted quota trips the breaker and preserves existing pairs', async () => {
  comtradeStatus = 429;
  existingKeys = new Set([`${KEY_PREFIX}MY:v1`, `${PARTNERS_KEY_PREFIX}MY:v1`]);
  await main();
  // Each refused reporter costs its first request plus the one 429 retry.
  assert.equal(comtradeUrls.length, MAX_CONSECUTIVE_RATE_LIMITED_FETCHES * 2);
  const m = meta();
  assert.equal(m.status, 'partial');
  assert.equal(m.preserveStreaks.MY, 1);
  assert.equal(sets().some(c => c[1] === ACTIVATION_KEY), false, 'a run that wrote nothing does not activate the probe');
  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.ok(expired.includes(`${KEY_PREFIX}MY:v1`) && expired.includes(`${PARTNERS_KEY_PREFIX}MY:v1`));
});

test('a pair Redis refuses is published as one generation: neither key changes and the last good pair is preserved', async () => {
  rejectedKeys = new Set([`${PARTNERS_KEY_PREFIX}MY:v1`]);
  existingKeys = new Set([`${KEY_PREFIX}MY:v1`, `${PARTNERS_KEY_PREFIX}MY:v1`]);
  const previous = { canonical: '{"iso2":"MY","fetchedAt":"previous-run"}', partners: '{"iso2":"MY","fetchedAt":"previous-run"}' };
  stored.set(`${KEY_PREFIX}MY:v1`, previous.canonical);
  stored.set(`${PARTNERS_KEY_PREFIX}MY:v1`, previous.partners);
  await main();
  // The canonical SET was valid on its own, but it travelled in the same
  // transaction as the refused one, so the previous generation is intact.
  assert.equal(stored.get(`${KEY_PREFIX}MY:v1`), previous.canonical);
  assert.equal(stored.get(`${PARTNERS_KEY_PREFIX}MY:v1`), previous.partners);
  // Every other country's pair was published together, under one stamp.
  const th = [JSON.parse(stored.get(`${KEY_PREFIX}TH:v1`)), JSON.parse(stored.get(`${PARTNERS_KEY_PREFIX}TH:v1`))];
  assert.equal(th[0].fetchedAt, th[1].fetchedAt);
  const m = meta();
  assert.equal(m.recordCount, ROSTER_SIZE - 1);
  assert.equal(m.countryCoverage.MY.state, 'cache_write_failed');
  assert.equal(m.countryCoverage.TH.state, 'observed');
  assert.equal(m.preserveStreaks.MY, 1);
  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.ok(expired.includes(`${KEY_PREFIX}MY:v1`) && expired.includes(`${PARTNERS_KEY_PREFIX}MY:v1`));
});
