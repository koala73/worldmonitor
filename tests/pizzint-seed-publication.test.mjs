import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { __testing__ as health } from '../api/health.js';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const envelopeWriter = relay.slice(relay.indexOf('function buildEnvelope('), relay.indexOf('// Envelope-aware read.'));
const envelopeReader = relay.slice(relay.indexOf('async function envelopeRead('), relay.indexOf('function notifySimpleHash('));
const producer = relay.slice(relay.indexOf('const PIZZINT_SEED_INTERVAL_MS'), relay.indexOf('function startPizzintSeedLoop()'));
const history = await import('../scripts/shared/pizzint-history.cjs');
const emptyResponse = {
  success: true, data: [], events: [], overall_index: 0, defcon_level: 5,
  active_spikes: 0, has_active_spikes: false, timestamp: '2026-09-25T12:09:33.653Z',
  method: 'serverless', data_freshness: 'old',
};
const validResponse = { success: true, data: [{
  place_id: 'test-location', name: 'Test location', current_popularity: 75,
  percentage_of_usual: 150, data_freshness: 'fresh', recorded_at: '2026-09-25T11:39:00Z',
}] };

function harness() {
  const state = {
    source: validResponse, writes: [], warnings: [], cache: new Map(), now: 1_790_335_140_000, failPayload: false,
    urls: [], gdelt: { ok: true, status: 200, json: async () => ({}) },
    env: {}, besttime: new Map(), besttimeCalls: [], historyCalls: [], failHistory: false,
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({
    Date: Clock, AbortSignal, CHROME_UA: 'test', console: { log() {}, warn: (...args) => state.warnings.push(args) },
    process: { env: state.env },
    upstashGet: async (key) => {
      const cached = state.cache.get(key);
      return cached && cached.expiresAt > state.now ? structuredClone(cached.data) : null;
    },
    fetch: async (url, init) => {
      state.urls.push(url);
      if (url.includes('besttime.app')) {
        state.besttimeCalls.push({ url, method: init?.method });
        const reply = state.besttime.get(new URL(url).searchParams.get('venue_id'));
        if (reply instanceof Error) throw reply;
        return reply ?? { ok: true, status: 200, json: async () => liveUnavailable };
      }
      if (url.includes('dashboard-data') && state.source instanceof Error) throw state.source;
      return url.includes('dashboard-data') ? { ok: true, json: async () => state.source } : state.gdelt;
    },
    upstashSet: async (key, data, ttl) => {
      if (key === payloadKey && state.failPayload) return false;
      state.writes.push(key);
      state.cache.set(key, { data: structuredClone(data), expiresAt: state.now + ttl * 1000 });
      return true;
    },
    recordPizzintHistory: async (input, evalCommand) => {
      state.historyCalls.push(structuredClone(input));
      if (state.failHistory) throw new Error('secret archive failure');
      return history.default.recordPizzintHistory(input, evalCommand);
    },
    upstashEval: async () => state.historyWait ? await state.historyWait : [1, 0, 0, 1],
  });
  vm.runInContext(envelopeWriter + envelopeReader + producer, context);
  return { state, seed: () => vm.runInContext('seedPizzint()', context) };
}

test('archives the normalized poll through the real helper', async () => {
  const { state, seed } = harness();
  await seed();
  assert.equal(state.historyCalls.length, 1);
  assert.equal(state.historyCalls[0].provider, 'pizzint');
  assert.equal(state.historyCalls[0].locations[0].placeId, 'test-location');
});

test('an archive failure logs a fixed category and does not block publication', async () => {
  const { state, seed } = harness();
  state.failHistory = true;
  await seed();
  assert.ok(state.cache.has(payloadKey));
  assert.deepEqual(state.warnings, [['[PizzINT] History archive failed']]);
});

test('a pending archive does not delay live publication or permit overlapping polls', async () => {
  const { state, seed } = harness();
  let finish;
  state.historyWait = new Promise((resolve) => { finish = resolve; });
  const pending = seed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(state.cache.has(payloadKey));
  await seed();
  assert.equal(state.historyCalls.length, 1);
  finish([1, 0, 0, 1]);
  await pending;
});

const liveUnavailable = { status: 'Error', message: 'No live data available.', analysis: { venue_live_busyness_available: false, venue_forecasted_busyness: 20 }, venue_info: { venue_open: 'Open' } };
const liveReading = (live, forecast, extra = {}) => ({
  ok: true, status: 200, json: async () => ({
    status: 'OK',
    analysis: { venue_live_busyness: live, venue_live_busyness_available: true, venue_forecast_busyness_available: true, venue_forecasted_busyness: forecast, venue_live_forecasted_delta: live - forecast },
    venue_info: { venue_open: 'Open', venue_address: '1419 S Fern St Arlington VA 22202', ...extra },
  }),
});

const payloadKey = 'intelligence:pizzint:seed:v1';
const metaKey = 'seed-meta:intelligence:pizzint';

for (const [reason, response] of [
  ['unsuccessful_response', { success: false, data: [] }],
  ['non_array_data', { success: true, data: { token: 'synthetic-secret' } }],
  ['empty_array', { success: true, data: [] }],
]) {
  test(`classifies ${reason} without logging response content or changing publication`, async () => {
    const { state, seed } = harness();
    await seed();
    const previous = structuredClone(state.cache);
    state.now += 600_000;
    state.source = {
      ...response,
      message: 'https://example.invalid/?token=synthetic-secret',
      token: 'synthetic-secret',
      reason: 'synthetic-secret\nforged log entry',
    };
    await seed();
    assert.deepEqual(state.warnings, [[
      `[PizzINT] No data in API response (${reason}); preserving last good observation`,
    ]], 'only the fixed category is logged; no payload fields or extra arguments');
    assert.deepEqual(state.cache, previous);
    assert.equal(state.writes.length, 2);
  });
}

test('empty upstream response preserves the last observation and its original expiry', async () => {
  const { state, seed } = harness();
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.defconLevel, 5);
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.source = emptyResponse;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('first-run emptiness publishes no normal activity and a later valid response recovers', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  await seed();
  assert.equal(state.cache.size, 0);
  state.source = validResponse;
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.locationsMonitored, 1);
  assert.equal(state.cache.get(metaKey).data.recordCount, 1);
});

test('failed payload publication does not advance success metadata', async () => {
  const { state, seed } = harness();
  await seed();
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.failPayload = true;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('a sustained empty source still expires the payload and fails the real health classifier', async () => {
  const { state, seed } = harness();
  await seed();
  const classify = () => health.classifyKey('pizzint', payloadKey, { allowOnDemand: false }, {
    keyStrens: new Map([[payloadKey, state.now < state.cache.get(payloadKey).expiresAt ? 100 : 0]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify(state.cache.get(metaKey).data)]]),
    now: state.now,
  });
  assert.equal(classify().status, 'OK');
  state.source = emptyResponse;
  state.now += 31 * 60_000;
  await seed();
  const expired = classify();
  assert.notEqual(expired.status, 'OK');
  assert.equal(expired.seedAgeMin, 31);
  assert.ok(['warn', 'crit'].includes(health.STATUS_COUNTS[expired.status]));
});

// Tensions are published by the bulk materializer independently of pizza.
test('does not request or publish PizzINT GDELT tensions', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: true, status: 200, json: async () => ({
    usa_iran: [{ t: '20260924', v: 2 }, { t: '20260925', v: 3 }],
  }) };
  await seed();
  assert.equal(state.urls.some((url) => url.includes('gdelt/batch')), false);
  const payload = JSON.stringify(state.cache.get(payloadKey).data);
  assert.match(payload, /"tensionPairs":\[\]/);
});

test('a broken PizzINT GDELT endpoint has no effect on pizza publication', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: false, status: 400, json: async () => ({ error: 'synthetic-secret' }) };
  await seed();
  assert.deepEqual(state.warnings, []);
  assert.ok(state.writes.includes(payloadKey), 'a GDELT failure never blocks the PizzINT publication');
});

// PizzINT's own backend went empty on 2026-09-25 (dashboard-data `data: []`,
// neh-index and gdelt/batch 500 "Failed to fetch data from Supabase"). BestTime
// live busyness for the same Pentagon-area venues replaces the feed while it is
// down; without a live reading nothing is published, as before.
const BESTTIME_KEY = 'pri_test_secret_value';
for (const [label, baseline] of [
  ['unavailable forecast', { venue_forecast_busyness_available: false, venue_forecasted_busyness: 0, venue_live_forecasted_delta: 60 }],
  ['missing forecast', { venue_forecast_busyness_available: true }],
  ['non-finite forecast', { venue_forecast_busyness_available: true, venue_forecasted_busyness: NaN }],
  ['zero forecast', { venue_forecast_busyness_available: true, venue_forecasted_busyness: 0 }],
]) {
  test(`keeps live readings without inventing spikes from ${label}`, async () => {
    const { state, seed } = harness();
    state.source = emptyResponse;
    state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
    await seed();
    for (const { url } of state.besttimeCalls) {
      state.besttime.set(new URL(url).searchParams.get('venue_id'), {
        ok: true, json: async () => ({
          analysis: { venue_live_busyness_available: true, venue_live_busyness: 60, ...baseline },
          venue_info: { venue_open: 'Open' },
        }),
      });
    }
    await seed();
    const { pizzint } = state.cache.get(payloadKey).data.data;
    assert.equal(pizzint.aggregateActivity, 60);
    assert.equal(pizzint.activeSpikes, 0);
    assert.equal(pizzint.defconLevel, 5);
    for (const location of pizzint.locations) {
      assert.equal(location.percentageOfUsual, 0);
      assert.equal(location.spikeMagnitude, 0);
    }
  });
}

test('falls back to BestTime live busyness when PizzINT is empty', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  assert.ok(ids.length >= 4, 'every registered venue is polled');
  assert.ok(state.besttimeCalls.every(({ method, url }) => method === 'POST' && new URL(url).pathname === '/api/v1/forecasts/live'));
  assert.equal(state.cache.has(payloadKey), false, 'no live reading, nothing published');
  assert.deepEqual(state.warnings.at(-1), [`[PizzINT] BestTime fallback: no live readings (0/${ids.length} venues); preserving last good observation`]);

  state.besttime.set(ids[0], liveReading(90, 40));
  state.besttime.set(ids[1], liveReading(30, 35));
  state.besttime.set(ids[2], new Error(`network down ${BESTTIME_KEY}`));
  state.now += 600_000;
  await seed();
  const { data } = state.cache.get(payloadKey);
  const payload = JSON.stringify(data);
  const { pizzint } = data.data ?? data;
  assert.equal(pizzint.locationsMonitored, 2, 'only venues with a live reading are published');
  assert.equal(pizzint.activeSpikes, 0);
  assert.equal(pizzint.aggregateActivity, 60);
  assert.equal(pizzint.defconLevel, 5, 'the first anomaly has not persisted');
  const [spike, calm] = pizzint.locations;
  assert.deepEqual(
    { id: spike.placeId, pop: spike.currentPopularity, pct: spike.percentageOfUsual, spike: spike.isSpike, mag: spike.spikeMagnitude, src: spike.dataSource, fresh: spike.dataFreshness },
    { id: ids[0], pop: 90, pct: 225, spike: false, mag: 0, src: 'besttime', fresh: 'DATA_FRESHNESS_FRESH' },
  );
  assert.equal(calm.isSpike, false);
  assert.equal(calm.percentageOfUsual, 86);
  assert.equal(state.cache.get(metaKey).data.recordCount, 2);
  assert.doesNotMatch(payload + JSON.stringify(state.warnings), /pri_test_secret_value/);
});

test('never calls BestTime while PizzINT answers or without a key', async () => {
  const withKey = harness();
  withKey.state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await withKey.seed();
  assert.equal(withKey.state.besttimeCalls.length, 0);
  assert.match(JSON.stringify(withKey.state.cache.get(payloadKey).data), /test-location/);

  const noKey = harness();
  noKey.state.source = emptyResponse;
  await noKey.seed();
  assert.equal(noKey.state.besttimeCalls.length, 0);
  assert.equal(noKey.state.cache.has(payloadKey), false);
});

test('marks a live venue that BestTime reports closed and keeps it out of the open average', async () => {
  const { state, seed } = harness();
  state.source = { success: false };
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  state.besttimeCalls.length = 0;
  state.besttime.set(ids[0], liveReading(40, 40));
  state.besttime.set(ids[1], liveReading(80, 20, { venue_open: 'Closed' }));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.equal(pizzint.locationsOpen, 1);
  assert.equal(pizzint.aggregateActivity, 40);
  assert.equal(pizzint.locations[1].isClosedNow, true);
});

test('falls back to BestTime when the PizzINT request itself fails', async () => {
  const { state, seed } = harness();
  state.source = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  assert.ok(ids.length >= 4, 'a thrown PizzINT fetch still reaches the fallback');
  state.besttime.set(ids[0], liveReading(50, 40));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.equal(pizzint.locationsMonitored, 1);
});

test('ignores a BestTime error response even when its body looks like a live reading', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  state.besttime.set(ids[0], { ...liveReading(90, 40), ok: false, status: 429 });
  state.besttime.set(ids[1], liveReading(30, 35));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.deepEqual(pizzint.locations.map((l) => l.placeId), [ids[1]]);
});

// 2026-09-27: the public key was set as BESTTIME_API_KEY_PRIVATE. BestTime answered
// every venue HTTP 400 "Invalid private API key", which logged as "no live readings".
test('reports a rejected BestTime request instead of calling it no live readings', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  for (const id of ids) {
    state.besttime.set(id, { ok: false, status: 400, json: async () => ({ status: 'Error', message: `Error: Invalid private API key ${BESTTIME_KEY}` }) });
  }
  state.warnings.length = 0;
  await seed();
  assert.deepEqual(state.warnings.at(-1), [
    `[PizzINT] BestTime fallback: no live readings (0/${ids.length} venues; ${ids.length} rejected: HTTP 400 Error: Invalid private API key ***); preserving last good observation`,
  ]);
  assert.doesNotMatch(JSON.stringify(state.warnings), /pri_test_secret_value/);
});

async function besttimeHarness(readings) {
  const run = harness();
  run.state.source = emptyResponse;
  run.state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await run.seed();
  const ids = run.state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  readings.forEach(([live, forecast], i) => run.state.besttime.set(ids[i], liveReading(live, forecast)));
  return { ...run, ids, status: () => run.state.cache.get(payloadKey).data.data.pizzint };
}

test('normal Sunday lunch publishes DEFCON 5 even when a venue is 100% busy', async () => {
  const run = await besttimeHarness([[50, 45], [40, 40], [30, 35], [100, 100]]);
  await run.seed();
  assert.equal(run.status().defconLevel, 5);
  assert.equal(run.status().activeSpikes, 0);
});

test('September 27 readings cannot raise DEFCON on their first observation', async () => {
  const run = await besttimeHarness([[70, 45], [0, 40], [65, 35], [100, 100]]);
  await run.seed();
  assert.equal(run.status().defconLevel, 5);
  assert.equal(run.status().activeSpikes, 0);
});

test('open live zero with forecast 40 is no live signal and excluded from the open average', async () => {
  const run = await besttimeHarness([[0, 40], [100, 100]]);
  await run.seed();
  assert.equal(run.status().locations[0].noLiveSignal, true);
  assert.equal(run.status().locationsOpen, 1);
  assert.equal(run.status().aggregateActivity, 100);
});

test('a real zero against a small baseline remains distinct from an unavailable baseline', async () => {
  const run = await besttimeHarness([[0, 10], [60, 0]]);
  await run.seed();
  const [quiet, unknown] = run.status().locations;
  assert.equal(quiet.hasBaseline, true);
  assert.equal(quiet.percentageOfUsual, 0);
  assert.equal(quiet.noLiveSignal, false);
  assert.equal(unknown.hasBaseline, false);
  assert.equal(unknown.noLiveSignal, false);
  assert.equal(run.status().locationsOpen, 2);
});

async function advance(run, minutes = 10) {
  run.state.now += minutes * 60_000;
  await run.seed();
}

test('September 27 anomalies sustained for 20 minutes publish DEFCON 4', async () => {
  const run = await besttimeHarness([[70, 45], [0, 40], [65, 35], [100, 100]]);
  await run.seed();
  await advance(run);
  assert.equal(run.status().defconLevel, 5, '10 elapsed minutes is not 20');
  await advance(run);
  assert.equal(run.status().activeSpikes, 2);
  assert.equal(run.status().defconLevel, 4);
});

test('three late-night surges at twice forecast sustained for 20 minutes publish DEFCON 3', async () => {
  const run = await besttimeHarness([[60, 30], [60, 30], [60, 30]]);
  await run.seed();
  await advance(run);
  await advance(run);
  assert.equal(run.status().activeSpikes, 3);
  assert.equal(run.status().defconLevel, 3);
});

test('single-reading blip never raises DEFCON and small baselines do not create spikes', async () => {
  const run = await besttimeHarness([[70, 30], [10, 5]]);
  await run.seed();
  assert.equal(run.status().defconLevel, 5);
  run.state.besttime.set(run.ids[0], liveReading(30, 30));
  await advance(run);
  await advance(run);
  assert.equal(run.status().activeSpikes, 0);
  assert.equal(run.status().defconLevel, 5);
});

test('a missed polling interval resets persistence', async () => {
  const run = await besttimeHarness([[90, 30], [90, 30], [90, 30]]);
  await run.seed();
  await advance(run, 20);
  assert.equal(run.status().activeSpikes, 0);
  await advance(run);
  assert.equal(run.status().activeSpikes, 0);
  await advance(run);
  assert.equal(run.status().activeSpikes, 3);
});

test('equivalent PizzINT and BestTime observations use the same rule, ignoring provider DEFCON', async () => {
  const best = await besttimeHarness([[60, 30], [60, 30], [60, 30]]);
  const primary = harness();
  const setPrimary = () => {
    primary.state.source = { success: true, defcon_level: 1, overall_index: 100, data: [0, 1, 2].map(i => ({
      place_id: String(i), current_popularity: 60, percentage_of_usual: 200,
      is_spike: true, data_freshness: 'fresh', recorded_at: new Date(primary.state.now).toISOString(),
    })) };
  };
  for (let i = 0; i < 3; i++) {
    setPrimary();
    await primary.seed();
    await best.seed();
    const actual = primary.state.cache.get(payloadKey).data.data.pizzint;
    assert.equal(actual.defconLevel, best.status().defconLevel);
    assert.equal(actual.activeSpikes, best.status().activeSpikes);
    primary.state.now += 600_000;
    best.state.now += 600_000;
  }
  assert.equal(best.status().defconLevel, 3);
});

test('repeated provider timestamps cannot establish persistence', async () => {
  const run = harness();
  run.state.source = { ...validResponse, data: [{ ...validResponse.data[0], recorded_at: new Date(run.state.now).toISOString() }] };
  await run.seed();
  await advance(run);
  assert.equal(run.state.cache.get(payloadKey).data.data.pizzint.locations[0].anomalyStartedAt, run.state.now);
  await advance(run);
  assert.equal(run.state.cache.get(payloadKey).data.data.pizzint.activeSpikes, 0);
});

test('all missing live signals preserve the previous payload and expiry', async () => {
  const run = await besttimeHarness([[40, 40]]);
  await run.seed();
  const previous = structuredClone(run.state.cache);
  run.state.besttime.set(run.ids[0], liveReading(0, 40));
  await advance(run);
  assert.deepEqual(run.state.cache, previous);
});

for (const currentPopularity of [0, undefined]) {
  test(`PizzINT ${currentPopularity === 0 ? 'zero without a recoverable baseline' : 'missing live value'} is no data, not quiet`, async () => {
    const run = harness();
    await run.seed();
    const previous = structuredClone(run.state.cache);
    const missing = { ...validResponse.data[0], current_popularity: currentPopularity, percentage_of_usual: 0 };
    run.state.source = { success: true, data: [missing] };
    await advance(run);
    assert.deepEqual(run.state.cache, previous, 'all missing signals must preserve expiry');
    run.state.source.data.push({ ...validResponse.data[0], place_id: 'normal', current_popularity: 100, percentage_of_usual: 100 });
    await advance(run);
    const status = run.state.cache.get(payloadKey).data.data.pizzint;
    assert.equal(status.locations[0].noLiveSignal, true);
    assert.equal(status.locationsOpen, 1);
    assert.equal(status.aggregateActivity, 100);
  });
}
