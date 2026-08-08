// Executable coverage for main()'s write path.
//
// Everything below was previously asserted only by reading the diff: a
// mutation run proved that hardcoding writeMeta's status to 'ok' and deleting
// the preserved-key TTL refresh left the entire suite green. These tests drive
// the real main() with fetch mocked for BOTH Comtrade and Upstash, and assert
// the commands that actually reach Redis.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  main,
  MAX_CONSECUTIVE_RATE_LIMITED_FETCHES,
  MAX_PRESERVE_RUNS,
  MIN_COUNTRY_COVERAGE,
  __setSleepForTests,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const REDIS_URL = 'https://fake-upstash.test';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  force: process.env.FORCE_RESEED,
};

/** Every Redis command issued this run, flattened. */
let redisCommands = [];
/** Countries whose payload key "exists" in the fake Redis. */
let existingKeys = new Set();
/** Prior seed-meta returned by GET, or null. */
let priorMeta = null;
/** How many countries the mocked Comtrade should return rows for. */
let countriesWithData = 0;
let comtradeCallCount = 0;
let rateLimitWaitCount = 0;
/** When true, every Comtrade call answers 429 (quota exhausted). */
let rateLimitEverything = false;
/** When true, every Comtrade call answers 503 and consumes all retry slots. */
let transientEverything = false;

function respond(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function runCommand(cmd) {
  const [op, key] = cmd;
  redisCommands.push(cmd);
  switch (op) {
    case 'GET':
      return { result: key === META_KEY ? priorMeta : null };
    case 'SET':
      return { result: 'OK' };
    case 'EXISTS':
      return { result: existingKeys.has(key) ? 1 : 0 };
    case 'EXPIRE':
      return { result: existingKeys.has(key) ? 1 : 0 };
    case 'EVAL':
      return { result: 1 };
    default:
      return { result: null };
  }
}

beforeEach(() => {
  redisCommands = [];
  existingKeys = new Set();
  priorMeta = null;
  countriesWithData = 0;
  comtradeCallCount = 0;
  rateLimitWaitCount = 0;
  rateLimitEverything = false;
  transientEverything = false;

  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  // No prior seed-meta in most cases, so the freshness gate lets the run
  // through; FORCE_RESEED would bypass the gate under test rather than exercise it.
  delete process.env.FORCE_RESEED;

  __setSleepForTests((delayMs) => {
    if (delayMs === 60_000) rateLimitWaitCount++;
    return Promise.resolve();
  });

  globalThis.fetch = (async (input, init) => {
    const href = String(input);

    if (href.startsWith(REDIS_URL)) {
      const body = JSON.parse(String(init?.body ?? '[]'));
      // The bare URL takes a single command; /pipeline takes an array of them.
      if (href.endsWith('/pipeline')) return respond(body.map(runCommand));
      return respond(runCommand(body));
    }

    if (href.includes('comtradeapi.un.org')) {
      comtradeCallCount++;
      if (rateLimitEverything) return new Response('{}', { status: 429 });
      if (transientEverything) return new Response('{}', { status: 503 });
      // Two batches per country; give the first N countries real rows.
      const countryIndex = Math.floor((comtradeCallCount - 1) / 2);
      if (countryIndex < countriesWithData) {
        return respond({
          count: 1,
          data: [{ cmdCode: '2709', partnerCode: '156', primaryValue: 1000, period: 2024 }],
        });
      }
      return respond({ count: 0, data: [] });
    }

    throw new Error(`unexpected fetch to ${href}`);
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  __setSleepForTests(null);
  process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
  if (ORIGINAL_ENV.force === undefined) delete process.env.FORCE_RESEED;
  else process.env.FORCE_RESEED = ORIGINAL_ENV.force;
});

/** The seed-meta record the run persisted. */
function writtenMeta() {
  const cmd = [...redisCommands].reverse().find(c => c[0] === 'SET' && c[1] === META_KEY);
  assert.ok(cmd, 'expected the run to write seed-meta');
  return JSON.parse(cmd[2]);
}

test('a run below the coverage floor records status partial, not ok', async () => {
  countriesWithData = 3; // far below MIN_COUNTRY_COVERAGE

  await main();

  const meta = writtenMeta();
  assert.equal(meta.status, 'partial', 'a 3-country run must not report ok');
  assert.equal(meta.recordCount, 3);
  assert.ok(meta.recordCount < MIN_COUNTRY_COVERAGE);
});

test('a run at or above the coverage floor records status ok', async () => {
  countriesWithData = MIN_COUNTRY_COVERAGE;

  await main();

  const meta = writtenMeta();
  assert.equal(meta.status, 'ok');
  assert.equal(meta.recordCount, MIN_COUNTRY_COVERAGE);
});

test('countries not written this run get their TTL refreshed, so they survive', async () => {
  countriesWithData = 2;
  // A country that has data in Redis from an earlier run but returns nothing now.
  existingKeys.add(`${KEY_PREFIX}NL:v1`);

  await main();

  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.ok(
    expired.includes(`${KEY_PREFIX}NL:v1`),
    'an existing payload with no fresh data must be kept alive',
  );
});

test('TTL refresh is limited to keys that actually exist', async () => {
  countriesWithData = 2;
  existingKeys.add(`${KEY_PREFIX}NL:v1`);

  await main();

  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.deepEqual(expired, [`${KEY_PREFIX}NL:v1`],
    'extending never-seeded keys fires a per-key "manual seed required" alarm for the whole roster');
});

test('a payload preserved too many runs in a row is allowed to expire', async () => {
  countriesWithData = 2;
  existingKeys.add(`${KEY_PREFIX}NL:v1`);
  priorMeta = JSON.stringify({
    // Old enough that the freshness gate does not skip the run.
    fetchedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    recordCount: 2,
    status: 'partial',
    preserveStreaks: { NL: MAX_PRESERVE_RUNS },
  });

  await main();

  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.ok(
    !expired.includes(`${KEY_PREFIX}NL:v1`),
    'an abandoned reporter must age out so the lazy fallback can re-probe it',
  );
});

test('the preserve streak is persisted so the grace period is bounded across runs', async () => {
  countriesWithData = 2;
  existingKeys.add(`${KEY_PREFIX}NL:v1`);

  await main();

  const meta = writtenMeta();
  assert.equal(meta.preserveStreaks?.NL, 1, 'first preservation should start the streak');
});

test('an exhausted quota aborts the run instead of outliving the lock', async () => {
  // Every call 429s and fetchBilateral waits 60s on the first 429 of each, so
  // a full pass would sit through ~394 of those waits — about 6.6 hours
  // against a 30-minute lock. The lock would expire mid-run and the next tick
  // would start a second run on top of this one.
  rateLimitEverything = true;

  await main();

  assert.ok(
    rateLimitWaitCount <= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES,
    `should bail after ${MAX_CONSECUTIVE_RATE_LIMITED_FETCHES} one-minute rate-limit waits, waited ${rateLimitWaitCount} times`,
  );
  assert.ok(comtradeCallCount < 100, `must not grind the full roster; made ${comtradeCallCount} calls`);
});

test('an aborted run still records its partial result', async () => {
  rateLimitEverything = true;

  await main();

  const meta = writtenMeta();
  assert.equal(meta.status, 'partial', 'the operator must see the run degraded, not silence');
  assert.equal(meta.recordCount, 0);
});

test('the request budget counts retry attempts, not only logical batch fetches', async () => {
  // A single logical fetch can make three upstream attempts after transient
  // failures. The monthly quota applies to those real HTTP requests, so the
  // hard cap must be enforced inside the retry loop.
  transientEverything = true;

  await main({ requestBudget: 2 });

  assert.equal(comtradeCallCount, 2, 'a transient retry must not cross the hard request cap');
  const meta = writtenMeta();
  assert.equal(meta.status, 'partial');
  assert.equal(meta.recordCount, 0);
});
