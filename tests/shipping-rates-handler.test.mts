import assert from 'node:assert/strict';
import { describe, it, afterEach, beforeEach } from 'node:test';

import { getShippingRates } from '../server/worldmonitor/supply-chain/v1/get-shipping-rates';

// The seeder writes the four decision-grade period-change fields as explicit
// JSON `null` when the exchange published no comparable prior (#6066), while
// `ShippingIndex` declares them `optional` — meaning ABSENT, not null (the
// generated client types them `number | undefined`, and the OpenAPI schema
// types them as a bare `number` with no `nullable`). #6078 declared the fields;
// these tests pin that what the endpoint actually serves matches that
// declaration, which the seeder-side contract gate cannot see.
//
// Driven end-to-end through the real handler with a stubbed transport rather
// than by unit-testing the normalizer: a normalizer that exists but is not
// wired into getShippingRates would pass any test that called it directly.

const REAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};

function seedRedisWith(payload: unknown, capture?: { url?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (capture) capture.url = String(input);
    return new Response(JSON.stringify({ result: JSON.stringify(payload) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function index(overrides: Record<string, unknown> = {}) {
  return {
    indexId: 'CCFI',
    name: 'CCFI - China Container Freight',
    currentValue: 1072.16,
    previousValue: 1054.38,
    changePct: 1.69,
    unit: 'index',
    history: [{ date: '2026-03-13', value: 1072.16 }],
    spikeAlert: false,
    periodChangePct: 1.69,
    periodChangeBasis: 'publisher_reported',
    priorPeriodValue: 1054.38,
    priorPeriodDate: '2026-03-06',
    ...overrides,
  };
}

const PERIOD_FIELDS = ['periodChangePct', 'periodChangeBasis', 'priorPeriodValue', 'priorPeriodDate'];

describe('get-shipping-rates response contract (#6078)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.LOCAL_API_MODE;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('reads the raw seed key (no env prefix)', async () => {
    const capture: { url?: string } = {};
    seedRedisWith({ indices: [index()], fetchedAt: '2026-03-13T00:00:00Z', upstreamUnavailable: false }, capture);
    await getShippingRates({} as never, {} as never);
    assert.match(capture.url ?? '', /\/get\/supply_chain%3Ashipping%3Av2$/,
      `expected an unprefixed read of supply_chain:shipping:v2, got ${capture.url}`);
  });

  it('omits the period-change fields entirely when the seeder published nulls', async () => {
    seedRedisWith({
      indices: [index({
        periodChangePct: null,
        periodChangeBasis: null,
        priorPeriodValue: null,
        priorPeriodDate: null,
      })],
      fetchedAt: '2026-03-13T00:00:00Z',
      upstreamUnavailable: false,
    });

    const response = await getShippingRates({} as never, {} as never);
    // Serialize: this is what a client actually receives. `undefined` values
    // drop out of JSON, `null` values do not — so the round-trip is the real
    // assertion, not the in-process object.
    const wire = JSON.parse(JSON.stringify(response));
    const entry = wire.indices[0];

    for (const field of PERIOD_FIELDS) {
      assert.ok(!(field in entry),
        `${field} was served as ${JSON.stringify(entry[field])}; ShippingIndex declares it optional, which means absent`);
    }
    // The rest of the entry is untouched.
    assert.equal(entry.indexId, 'CCFI');
    assert.equal(entry.currentValue, 1072.16);
    assert.equal(entry.changePct, 1.69);
    assert.deepEqual(entry.history, [{ date: '2026-03-13', value: 1072.16 }]);
  });

  it('passes real period-change readings through unchanged', async () => {
    seedRedisWith({
      indices: [index()],
      fetchedAt: '2026-03-13T00:00:00Z',
      upstreamUnavailable: false,
    });

    const wire = JSON.parse(JSON.stringify(await getShippingRates({} as never, {} as never)));
    const entry = wire.indices[0];
    assert.equal(entry.periodChangePct, 1.69);
    assert.equal(entry.periodChangeBasis, 'publisher_reported');
    assert.equal(entry.priorPeriodValue, 1054.38);
    assert.equal(entry.priorPeriodDate, '2026-03-06');
  });

  it('never serves a prior-period date without the level it dates', async () => {
    // The seeder takes the publisher's `lastDate` independently of whether
    // `lastContent` parsed as a number, so a dated envelope with an unusable
    // prior level yields a date describing a level that was never published —
    // contradicting prior_period_date's declared meaning.
    seedRedisWith({
      indices: [index({ periodChangePct: null, periodChangeBasis: null, priorPeriodValue: null })],
      fetchedAt: '2026-03-13T00:00:00Z',
      upstreamUnavailable: false,
    });

    const wire = JSON.parse(JSON.stringify(await getShippingRates({} as never, {} as never)));
    const entry = wire.indices[0];
    assert.ok(!('priorPeriodValue' in entry));
    assert.ok(!('priorPeriodDate' in entry),
      `priorPeriodDate survived as ${JSON.stringify(entry.priorPeriodDate)} with no priorPeriodValue to date`);
  });

  it('keeps the pair when the prior level is a real zero', async () => {
    // 0 is a published level, not a missing one — the pairing rule must key on
    // absence, not falsiness, or a genuine zero prior loses its date.
    seedRedisWith({
      indices: [index({ priorPeriodValue: 0, priorPeriodDate: '2026-03-06' })],
      fetchedAt: '2026-03-13T00:00:00Z',
      upstreamUnavailable: false,
    });

    const entry = JSON.parse(JSON.stringify(await getShippingRates({} as never, {} as never))).indices[0];
    assert.equal(entry.priorPeriodValue, 0);
    assert.equal(entry.priorPeriodDate, '2026-03-06');
  });

  it('keeps a published zero move rather than dropping it as missing', async () => {
    // 0 is falsy; a `||`-based normalizer would erase a real unchanged period
    // and make it indistinguishable from "no comparable prior" — the exact
    // conflation #6066 introduced these fields to prevent.
    seedRedisWith({
      indices: [index({ periodChangePct: 0, priorPeriodValue: 0 })],
      fetchedAt: '2026-03-13T00:00:00Z',
      upstreamUnavailable: false,
    });

    const wire = JSON.parse(JSON.stringify(await getShippingRates({} as never, {} as never)));
    const entry = wire.indices[0];
    assert.equal(entry.periodChangePct, 0, 'a published zero move must survive normalization');
    assert.equal(entry.priorPeriodValue, 0);
  });

  it('degrades to upstreamUnavailable on a cache miss', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: null }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const response = await getShippingRates({} as never, {} as never);
    assert.deepEqual(response.indices, []);
    assert.equal(response.upstreamUnavailable, true);
  });

  it('degrades to upstreamUnavailable when the cache read throws', async () => {
    globalThis.fetch = (async () => { throw new Error('redis down'); }) as typeof fetch;

    const response = await getShippingRates({} as never, {} as never);
    assert.deepEqual(response.indices, []);
    assert.equal(response.upstreamUnavailable, true);
  });

  it('tolerates a malformed payload with no indices array', async () => {
    seedRedisWith({ fetchedAt: '2026-03-13T00:00:00Z', upstreamUnavailable: false });
    const response = await getShippingRates({} as never, {} as never);
    assert.deepEqual(response.indices, []);
  });
});
