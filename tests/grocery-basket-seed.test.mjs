import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fetchGroceryBasketPrices, fetchCountryItems, recordBaseline, selectWeekAgo, COUNTRY_CONCURRENCY, COUNTRIES } from '../scripts/seed-grocery-basket.mjs';

// The seeder logs one line per country and item. Silence it so the flood can't
// corrupt node:test's child-process message parser under --test-concurrency.
const realLog = console.log;
const realWarn = console.warn;
before(() => { console.log = () => {}; console.warn = () => {}; });
after(() => { console.log = realLog; console.warn = realWarn; });

// Reproduces the 2026-10-30 seed-grocery-basket crash: 24 countries ran STRICTLY
// SEQUENTIALLY at ~42s each (learned-route Firecrawl scrapes with 30s timeouts),
// so the run reached Kenya (country 21) at 840s and tripped runSeed's fetch-phase
// deadline (lockTtlMs 720s + 120s) — an exit-75 "Deploy Crashed!" every week.
// The fix processes countries with bounded concurrency. These tests pin that in.

// Hard-coded on purpose: a regression to sequential (1) must fail this suite, and
// an intentional change must consciously update it here.
const EXPECTED_DEFAULT_CONCURRENCY = 4;

const noRoutes = {
  read: async () => new Map(),
  write: async () => {},
};
const fakeFx = async () => Object.fromEntries(COUNTRIES.map((c) => [c.currency, 1]));

function makeTrackingCountry({ failCodes = new Set() } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (country) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 10));
      if (failCodes.has(country.code)) throw new Error(`simulated failure for ${country.code}`);
      return [{ itemId: 'rice', itemName: 'Rice', unit: '1kg', localPrice: 2, usdPrice: 2, currency: country.currency, sourceSite: 'https://test.example', available: true }];
    } finally {
      inFlight -= 1;
    }
  };
  return { fn, get maxInFlight() { return maxInFlight; } };
}

describe('seed-grocery-basket fetchGroceryBasketPrices', () => {
  it('pins the production country concurrency', () => {
    assert.equal(COUNTRY_CONCURRENCY, EXPECTED_DEFAULT_CONCURRENCY);
  });

  it('holds COUNTRY_CONCURRENCY countries in flight when no override is passed', async () => {
    const tracker = makeTrackingCountry();
    await fetchGroceryBasketPrices(null, { fetchCountryItemsFn: tracker.fn, getFxRatesFn: fakeFx, routes: noRoutes });
    assert.equal(
      tracker.maxInFlight,
      EXPECTED_DEFAULT_CONCURRENCY,
      `expected ${EXPECTED_DEFAULT_CONCURRENCY} countries in flight, got ${tracker.maxInFlight}; 1 means the loop regressed to sequential`,
    );
  });

  it('preserves country order and returns one row per country', async () => {
    const data = await fetchGroceryBasketPrices(null, { fetchCountryItemsFn: makeTrackingCountry().fn, getFxRatesFn: fakeFx, routes: noRoutes });
    assert.deepEqual(data.countries.map((c) => c.code), COUNTRIES.map((c) => c.code));
    assert.ok(data.countries.every((c) => c.totalUsd === 2));
  });

  it('a failing country degrades to unavailable items instead of crashing the run', async () => {
    const failed = COUNTRIES[3];
    const data = await fetchGroceryBasketPrices(null, {
      fetchCountryItemsFn: makeTrackingCountry({ failCodes: new Set([failed.code]) }).fn,
      getFxRatesFn: fakeFx,
      routes: noRoutes,
    });
    assert.equal(data.countries.length, COUNTRIES.length);
    const row = data.countries.find((c) => c.code === failed.code);
    assert.equal(row.totalUsd, 0);
    assert.ok(row.items.length > 0 && row.items.every((i) => i.available === false));
    assert.ok(data.countries.filter((c) => c.code !== failed.code).every((c) => c.totalUsd === 2));
  });
});

describe('seed-grocery-basket fetchCountryItems', () => {
  // A throwing item must not release the country's concurrency slot while its
  // sibling items are still in flight (they would keep calling Firecrawl/EXA past
  // the limit and record route changes after routes.write has already run).
  it('waits for every item to settle and degrades only the throwing item', async () => {
    let inFlight = 0;
    const routeUpdates = new Map();
    const processItemRouteFn = async ({ itemId }) => {
      inFlight += 1;
      try {
        if (itemId === 'rice') throw new Error('simulated item failure');
        await new Promise((r) => setTimeout(r, 30));
        return { localPrice: 2, sourceSite: 'https://test.example', routeUpdate: { url: 'https://test.example' }, routeDelete: false };
      } finally {
        inFlight -= 1;
      }
    };
    const items = await fetchCountryItems(COUNTRIES[0], {
      fxRate: 1, learnedRoutes: new Map(), routeUpdates, routeDeletes: new Set(), processItemRouteFn,
    });
    assert.equal(inFlight, 0, 'no item may still be running when the country resolves');
    const rice = items.find((i) => i.itemId === 'rice');
    assert.equal(rice.available, false);
    assert.ok(items.filter((i) => i.itemId !== 'rice').every((i) => i.available && i.usdPrice === 2));
    assert.equal(routeUpdates.size, items.length - 1, 'every surviving item recorded its route before the country resolved');
  });
});

describe('grocery basket comparability', () => {
  const units = {
    sugar: '1kg', salt: '1kg', rice: '1kg', pasta: '500g', potatoes: '1kg',
    oil: '1L', flour: '1kg', eggs: '12pc', milk: '1L', bread: '400g',
  };
  const items = (count, price) => Object.entries(units).slice(0, count).map(([itemId, unit]) => ({
    itemId, unit, usdPrice: price, localPrice: price, available: true,
  }));
  const [partial, complete, gained] = COUNTRIES;
  const now = new Date('2026-11-10T06:02:00Z');
  const previousWeek = {
    basketVersion: 3,
    fetchedAt: '2026-11-03T06:00:00Z',
    countries: [
      { code: partial.code, totalUsd: 7, items: items(7, 1) },
      { code: complete.code, totalUsd: 20, items: items(10, 2) },
      { code: gained.code, totalUsd: 18, items: items(9, 2) },
    ],
  };
  const options = {
    now,
    getFxRatesFn: fakeFx,
    routes: noRoutes,
    fetchCountryItemsFn: async ({ code }) => code === partial.code ? items(8, 1)
      : code === complete.code ? items(10, 2.1451) : code === gained.code ? items(10, 2.5) : [],
  };

  it('ranks complete baskets and compares only baskets complete a week earlier', async () => {
    const data = await fetchGroceryBasketPrices(selectWeekAgo(recordBaseline([], previousWeek), now), options);
    assert.equal(data.cheapestCountry, complete.code);
    assert.equal(data.mostExpensiveCountry, gained.code);
    assert.equal(data.countries[0].wowPct, null);
    assert.equal(data.countries[1].totalUsd, 21.5);
    assert.equal(data.countries[1].wowPct, 7.5);
    assert.equal(data.countries[2].wowPct, null);
    assert.equal(data.wowAvgPct, 7.5);
    assert.equal(data.prevFetchedAt, previousWeek.fetchedAt);
  });
});

describe('grocery basket week-over-week baseline', () => {
  const units = {
    sugar: '1kg', salt: '1kg', rice: '1kg', pasta: '500g', potatoes: '1kg',
    oil: '1L', flour: '1kg', eggs: '12pc', milk: '1L', bread: '400g',
  };
  const [tracked] = COUNTRIES;
  const start = Date.parse('2026-11-09T00:00:00Z');
  const HOUR_MS = 3_600_000;
  // Prices rise 1% of the starting price per day, so a true weekly change is about 7%.
  const priceAt = (ms) => 1 + (ms - start) / (24 * HOUR_MS) / 100;
  const runAt = (ms, baseline) => fetchGroceryBasketPrices(baseline, {
    now: new Date(ms),
    getFxRatesFn: fakeFx,
    routes: noRoutes,
    fetchCountryItemsFn: async ({ code }) => code === tracked.code
      ? Object.entries(units).map(([itemId, unit]) => ({ itemId, unit, usdPrice: priceAt(ms), localPrice: priceAt(ms), available: true }))
      : [],
  });

  it('compares a six-hourly run against the basket from seven days earlier', async () => {
    let history = [];
    const reported = [];
    for (let ms = start; ms <= Date.parse('2026-11-17T12:00:00Z'); ms += 6 * HOUR_MS) {
      const data = await runAt(ms, selectWeekAgo(history, new Date(ms)));
      history = recordBaseline(history, data);
      if (data.wowAvailable) reported.push({ ms, data });
    }
    assert.equal(new Date(reported[0].ms).toISOString(), '2026-11-15T12:00:00.000Z',
      'the first comparison waits for a basket at least six and a half days old');
    for (const { ms, data } of reported) {
      const baselineAt = Date.parse(data.prevFetchedAt);
      const gapHours = (ms - baselineAt) / HOUR_MS;
      if (ms >= Date.parse('2026-11-16T00:00:00Z')) assert.equal(gapHours, 168, `${new Date(ms).toISOString()} baseline`);
      else assert.ok(gapHours >= 156 && gapHours <= 180, `${new Date(ms).toISOString()} baseline is ${gapHours} h old`);
      const total = (at) => Number(priceAt(at).toFixed(2)) * 10;
      const expected = +((total(ms) - total(baselineAt)) / total(baselineAt) * 100).toFixed(2);
      assert.equal(data.countries[0].wowPct, expected);
    }
  });

  it('reports no change when no basket of the current version is about a week old', async () => {
    const now = Date.parse('2026-11-17T00:00:00Z');
    const weekOld = await runAt(now - 7 * 24 * HOUR_MS);
    for (const history of [
      recordBaseline([], await runAt(now - 8 * 24 * HOUR_MS)),
      recordBaseline([], await runAt(now - 6 * 24 * HOUR_MS)),
      recordBaseline([], { ...weekOld, basketVersion: 2 }),
    ]) {
      const data = await runAt(now, selectWeekAgo(history, new Date(now)));
      assert.equal(data.wowAvailable, false);
      assert.equal(data.prevFetchedAt, '');
      assert.ok(data.countries.every(({ wowPct }) => wowPct === null));
    }
  });

  it('keeps one entry per run and drops entries older than the comparison needs', async () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    const old = await runAt(now - 12 * 24 * HOUR_MS);
    const current = await runAt(now);
    const history = recordBaseline(recordBaseline(recordBaseline([], old), current), current);
    assert.deepEqual(history.map(({ fetchedAt }) => fetchedAt), [current.fetchedAt]);
  });
});

it('normalizes validated EXA and Firecrawl offers and drops unverifiable prices', async (t) => {
  const country = COUNTRIES.find(({ code }) => code === 'US');
  const product = (slug) => `https://www.target.com/p/${slug}`;
  const learnedUrl = product('old-milk-route');
  const offer = (productName, price, quantity, unit, matchesStaple = true) => ({
    matchesStaple, productName, price, currency: 'USD', quantity, unit,
    offerEvidence: `Main product offer for ${productName}`,
  });
  const entries = {
    rice: offer('Plain white rice, 1 lb', 0.89, 1, 'lb'),
    flour: offer('All purpose flour, 5 lb', 3.99, 5, 'lb'),
    eggs: offer('Large eggs, 18 pack', 6, 18, 'pc'),
    oil: { ...offer('Pure canola oil, 900 ml', '4.50', '900', 'ML'), currency: ' usd ' },
    salt: offer('Unavailable 10 kg salt, with a 1 kg recommendation', 2.75, 10, 'kg', false),
    potatoes: offer('Sweet potato', 1.5, 1, 'kg', false),
    milk: offer('Milk without a declared size', 3, 0, 'ml'),
    sugar: offer('Sugar', 3, 1, 'l'),
    pasta: offer('Dry spaghetti, 1000 kg', 1000, 1000, 'kg'),
    bread: offer('White bread, 500 g', 0.001, 500, 'g'),
  };
  const itemQueries = {
    'white rice': 'rice', 'all purpose': 'flour', 'fresh eggs': 'eggs', 'canola oil': 'oil',
    'table salt': 'salt', 'potatoes': 'potatoes', 'fresh whole milk': 'milk', 'white granulated': 'sugar',
    'spaghetti pasta': 'pasta', 'white bread': 'bread',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    if (url === 'https://api.firecrawl.dev/v1/scrape') {
      // A learned route must pass the same checks as fresh search results.
      return Response.json({ data: { extract: request.url === learnedUrl
        ? offer('Whole milk, 2 litres', 6, 2, 'l') : null } });
    }
    assert.equal(url, 'https://api.exa.ai/search');
    const itemId = itemQueries[Object.keys(itemQueries).find(query => request.query.startsWith(query))];
    if (request.userLocation === 'ID') {
      return Response.json({ results: itemId === 'rice' ? [{
        url: 'https://www.tokopedia.com/store/rice',
        summary: JSON.stringify({ ...offer('Plain white rice, 5 kg', 120000, 5, 'kg'), currency: 'IDR' }),
      }] : [] });
    }
    if (request.userLocation === 'IN') {
      const pack = itemId === 'salt' ? offer('Table salt, 100 g', 10, 100, 'g')
        : itemId === 'rice' ? offer('Plain white rice, 5 kg', 50, 5, 'kg') : null;
      return Response.json({ results: pack ? [{
        url: `https://www.bigbasket.com/pd/${itemId}`,
        summary: JSON.stringify({ ...pack, currency: 'INR' }),
      }] : [] });
    }
    return Response.json({ results: [
      { url: product('no-offer'), summary: 'USD 0.99' },
      ...(itemId ? [{ url: product(itemId), summary: JSON.stringify(entries[itemId]) }] : []),
    ] });
  });
  const originalKey = process.env.EXA_API_KEYS;
  const originalFirecrawl = process.env.FIRECRAWL_API_KEY;
  process.env.EXA_API_KEYS = 'test';
  process.env.FIRECRAWL_API_KEY = 'test';
  t.after(() => {
    if (originalKey === undefined) delete process.env.EXA_API_KEYS;
    else process.env.EXA_API_KEYS = originalKey;
    if (originalFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalFirecrawl;
  });
  const results = await fetchCountryItems(country, {
    fxRate: 1,
    learnedRoutes: new Map([['US:milk', { url: learnedUrl, hits: 1, failsSinceSuccess: 0 }]]),
    routeUpdates: new Map(),
    routeDeletes: new Set(),
  });
  const prices = Object.fromEntries(results.map(item => [item.itemId, item.usdPrice]));
  assert.equal(prices.rice, 1.9621);
  assert.equal(prices.flour, 1.7593);
  assert.equal(prices.eggs, 4);
  assert.equal(prices.oil, 5);
  assert.equal(prices.milk, 3);
  for (const itemId of ['salt', 'potatoes', 'sugar', 'pasta', 'bread']) assert.equal(prices[itemId], null);

  const india = await fetchCountryItems(COUNTRIES.find(({ code }) => code === 'IN'), {
    fxRate: 0.012, learnedRoutes: new Map(), routeUpdates: new Map(), routeDeletes: new Set(),
  });
  assert.equal(india.find(item => item.itemId === 'salt').localPrice, 100);
  assert.equal(india.find(item => item.itemId === 'rice').localPrice, null);

  const indonesia = await fetchCountryItems(COUNTRIES.find(({ code }) => code === 'ID'), {
    fxRate: 0.00006, learnedRoutes: new Map(), routeUpdates: new Map(), routeDeletes: new Set(),
  });
  assert.equal(indonesia.find(item => item.itemId === 'rice').usdPrice, 1.44);
});
