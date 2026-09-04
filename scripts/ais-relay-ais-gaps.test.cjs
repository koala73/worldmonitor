/**
 * Regression tests for the trusted AIS-gaps producer (#7574).
 *
 * The retired client-side `ais_gaps` baseline counted, per browser session,
 * vessels that returned after extended AIS silence. The trusted replacement
 * is the relay's dark-ship count, published as `maritime:ais-gaps:v1` and
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

const GAP_THRESHOLD_MS = 60 * 60 * 1000; // must match GAP_THRESHOLD in ais-relay.cjs
const { countDarkShips, seedAisGaps } = loadFunctions(['countDarkShips', 'seedAisGaps']);

// The eval'd function bodies resolve free variables against globalThis.
globalThis.GAP_THRESHOLD = GAP_THRESHOLD_MS;

// The wiring must target the keys the temporal-anomalies rebuild and the
// health monitor read — a renamed key would silently strand the producer.
assert.ok(relaySource.includes("const AIS_GAPS_REDIS_KEY = 'maritime:ais-gaps:v1';"),
  'AIS_GAPS_REDIS_KEY must stay maritime:ais-gaps:v1 (COUNT_SOURCE_KEYS #7574 reads it)');
assert.ok(relaySource.includes("'seed-meta:maritime:ais-gaps'"),
  'the seed loop must write seed-meta:maritime:ais-gaps (health registration)');

function makeHistory(...agesMs) {
  const now = Date.now();
  return agesMs.map((age) => now - age);
}

test('countDarkShips counts only vessels that returned after a long gap and are freshly seen', () => {
  globalThis.vesselHistory = new Map([
    // Returned after a >1h gap (2h25m), last seen 5min ago → dark.
    ['mmsi-dark', makeHistory(4 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 + 25 * 60 * 1000, 5 * 60 * 1000)],
    // 10min gap between the last two fixes → not dark.
    ['mmsi-brief', makeHistory(3 * 60 * 60 * 1000, 12 * 60 * 1000, 2 * 60 * 1000)],
    // Long gap but not seen again within 10min → not dark.
    ['mmsi-gone', makeHistory(4 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 + 25 * 60 * 1000, 30 * 60 * 1000)],
    // Single fix only → not dark.
    ['mmsi-lone', makeHistory(5 * 60 * 1000)],
  ]);
  try {
    assert.equal(countDarkShips(), 1);
  } finally {
    delete globalThis.vesselHistory;
  }
});

test('seedAisGaps publishes one envelope and one seed-meta stamp on a single clock', async () => {
  const writes = [];
  globalThis.vesselHistory = new Map([
    ['mmsi-dark', makeHistory(4 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 + 25 * 60 * 1000, 5 * 60 * 1000)],
  ]);
  globalThis.countDarkShips = countDarkShips;
  globalThis.AIS_GAPS_REDIS_KEY = 'maritime:ais-gaps:v1';
  globalThis.AIS_GAPS_TTL = 1800;
  globalThis.envelopeWrite = async (key, data, ttlSeconds, meta) => {
    writes.push({ key, data, ttlSeconds, meta });
    return true;
  };
  globalThis.upstashSet = async (key, value, ttlSeconds) => {
    writes.push({ key, value, ttlSeconds });
    return true;
  };

  try {
    await seedAisGaps();
  } finally {
    delete globalThis.vesselHistory;
    delete globalThis.countDarkShips;
    delete globalThis.AIS_GAPS_REDIS_KEY;
    delete globalThis.AIS_GAPS_TTL;
    delete globalThis.envelopeWrite;
    delete globalThis.upstashSet;
  }

  const envelope = writes.find((w) => w.key === 'maritime:ais-gaps:v1');
  assert.ok(envelope, 'must write the maritime:ais-gaps:v1 envelope');
  assert.equal(envelope.ttlSeconds, 1800);
  assert.equal(envelope.data.darkShips, 1, 'envelope data carries the dark-ship count');
  assert.equal(typeof envelope.data.sampledAt, 'number', 'envelope data carries the content clock');
  assert.equal(envelope.meta.recordCount, 1);
  assert.equal(envelope.meta.fetchedAt, envelope.data.sampledAt, '#6775: one clock for _seed and payload');

  const meta = writes.find((w) => w.key === 'seed-meta:maritime:ais-gaps');
  assert.ok(meta, 'must write the health seed-meta stamp');
  assert.equal(meta.value.fetchedAt, envelope.meta.fetchedAt, 'seed-meta and envelope agree on fetchedAt');
  assert.equal(meta.value.recordCount, 1);
});

test('seedAisGaps publishes OK_ZERO when no vessel went dark', async () => {
  const writes = [];
  globalThis.vesselHistory = new Map();
  globalThis.countDarkShips = countDarkShips;
  globalThis.AIS_GAPS_REDIS_KEY = 'maritime:ais-gaps:v1';
  globalThis.AIS_GAPS_TTL = 1800;
  globalThis.envelopeWrite = async (key, data, ttlSeconds, meta) => {
    writes.push({ key, data, ttlSeconds, meta });
    return true;
  };
  globalThis.upstashSet = async (key, value, ttlSeconds) => {
    writes.push({ key, value, ttlSeconds });
    return true;
  };

  try {
    await seedAisGaps();
  } finally {
    delete globalThis.vesselHistory;
    delete globalThis.countDarkShips;
    delete globalThis.AIS_GAPS_REDIS_KEY;
    delete globalThis.AIS_GAPS_TTL;
    delete globalThis.envelopeWrite;
    delete globalThis.upstashSet;
  }

  const envelope = writes.find((w) => w.key === 'maritime:ais-gaps:v1');
  assert.ok(envelope);
  assert.equal(envelope.data.darkShips, 0);
  assert.equal(envelope.meta.recordCount, 0);
  // Zero dark ships is a legitimate peaceful state, not a failed publish —
  // the producer opts into OK_ZERO grading (envelopeWrite derives the state).
  assert.equal(envelope.meta.zeroOk, true);
});
