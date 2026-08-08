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

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_KEYS, fetchInputData } from '../scripts/seed-correlation.mjs';
import { unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';

const REDIS_URL = 'https://correlation-seeder.test.upstash.io';
const MINUTE = 60_000;
const now = Date.now();

function seedEnvelope(data, fetchedAt = now) {
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
      generatedAt: new Date(now).toISOString(),
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
  function stubPipeline(byKey) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => INPUT_KEYS.map((key) => ({ result: byKey[key] ?? null })),
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
    // runSeed, so they carry no `_seed` and must not be touched.
    const payload = { flights: [{ hex: 'ae1234', type: 'bomber', lat: 35.1, lon: 33.4 }] };
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
        seedEnvelope({ earthquakes: [{ id: 'stale', magnitude: 7.1 }] }, now - 31 * MINUTE),
      ),
    });

    const data = await fetchInputData();
    assert.equal('seismology:earthquakes:v1' in data, false);
  });

  it('keeps an envelope inside its budget', async () => {
    const payload = { earthquakes: [{ id: 'fresh', magnitude: 7.1 }] };
    stubPipeline({
      'seismology:earthquakes:v1': JSON.stringify(seedEnvelope(payload, now - 29 * MINUTE)),
    });

    const data = await fetchInputData();
    assert.deepEqual(data['seismology:earthquakes:v1'], payload);
  });

  it('gives unrest the longer budget its own seeder declares', async () => {
    // seed-unrest-events.mjs runs with maxStaleMin: 120, so a 31-minute-old
    // envelope that would drop earthquakes must survive here.
    const payload = { events: [{ id: 'p1', country: 'FR' }] };
    stubPipeline({
      'unrest:events:v1': JSON.stringify(seedEnvelope(payload, now - 31 * MINUTE)),
    });

    const data = await fetchInputData();
    assert.deepEqual(data['unrest:events:v1'], payload);

    stubPipeline({
      'unrest:events:v1': JSON.stringify(seedEnvelope(payload, now - 121 * MINUTE)),
    });
    assert.equal('unrest:events:v1' in (await fetchInputData()), false);
  });

  it('never age-gates the bare flights keys', async () => {
    // No `_seed` means no fetchedAt to judge, and these keys are the only ones
    // still keeping the military domain alive today.
    const payload = { flights: [{ hex: 'ae1234', type: 'bomber' }], fetchedAt: now - 48 * 60 * MINUTE };
    stubPipeline({ 'military:flights:v1': JSON.stringify(payload) });

    const data = await fetchInputData();
    assert.deepEqual(data['military:flights:v1'], payload);
  });
});
