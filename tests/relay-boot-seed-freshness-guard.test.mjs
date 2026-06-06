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
// `maybeBootSeed(label, metaKey, intervalMs, seedFn)` gates the boot seed on the
// existing seed-meta age and only runs the seed when a refresh is actually due.
//
// ais-relay.cjs calls server.listen() at top level and has no module.exports, so
// it cannot be imported. These tests (1) extract the real maybeBootSeed body and
// exercise its behavior against mocked Redis, and (2) assert the source wires
// every fixed-schedule external seeder through it while leaving the setInterval
// path — and real-time pollers / internal warm-pings — untouched.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

// ── Extract the real maybeBootSeed function body via brace-matching ──────────
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

const fnText = extractFunction(relaySource, 'async function maybeBootSeed(label, metaKey, intervalMs, seedFn)');

// Rebuild the function with its free variables injected as closure params.
// (It references UPSTASH_ENABLED, upstashGet, console, plus globals Date/Number/Math.)
function buildGuard({ enabled = true, get = async () => null } = {}) {
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]) };
  const factory = new Function('UPSTASH_ENABLED', 'upstashGet', 'console', `return (${fnText});`);
  return { guard: factory(enabled, get, fakeConsole), logs };
}

const MIN = 60 * 1000;

test('skips the boot seed when data is fresher than the interval', async () => {
  let called = false;
  const { guard } = buildGuard({ get: async () => ({ fetchedAt: Date.now() - 5 * MIN, recordCount: 10 }) });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, false, 'fresh data must suppress the boot seed');
});

test('runs the boot seed when data is older than the interval (refresh due)', async () => {
  let called = false;
  const { guard } = buildGuard({ get: async () => ({ fetchedAt: Date.now() - 200 * MIN, recordCount: 10 }) });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, true, 'stale data must trigger the boot seed');
});

test('runs the boot seed when there is no prior seed-meta', async () => {
  let called = false;
  const { guard } = buildGuard({ get: async () => null });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, true);
});

test('fails OPEN — a Redis read error still seeds (never starves a panel)', async () => {
  let called = false;
  const { guard, logs } = buildGuard({ get: async () => { throw new Error('redis down'); } });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, true, 'a meta read failure must fall through to seeding');
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && /freshness check failed/.test(String(msg))));
});

test('runs the boot seed when Upstash is disabled (no gate possible)', async () => {
  let called = false;
  const { guard } = buildGuard({ enabled: false, get: async () => ({ fetchedAt: Date.now() }) });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, true);
});

test('a future-dated fetchedAt (negative age) is treated defensively — seeds', async () => {
  let called = false;
  const { guard } = buildGuard({ get: async () => ({ fetchedAt: Date.now() + 60 * MIN }) });
  await guard('X', 'seed-meta:x', 180 * MIN, async () => { called = true; });
  assert.equal(called, true, 'corrupt future timestamp must not permanently suppress seeding');
});

test('intervalMs<=0 disables the gate (always seeds)', async () => {
  let called = false;
  const { guard } = buildGuard({ get: async () => ({ fetchedAt: Date.now() }) });
  await guard('X', 'seed-meta:x', 0, async () => { called = true; });
  assert.equal(called, true);
});

test('propagates the seedFn promise so the call site .catch still applies', async () => {
  const { guard } = buildGuard({ get: async () => null });
  await assert.rejects(
    () => guard('X', 'seed-meta:x', 180 * MIN, async () => { throw new Error('seed boom'); }),
    /seed boom/,
  );
});

// ── Wiring: every fixed-schedule external seeder routes its boot seed through
// maybeBootSeed with the exact (label, metaKey, intervalConst, seedFn). The
// exact-string match pins all four arguments so a future edit can't silently
// drift the meta key or interval and re-open the boot-abuse hole. ────────────
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
  test(`${label} boot seed is gated through maybeBootSeed(${intervalConst}, ${seedFn})`, () => {
    const call = `maybeBootSeed('${label}', ${metaKey}, ${intervalConst}, ${seedFn})`;
    assert.ok(relaySource.includes(call), `expected boot-seed wiring: ${call}`);
    // The setInterval (real-cadence) path must remain a direct, UNGATED call so a
    // long-lived relay still refreshes when the timer fires (data is due then).
    assert.ok(relaySource.includes(`${seedFn}().catch`), `${seedFn} interval path must stay a direct call`);
  });
}

test('exactly the expected number of boot seeds are gated (no drift)', () => {
  const count = (relaySource.match(/maybeBootSeed\('/g) || []).length;
  assert.equal(count, SEEDERS.length, `expected ${SEEDERS.length} gated boot seeds, found ${count}`);
});

// ── Exclusions: internal warm-pings short-circuit at their own endpoint when the
// data is fresh (cheap), so gating them adds risk for no benefit; real-time
// pollers must run continuously. None of these may be wrapped. ───────────────
test('internal warm-pings are NOT gated (self-limiting at the endpoint)', () => {
  for (const label of ['ServiceStatuses', 'CII', 'Chokepoints', 'CableHealth']) {
    assert.ok(!relaySource.includes(`maybeBootSeed('${label}'`), `warm-ping ${label} must not be gated`);
  }
  // and the warm-pings still fire their immediate boot ping
  assert.match(relaySource, /seedServiceStatuses\(\)\.catch/);
  assert.match(relaySource, /seedCiiWarmPing\(\)\.catch/);
});

test('real-time pollers are NOT gated (must run continuously on every boot)', () => {
  for (const label of ['Telegram', 'Oref', 'OREF']) {
    assert.ok(!relaySource.includes(`maybeBootSeed('${label}'`), `poller ${label} must not be gated`);
  }
});

test('maybeBootSeed fails open and keys on fetchedAt (source contract)', () => {
  // guard only engages when Upstash is on AND a key + positive interval are given
  assert.match(fnText, /if \(UPSTASH_ENABLED && metaKey && intervalMs > 0\)/);
  // sane positive age strictly under the interval → skip
  assert.match(fnText, /if \(ageMs >= 0 && ageMs < intervalMs\)/);
  // terminal path always seeds (fail-open / not-fresh)
  assert.match(fnText, /return seedFn\(\);\s*}$/);
});
