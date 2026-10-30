import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fetchGroceryBasketPrices, COUNTRY_CONCURRENCY, COUNTRIES } from '../scripts/seed-grocery-basket.mjs';

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
