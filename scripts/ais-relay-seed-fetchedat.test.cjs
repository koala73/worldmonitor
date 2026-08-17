/**
 * Regression tests for #6775 / audit R12: the market-stocks and commodities
 * seeders in ais-relay.cjs each issue multiple `envelopeWrite(...)` calls plus
 * a bare `upstashSet('seed-meta:market:*', { fetchedAt: Date.now(), ... })`.
 * `envelopeWrite` defaults `fetchedAt` to `Date.now()` when the caller's
 * `meta` doesn't supply one — so unless the seeder computes `fetchedAt` once
 * and threads it through every write, each write for a single logical
 * publish samples the clock independently, and `_seed.fetchedAt` (envelope)
 * disagrees with `seed-meta.fetchedAt` for that same publish.
 *
 * ais-relay.cjs starts an HTTP/WebSocket server, poll loops, and intervals at
 * top level (no require.main guard), so it cannot be require()d from a test.
 * Instead we lift the real function bodies (envelopeWrite, buildEnvelope, and
 * the seeder under test) out of the production source and eval them together,
 * so the assertions run against the shipped code, not a copy. Free variables
 * the extracted code relies on (fetch helpers, Redis primitives, config) are
 * supplied as globals, mirroring scripts/ais-relay-entity-decode.test.cjs.
 *
 * Run: node --test scripts/ais-relay-seed-fetchedat.test.cjs
 */
'use strict';

const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { mergeLastGoodQuotes, planYahooRefresh } = require('./shared/market-quote-refresh.cjs');

const relaySource = readFileSync(join(__dirname, 'ais-relay.cjs'), 'utf8');

// Extracts one or more top-level function declarations (async or sync) from
// the relay source and evaluates them together in a single Function scope so
// they can call one another (e.g. envelopeWrite -> buildEnvelope) exactly as
// they do in production. Any identifier the bundle doesn't define itself
// (fetch helpers, Redis primitives, module-level config/state) resolves
// against globalThis at call time — set those up as globals before calling.
function loadFunctions(names) {
  const bodies = names.map((name) => {
    const match = relaySource.match(new RegExp(`(?:async\\s+)?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `could not locate ${name}() in ais-relay.cjs`);
    return match[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

const { envelopeWrite, buildEnvelope } = loadFunctions(['buildEnvelope', 'envelopeWrite']);
void buildEnvelope; // pulled in only so envelopeWrite can call it
globalThis.envelopeWrite = envelopeWrite;

// Records every upstashSet(key, value, ttlSeconds) call — both the ones made
// indirectly through envelopeWrite and the seeder's own bare seed-meta write.
function captureUpstashSet() {
  const calls = [];
  const upstashSet = async (key, value, ttlSeconds) => {
    calls.push({ key, value, ttlSeconds });
    return true;
  };
  return { calls, upstashSet };
}

// Makes Date.now() return a strictly increasing value on every call, so a
// bug that samples the clock independently at each write is guaranteed to
// disagree between writes (as opposed to two real Date.now() calls a
// microtask apart landing on the same millisecond and hiding the bug).
function mockIncrementingClock() {
  let counter = 1_700_000_000_000;
  const original = Date.now;
  Date.now = () => counter++;
  return () => { Date.now = original; };
}

function fetchedAtValuesFor(calls, keys) {
  return calls
    .filter((c) => keys.includes(c.key))
    .map((c) => (c.value && c.value._seed ? c.value._seed.fetchedAt : c.value.fetchedAt));
}

test('seedCommodityQuotes: envelope fetchedAt matches seed-meta fetchedAt for one publish', async () => {
  const { seedCommodityQuotes } = loadFunctions(['seedCommodityQuotes']);
  globalThis.seedCommodityQuotes = seedCommodityQuotes;

  globalThis.COMMODITY_SYMBOLS = ['CL=F', 'GC=F'];
  globalThis.COMMODITY_META = new Map([
    ['CL=F', { name: 'Crude Oil', display: 'Crude Oil' }],
    ['GC=F', { name: 'Gold', display: 'Gold' }],
  ]);
  globalThis.fetchYahooChartDirect = async () => ({ price: 100, change: 1, sparkline: [1, 2, 3] });
  globalThis.sleep = async () => {};
  globalThis.upstashExpire = async () => true;
  globalThis.MARKET_SEED_TTL = 7200;
  globalThis.publishNotificationEvent = async () => {};
  globalThis.marketAlertCoalesceKey = () => 'coalesce-key';

  const { calls, upstashSet } = captureUpstashSet();
  globalThis.upstashSet = upstashSet;
  const restoreClock = mockIncrementingClock();

  try {
    const count = await seedCommodityQuotes();
    assert.equal(count, 2);
  } finally {
    restoreClock();
  }

  const commodityKey = `market:commodities:v1:${[...globalThis.COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesKey = `market:quotes:v1:${[...globalThis.COMMODITY_SYMBOLS].sort().join(',')}`;
  const envelopeKeys = [commodityKey, quotesKey, 'market:commodities-bootstrap:v1'];
  const seedMetaKey = 'seed-meta:market:commodities';

  assert.equal(calls.filter((c) => envelopeKeys.includes(c.key)).length, 3, 'expected three enveloped writes');
  assert.equal(calls.filter((c) => c.key === seedMetaKey).length, 1, 'expected one seed-meta write');

  const envelopeFetchedAts = fetchedAtValuesFor(calls, envelopeKeys);
  const seedMetaFetchedAt = fetchedAtValuesFor(calls, [seedMetaKey])[0];

  assert.ok(envelopeFetchedAts.every((ts) => ts === envelopeFetchedAts[0]), `envelope fetchedAt values must agree with each other, saw: ${JSON.stringify(envelopeFetchedAts)}`);
  assert.equal(seedMetaFetchedAt, envelopeFetchedAts[0], 'seed-meta.fetchedAt must equal the envelopes\' _seed.fetchedAt for one logical publish');
});

test('seedMarketQuotes: envelope fetchedAt matches seed-meta fetchedAt for one publish', async () => {
  const { seedMarketQuotes } = loadFunctions(['seedMarketQuotes']);
  globalThis.seedMarketQuotes = seedMarketQuotes;

  globalThis.MARKET_SYMBOLS = ['AAPL', 'MSFT'];
  globalThis.YAHOO_ONLY = new Set(globalThis.MARKET_SYMBOLS); // route everything through the Yahoo-only path
  globalThis.MARKET_META = new Map([
    ['AAPL', { name: 'Apple', display: 'Apple' }],
    ['MSFT', { name: 'Microsoft', display: 'Microsoft' }],
  ]);
  globalThis.FINNHUB_API_KEY = '';
  globalThis.fetchFinnhubQuoteDirect = async () => null;
  globalThis.envelopeRead = async () => null; // no previous payload to merge
  globalThis.planYahooRefresh = planYahooRefresh;
  globalThis.mergeLastGoodQuotes = mergeLastGoodQuotes;
  globalThis._lastYahooMarketRefreshAt = 0;
  globalThis.MARKET_YAHOO_REFRESH_INTERVAL_MS = 300_000;
  globalThis.fetchYahooChartDirect = async () => ({ price: 200, change: 1, sparkline: [1, 2, 3] });
  globalThis.sleep = async () => {};
  globalThis.MARKET_SEED_TTL = 7200;
  globalThis.CHINA_COUNTRY_STOCK_SYMBOL = '000001.SS'; // not in MARKET_SYMBOLS -> China index branch skipped
  globalThis.writeChinaCountryStockIndex = async () => {};
  globalThis._lastEquityQuoteCount = 0;
  globalThis.publishNotificationEvent = async () => {};
  globalThis.marketAlertCoalesceKey = () => 'coalesce-key';

  const { calls, upstashSet } = captureUpstashSet();
  globalThis.upstashSet = upstashSet;
  const restoreClock = mockIncrementingClock();

  try {
    const count = await seedMarketQuotes();
    assert.equal(count, 2);
  } finally {
    restoreClock();
  }

  const quotesKey = `market:quotes:v1:${[...globalThis.MARKET_SYMBOLS].sort().join(',')}`;
  const envelopeKeys = [quotesKey, 'market:stocks-bootstrap:v1'];
  const seedMetaKey = 'seed-meta:market:stocks';

  assert.equal(calls.filter((c) => envelopeKeys.includes(c.key)).length, 2, 'expected two enveloped writes');
  assert.equal(calls.filter((c) => c.key === seedMetaKey).length, 1, 'expected one seed-meta write');

  const envelopeFetchedAts = fetchedAtValuesFor(calls, envelopeKeys);
  const seedMetaFetchedAt = fetchedAtValuesFor(calls, [seedMetaKey])[0];

  assert.ok(envelopeFetchedAts.every((ts) => ts === envelopeFetchedAts[0]), `envelope fetchedAt values must agree with each other, saw: ${JSON.stringify(envelopeFetchedAts)}`);
  assert.equal(seedMetaFetchedAt, envelopeFetchedAts[0], 'seed-meta.fetchedAt must equal the envelopes\' _seed.fetchedAt for one logical publish');
});
