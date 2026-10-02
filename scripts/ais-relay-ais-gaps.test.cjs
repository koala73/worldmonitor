/**
 * Regression tests for the trusted AIS-gaps producer (#7574).
 *
 * The retired client-side `ais_gaps` baseline counted, per browser session,
 * vessels that returned after extended AIS silence. The trusted replacement
 * is the relay's dark-ship count, recorded at position ingestion (the
 * history map is pruned to the 30-min DENSITY_WINDOW, so a >1h silence can
 * never be reconstructed from it), published as `maritime:ais-gaps:v1` and
 * consumed by the temporal-anomalies rebuild via COUNT_SOURCE_KEYS.
 *
 * ais-relay.cjs starts an HTTP/WebSocket server and poll loops at top level
 * (no require.main guard), so it cannot be require()d from a test. As in
 * scripts/ais-relay-seed-fetchedat.test.cjs, we lift the real function bodies
 * out of the production source and eval them together, so the assertions run
 * against the shipped code, not a copy.
 *
 * Run: node --test scripts/ais-relay-ais-gaps.test.cjs
 */
'use strict';

const { strict: assert } = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const relaySource = readFileSync(join(__dirname, 'ais-relay.cjs'), 'utf8');

// Same extraction harness as scripts/ais-relay-seed-fetchedat.test.cjs,
// widened to `[\s\S]*?` inside the parameter list so default-valued params
// like `countDarkShips(now = Date.now())` still match.
function loadFunctions(names) {
  const bodies = names.map((name) => {
    const match = relaySource.match(new RegExp(`(?:async\\s+)?function ${name}\\([\\s\\S]*?\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `could not locate ${name}() in ais-relay.cjs`);
    return match[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

// The wiring must target the keys the temporal-anomalies rebuild and the
// health monitor read — a renamed key would silently strand the producer.
assert.ok(relaySource.includes("const AIS_GAPS_REDIS_KEY = 'maritime:ais-gaps:v1';"),
  'AIS_GAPS_REDIS_KEY must stay maritime:ais-gaps:v1 (COUNT_SOURCE_KEYS #7574 reads it)');
assert.ok(relaySource.includes("'seed-meta:maritime:ais-gaps'"),
  'the seed loop must write seed-meta:maritime:ais-gaps (health registration)');
// Pin the shipped constants the eval'd functions otherwise free-resolve: a
// relay-side change to either would silently desync this test from production.
assert.ok(relaySource.includes('const GAP_THRESHOLD = 60 * 60 * 1000'),
  'GAP_THRESHOLD must stay 1h in ais-relay.cjs');
assert.ok(relaySource.includes('const AIS_GAPS_TTL = 3600'),
  'AIS_GAPS_TTL must stay 3600 (must strictly exceed the 30min health budget)');
// The prior fix MUST come from vesselLastFixSeen (retention > GAP_THRESHOLD)
// and the sighting MUST be recorded at ingestion — cleanupAggregates prunes
// vesselHistory to the 30-min DENSITY_WINDOW and caps it at 10 entries, so
// neither a history-diffing form of this check nor a vesselHistory-sourced
// last fix can ever observe a >1h silence.
assert.ok(relaySource.includes('const lastFixAt = vesselLastFixSeen.get(mmsi);'),
  'the dark-ship return check must read the prior fix from vesselLastFixSeen');
assert.ok(relaySource.includes('darkShipReturns.set(mmsi, now)'),
  'dark-ship returns must be recorded at ingestion time in processPositionReportForSnapshot');
assert.ok(relaySource.includes('vesselLastFixSeen.set(mmsi, now)'),
  'the last-fix map must be updated on every position report');
assert.ok(relaySource.includes('const lastFixCutoff = now - LAST_FIX_RETENTION_MS;'),
  'vesselLastFixSeen must be retention-pruned in cleanupAggregates');
assert.ok(relaySource.includes('const LAST_FIX_RETENTION_MS = 6 * 60 * 60 * 1000;'),
  'last-fix retention must exceed GAP_THRESHOLD');

const GAP_THRESHOLD_MS = 60 * 60 * 1000; // mirrors the pinned production constant
const { countDarkShips, seedAisGaps } = loadFunctions(['countDarkShips', 'seedAisGaps']);

// The eval'd function bodies resolve free variables against globalThis.
globalThis.GAP_THRESHOLD = GAP_THRESHOLD_MS;

const STUB_GLOBALS = ['darkShipReturns', 'AIS_GAPS_REDIS_KEY', 'AIS_GAPS_TTL', 'countDarkShips', 'envelopeWrite', 'upstashSet', 'getAisPositionFreshness'];
function withStubs(stubs, fn) {
  const saved = {};
  for (const key of STUB_GLOBALS) {
    saved[key] = globalThis[key];
    if (stubs[key] !== undefined) globalThis[key] = stubs[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of STUB_GLOBALS) {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
      }
    });
}

function captureWrites() {
  const writes = [];
  const envelopeWrite = async (key, data, ttlSeconds, meta) => {
    writes.push({ kind: 'envelope', key, data, ttlSeconds, meta });
    return true;
  };
  const upstashSet = async (key, value, ttlSeconds) => {
    writes.push({ kind: 'meta', key, value, ttlSeconds });
    return true;
  };
  return { writes, envelopeWrite, upstashSet };
}

test('countDarkShips counts only returns seen again within the 10-minute window', () => {
  const now = Date.now();
  const darkShipReturns = new Map([
    ['mmsi-dark', now - 5 * 60 * 1000],
    ['mmsi-stale', now - 15 * 60 * 1000],
  ]);
  return withStubs({ darkShipReturns }, () => {
    assert.equal(countDarkShips(now), 1, 'a return older than 10min must not count');
    assert.equal(darkShipReturns.has('mmsi-stale'), false, 'stale sightings are pruned on read');
    assert.equal(darkShipReturns.has('mmsi-dark'), true, 'fresh sightings survive the read');
  });
});

test('seedAisGaps publishes one envelope and one seed-meta stamp on a single clock', () => {
  const now = Date.now();
  const { writes, envelopeWrite, upstashSet } = captureWrites();
  const darkShipReturns = new Map([['mmsi-dark', now - 5 * 60 * 1000]]);
  return withStubs({
    darkShipReturns,
    countDarkShips,
    AIS_GAPS_REDIS_KEY: 'maritime:ais-gaps:v1',
    AIS_GAPS_TTL: 3600,
    envelopeWrite,
    upstashSet,
    getAisPositionFreshness: () => ({ currentPositionReady: true, positionAgeMs: 1000 }),
  }, async () => {
    await seedAisGaps();

    const envelope = writes.find((w) => w.kind === 'envelope' && w.key === 'maritime:ais-gaps:v1');
    assert.ok(envelope, 'must write the maritime:ais-gaps:v1 envelope');
    assert.equal(envelope.ttlSeconds, 3600);
    assert.equal(envelope.data.darkShips, 1, 'envelope data carries the dark-ship count');
    assert.equal(typeof envelope.data.sampledAt, 'number', 'envelope data carries the content clock');
    assert.equal(envelope.meta.recordCount, 1);
    assert.equal(envelope.meta.fetchedAt, envelope.data.sampledAt, '#6775: one clock for _seed and payload');

    const meta = writes.find((w) => w.kind === 'meta' && w.key === 'seed-meta:maritime:ais-gaps');
    assert.ok(meta, 'must write the health seed-meta stamp');
    assert.equal(meta.value.fetchedAt, envelope.meta.fetchedAt, 'seed-meta and envelope agree on fetchedAt');
    assert.equal(meta.value.recordCount, 1);
  });
});

test('seedAisGaps publishes OK_ZERO when no vessel went dark', () => {
  const { writes, envelopeWrite, upstashSet } = captureWrites();
  return withStubs({
    darkShipReturns: new Map(),
    countDarkShips,
    AIS_GAPS_REDIS_KEY: 'maritime:ais-gaps:v1',
    AIS_GAPS_TTL: 3600,
    envelopeWrite,
    upstashSet,
    getAisPositionFreshness: () => ({ currentPositionReady: true, positionAgeMs: 1000 }),
  }, async () => {
    await seedAisGaps();

    const envelope = writes.find((w) => w.kind === 'envelope' && w.key === 'maritime:ais-gaps:v1');
    assert.ok(envelope);
    assert.equal(envelope.data.darkShips, 0);
    assert.equal(envelope.meta.recordCount, 0);
    // Zero dark ships is a legitimate peaceful state, not a failed publish —
    // the producer opts into OK_ZERO grading (envelopeWrite derives the state).
    assert.equal(envelope.meta.zeroOk, true);
  });
});

test('seedAisGaps skips BOTH writes while the AIS sensor is blind', () => {
  const { writes, envelopeWrite, upstashSet } = captureWrites();
  return withStubs({
    darkShipReturns: new Map([['mmsi-dark', Date.now() - 60 * 1000]]),
    countDarkShips,
    AIS_GAPS_REDIS_KEY: 'maritime:ais-gaps:v1',
    AIS_GAPS_TTL: 3600,
    envelopeWrite,
    upstashSet,
    getAisPositionFreshness: () => ({ currentPositionReady: false, positionAgeMs: 10 * 60 * 1000 }),
  }, async () => {
    await seedAisGaps();
    assert.equal(writes.length, 0, 'a blind sensor must not publish an OK it cannot back');
  });
});

test('seedAisGaps surfaces write failures instead of logging success', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const { envelopeWrite, upstashSet } = captureWrites();
  return withStubs({
    darkShipReturns: new Map(),
    countDarkShips,
    AIS_GAPS_REDIS_KEY: 'maritime:ais-gaps:v1',
    AIS_GAPS_TTL: 3600,
    envelopeWrite: async () => false,
    upstashSet,
    getAisPositionFreshness: () => ({ currentPositionReady: true, positionAgeMs: 1000 }),
  }, async () => {
    try {
      await seedAisGaps();
      assert.ok(
        warnings.some((line) => line.includes('[AisGaps] Seed write FAILED')),
        `expected a grep-able failure marker; saw ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
