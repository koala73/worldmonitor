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
// every fixed-schedule external seeder AND internal warm-ping through the
// scheduler while leaving real-time pollers (Telegram/OREF) untouched.

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

function extractNamedFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)`).exec(src);
  assert.ok(match, `missing function: ${name}`);
  return extractFunction(src, match[0]);
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
  // Internal warm-pings — gated on the seed-meta key their own RPC handler writes,
  // so frequent relay recycling no longer re-pings these endpoints on every boot.
  // (Previously excluded; the endpoints self-limit, so gating is risk-free here —
  // a missing key fails open to an immediate ping — and also dedupes the boot ping
  // against organic traffic that already kept the cache warm.)
  ['ServiceStatuses', "'seed-meta:infra:service-statuses'", 'SERVICE_STATUSES_SEED_INTERVAL_MS', 'seedServiceStatuses'],
  ['CII', "'seed-meta:intelligence:risk-scores'", 'CII_WARM_PING_INTERVAL_MS', 'seedCiiWarmPing'],
  ['Chokepoints', "'seed-meta:supply_chain:chokepoints'", 'CHOKEPOINT_WARM_PING_INTERVAL_MS', 'seedChokepointWarmPing'],
  ['CableHealth', "'seed-meta:cable-health'", 'CABLE_HEALTH_WARM_PING_INTERVAL_MS', 'seedCableHealthWarmPing'],
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

test('every relay seed loop and warm-ping loop is routed through startBootSeedLoop instead of raw setInterval', () => {
  const seedLoopNames = [...relaySource.matchAll(/(?:async\s+)?function\s+(start[A-Za-z0-9]+(?:SeedLoop|WarmPingLoop))\s*\(/g)]
    .map(([, name]) => name)
    .filter((name) => name !== 'startBootSeedLoop');

  assert.ok(seedLoopNames.length > 0, 'expected to find relay seed/warm-ping loop functions');

  const rawIntervalSeedLoops = [];
  const ungatedSeedLoops = [];
  for (const name of seedLoopNames) {
    const fnText = extractNamedFunction(relaySource, name);
    if (/setInterval\s*\(/.test(fnText)) rawIntervalSeedLoops.push(name);
    if (!/startBootSeedLoop\(/.test(fnText)) ungatedSeedLoops.push(name);
  }

  assert.deepEqual(
    rawIntervalSeedLoops,
    [],
    `seed/warm-ping loops must not schedule raw setInterval; use startBootSeedLoop: ${rawIntervalSeedLoops.join(', ')}`,
  );
  assert.deepEqual(
    ungatedSeedLoops,
    [],
    `seed/warm-ping loops must call startBootSeedLoop: ${ungatedSeedLoops.join(', ')}`,
  );
});

// ── Internal warm-pings (ServiceStatuses, CII, Chokepoints, CableHealth) are
// gated like every other fixed-schedule seeder — each routes through
// startBootSeedLoop on the seed-meta key its RPC handler writes (asserted in the
// SEEDERS table above). They must NOT fire an unconditional immediate boot ping,
// so a relay reboot storm can't re-ping these endpoints on every recycle. ────────
test('internal warm-pings no longer fire an unconditional immediate boot ping', () => {
  for (const fn of ['seedServiceStatuses', 'seedCiiWarmPing', 'seedChokepointWarmPing', 'seedCableHealthWarmPing']) {
    assert.doesNotMatch(
      relaySource,
      new RegExp(`${fn}\\(\\)\\.catch`),
      `${fn} must be scheduled via startBootSeedLoop, not an ungated boot ping`,
    );
  }
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
