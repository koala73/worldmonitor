// Regression test for the correlation seeder's input reads.
//
// scripts/seed-correlation.mjs read all nine of its INPUT_KEYS with a bare
// JSON.parse and no envelope unwrap. Seven of those keys are written by
// contract-mode seeders, which store `{ _seed, data }` (scripts/_seed-utils.mjs),
// so computeCorrelation's `data['<key>']?.<field>` reads were reading the
// envelope: every one of them resolved to undefined and fell through to `[]`.
//
// Only the `military:flights` pair survived, because seed-military-flights.mjs
// never migrated to runSeed and still writes bare. That left three of the four
// correlation domains — escalation, economic, disaster — computing over empty
// inputs while the seeder exited 0.
//
// It was silent by construction: the `hasAnyData` tripwire in computeCorrelation
// tests `data[k] != null`, and an envelope object is not null, so it never fired.
//
// Same defect and same fix as #5870 / #5896 one seeder over, and the same shape
// tests/regional-snapshot-envelope-unwrap.test.mjs pins a layer down.
//
// Every enveloped fixture below also asserts that the pre-fix shape — the raw
// envelope handed straight to the field read — produces nothing, so the bug
// stays pinned and cannot be reintroduced silently.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEconomicSignals,
  collectMilitarySignals,
  INPUT_KEYS,
  fetchInputData,
} from '../scripts/seed-correlation.mjs';
import { unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';

const REDIS_URL = 'https://correlation-seeder.test.upstash.io';
const MINUTE = 60_000;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
});

function seedEnvelope(data, fetchedAt = Date.now()) {
  return {
    _seed: {
      fetchedAt,
      sourceVersion: 'test-v1',
      schemaVersion: 1,
      recordCount: 1,
    },
    data,
  };
}

// Drive a stored value through exactly what fetchInputData does to a Redis
// string, so a fixture can never exercise a shape the reader cannot produce.
function asReadByTheSeeder(storedValue) {
  return unwrapEnvelope(JSON.parse(JSON.stringify(storedValue))).data;
}

// The seven contract-mode keys, each with the field computeCorrelation reads
// off it and the writer that publishes it.
const ENVELOPED_KEYS = [
  {
    key: 'unrest:events:v1',
    field: 'events',
    writer: 'scripts/seed-unrest-events.mjs',
    payload: { events: [{ id: 'p1', country: 'FR', size: 5_000 }] },
  },
  {
    key: 'infra:outages:v1',
    field: 'outages',
    writer: 'scripts/seed-internet-outages.mjs',
    payload: { outages: [{ id: 'o1', country: 'IR', severity: 'major' }] },
  },
  {
    key: 'seismology:earthquakes:v1',
    field: 'earthquakes',
    writer: 'scripts/seed-earthquakes.mjs',
    payload: { earthquakes: [{ id: 'us1', magnitude: 7.1, lat: 38.1, lon: 44.2 }] },
  },
  {
    key: 'market:stocks-bootstrap:v1',
    field: 'quotes',
    writer: 'scripts/seed-market-quotes.mjs',
    payload: { quotes: [{ symbol: '^VIX', changePercent: 12.4 }] },
  },
  {
    key: 'market:commodities-bootstrap:v1',
    field: 'quotes',
    writer: 'scripts/seed-commodity-quotes.mjs',
    payload: { quotes: [{ symbol: 'CL=F', changePercent: -4.2 }] },
  },
  {
    key: 'market:crypto:v1',
    field: 'quotes',
    writer: 'scripts/seed-crypto-quotes.mjs',
    payload: { quotes: [{ symbol: 'BTC-USD', changePercent: 6.8 }] },
  },
  {
    key: 'news:insights:v1',
    field: 'topStories',
    writer: 'scripts/seed-insights.mjs',
    payload: {
      topStories: [{ primaryTitle: 'Strait closure reported', threatLevel: 'high', lat: 26.5, lon: 56.2 }],
      generatedAt: new Date().toISOString(),
    },
  },
];

describe('fetchInputData envelope handling', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  // Stub the Upstash pipeline: `byKey` maps an input key to the raw string
  // Redis would return; anything unlisted comes back as a null result.
  function stubPipeline(byKey, pipelineEntries = {}) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => INPUT_KEYS.map((key) => (
        pipelineEntries[key] ?? { result: byKey[key] ?? null }
      )),
    });
  }

  it('pins the exact key set the correlation domains are built from', () => {
    assert.deepEqual(INPUT_KEYS, [
      'military:flights:v1',
      'military:flights:stale:v1',
      'unrest:events:v1',
      'infra:outages:v1',
      'seismology:earthquakes:v1',
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'news:insights:v1',
    ]);
  });

  for (const { key, field, writer, payload } of ENVELOPED_KEYS) {
    it(`unwraps ${key} down to the payload computeCorrelation reads (${writer})`, async () => {
      const stored = JSON.stringify(seedEnvelope(payload));
      stubPipeline({ [key]: stored });

      // Pre-fix: the bare parse stored the envelope, so the field read below —
      // the one computeCorrelation performs — resolved to undefined and the
      // domain fell through to an empty array.
      assert.equal(JSON.parse(stored)[field], undefined, 'the envelope must not expose the payload field');

      const data = await fetchInputData();
      assert.deepEqual(data[key], payload);
      assert.ok(Array.isArray(data[key][field]) && data[key][field].length > 0, `${field} must survive the read`);
      assert.deepEqual(data[key], asReadByTheSeeder(seedEnvelope(payload)));
    });
  }

  it('passes the bare military flights keys through unchanged', async () => {
    // seed-military-flights.mjs writes these with a local redisSet(), not
    // runSeed, so they carry no `_seed`; their top-level timestamp is retained.
    const payload = {
      flights: [{ hex: 'ae1234', type: 'bomber', lat: 35.1, lon: 33.4 }],
      fetchedAt: Date.now(),
    };
    stubPipeline({
      'military:flights:v1': JSON.stringify(payload),
      'military:flights:stale:v1': JSON.stringify(payload),
    });

    const data = await fetchInputData();
    assert.deepEqual(data['military:flights:v1'], payload);
    assert.deepEqual(data['military:flights:stale:v1'], payload);
  });

  it('passes a legacy top-level array through unchanged', async () => {
    // computeCorrelation still has an `Array.isArray(protestData)` fallback for
    // the pre-envelope shape; unwrapping must not break it.
    const payload = [{ id: 'p1', country: 'FR' }];
    stubPipeline({ 'unrest:events:v1': JSON.stringify(payload) });

    const data = await fetchInputData();
    assert.deepEqual(data['unrest:events:v1'], payload);
  });

  it('rejects a top-level array for a strict input policy', async () => {
    stubPipeline({
      'market:stocks-bootstrap:v1': JSON.stringify([{ symbol: '^VIX', changePercent: 12.4 }]),
    });

    const data = await fetchInputData();
    assert.equal('market:stocks-bootstrap:v1' in data, false);
  });

  it('skips malformed JSON instead of registering the raw string as a found key', async () => {
    // The `hasAnyData` tripwire in computeCorrelation tests `data[k] != null`,
    // so a raw string registered here would read as real input.
    stubPipeline({ 'unrest:events:v1': '{"events":[' });

    const data = await fetchInputData();
    assert.equal('unrest:events:v1' in data, false);
  });

  it('skips an envelope whose payload is null', async () => {
    stubPipeline({ 'infra:outages:v1': JSON.stringify(seedEnvelope(null)) });

    const data = await fetchInputData();
    assert.equal('infra:outages:v1' in data, false);
  });

  it('rejects parseable values that do not match the consumer field shape', async () => {
    const accepted = { earthquakes: [{ id: 'fresh', magnitude: 7.1 }] };
    stubPipeline({
      'seismology:earthquakes:v1': JSON.stringify(seedEnvelope(accepted)),
      'market:stocks-bootstrap:v1': JSON.stringify(seedEnvelope({ quotes: {} })),
      'market:commodities-bootstrap:v1': JSON.stringify(seedEnvelope(42)),
      'market:crypto:v1': JSON.stringify(seedEnvelope({ quotes: [null] })),
      'news:insights:v1': JSON.stringify(seedEnvelope({ topStories: {} })),
    });

    const data = await fetchInputData();
    assert.deepEqual(data, { 'seismology:earthquakes:v1': accepted });
  });

  it('emits one payload-free discard summary for a partial read', async () => {
    const sentinel = 'must-not-reach-logs';
    const pipelineError = 'ERR test';
    stubPipeline({
      'unrest:events:v1': JSON.stringify(seedEnvelope({ events: [{ id: 'valid' }] })),
      'infra:outages:v1': JSON.stringify(seedEnvelope(null)),
      'seismology:earthquakes:v1': '{"earthquakes":[',
      'market:stocks-bootstrap:v1': JSON.stringify(seedEnvelope({ quotes: { sentinel } })),
    }, {
      'market:crypto:v1': { error: pipelineError },
    });

    const warnings = [];
    console.warn.mock.mockImplementation((...args) => warnings.push(args));
    const data = await fetchInputData();
    assert.deepEqual(data['unrest:events:v1'], { events: [{ id: 'valid' }] });
    assert.equal('market:crypto:v1' in data, false);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], '  [Correlation] discarded Redis inputs');
    assert.deepEqual(warnings[0][1].byReason, {
      invalid_shape: 1,
      malformed_json: 1,
      missing: 4,
      null_payload: 1,
      pipeline_error: 1,
    });
    assert.equal(JSON.stringify(warnings).includes(sentinel), false);
    assert.equal(JSON.stringify(warnings).includes(pipelineError), false);
  });

  it('fails closed with one payload-free summary for a non-array pipeline body', async () => {
    const sentinel = 'must-not-reach-logs';
    const warnings = [];
    console.warn.mock.mockImplementation((...args) => warnings.push(args));

    for (const body of [null, { result: sentinel }]) {
      warnings.length = 0;
      globalThis.fetch = async () => ({ ok: true, json: async () => body });

      assert.deepEqual(await fetchInputData(), {});
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], '  [Correlation] discarded Redis inputs');
      assert.deepEqual(warnings[0][1].byReason, { invalid_pipeline_shape: INPUT_KEYS.length });
      assert.deepEqual(
        warnings[0][1].inputs,
        INPUT_KEYS.map((key) => ({ key, reason: 'invalid_pipeline_shape' })),
      );
      assert.equal(JSON.stringify(warnings).includes(sentinel), false);
    }
  });
});

describe('fetchInputData freshness gate', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  function stubPipeline(byKey) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => INPUT_KEYS.map((key) => ({ result: byKey[key] ?? null })),
    });
  }

  it('drops a preserved envelope past its source freshness budget', async () => {
    // runSeed extends a last-good key without advancing _seed.fetchedAt, so
    // without this gate unwrapping revives stale observations into cards
    // stamped `computedAt: Date.now()`.
    stubPipeline({
      'seismology:earthquakes:v1': JSON.stringify(
        seedEnvelope({ earthquakes: [{ id: 'stale', magnitude: 7.1 }] }, Date.now() - 31 * MINUTE),
      ),
    });

    const data = await fetchInputData();
    assert.equal('seismology:earthquakes:v1' in data, false);
  });

  it('keeps an envelope inside its budget', async () => {
    const payload = { earthquakes: [{ id: 'fresh', magnitude: 7.1 }] };
    stubPipeline({
      'seismology:earthquakes:v1': JSON.stringify(seedEnvelope(payload, Date.now() - 29 * MINUTE)),
    });

    const data = await fetchInputData();
    assert.deepEqual(data['seismology:earthquakes:v1'], payload);
  });

  it('gives unrest the longer budget its own seeder declares', async () => {
    // seed-unrest-events.mjs runs with maxStaleMin: 120, so a 31-minute-old
    // envelope that would drop earthquakes must survive here.
    const payload = { events: [{ id: 'p1', country: 'FR' }] };
    stubPipeline({
      'unrest:events:v1': JSON.stringify(seedEnvelope(payload, Date.now() - 31 * MINUTE)),
    });

    const data = await fetchInputData();
    assert.deepEqual(data['unrest:events:v1'], payload);

    stubPipeline({
      'unrest:events:v1': JSON.stringify(seedEnvelope(payload, Date.now() - 121 * MINUTE)),
    });
    assert.equal('unrest:events:v1' in (await fetchInputData()), false);
  });

  it('keeps a bare flights payload inside the military freshness budget', async () => {
    const payload = { flights: [{ hex: 'ae1234', type: 'bomber' }], fetchedAt: Date.now() - 29 * MINUTE };
    stubPipeline({ 'military:flights:v1': JSON.stringify(payload) });

    const data = await fetchInputData();
    assert.deepEqual(data['military:flights:v1'], payload);
  });

  it('drops both bare flights keys past the military freshness budget', async () => {
    const payload = { flights: [{ hex: 'ae1234', type: 'bomber' }], fetchedAt: Date.now() - 31 * MINUTE };
    stubPipeline({
      'military:flights:v1': JSON.stringify(payload),
      'military:flights:stale:v1': JSON.stringify(payload),
    });

    const data = await fetchInputData();
    assert.equal('military:flights:v1' in data, false);
    assert.equal('military:flights:stale:v1' in data, false);
  });

  for (const { name, fetchedAt } of [
    { name: 'missing', fetchedAt: () => undefined },
    { name: 'string', fetchedAt: () => 'not-a-number' },
    { name: 'non-finite', fetchedAt: () => Number.POSITIVE_INFINITY },
    { name: 'future', fetchedAt: () => Date.now() + MINUTE },
  ]) {
    it(`rejects a bare flights payload with a ${name} fetchedAt`, async () => {
      const payload = { flights: [{ hex: 'ae1234', type: 'bomber' }] };
      const value = fetchedAt();
      if (value !== undefined) payload.fetchedAt = value;
      stubPipeline({ 'military:flights:v1': JSON.stringify(payload) });

      const warnings = [];
      console.warn.mock.mockImplementation((...args) => warnings.push(args));
      const data = await fetchInputData();

      assert.equal('military:flights:v1' in data, false);
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0][1].byReason, {
        invalid_fetched_at: 1,
        missing: 8,
      });
      assert.equal(JSON.stringify(warnings).includes(String(value)), false);
    });
  }
});

describe('military flight observation timestamps', () => {
  it('uses the producer lastSeenMs instead of making an old flight current', () => {
    const lastSeenMs = Date.now() - 2 * 60 * MINUTE;
    const signals = collectMilitarySignals([{
      hexCode: 'ae1234',
      aircraftType: 'bomber',
      lat: 35.1,
      lon: 33.4,
      lastSeenMs,
    }]);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].timestamp, lastSeenMs);
  });

  it('filters a producer lastSeenMs older than the 24-hour window', () => {
    const signals = collectMilitarySignals([{
      hexCode: 'ae1234',
      aircraftType: 'bomber',
      lat: 35.1,
      lon: 33.4,
      lastSeenMs: Date.now() - 24 * 60 * MINUTE - MINUTE,
    }]);

    assert.deepEqual(signals, []);
  });

  it('parses and filters an old numeric lastSeenMs string', () => {
    const signals = collectMilitarySignals([{
      hexCode: 'ae1234',
      aircraftType: 'bomber',
      lat: 35.1,
      lon: 33.4,
      lastSeenMs: String(Date.now() - 24 * 60 * MINUTE - MINUTE),
    }]);

    assert.deepEqual(signals, []);
  });

  it('rejects an invalid supplied lastSeenMs string', () => {
    const signals = collectMilitarySignals([{
      hexCode: 'ae1234',
      aircraftType: 'bomber',
      lat: 35.1,
      lon: 33.4,
      lastSeenMs: 'not-a-timestamp',
    }]);

    assert.deepEqual(signals, []);
  });

  it('rejects a future lastSeenMs value', () => {
    const signals = collectMilitarySignals([{
      hexCode: 'ae1234',
      aircraftType: 'bomber',
      lat: 35.1,
      lon: 33.4,
      lastSeenMs: Date.now() + MINUTE,
    }]);

    assert.deepEqual(signals, []);
  });
});

describe('economic record validation', () => {
  it('skips a quote with a string change while retaining a valid quote', () => {
    const signals = collectEconomicSignals([
      { symbol: 'BAD', display: 'Malformed', price: 100, change: '2.5' },
      { symbol: 'CL=F', display: 'Crude Oil', price: 75, change: 2.5 },
    ], []);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].symbol, 'CL=F');
    assert.equal(signals[0].label, 'Crude Oil +2.5%');
  });
});
