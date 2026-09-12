// Cache contract for the bilateral HS4 lazy fetch and the country-products
// reader: what each outcome writes, what a second request reads back, and that
// warm recovery never replaces the canonical key. Redis is an in-memory stub
// so repeated requests see the state the first one left behind.

import { beforeEach, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ store: new Map<string, unknown>(), ttl: new Map<string, number>(), errors: new Set<string>(), reads: [] as string[] }));
vi.mock('../../server/_shared/redis', () => ({
  getCachedJson: async (key: string) => { redis.reads.push(key); return redis.store.get(key) ?? null; },
  readCachedJson: async (key: string) => {
    redis.reads.push(key);
    return redis.errors.has(key) ? { status: 'error' }
      : redis.store.has(key) ? { status: 'hit', value: redis.store.get(key) } : { status: 'miss' };
  },
  setCachedJsonIfAbsent: async (key: string, value: unknown, ttl: number) => {
    if (redis.store.has(key)) return false;
    redis.store.set(key, value); redis.ttl.set(key, ttl); return true;
  },
  setCachedJson: async (key: string, value: unknown, ttl: number) => { redis.store.set(key, value); redis.ttl.set(key, ttl); return true; },
  // The world-exports snapshot is read through the large-value path.
  getLargeRawJson: async (key: string) => { redis.reads.push(key); return redis.store.get(key) ?? null; },
  logCacheReadError: () => {},
}));
vi.mock('../../server/_shared/premium-check', () => ({ isCallerPremium: async () => true }));

import { lazyFetchBilateralHs4, lazyFetchHeading } from '../../server/worldmonitor/supply-chain/v1/_bilateral-hs4-lazy';
import { getCountryProducts } from '../../server/worldmonitor/supply-chain/v1/get-country-products';
import { ValidationError } from '../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

const SENTINEL = (iso2: string) => `comtrade:bilateral-hs4-lazy-sentinel:${iso2}:v1`;
const CANONICAL = (iso2: string) => `comtrade:bilateral-hs4:${iso2}:v1`;
const PARTNERS = (iso2: string) => `comtrade:bilateral-hs4-partners:${iso2}:v1`;
const HEADING = (iso2: string, hs4: string) => `comtrade:bilateral-hs4-lazy-heading:${iso2}:${hs4}:v1`;
const WORLD_EXPORTS = 'comtrade:world-exports-hs4:v1';
const DAY = 86_400;

let upstreamCalls = 0;
function upstream(respond: (url: URL) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'comtradeapi.un.org') upstreamCalls++;
    return respond(url);
  });
}
const rows = (url: URL, data: Array<Record<string, unknown>>) =>
  Response.json({ data: data.filter(row => url.searchParams.get('cmdCode')!.split(',').includes(String(row.cmdCode))) });
const read = (ctx: { iso2: string; hs4?: string }) => getCountryProducts({ request: new Request('https://example.test') } as never, ctx);

beforeEach(() => {
  redis.store.clear(); redis.ttl.clear(); redis.errors.clear(); redis.reads.length = 0;
  upstreamCalls = 0;
});

for (const [iso2, state] of [['DE', 'no_records'], ['ZZ', 'unsupported_reporter']] as const) {
  it(`${state} stays a permanent empty when the sentinel is read back`, async () => {
    upstream(url => rows(url, []));
    const first = await lazyFetchBilateralHs4(iso2);
    const second = await lazyFetchBilateralHs4(iso2);
    expect(first).toMatchObject({ comtradeSource: 'empty', state });
    // Route impact caches 'empty' for 24h and renders "no strategic products";
    // 'lazy' would render "Loading trade data" until the sentinel expires.
    expect(second).toMatchObject({ comtradeSource: 'empty', state });
  });
}

for (const [label, respond, state] of [
  ['HTTP 503', () => new Response('down', { status: 503 }), 'unavailable'],
  ['HTTP 400', () => new Response('bad', { status: 400 }), 'unavailable'],
  ['a body without a data array', () => Response.json({ unexpected: true }), 'malformed'],
] as const) {
  it(`${label} is suppressed briefly instead of refetched on every request`, async () => {
    upstream(respond);
    const first = await lazyFetchBilateralHs4('DE');
    const callsAfterFirst = upstreamCalls;
    const second = await lazyFetchBilateralHs4('DE');
    expect(first).toMatchObject({ comtradeSource: 'lazy', state });
    expect(second).toMatchObject({ comtradeSource: 'lazy', state });
    expect(upstreamCalls).toBe(callsAfterFirst);
    const ttl = redis.ttl.get(SENTINEL('DE'))!;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThan(DAY);
    expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  });
}

it('a response filling the requested cap is incomplete and publishes nothing', async () => {
  upstream(url => Response.json({ data: Array.from({ length: Number(url.searchParams.get('maxRecords')) }, (_, i) => (
    { cmdCode: url.searchParams.get('cmdCode')!.split(',')[0], partnerCode: 1 + (i % 890), primaryValue: 1, period: 2024 })) }));
  const result = await lazyFetchBilateralHs4('DE');
  expect(result).toMatchObject({ comtradeSource: 'lazy', state: 'incomplete' });
  expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  expect((redis.store.get(SENTINEL('DE')) as { state: string }).state).toBe('incomplete');
});

it('a cold success publishes the canonical key with NX and reports observed', async () => {
  upstream(url => rows(url, [
    { cmdCode: '2804', partnerCode: 0, primaryValue: 1000, netWgt: 5000, period: 2024 },
    { cmdCode: '2804', partnerCode: 842, primaryValue: 392, netWgt: 1960, period: 2024 },
  ]));
  const result = await lazyFetchBilateralHs4('JP');
  expect(result).toMatchObject({ comtradeSource: 'bilateral-hs4', state: 'observed' });
  expect(redis.ttl.get(CANONICAL('JP'))).toBe(40 * DAY);
  const stored = redis.store.get(CANONICAL('JP')) as { products: Array<Record<string, unknown>> };
  expect(stored.products.map(p => p.hs4)).toEqual(['2804']);
  // The canonical key is read by three scorers and two bulk pipelines under a
  // 4.5 MB ceiling (KTD1). Partner detail belongs to the sibling key only.
  expect(stored.products[0]).not.toHaveProperty('partners');
  expect(stored.products[0]).not.toHaveProperty('worldNetWeightKg');
});

it('a scheduled write that lands during a cold fetch is not overwritten', async () => {
  const scheduled = { iso2: 'JP', fetchedAt: new Date().toISOString(), products: [] };
  upstream(url => {
    redis.store.set(CANONICAL('JP'), scheduled);
    return rows(url, [{ cmdCode: '2804', partnerCode: 842, primaryValue: 392, period: 2024 }]);
  });
  const result = await lazyFetchBilateralHs4('JP');
  expect(result?.state).toBe('cache_write_failed');
  expect(redis.store.get(CANONICAL('JP'))).toBe(scheduled);
});

const previous = { iso2: 'DE', fetchedAt: '2026-07-27T16:47:53.750Z', products: [{ hs4: '1001', description: 'Wheat', year: 2023, totalValue: 100,
  topExporters: [{ partnerCode: 251, partnerIso2: '', value: 100, share: 1 }] }] };
for (const [label, recovered] of [
  ['an older year for a held heading', { ...previous, fetchedAt: '2026-08-01T00:00:00.000Z', products: [{ ...previous.products[0], year: 2022 }] }],
  ['an older fetch time', { ...previous, fetchedAt: '2026-07-01T00:00:00.000Z', products: [{ ...previous.products[0], year: 2024 }] }],
] as const) {
  it(`an observed sentinel with ${label} is rejected and refetched`, async () => {
    redis.store.set(SENTINEL('DE'), { state: 'observed', attemptedAt: recovered.fetchedAt, payload: recovered });
    upstream(url => rows(url, [{ cmdCode: '1001', partnerCode: 251, primaryValue: 100, period: 2024 }]));
    const result = await lazyFetchBilateralHs4('DE', previous);
    expect(upstreamCalls).toBeGreaterThan(0);
    expect(result?.payload).not.toBe(recovered);
    expect(result?.payload?.products[0]?.year).toBe(2024);
  });
}

it('the warm sentinel payload carries the canonical shape, not the partner detail', async () => {
  upstream(url => rows(url, [
    { cmdCode: '1001', partnerCode: 0, primaryValue: 200, netWgt: 900, period: 2024 },
    { cmdCode: '1001', partnerCode: 251, primaryValue: 100, netWgt: 450, period: 2024 },
  ]));
  await lazyFetchBilateralHs4('DE', previous);
  const sentinel = redis.store.get(SENTINEL('DE')) as { payload: { products: Array<Record<string, unknown>> } };
  // A warm sentinel payload is read straight back as the canonical payload, so
  // it must not smuggle partner detail into the canonical contract.
  expect(sentinel.payload.products[0]).not.toHaveProperty('partners');
  expect(sentinel.payload.products[0]).not.toHaveProperty('worldNetWeightKg');
});

it('a cache read error is reported and never triggers a provider fetch', async () => {
  redis.errors.add(CANONICAL('DE'));
  upstream(url => rows(url, []));
  const result = await read({ iso2: 'DE', hs4: '2804' });
  expect(result.evidence?.state).toBe('cache_unavailable');
  expect(upstreamCalls).toBe(0);
});

it('a cached payload for another country is treated as unreadable, not as data', async () => {
  redis.store.set(CANONICAL('DE'), { ...previous, iso2: 'FR', fetchedAt: new Date().toISOString() });
  upstream(url => rows(url, []));
  const result = await read({ iso2: 'DE', hs4: '2804' });
  expect(result.evidence?.state).toBe('cache_unavailable');
  expect(result.products).toEqual([]);
  expect(upstreamCalls).toBe(0);
});

it('an unsupported heading is rejected before any cache or provider access', async () => {
  upstream(url => rows(url, []));
  await expect(read({ iso2: 'DE', hs4: '9999' })).rejects.toBeInstanceOf(ValidationError);
  expect(upstreamCalls).toBe(0);
});

// --- Single-heading recovery and the sibling/world-exports merge (KTD5, KTD6, KTD8) ---

const fresh = () => new Date().toISOString();
/** One heading's worth of preview rows: a World total, two sizeable origins, and a long tail below 1%. */
const helium = (year = 2024) => [
  { cmdCode: '2804', partnerCode: 0, primaryValue: 1000, netWgt: 5000, period: year },
  { cmdCode: '2804', partnerCode: 842, primaryValue: 392, netWgt: 1960, isNetWgtEstimated: false, qty: 1960, qtyUnitCode: 8, period: year },
  { cmdCode: '2804', partnerCode: 490, primaryValue: 100, period: year },
  ...Array.from({ length: 8 }, (_, i) => ({ cmdCode: '2804', partnerCode: 300 + i, primaryValue: 1, period: year })),
];
// An hour old: well inside the 35-day freshness window, and far enough from
// the recovery's own timestamp to tell the two fetch times apart.
const wheatOnly = (iso2: string) => ({
  iso2, fetchedAt: new Date(Date.now() - 3_600_000).toISOString(), source: 'UN Comtrade bilateral HS4', requestedHs4s: ['1001'],
  products: [{
    hs4: '1001', description: 'Wheat', year: 2024, totalValue: 100, denominatorBasis: 'reported_world',
    topExporters: [{ partnerCode: 251, partnerIso2: 'FR', value: 100, share: 1 }],
  }],
});

it('a heading the stored payload lacks is recovered in one request without touching the canonical key', async () => {
  const canonical = wheatOnly('DE');
  redis.store.set(CANONICAL('DE'), canonical);
  const requested: URL[] = [];
  upstream(url => { requested.push(url); return rows(url, helium()); });

  const result = await read({ iso2: 'DE', hs4: '2804' });

  expect(requested).toHaveLength(1);
  expect(requested[0]!.searchParams.get('cmdCode')).toBe('2804');
  expect(requested[0]!.searchParams.get('partner2Code')).toBe('0');
  expect(requested[0]!.searchParams.get('motCode')).toBe('0');
  expect(requested[0]!.searchParams.get('customsCode')).toBe('C00');

  const recovered = result.products.find(p => p.hs4 === '2804')!;
  expect(recovered.partnerBasis).toBe('share_threshold');
  // Padded to MIN_PARTNERS: only 842 and 490 clear the 1% threshold.
  expect(recovered.topExporters).toHaveLength(5);
  expect(recovered.topExporters[0]).toMatchObject({ partnerCode: 842, partnerIso2: 'US', netWeightKg: 1960, quantity: 1960, quantityUnitCode: 8 });
  expect(recovered.omittedPartnerCount).toBe(5);
  expect(recovered.omittedPartnerShare).toBe(0.005);
  // The recovered heading carries its own fetch time; the payload keeps the canonical one.
  expect(recovered.fetchedAt).toBeTruthy();
  expect(recovered.fetchedAt).not.toBe(canonical.fetchedAt);
  expect(result.fetchedAt).toBe(canonical.fetchedAt);
  expect(result.evidence?.recoveredHs4s).toEqual(['2804']);
  expect(result.evidence?.lastAttemptState).toBe('observed');

  expect(redis.store.get(CANONICAL('DE'))).toBe(canonical);
  expect(redis.store.has(SENTINEL('DE'))).toBe(false);
  expect((redis.store.get(HEADING('DE', '2804')) as { state: string }).state).toBe('observed');
  expect(redis.ttl.get(HEADING('DE', '2804'))).toBe(DAY);
});

it('a second missing heading for the same country within the day gets its own request', async () => {
  redis.store.set(CANONICAL('DE'), wheatOnly('DE'));
  const requested: string[] = [];
  upstream(url => {
    requested.push(url.searchParams.get('cmdCode')!);
    return rows(url, [...helium(), { cmdCode: '1005', partnerCode: 842, primaryValue: 50, period: 2024 }]);
  });

  await read({ iso2: 'DE', hs4: '2804' });
  const repeat = await read({ iso2: 'DE', hs4: '2804' });
  const second = await read({ iso2: 'DE', hs4: '1005' });

  // The 2804 sentinel answers the repeat; it must not suppress 1005 as well.
  expect(requested).toEqual(['2804', '1005']);
  expect(repeat.products.find(p => p.hs4 === '2804')?.partnerBasis).toBe('share_threshold');
  expect(second.products.find(p => p.hs4 === '1005')?.partnerBasis).toBe('share_threshold');
  expect(second.evidence?.recoveredHs4s).toEqual(['1005']);
});

it('single-heading recovery leaves a cold canonical key absent and never blocks the full catalogue path', async () => {
  upstream(url => rows(url, helium()));

  const heading = await lazyFetchHeading('DE', '2804');
  expect(heading).toMatchObject({ state: 'observed' });
  expect(heading?.product?.partners?.[0]?.partnerCode).toBe(842);
  expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  expect((redis.store.get(HEADING('DE', '2804')) as { state: string }).state).toBe('observed');

  // get-route-impact passes no hs4 and reads the country sentinel; the heading
  // sentinel must not short-circuit it.
  const callsAfterHeading = upstreamCalls;
  const full = await lazyFetchBilateralHs4('DE');
  expect(upstreamCalls).toBe(callsAfterHeading + 2);
  expect(full?.state).toBe('observed');
  expect(redis.store.has(CANONICAL('DE'))).toBe(true);
});

it('an observed heading sentinel with no usable product is refetched, not reported as observed', async () => {
  redis.store.set(HEADING('DE', '2804'), { state: 'observed', attemptedAt: fresh(), product: { hs4: '1001', partners: [] } });
  upstream(url => rows(url, helium()));

  const result = await lazyFetchHeading('DE', '2804');

  expect(upstreamCalls).toBe(1);
  expect(result?.product?.hs4).toBe('2804');
});

it('a recovered heading older than the stored year is rejected and the stored row is served', async () => {
  upstream(url => rows(url, helium(2022)));
  const rejected = await lazyFetchHeading('DE', '2804', 2024);
  expect(rejected).toMatchObject({ state: 'regression_rejected' });
  expect(rejected?.product).toBeUndefined();
  expect(redis.ttl.get(HEADING('DE', '2804'))).toBe(DAY);

  redis.store.set(CANONICAL('DE'), {
    iso2: 'DE', fetchedAt: fresh(), requestedHs4s: ['2804'],
    products: [{ hs4: '2804', description: 'Helium', year: 2024, totalValue: 1000, denominatorBasis: 'reported_world',
      topExporters: [{ partnerCode: 842, partnerIso2: '', value: 392, share: 0.392 }] }],
  });
  const callsBefore = upstreamCalls;
  const result = await read({ iso2: 'DE', hs4: '2804' });
  expect(upstreamCalls).toBe(callsBefore);
  expect(result.products.find(p => p.hs4 === '2804')?.year).toBe(2024);
});

const canonicalHelium = (iso2: string) => ({
  iso2, fetchedAt: fresh(), source: 'UN Comtrade bilateral HS4', requestedHs4s: ['2804'],
  products: [{
    hs4: '2804', description: 'Helium', year: 2024, totalValue: 1000, denominatorBasis: 'reported_world',
    topExporters: [
      { partnerCode: 842, partnerIso2: '', value: 392, share: 0.392 },
      { partnerCode: 490, partnerIso2: '', value: 100, share: 0.1 },
    ],
  }],
});
const siblingHelium = (iso2: string, year: number) => ({
  iso2, fetchedAt: fresh(), source: 'UN Comtrade bilateral HS4', requestedHs4s: ['2804'],
  products: [{
    hs4: '2804', year, denominatorBasis: 'reported_world', totalValue: 1000, worldNetWeightKg: 5000,
    partners: [
      { partnerCode: 842, partnerIso2: '', value: 392, share: 0.392, netWeightKg: 1960, netWeightEstimated: false, quantity: 1960, quantityUnitCode: 8 },
      { partnerCode: 490, partnerIso2: '', value: 100, share: 0.1, netWeightKg: null, netWeightEstimated: false, quantity: null, quantityUnitCode: null },
      { partnerCode: 156, partnerIso2: '', value: 30, share: 0.03, netWeightKg: 90, netWeightEstimated: true, quantity: null, quantityUnitCode: null },
    ],
    omittedCount: 12, omittedShare: 0.041,
  }],
});

for (const [label, siblingYear, basis, partnerCount] of [
  ['a later year', 2025, 'share_threshold', 3],
  ['the same year', 2024, 'share_threshold', 3],
  ['an older year', 2023, 'leading_5', 2],
] as const) {
  it(`a sibling row at ${label} than the canonical row yields ${basis}`, async () => {
    redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
    redis.store.set(PARTNERS('JP'), siblingHelium('JP', siblingYear));
    upstream(url => rows(url, []));

    const result = await read({ iso2: 'JP', hs4: '2804' });

    const product = result.products.find(p => p.hs4 === '2804')!;
    expect(upstreamCalls).toBe(0);
    expect(product.partnerBasis).toBe(basis);
    expect(product.topExporters).toHaveLength(partnerCount);
    // Partner-code normalization applies to whichever list is served.
    expect(product.topExporters[0]!.partnerIso2).toBe('US');
    if (basis === 'share_threshold') {
      expect(product.omittedPartnerCount).toBe(12);
      expect(product.omittedPartnerShare).toBe(0.041);
      expect(product.topExporters[0]!.netWeightKg).toBe(1960);
      // A partner that reported no weight must omit the field, never send 0.
      expect(product.topExporters[1]).not.toHaveProperty('netWeightKg');
      expect(product.topExporters[2]!.netWeightEstimated).toBe(true);
    } else {
      expect(product).not.toHaveProperty('omittedPartnerCount');
      expect(product.topExporters[0]).not.toHaveProperty('netWeightKg');
    }
    // The payload-level fetch time is always the canonical one.
    expect(product).not.toHaveProperty('fetchedAt');
    expect(result.evidence?.recoveredHs4s).toEqual([]);
  });
}

it('a malformed sibling key is treated as absent, not as a cache failure', async () => {
  redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
  redis.store.set(PARTNERS('JP'), { iso2: 'JP', products: 'not-an-array' });
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP', hs4: '2804' });

  expect(result.evidence?.state).toBe('partial');
  expect(result.products.find(p => p.hs4 === '2804')?.partnerBasis).toBe('leading_5');
});

it('a legacy country with no sibling and no world exports reports leading_5 with no volume or scale', async () => {
  redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP', hs4: '2804' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(product.partnerBasis).toBe('leading_5');
  expect(product.topExporters[0]).not.toHaveProperty('netWeightKg');
  expect(product.topExporters[0]).not.toHaveProperty('scale');
  expect(result.evidence).not.toHaveProperty('worldExportsFetchedAt');
});

// --- Recovery dispatch through the reader (cold and stale caches, sibling currency) ---

/** A large importer: any multi-heading request fills the preview cap; a single heading answers normally. */
const largeImporter = (heading: Array<Record<string, unknown>>) => (url: URL) => {
  const codes = url.searchParams.get('cmdCode')!.split(',');
  if (codes.length > 1) {
    return Response.json({ data: Array.from({ length: Number(url.searchParams.get('maxRecords')) }, (_, i) => (
      { cmdCode: codes[0], partnerCode: 1 + (i % 890), primaryValue: 1, period: 2024 })) });
  }
  return rows(url, heading);
};

it('a cold cache still recovers the requested heading after the catalogue attempt fills the cap', async () => {
  const requested: string[] = [];
  const requestedAt: number[] = [];
  upstream(url => {
    requested.push(url.searchParams.get('cmdCode')!);
    requestedAt.push(performance.now());
    return largeImporter(helium())(url);
  });

  const result = await read({ iso2: 'DE', hs4: '2804' });

  // The first catalogue batch is capped and ends the catalogue attempt; then
  // the one heading is requested on its own.
  expect(requested).toHaveLength(2);
  expect(requested[0]!.includes(',')).toBe(true);
  expect(requested[1]).toBe('2804');
  // The public preview route allows about one request per second, so the
  // heading request waits out that gap after the catalogue request it follows.
  expect(requestedAt[1]! - requestedAt[0]!).toBeGreaterThanOrEqual(1_000);
  expect(result.products.map(p => p.hs4)).toEqual(['2804']);
  expect(result.products[0]!.partnerBasis).toBe('share_threshold');
  expect(result.evidence?.recoveredHs4s).toEqual(['2804']);
  expect(result.evidence?.lastAttemptState).toBe('observed');
  // Nothing is stored and one heading was recovered: a partial answer from the
  // public preview, not an observed catalogue from an unknown legacy cache.
  expect(result.evidence?.state).toBe('partial');
  expect(result.evidence?.source).toBe('UN Comtrade public preview (single-heading recovery)');
  expect(redis.store.has(CANONICAL('DE'))).toBe(false);
  expect((redis.store.get(SENTINEL('DE')) as { state: string }).state).toBe('incomplete');
});

const staleHelium = (iso2: string, year = 2024) => ({
  ...canonicalHelium(iso2),
  fetchedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  products: [{ ...canonicalHelium(iso2).products[0]!, year }],
});

it('a stale stored heading is refreshed on its own when the catalogue refresh fails', async () => {
  const stale = staleHelium('DE');
  redis.store.set(CANONICAL('DE'), stale);
  const requested: string[] = [];
  upstream(url => {
    requested.push(url.searchParams.get('cmdCode')!);
    return url.searchParams.get('cmdCode')!.includes(',') ? new Response('down', { status: 503 }) : rows(url, helium(2025));
  });

  const result = await read({ iso2: 'DE', hs4: '2804' });

  expect(requested[requested.length - 1]).toBe('2804');
  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(result.products.filter(p => p.hs4 === '2804')).toHaveLength(1);
  expect(product.year).toBe(2025);
  expect(product.partnerBasis).toBe('share_threshold');
  expect(product.fetchedAt).toBeTruthy();
  expect(result.fetchedAt).toBe(stale.fetchedAt);
  expect(result.evidence?.recoveredHs4s).toEqual(['2804']);
  expect(redis.store.get(CANONICAL('DE'))).toBe(stale);
});

it('a stale stored heading arms the year-regression guard through the reader', async () => {
  const stale = staleHelium('DE', 2024);
  redis.store.set(CANONICAL('DE'), stale);
  upstream(url => url.searchParams.get('cmdCode')!.includes(',') ? new Response('down', { status: 503 }) : rows(url, helium(2022)));

  const result = await read({ iso2: 'DE', hs4: '2804' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(product.year).toBe(2024);
  expect(product.partnerBasis).toBe('leading_5');
  expect(result.evidence?.lastAttemptState).toBe('regression_rejected');
  expect(result.evidence?.recoveredHs4s).toEqual([]);
  expect((redis.store.get(HEADING('DE', '2804')) as { state: string }).state).toBe('regression_rejected');
});

it('a sibling written before a successful warm refresh does not override the refreshed rows', async () => {
  redis.store.set(CANONICAL('DE'), staleHelium('DE'));
  // Written by last month's run: current for the stale payload, not for a refresh.
  redis.store.set(PARTNERS('DE'), { ...siblingHelium('DE', 2024), fetchedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  upstream(url => rows(url, [
    { cmdCode: '2804', partnerCode: 0, primaryValue: 1000, period: 2024 },
    { cmdCode: '2804', partnerCode: 842, primaryValue: 800, period: 2024 },
  ]));

  const result = await read({ iso2: 'DE', hs4: '2804' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(product.topExporters[0]).toMatchObject({ partnerCode: 842, share: 0.8 });
  expect(product.partnerBasis).toBe('leading_5');
});

it('a caller without hs4 keeps the leading 5 even when a current sibling exists', async () => {
  redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
  redis.store.set(PARTNERS('JP'), siblingHelium('JP', 2024));
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(upstreamCalls).toBe(0);
  expect(product.partnerBasis).toBe('leading_5');
  expect(product.topExporters).toHaveLength(2);
});

const worldExportsHelium = (year = 2024) => ({
  fetchedAt: '2026-09-01T00:00:00.000Z', period: String(year), source: 'UN Comtrade',
  headings: {
    '2804': {
      year,
      exporters: [
        { reporterCode: 156, iso2: 'CN', valueUsd: 2_107_000_000, netWeightKg: 875_000_000 },
        { reporterCode: 842, iso2: 'US', valueUsd: 1_809_000_000, netWeightKg: null },
      ],
      unrankedReporterCount: 3,
    },
  },
});

it('world exports attach rank and value to the origins they cover and nothing to the rest', async () => {
  redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
  redis.store.set(WORLD_EXPORTS, worldExportsHelium());
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP', hs4: '2804' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  // The rank basis travels with the rank: 2 ranked reporters, and 3 whose
  // newest filing predates the heading year and so are not in the ranking.
  expect(product.topExporters[0]!.scale).toEqual({ worldExportsUsd: 1_809_000_000, rank: 2, year: 2024, reporterCount: 2, unrankedReporterCount: 3 });
  expect(product.topExporters[1]).not.toHaveProperty('scale');
  expect(result.evidence?.worldExportsFetchedAt).toBe('2026-09-01T00:00:00.000Z');
});

it('world exports from a different observation year than the served row attach no scale', async () => {
  // A late filer: its newest row is 2023 while the world snapshot for the
  // heading is 2024. A 2024 rank beside a 2023 share is the comparison the
  // scale's stated same-year requirement exists to prevent.
  redis.store.set(CANONICAL('JP'), { ...canonicalHelium('JP'), products: [{ ...canonicalHelium('JP').products[0]!, year: 2023 }] });
  redis.store.set(WORLD_EXPORTS, worldExportsHelium(2024));
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP', hs4: '2804' });

  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(product.year).toBe(2023);
  expect(product.topExporters.every(exporter => !('scale' in exporter))).toBe(true);
  // The snapshot was read and is reported; it simply matched nothing.
  expect(result.evidence?.worldExportsFetchedAt).toBe('2026-09-01T00:00:00.000Z');
});

it('a caller without hs4 reads neither the world-exports snapshot nor the sibling key', async () => {
  // The deep-dive panel asks for the whole catalogue and renders the leading 5
  // only; the several-hundred-kilobyte snapshot and the sibling detail are for
  // the single-heading brief, so a panel load must not pay for them.
  redis.store.set(CANONICAL('JP'), canonicalHelium('JP'));
  redis.store.set(PARTNERS('JP'), siblingHelium('JP', 2024));
  redis.store.set(WORLD_EXPORTS, worldExportsHelium());
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'JP' });

  expect(redis.reads).not.toContain(WORLD_EXPORTS);
  expect(redis.reads).not.toContain(PARTNERS('JP'));
  const product = result.products.find(p => p.hs4 === '2804')!;
  expect(product.partnerBasis).toBe('leading_5');
  expect(product.topExporters[0]).not.toHaveProperty('scale');
  expect(result.evidence).not.toHaveProperty('worldExportsFetchedAt');
});

// --- One lazy budget per request: pacing, redundancy, deadline ---

it('an empty single-heading answer adds exactly that heading to the requested set', async () => {
  // A fresh payload that never asked for 2804, so only the heading attempt runs.
  redis.store.set(CANONICAL('DE'), wheatOnly('DE'));
  upstream(url => rows(url, []));

  const result = await read({ iso2: 'DE', hs4: '2804' });

  expect(result.evidence?.lastAttemptState).toBe('no_records');
  // Not the whole catalogue: only 1001 (the payload's) and 2804 (this attempt's)
  // were asked for, and the brief reads this list as "asked and answered empty".
  expect(result.evidence?.requestedHs4s).toEqual(['1001', '2804']);
});

for (const [label, catalogue, state] of [
  ['returns no records at all', [], 'no_records'],
  ['is observed without the heading', [{ cmdCode: '1001', partnerCode: 251, primaryValue: 100, period: 2024 }], 'observed'],
] as const) {
  it(`a catalogue attempt that ${label} is not followed by the same request for one heading`, async () => {
    const requested: string[] = [];
    upstream(url => { requested.push(url.searchParams.get('cmdCode')!); return rows(url, [...catalogue]); });

    const result = await read({ iso2: 'JP', hs4: '2804' });

    // The catalogue request already asked the same route for the same period
    // about 2804; asking again for that heading alone cannot answer differently.
    expect(requested.every(codes => codes.includes(','))).toBe(true);
    expect(redis.store.has(HEADING('JP', '2804'))).toBe(false);
    expect(result.evidence?.lastAttemptState).toBe(state);
    expect(result.evidence?.requestedHs4s).toContain('2804');
  });
}

it('the heading attempt is skipped when the catalogue attempt used up the request budget', async () => {
  // Clock skew stands in for a slow provider: the catalogue attempt returns
  // with less budget left than a heading request needs.
  const realNow = Date.now.bind(Date);
  let skew = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  const requested: string[] = [];
  upstream(url => {
    requested.push(url.searchParams.get('cmdCode')!);
    skew = 8_500;
    return largeImporter(helium())(url);
  });

  const result = await read({ iso2: 'DE', hs4: '2804' });

  expect(requested).toHaveLength(1);
  expect(redis.store.has(HEADING('DE', '2804'))).toBe(false);
  // The catalogue attempt is the last attempt this request made.
  expect(result.evidence?.lastAttemptState).toBe('incomplete');
  expect(result.evidence?.recoveredHs4s).toEqual([]);
});
