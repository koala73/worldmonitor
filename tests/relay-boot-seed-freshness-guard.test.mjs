// Boot-seed freshness guard — behavioral + wiring regression tests.
//
// ais-relay is recycled frequently on proxy.worldmonitor.app. Every seed loop
// fires an IMMEDIATE seed on boot and then schedules a setInterval at its real
// cadence — but the process is usually recycled long before that interval
// elapses, so the boot seed is the de-facto scheduler. During a reboot storm
// that re-fetches every upstream on every boot (~8 min apart) instead of on its
// interval: paid ScrapeCreators credits, plus rate-limit/ban risk for Reddit,
// Yahoo, CoinGecko, UCDP, OpenSky, etc.
//
// `bootSeedDelayMs(label, metaKey, intervalMs)` gates the boot seed on the
// existing seed-meta age, and `startBootSeedLoop` schedules the first skipped
// refresh for the remaining freshness window before starting the recurring
// interval.
//
// ais-relay.cjs calls server.listen() at top level and has no module.exports, so
// it cannot be imported. These tests (1) extract the real guard/scheduler bodies
// and exercise them against mocked Redis/timers, and (2) assert the source wires
// every fixed-schedule external seeder through the scheduler while leaving
// real-time pollers / internal warm-pings untouched.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

// -- Extract real function bodies via brace-matching ---------------------------
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

const delayFnText = extractFunction(relaySource, 'async function bootSeedDelayMs(label, metaKey, intervalMs)');
const loopFnText = extractFunction(relaySource, 'function startBootSeedLoop(label, metaKey, intervalMs, seedFn, onInitialError, onSeedError = onInitialError)');

// Rebuild the function with its free variables injected as closure params.
// (It references UPSTASH_ENABLED, upstashGet, console, plus globals Date/Number/Math.)
function buildDelayResolver({ enabled = true, get = async () => null } = {}) {
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]) };
  const factory = new Function('UPSTASH_ENABLED', 'upstashGet', 'console', `return (${delayFnText});`);
  return { resolveDelay: factory(enabled, get, fakeConsole), logs };
}

function buildLoop({ delay = 0 } = {}) {
  const timeouts = [];
  const intervals = [];
  const initialErrors = [];
  const seedErrors = [];
  let seedCalls = 0;
  const fakeSetTimeout = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timeouts.push(timer);
    return timer;
  };
  const fakeSetInterval = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    intervals.push(timer);
    return timer;
  };
  const fakeDelayResolver = async () => delay;
  const factory = new Function('bootSeedDelayMs', 'setTimeout', 'setInterval', `return (${loopFnText});`);
  const loop = factory(fakeDelayResolver, fakeSetTimeout, fakeSetInterval);
  const seedFn = async () => { seedCalls++; };
  const onInitialError = (e) => { initialErrors.push(e); };
  const onSeedError = (e) => { seedErrors.push(e); };
  return {
    loop,
    seedFn,
    onInitialError,
    onSeedError,
    timeouts,
    intervals,
    initialErrors,
    seedErrors,
    get seedCalls() { return seedCalls; },
  };
}

const MIN = 60 * 1000;

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('returns the remaining freshness window when data is fresher than the interval', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() - 5 * MIN, recordCount: 10 }) });
  const delayMs = await resolveDelay('X', 'seed-meta:x', 180 * MIN);
  assert.ok(delayMs > 174 * MIN && delayMs <= 175 * MIN, `fresh data should delay roughly 175min, got ${delayMs}`);
});

test('returns 0 delay when data is older than the interval (refresh due)', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() - 200 * MIN, recordCount: 10 }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('returns 0 delay when there is no prior seed-meta', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => null });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('fails OPEN — a Redis read error returns 0 delay (never starves a panel)', async () => {
  const { resolveDelay, logs } = buildDelayResolver({
    get: async (_key, onFailure) => {
      onFailure('redis down');
      return null;
    },
  });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && /freshness check failed/.test(String(msg))));
});

test('returns 0 delay when Upstash is disabled (no gate possible)', async () => {
  const { resolveDelay } = buildDelayResolver({ enabled: false, get: async () => ({ fetchedAt: Date.now() }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('a future-dated fetchedAt (negative age) is treated defensively — 0 delay', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() + 60 * MIN }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('intervalMs<=0 disables the gate (0 delay)', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 0), 0);
});

test('startBootSeedLoop seeds immediately and starts the recurring interval when delay is 0', async () => {
  const harness = buildLoop({ delay: 0 });
  harness.loop('X', 'seed-meta:x', 180 * MIN, harness.seedFn, harness.onInitialError, harness.onSeedError);
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 1);
  assert.equal(harness.timeouts.length, 0);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].ms, 180 * MIN);
  assert.equal(harness.intervals[0].unrefCalled, true);
});

test('startBootSeedLoop waits the remaining freshness window before first skipped refresh', async () => {
  const harness = buildLoop({ delay: 60 * MIN });
  harness.loop('X', 'seed-meta:x', 180 * MIN, harness.seedFn, harness.onInitialError, harness.onSeedError);
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 0, 'fresh data must not seed at boot');
  assert.equal(harness.intervals.length, 0, 'recurring interval must not start before the due refresh');
  assert.equal(harness.timeouts.length, 1);
  assert.equal(harness.timeouts[0].ms, 60 * MIN);
  assert.equal(harness.timeouts[0].unrefCalled, true);

  harness.timeouts[0].fn();
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 1, 'remaining-window timer should run the skipped boot seed');
  assert.equal(harness.intervals.length, 1, 'recurring interval starts after the due refresh');
  assert.equal(harness.intervals[0].ms, 180 * MIN);
});

// -- Wiring: every fixed-schedule external seeder routes through
// startBootSeedLoop with the exact (label, metaKey, intervalConst, seedFn). The
// exact-string match pins all four arguments so a future edit can't silently
// drift the meta key or interval and re-open the boot-abuse hole.
const SEEDERS = [
  ['UCDP', "'seed-meta:conflict:ucdp-events'", 'UCDP_POLL_INTERVAL_MS', 'seedUcdpEvents'],
  ['Satellites', "'seed-meta:intelligence:satellites'", 'SAT_SEED_INTERVAL_MS', 'seedSatelliteTLEs'],
  ['Market', "'seed-meta:market:stocks'", 'MARKET_SEED_INTERVAL_MS', 'seedAllMarketData'],
  ['PositiveEvents', "'seed-meta:positive-events:geo'", 'POSITIVE_EVENTS_INTERVAL_MS', 'seedPositiveEvents'],
  ['Classify', "'seed-meta:classify'", 'CLASSIFY_SEED_INTERVAL_MS', 'seedClassify'],
  ['TheaterPosture', "'seed-meta:theater-posture'", 'THEATER_POSTURE_SEED_INTERVAL_MS', 'seedTheaterPosture'],
  ['Weather', "'seed-meta:weather:alerts'", 'WEATHER_SEED_INTERVAL_MS', 'seedWeatherAlerts'],
  ['Spending', "'seed-meta:economic:spending'", 'SPENDING_SEED_INTERVAL_MS', 'seedUsaSpending'],
  ['GSCPI', "'seed-meta:economic:gscpi'", 'GSCPI_SEED_INTERVAL_MS', 'seedGscpi'],
  ['TechEvents', "'seed-meta:research:tech-events'", 'TECH_EVENTS_SEED_INTERVAL_MS', 'seedTechEvents'],
  ['WB', '`seed-meta:${WB_BOOTSTRAP_KEY}`', 'WB_SEED_INTERVAL_MS', 'seedWorldBank'],
  ['CorridorRisk', "'seed-meta:supply_chain:corridorrisk'", 'CORRIDOR_RISK_SEED_INTERVAL_MS', 'seedCorridorRisk'],
  ['USNI', "'seed-meta:military:usni-fleet'", 'USNI_SEED_INTERVAL_MS', 'seedUsniFleet'],
  ['ShippingStress', "'seed-meta:supply_chain:shipping_stress'", 'SHIPPING_STRESS_INTERVAL_MS', 'seedShippingStress'],
  ['SocialVelocity', 'SOCIAL_VELOCITY_SEED_META_KEY', 'SOCIAL_VELOCITY_INTERVAL_MS', 'seedSocialVelocity'],
  ['WsbTickers', "'seed-meta:intelligence:wsb-tickers'", 'WSB_TICKERS_INTERVAL_MS', 'seedWsbTickers'],
  ['ClimateNewsSeed', "'relay:heartbeat:climate-news'", 'CLIMATE_NEWS_SEED_INTERVAL_MS', 'seedClimateNews'],
  ['ChokepointFlows', "'relay:heartbeat:chokepoint-flows'", 'CHOKEPOINT_FLOWS_SEED_INTERVAL_MS', 'seedChokepointFlows'],
  ['PizzINT', "'seed-meta:intelligence:pizzint'", 'PIZZINT_SEED_INTERVAL_MS', 'seedPizzint'],
  ['DodoPrices', "'seed-meta:product-catalog'", 'DODO_PRICE_SEED_INTERVAL_MS', 'seedDodoPrices'],
  ['Transit', "'seed-meta:supply_chain:chokepoint_transits'", 'CHOKEPOINT_TRANSIT_INTERVAL_MS', 'seedChokepointTransits'],
  ['TransitSummary', "'seed-meta:supply_chain:transit-summaries'", 'TRANSIT_SUMMARY_INTERVAL_MS', 'seedTransitSummaries'],
  ['Cyber', "'seed-meta:cyber:threats'", 'CYBER_SEED_INTERVAL_MS', 'seedCyberThreats'],
];

for (const [label, metaKey, intervalConst, seedFn] of SEEDERS) {
  test(`${label} boot seed is scheduled through startBootSeedLoop(${intervalConst}, ${seedFn})`, () => {
    const call = `startBootSeedLoop('${label}', ${metaKey}, ${intervalConst}, ${seedFn},`;
    assert.ok(relaySource.includes(call), `expected boot-seed wiring: ${call}`);
  });
}

test('exactly the expected number of boot seeds are scheduled (no drift)', () => {
  const count = (relaySource.match(/startBootSeedLoop\('/g) || []).length;
  assert.equal(count, SEEDERS.length, `expected ${SEEDERS.length} gated boot seeds, found ${count}`);
});

// ── Exclusions: internal warm-pings short-circuit at their own endpoint when the
// data is fresh (cheap), so gating them adds risk for no benefit; real-time
// pollers must run continuously. None of these may be wrapped. ───────────────
test('internal warm-pings are NOT gated (self-limiting at the endpoint)', () => {
  for (const label of ['ServiceStatuses', 'CII', 'Chokepoints', 'CableHealth']) {
    assert.ok(!relaySource.includes(`startBootSeedLoop('${label}'`), `warm-ping ${label} must not be gated`);
  }
  // and the warm-pings still fire their immediate boot ping
  assert.match(relaySource, /seedServiceStatuses\(\)\.catch/);
  assert.match(relaySource, /seedCiiWarmPing\(\)\.catch/);
});

test('real-time pollers are NOT gated (must run continuously on every boot)', () => {
  for (const label of ['Telegram', 'Oref', 'OREF']) {
    assert.ok(!relaySource.includes(`startBootSeedLoop('${label}'`), `poller ${label} must not be gated`);
  }
});

test('bootSeedDelayMs fails open and keys on fetchedAt (source contract)', () => {
  // guard only engages when Upstash is on AND a key + positive interval are given
  assert.match(delayFnText, /if \(UPSTASH_ENABLED && metaKey && intervalMs > 0\)/);
  assert.match(delayFnText, /upstashGet\(metaKey, \(reason\) => \{/);
  // sane positive age strictly under the interval -> delay until the data is due
  assert.match(delayFnText, /if \(ageMs >= 0 && ageMs < intervalMs\)/);
  assert.match(delayFnText, /const delayMs = intervalMs - ageMs/);
  // terminal path always returns 0 delay (fail-open / not-fresh)
  assert.match(delayFnText, /return 0;\s*}$/);
  assert.doesNotMatch(delayFnText, /catch \(e\)/);
  assert.match(loopFnText, /setTimeout\(\(\) => \{/);
  assert.match(loopFnText, /\.finally\(startInterval\)/);
});
