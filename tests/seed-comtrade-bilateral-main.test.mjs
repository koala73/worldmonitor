// Executable coverage for main()'s write path.
//
// Everything below was previously asserted only by reading the diff: a
// mutation run proved that hardcoding writeMeta's status to 'ok' and deleting
// the preserved-key TTL refresh left the entire suite green. These tests drive
// the real main() with fetch mocked for BOTH Comtrade and Upstash, and assert
// the commands that actually reach Redis.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  main,
  MAX_CONSECUTIVE_RATE_LIMITED_FETCHES,
  MAX_PRESERVE_RUNS,
  MIN_COUNTRY_COVERAGE,
  __setSleepForTests,
  __setLngCoverageFloorForTests,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const PARTNERS_KEY_PREFIX = 'comtrade:bilateral-hs4-partners:';
const WORLD_EXPORTS_KEY = 'comtrade:world-exports-hs4:v1';
const LNG_KEY = 'comtrade:lng-hormuz-share:v1';
/** Run-level requests made before the first reporter: two world-export batches and three LNG origin requests. */
const RESERVED_REQUESTS = 5;
/**
 * The recorded all-reporter HS 271111 responses, answered by request shape.
 * The suite runs keyless, where the preview route caps a response at 500 rows,
 * so the mock answers with the recorded rows of Japan, Korea and Germany only.
 */
const LNG_REPORTERS = new Set([392, 410, 276]);
const lngFixture = (name) => {
  const body = JSON.parse(readFileSync(
    new URL(`./fixtures/energy-shock/comtrade-lng-271111-${name}-2026-10-28.json`, import.meta.url), 'utf8'));
  const data = body.data.filter(r => LNG_REPORTERS.has(r.reporterCode));
  return { count: data.length, data };
};
const LNG_RESPONSES = { annual: lngFixture('annual'), preCrisis: lngFixture('pre-crisis'), current: lngFixture('current') };
function lngResponseFor(href) {
  const url = new URL(href);
  if (url.pathname.includes('/C/A/')) return LNG_RESPONSES.annual;
  return url.searchParams.get('period').startsWith('202502') ? LNG_RESPONSES.preCrisis : LNG_RESPONSES.current;
}
const REDIS_URL = 'https://fake-upstash.test';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  force: process.env.FORCE_RESEED,
  retryDelay: process.env.WM_SEED_RETRY_DELAY_MS,
};

/** Every Redis command issued this run, flattened. */
let redisCommands = [];
/** Each /pipeline POST's command array, so a flush can be sized. */
let pipelineBatches = [];
/** Countries whose payload key "exists" in the fake Redis. */
let existingKeys = new Set();
/** Prior seed-meta returned by GET, or null. */
let priorMeta = null;
/** How many countries the mocked Comtrade should return rows for. */
let countriesWithData = 0;
/** Every upstream Comtrade call this run, world-export requests included. */
let comtradeCallCount = 0;
/** Reporter (flowCode=M) calls only, so the world reservation cannot shift which country gets rows. */
let countryCallCount = 0;
let rateLimitWaitCount = 0;
/** When true, every Comtrade call answers 429 (quota exhausted). */
let rateLimitEverything = false;
/** When true, every Comtrade call answers 503 and consumes all retry slots. */
let transientEverything = false;
let failSecondBatch = false;
/** 'malformed' answers a body without a data array; 'capped' fills the requested maxRecords. */
let providerDefect = null;
/** Every Comtrade URL the run requested, in order. */
let comtradeUrls = [];
/**
 * Rows the mocked provider returns per batch index, when set. Each entry is the
 * RAW row count; the first row of every batch carries primaryValue 0 so the raw
 * count differs from what parseRecords keeps.
 */
let batchRawRowCounts = null;
/** HTTP status the world-exports requests answer with; 200 when null. */
let worldStatus = null;
/** When true, the world-exports requests answer 200 with an empty data array. */
let worldEmpty = false;
/** Rows every reporter batch returns, when set. Overrides countriesWithData. */
let countryRows = null;
/** When true, acquiring the run lock fails the way an unreachable Redis does. */
let lockUnavailable = false;
/** HTTP status the LNG origin requests answer with; the recorded response when null. */
let lngStatus = null;

/**
 * One heading's world-export rows: the reporter totals a `flowCode=X` request
 * returns. Qatar reports value with no weight, exactly as the probe observed.
 */
const worldRows = (cmdCode) => [
  { cmdCode, reporterCode: '156', partnerCode: '0', primaryValue: 2_107_000, netWgt: 875_000, period: 2024 },
  { cmdCode, reporterCode: '842', partnerCode: '0', primaryValue: 1_809_000, netWgt: 0, period: 2024 },
  { cmdCode, reporterCode: '634', partnerCode: '0', primaryValue: 1_398_000, period: 2024 },
];

/**
 * One heading with eight origins above the 1% retention threshold and two
 * below, so the canonical leading-5 slice and the sibling threshold list
 * cannot be the same array by accident.
 */
const THRESHOLD_ROWS = [
  ['0', 1000, 5000], ['842', 300, 1500], ['156', 200, 0], ['276', 150, undefined],
  ['392', 100, undefined], ['124', 80, undefined], ['251', 60, undefined],
  ['579', 50, undefined], ['634', 40, undefined], ['490', 8, undefined], ['699', 5, undefined],
].map(([partnerCode, primaryValue, netWgt]) => ({
  cmdCode: '2804', partnerCode, primaryValue, period: 2024, ...(netWgt === undefined ? {} : { netWgt }),
}));

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
  pipelineBatches = [];
  existingKeys = new Set();
  priorMeta = null;
  countriesWithData = 0;
  comtradeCallCount = 0;
  countryCallCount = 0;
  rateLimitWaitCount = 0;
  rateLimitEverything = false;
  transientEverything = false;
  failSecondBatch = false;
  providerDefect = null;
  comtradeUrls = [];
  batchRawRowCounts = null;
  worldStatus = null;
  worldEmpty = false;
  countryRows = null;
  lockUnavailable = false;
  lngStatus = null;

  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  // The lock-unavailable path retries with real backoff; cap the idle wait so
  // the suite does not sleep through it. Attempt count stays real.
  process.env.WM_SEED_RETRY_DELAY_MS = '1';
  // No prior seed-meta in most cases, so the freshness gate lets the run
  // through; FORCE_RESEED would bypass the gate under test rather than exercise it.
  delete process.env.FORCE_RESEED;

  // The mocked LNG responses carry three reporters (the keyless 500-row cap);
  // the production floor is sized for ~114, so the suite lowers it.
  __setLngCoverageFloorForTests(1);

  __setSleepForTests((delayMs) => {
    if (delayMs === 60_000) rateLimitWaitCount++;
    return Promise.resolve();
  });

  globalThis.fetch = (async (input, init) => {
    const href = String(input);

    if (href.startsWith(REDIS_URL)) {
      const body = JSON.parse(String(init?.body ?? '[]'));
      // The bare URL takes a single command; /pipeline takes an array of them.
      if (href.endsWith('/pipeline')) {
        pipelineBatches.push(body);
        return respond(body.map(runCommand));
      }
      // acquireLockSafely treats a network-shaped failure as "another instance
      // may be running" and takes the TTL-extension-only path.
      if (lockUnavailable && body[0] === 'SET' && String(body[1]).startsWith('seed-lock:')) {
        throw new Error('fetch failed');
      }
      return respond(runCommand(body));
    }

    if (href.includes('comtradeapi.un.org')) {
      comtradeCallCount++;
      comtradeUrls.push(href);
      const isWorldExports = new URL(href).searchParams.get('flowCode') === 'X';
      const isLng = new URL(href).searchParams.get('cmdCode') === '271111';
      if (!isWorldExports && !isLng) countryCallCount++;
      if (isLng && lngStatus) return new Response('{}', { status: lngStatus });
      if (isWorldExports && worldStatus) return new Response('{}', { status: worldStatus });
      if (isWorldExports && worldEmpty) return respond({ count: 0, data: [] });
      if (rateLimitEverything) return new Response('{}', { status: 429 });
      if (failSecondBatch && countryCallCount > 1) return new Response('{}', { status: 403 });
      if (transientEverything) return new Response('{}', { status: 503 });
      if (providerDefect === 'malformed') return respond({ count: 1, unexpected: true });
      if (providerDefect === 'capped') {
        // Fill exactly the cap the request asked for, so the truncation check
        // is tied to the same number the URL sent.
        const url = new URL(href);
        const cap = Number(url.searchParams.get('maxRecords'));
        const cmdCode = url.searchParams.get('cmdCode').split(',')[0];
        return respond({
          count: cap,
          data: Array.from({ length: cap }, (_, i) => ({ cmdCode, partnerCode: String(1 + (i % 890)), primaryValue: 1, period: 2024 })),
        });
      }
      if (isWorldExports) {
        const cmdCode = new URL(href).searchParams.get('cmdCode').split(',')[0];
        const rows = worldRows(cmdCode);
        return respond({ count: rows.length, data: rows });
      }
      if (isLng) return respond(lngResponseFor(href));
      if (countryRows) return respond({ count: countryRows.length, data: countryRows });
      if (batchRawRowCounts) {
        const batchIndex = (countryCallCount - 1) % batchRawRowCounts.length;
        const rows = batchRawRowCounts[batchIndex];
        const cmdCode = new URL(href).searchParams.get('cmdCode').split(',')[0];
        return respond({
          count: rows,
          // A zero-value row is a real Comtrade row that parseRecords drops, so
          // a rowCounts assertion that matches this length can only be reading
          // the raw array and not the parsed one.
          data: Array.from({ length: rows }, (_, i) => ({
            cmdCode, partnerCode: String(100 + i), primaryValue: i === 0 ? 0 : 1000 * (i + 1), period: 2024,
          })),
        });
      }
      // Two batches per country; give the first N countries real rows.
      const countryIndex = Math.floor((countryCallCount - 1) / 2);
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
  __setLngCoverageFloorForTests(null);
  process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
  if (ORIGINAL_ENV.force === undefined) delete process.env.FORCE_RESEED;
  else process.env.FORCE_RESEED = ORIGINAL_ENV.force;
  if (ORIGINAL_ENV.retryDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
  else process.env.WM_SEED_RETRY_DELAY_MS = ORIGINAL_ENV.retryDelay;
});

/** The payload the run SET at `key`, parsed. */
function writtenPayload(key) {
  const cmd = [...redisCommands].reverse().find(c => c[0] === 'SET' && c[1] === key);
  assert.ok(cmd, `expected the run to write ${key}`);
  return JSON.parse(cmd[2]);
}

/** Whether any request in this run carried the world-exports shape. */
const worldExportUrls = () => comtradeUrls.filter(h => new URL(h).searchParams.get('flowCode') === 'X');
const reporterUrls = () => comtradeUrls.filter(h => new URL(h).searchParams.get('flowCode') === 'M'
  && new URL(h).searchParams.get('cmdCode') !== '271111');
const lngUrls = () => comtradeUrls.filter(h => new URL(h).searchParams.get('cmdCode') === '271111');

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

  // Counts every upstream call, world-export reservation included: the monthly
  // quota does not distinguish them.
  assert.equal(comtradeCallCount, 2, 'a transient retry must not cross the hard request cap');
  const meta = writtenMeta();
  assert.equal(meta.status, 'partial');
  assert.equal(meta.recordCount, 0);
});

 test('failed second batch cannot replace the previous country with the successful first batch', async () => {
  countriesWithData = 1;
  failSecondBatch = true;
  existingKeys.add(`${KEY_PREFIX}US:v1`);
  // The reserved run-level requests plus this reporter's two batches.
  await main({ requestBudget: RESERVED_REQUESTS + 2 });
  assert(!redisCommands.some(c => c[0] === 'SET' && c[1] === `${KEY_PREFIX}US:v1`));
  assert.equal(writtenMeta().countryCoverage.US.state, 'unavailable');
  assert.equal(writtenMeta().preserveStreaks.US, 1);
});

for (const [defect, state] of [['malformed', 'malformed'], ['capped', 'incomplete']]) {
  test(`a ${defect} provider response is recorded as ${state} and preserves the country`, async () => {
    providerDefect = defect;
    existingKeys.add(`${KEY_PREFIX}US:v1`);
    await main({ requestBudget: RESERVED_REQUESTS + 2 });
    assert(!redisCommands.some(c => c[0] === 'SET' && c[1] === `${KEY_PREFIX}US:v1`));
    assert.equal(writtenMeta().countryCoverage.US.state, state);
    assert.equal(writtenMeta().preserveStreaks.US, 1);
  });
}

test('every batch asks Comtrade for aggregate-only rows', async () => {
  // Without these three filters Comtrade returns one row per partner x second
  // partner x transport mode x customs procedure — about 9x the rows — which
  // fills the preview route's 500-row cap and inflates authenticated payloads.
  // The seeder's grouping already collapsed the duplicates, so the filters
  // change the row count, not the result.
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  assert.equal(reporterUrls().length, 2, 'expected both catalogue batches to be requested');
  for (const href of comtradeUrls) {
    const params = new URL(href).searchParams;
    assert.equal(params.get('partner2Code'), '0', `partner2Code missing from ${params.get('cmdCode')}`);
    assert.equal(params.get('motCode'), '0', `motCode missing from ${params.get('cmdCode')}`);
    assert.equal(params.get('customsCode'), 'C00', `customsCode missing from ${params.get('cmdCode')}`);
  }
});

test('coverage records the raw row count each batch returned', async () => {
  // R9: an operator cannot tell a reporter that genuinely trades three headings
  // from one whose response was silently trimmed, unless the run records what
  // the provider actually sent back.
  batchRawRowCounts = [4, 3];

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const coverage = writtenMeta().countryCoverage.US;
  assert.equal(coverage.state, 'observed');
  assert.deepEqual(coverage.rowCounts, [4, 3],
    'rowCounts must be the provider row counts per batch, before the zero-value rows are filtered out');
});

test('a capped batch records the count it saw alongside the incomplete state', async () => {
  // The cap throws inside parseRecords, so a count captured only on the success
  // path would leave the one state an operator most needs sized as a blank.
  providerDefect = 'capped';
  existingKeys.add(`${KEY_PREFIX}US:v1`);

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const cap = Number(new URL(reporterUrls()[0]).searchParams.get('maxRecords'));
  const coverage = writtenMeta().countryCoverage.US;
  assert.equal(coverage.state, 'incomplete');
  // Batch 1 threw, so batch 2 never ran: a single-element array, not a pair.
  assert.deepEqual(coverage.rowCounts, [cap]);
});

// ─── World exports (R10 / AE5 / KTD7) ────────────────────────────────────────

test('the two world-exports requests are reserved before the first reporter', async () => {
  // AE5: reserving after the loop would let a budget abort drop them entirely,
  // and the per-reporter pre-check would then over-commit the remainder.
  countriesWithData = 5;

  await main({ requestBudget: RESERVED_REQUESTS + 4 });

  assert.equal(worldExportUrls().length, 2, 'both catalogue batches need a world-exports request');
  assert.deepEqual(comtradeUrls.slice(0, 2), worldExportUrls(),
    'the reservation must happen before any reporter is fetched');
  assert.equal(reporterUrls().length, 4, 'the reserved requests leave 4, i.e. at most 2 reporters');
});

test('a world-exports request asks every reporter for its exports to the World', async () => {
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const [first, second] = worldExportUrls().map(href => new URL(href).searchParams);
  for (const params of [first, second]) {
    assert.equal(params.has('reporterCode'), false, 'omitting the reporter is what makes it all-reporter');
    assert.equal(params.get('flowCode'), 'X');
    assert.equal(params.get('partnerCode'), '0', 'without it the response is one row per corridor, not per reporter');
    assert.equal(params.get('partner2Code'), '0');
    assert.equal(params.get('motCode'), '0');
    assert.equal(params.get('customsCode'), 'C00');
    assert.ok(Number(params.get('maxRecords')) > 0, 'the row cap must still be sent');
  }
  assert.notEqual(first.get('cmdCode'), second.get('cmdCode'), 'the two requests must cover different headings');
  // The reporter requests are unchanged: still flowCode=M with an explicit reporter.
  for (const href of reporterUrls()) {
    const params = new URL(href).searchParams;
    assert.ok(params.get('reporterCode'));
    assert.equal(params.has('partnerCode'), false);
  }
});

test('an observed world-exports fetch is published and summarised in seed-meta', async () => {
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const payload = writtenPayload(WORLD_EXPORTS_KEY);
  assert.ok(payload.fetchedAt, 'the brief dates the supplier scale it prints');
  assert.ok(payload.period, 'the requested period must travel with the snapshot');
  assert.equal(Object.keys(payload.headings).length, 2);
  const heading = payload.headings[Object.keys(payload.headings)[0]];
  assert.equal(heading.year, 2024);
  assert.equal(heading.unrankedReporterCount, 0, 'the rank basis travels with the snapshot');
  assert.deepEqual(heading.exporters, [
    { reporterCode: 156, iso2: 'CN', valueUsd: 2_107_000, netWeightKg: 875_000 },
    { reporterCode: 842, iso2: 'US', valueUsd: 1_809_000, netWeightKg: null },
    { reporterCode: 634, iso2: 'QA', valueUsd: 1_398_000, netWeightKg: null },
  ]);

  assert.deepEqual(writtenMeta().worldExports, {
    state: 'observed',
    fetchedAt: payload.fetchedAt,
    headingCount: 2,
    reporterCount: 3,
  });
});

test('a failed world-exports fetch is recorded and the reporters still seed', async () => {
  // AE5's second half: the world request is one run-level fetch. Its failure
  // must degrade the supplier scale, never the country coverage.
  worldStatus = 503;
  countriesWithData = 2;

  // The failed world batch makes three attempts (two 5xx retries) against its
  // two reserved slots, so the two reporters need one request more.
  await main({ requestBudget: RESERVED_REQUESTS + 4 + 1 });

  const meta = writtenMeta();
  assert.equal(meta.worldExports.state, 'unavailable');
  assert.ok(meta.worldExports.attemptedAt, 'a failed attempt is dated');
  assert.ok(
    !redisCommands.some(c => c[0] === 'SET' && c[1] === WORLD_EXPORTS_KEY),
    'a failed fetch must not overwrite the last good world-exports key',
  );
  assert.equal(meta.recordCount, 2, 'the countries must still be written');
  // The previous snapshot is kept alive like a preserved country shard, or it
  // would expire mid-cycle and the brief would lose supplier scale entirely.
  assert.ok(
    redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === WORLD_EXPORTS_KEY),
    'a failed fetch must extend the last good snapshot\'s TTL',
  );
});

test('a world-exports answer with no usable rows is no_records and keeps the previous snapshot', async () => {
  worldEmpty = true;
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const meta = writtenMeta();
  assert.equal(meta.worldExports.state, 'no_records');
  assert.ok(meta.worldExports.attemptedAt);
  assert.ok(
    !redisCommands.some(c => c[0] === 'SET' && c[1] === WORLD_EXPORTS_KEY),
    'a valid empty answer must not overwrite the last good snapshot',
  );
  assert.ok(redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === WORLD_EXPORTS_KEY));
  assert.equal(meta.recordCount, 1);
});

test('an observed world-exports fetch does not extend the snapshot it just rewrote', async () => {
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  assert.ok(redisCommands.some(c => c[0] === 'SET' && c[1] === WORLD_EXPORTS_KEY));
  assert.ok(!redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === WORLD_EXPORTS_KEY));
});

// ─── Hormuz LNG origin shares (HS 271111) ────────────────────────────────────

test('the three LNG origin requests are all-reporter, all-partner and reserved before the first reporter', async () => {
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  assert.equal(lngUrls().length, 3);
  assert.deepEqual(comtradeUrls.slice(2, 5), lngUrls(), 'reserved after world exports and before any reporter');
  const [annual, preCrisis, current] = lngUrls().map(href => new URL(href));
  assert.match(annual.pathname, /\/C\/A\/HS$/);
  assert.match(preCrisis.pathname, /\/C\/M\/HS$/);
  assert.match(current.pathname, /\/C\/M\/HS$/);
  assert.equal(annual.searchParams.get('period'), '2025,2024');
  assert.equal(preCrisis.searchParams.get('period').split(',').length, 12);
  // The request slides to the latest 12 complete months, so only the floor is fixed.
  assert.ok(current.searchParams.get('period').split(',').every(p => p >= '202603'), 'no current-flows month before 2026-03');
  for (const url of [annual, preCrisis, current]) {
    const params = url.searchParams;
    assert.equal(params.get('cmdCode'), '271111', 'LNG only: HS4 2711 mixes in LPG and pipeline gas');
    assert.equal(params.get('flowCode'), 'M');
    assert.equal(params.has('reporterCode'), false, 'one call covers every importer');
    assert.equal(params.has('partnerCode'), false, 'all partners, so withheld origins are visible');
    assert.equal(params.get('partner2Code'), '0');
  }
  assert.equal(reporterUrls().length, 2, 'the reporter still gets both batches');
});

test('an observed LNG run publishes both baselines from the recorded responses', async () => {
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const payload = writtenPayload(LNG_KEY);
  assert.ok(payload.fetchedAt);
  assert.equal(payload.cmdCode, '271111');
  assert.deepEqual(payload.hormuzPartnerCodes, ['634', '784']);
  assert.deepEqual(payload.preCrisisWindow, { startMonth: '2025-02', endMonth: '2026-01', annualYears: ['2025', '2024'] });
  const { JP, KR, DE } = payload.countries;
  assert.deepEqual([JP.preCrisis.basis, JP.preCrisis.share, JP.current.fromMonth, JP.current.toMonth, JP.current.share],
    ['comtrade_monthly', 0.064, '2026-06', '2026-08', 0.0044]);
  assert.deepEqual([KR.preCrisis.basis, KR.preCrisis.share, KR.current], ['comtrade_annual', 0.1545, null]);
  assert.equal(DE.preCrisis, null);
  assert.equal(DE.preCrisisUnavailable, 'partners_unattributed');

  const meta = writtenMeta();
  assert.equal(meta.lngOrigin.state, 'observed');
  assert.equal(meta.lngOrigin.fetchedAt, payload.fetchedAt);
  assert.equal(meta.lngOrigin.countryCount, Object.keys(payload.countries).length);
  assert.ok(!redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === LNG_KEY), 'a rewritten snapshot needs no TTL refresh');
});

test('an LNG snapshot below the pre-crisis coverage floor keeps the previous one', async () => {
  // JP and KR have pre-crisis shares, DE is withheld: two usable importers.
  __setLngCoverageFloorForTests(3);
  countriesWithData = 1;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const meta = writtenMeta();
  assert.equal(meta.lngOrigin.state, 'incomplete');
  assert.equal(meta.lngOrigin.preCrisisCount, 2);
  assert.ok(!redisCommands.some(c => c[0] === 'SET' && c[1] === LNG_KEY), 'a thin snapshot must not replace a fuller one');
  assert.ok(redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === LNG_KEY));
});

test('a failed LNG request keeps the previous snapshot, stops the LNG phase and still seeds the reporters', async () => {
  lngStatus = 503;
  countriesWithData = 2;

  await main({ requestBudget: RESERVED_REQUESTS + 4 });

  const meta = writtenMeta();
  assert.equal(meta.lngOrigin.state, 'unavailable');
  assert.ok(meta.lngOrigin.attemptedAt);
  assert.ok(!redisCommands.some(c => c[0] === 'SET' && c[1] === LNG_KEY),
    'a partial LNG fetch must not overwrite the last good snapshot');
  assert.ok(redisCommands.some(c => c[0] === 'EXPIRE' && c[1] === LNG_KEY),
    'the last good snapshot is kept alive like world exports');
  // One logical request (three attempts with the 5xx retries), not three: the
  // snapshot is all-or-nothing, so the rest would only spend quota.
  assert.equal(lngUrls().length, 3);
  assert.equal(new Set(lngUrls().map(h => new URL(h).searchParams.get('period'))).size, 1);
  assert.equal(meta.recordCount, 2, 'the reporters do not depend on the LNG snapshot');
});

// ─── Sibling partners key (R1 / KTD1) ────────────────────────────────────────

test('a country write issues the canonical key and its sibling partner key', async () => {
  countryRows = THRESHOLD_ROWS;

  await main({ requestBudget: RESERVED_REQUESTS + 2 });

  const canonical = writtenPayload(`${KEY_PREFIX}US:v1`);
  const [product] = canonical.products;
  assert.equal(product.topExporters.length, 5, 'the canonical contract is the leading five');
  assert.deepEqual(product.topExporters.map(e => e.partnerCode), [842, 156, 276, 392, 124]);
  // Three scorers sum over every topExporters row and two bulk readers pull all
  // 197 canonical keys under a 4.5 MB ceiling, so the extra fields must NOT ride
  // along. Nothing else in the suite pins their absence.
  assert.deepEqual(Object.keys(product).sort(),
    ['denominatorBasis', 'description', 'hs4', 'topExporters', 'totalValue', 'year']);
  assert.equal('partners' in product, false);
  assert.equal('worldNetWeightKg' in product, false);

  const sibling = writtenPayload(`${PARTNERS_KEY_PREFIX}US:v1`);
  assert.equal(sibling.iso2, 'US');
  assert.equal(sibling.source, canonical.source);
  assert.deepEqual(sibling.requestedHs4s, canonical.requestedHs4s);
  const [detail] = sibling.products;
  assert.deepEqual(Object.keys(detail).sort(),
    ['denominatorBasis', 'hs4', 'omittedCount', 'omittedShare', 'partners', 'totalValue', 'worldNetWeightKg', 'year']);
  assert.deepEqual(detail.partners.map(p => p.partnerCode), [842, 156, 276, 392, 124, 251, 579, 634],
    'every origin at or above 1% of the denominator, ranked by value');
  assert.equal(detail.omittedCount, 2);
  assert.equal(detail.omittedShare, 0.013);
  assert.equal(detail.worldNetWeightKg, 5000);
  assert.equal(detail.partners[0].netWeightKg, 1500);
  assert.equal(detail.partners[1].netWeightKg, null, "a provider 0 means 'not reported', not zero tonnes");
});

test('a preserved country keeps its sibling partner key alive too', async () => {
  countriesWithData = 2;
  existingKeys.add(`${KEY_PREFIX}NL:v1`);
  existingKeys.add(`${PARTNERS_KEY_PREFIX}NL:v1`);

  await main();

  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]).sort();
  assert.deepEqual(expired, [`${KEY_PREFIX}NL:v1`, `${PARTNERS_KEY_PREFIX}NL:v1`].sort(),
    'the two keys describe one observation and must expire together');
});

test('a payload preserved too many runs in a row takes its sibling key with it', async () => {
  countriesWithData = 2;
  existingKeys.add(`${KEY_PREFIX}NL:v1`);
  existingKeys.add(`${PARTNERS_KEY_PREFIX}NL:v1`);
  priorMeta = JSON.stringify({
    fetchedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    recordCount: 2,
    status: 'partial',
    preserveStreaks: { NL: MAX_PRESERVE_RUNS },
  });

  await main();

  const expired = redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]);
  assert.ok(!expired.includes(`${KEY_PREFIX}NL:v1`));
  assert.ok(!expired.includes(`${PARTNERS_KEY_PREFIX}NL:v1`),
    'an immortal sibling would outlive the canonical payload it describes');
});

test('a lock-skipped run extends both country keys and the world-exports key', async () => {
  lockUnavailable = true;

  await main();

  const expired = new Set(redisCommands.filter(c => c[0] === 'EXPIRE').map(c => c[1]));
  assert.ok(expired.has(`${KEY_PREFIX}NL:v1`));
  assert.ok(expired.has(`${PARTNERS_KEY_PREFIX}NL:v1`),
    'a sibling left out here expires alone while its canonical key survives');
  assert.ok(expired.has(WORLD_EXPORTS_KEY));
  assert.ok(expired.has(LNG_KEY), 'the LNG snapshot is a run-level key like world exports');
  assert.ok(expired.has(META_KEY));
  assert.equal(comtradeCallCount, 0, 'a skipped run must not spend quota');
});

// ─── Byte-aware pipeline flush (KTD11) ───────────────────────────────────────

/**
 * 16 headings x 30 origins, each origin above the 1% retention threshold, so a
 * country's two writes are ~75 KB rather than the ~2 KB of the other fixtures.
 * 496 rows stays under the preview route's 500-row cap.
 */
const BULKY_ROWS = Array.from({ length: 16 }, (_, h) => {
  const cmdCode = String(1000 + h);
  return [
    { cmdCode, partnerCode: '0', primaryValue: 100_000_000.123, netWgt: 88_888_888.456, period: 2024 },
    ...Array.from({ length: 30 }, (_, p) => ({
      cmdCode, partnerCode: String(100 + p), primaryValue: 3_000_000.111,
      netWgt: 987_654.321, qty: 123_456.789, qtyUnitCode: 8, period: 2024,
    })),
  ];
}).flat();

test('the write pipeline flushes on accumulated bytes, not only on the command count', async () => {
  // Sibling keys roughly triple the bytes per country. At 50 commands the body
  // would be several megabytes, which Upstash rejects and which no test caught.
  countryRows = BULKY_ROWS;

  await main({ requestBudget: RESERVED_REQUESTS + 2 * 40 });

  const writeFlushes = pipelineBatches.filter(cmds => cmds.some(c => c[0] === 'SET' && c[1].startsWith(KEY_PREFIX)));
  assert.ok(writeFlushes.length >= 2, `expected repeated flushes, got ${writeFlushes.length}`);
  const first = writeFlushes[0];
  assert.ok(first.length < 50, `a 1 MB body must flush before the 50-command count, flushed at ${first.length}`);
  const bytes = first.filter(c => c[0] === 'SET').reduce((sum, c) => sum + c[2].length, 0);
  assert.ok(bytes >= 1_048_576, `the flush must be driven by real bytes, saw ${bytes}`);
  assert.ok(bytes < 2 * 1_048_576, `the flush must fire at the 1 MB ceiling, not a multiple of it (${bytes})`);
});
