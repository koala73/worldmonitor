// Executable coverage for the on-demand bilateral-HS4 fallback.
//
// The route and period wiring here was previously guarded only by grepping the
// module's source text, which cannot tell whether the live request actually
// uses them — a refactor that built the URL from a different constant would
// still match the substring. These tests drive the real exported function with
// a mocked fetch and assert the request that leaves the process.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HS4_CODES, HS4_LABELS } from '../scripts/shared/comtrade';
import { recentPeriod } from '../scripts/shared/comtrade-period.mjs';
import { lazyFetchBilateralHs4, UPSTREAM_GAP_MS } from '../server/worldmonitor/supply-chain/v1/_bilateral-hs4-lazy.js';

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls: string[] = [];
let upstreamData: unknown[] = [];
// Comtrade requests and timer delays, in the order the module issued them.
let timeline: string[] = [];

// Only the upstream calls. The module also talks to Upstash over REST through
// the same global fetch, so asserting on the raw list would make these tests
// pass or fail depending on whether UPSTASH_REDIS_REST_URL/TOKEN happen to be
// set in the shell — green on a bare CI runner, red for anyone who sourced
// .env.local, and asserting "Redis is unconfigured" rather than the behaviour
// under test.
const comtradeCalls = () => fetchCalls.filter(u => u.includes('comtradeapi.un.org'));

beforeEach(() => {
  fetchCalls = [];
  upstreamData = [];
  timeline = [];
  // Every call pauses UPSTREAM_GAP_MS (1.1 s) between its two catalogue
  // batches for the preview route's ~1 req/s limit, and the description test
  // makes one call per heading: ~29 s of real waiting for 0.3 s of work.
  // Every delay is recorded and only that pause is skipped; the gap test below
  // asserts it is still requested, between the two batches.
  const realSetTimeout = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    timeline.push(`delay:${ms}`);
    if (ms !== UPSTREAM_GAP_MS) return realSetTimeout(callback, ms, ...args);
    // Record when the gap ends, so a request that does not wait for it shows up.
    return realSetTimeout((...callbackArgs: unknown[]) => {
      timeline.push('gap-elapsed');
      callback(...callbackArgs);
    }, 0, ...args);
  }) as typeof setTimeout);
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    fetchCalls.push(href);
    if (!href.includes('comtradeapi.un.org')) {
      // Stub Upstash REST so the code path is identical either way.
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    timeline.push('comtrade');
    return new Response(JSON.stringify({ data: upstreamData }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restoreAll();
});

test('lazy fallback requests the stable HS preview route', async () => {
  await lazyFetchBilateralHs4('DE');

  assert.equal(comtradeCalls().length, 2, 'expected two bounded catalogue requests');
  assert.equal(new URL(comtradeCalls()[0]).pathname, '/public/v1/preview/C/A/HS');
});

test('lazy fallback waits the upstream gap between its two catalogue batches, and only there', async () => {
  // The public preview route allows about one request per second. The real
  // pause is skipped above, so this is what keeps the throttle honest.
  await lazyFetchBilateralHs4('DE');

  assert.deepEqual(timeline, ['comtrade', `delay:${UPSTREAM_GAP_MS}`, 'gap-elapsed', 'comtrade']);
  assert.ok(UPSTREAM_GAP_MS >= 1000, `gap ${UPSTREAM_GAP_MS} ms is under the route's 1 req/s limit`);
});

test('lazy fallback sends an explicit annual period', async () => {
  // Omitting `period` is what made Comtrade answer 200 with count=0 and drop
  // every country — the outage this PR exists to fix.
  await lazyFetchBilateralHs4('DE');

  const period = new URL(comtradeCalls()[0]).searchParams.get('period');
  assert.equal(period, recentPeriod());
});

test('lazy fallback asks the preview route for aggregate-only rows', async () => {
  // The preview route caps every response at 500 rows. Without these filters
  // Comtrade returns one row per partner x second partner x transport mode x
  // customs procedure — about 9x — so a large importer fills the cap and the
  // attempt is recorded `incomplete` however few headings it asked for.
  await lazyFetchBilateralHs4('DE');

  assert.equal(comtradeCalls().length, 2, 'expected two bounded catalogue requests');
  for (const href of comtradeCalls()) {
    const params = new URL(href).searchParams;
    assert.equal(params.get('partner2Code'), '0');
    assert.equal(params.get('motCode'), '0');
    assert.equal(params.get('customsCode'), 'C00');
  }
});

test('lazy fallback sends a single period, not a list', async () => {
  // The public preview route answers HTTP 400 to a comma-separated period
  // (probed 2026-07-26), so the multi-year window used by the bulk seeder must
  // never leak into this path.
  await lazyFetchBilateralHs4('DE');

  const period = new URL(comtradeCalls()[0]).searchParams.get('period') ?? '';
  assert.ok(!period.includes(','), `preview route cannot take a period list, got "${period}"`);
});

test('both producers of the shared key request the SAME HS4 catalogue', async () => {
  // The bulk seeder and this fallback write the same
  // comtrade:bilateral-hs4:{iso2}:v1 key. When this module carried its own
  // hardcoded list, adding a product to the catalogue would land in the
  // seeder's payloads and be silently missing from the fallback's — with
  // nothing to surface the divergence.
  const expected = HS4_CODES;

  await lazyFetchBilateralHs4('DE');
  const batches = comtradeCalls().map(url => (new URL(url).searchParams.get('cmdCode') ?? '').split(','));
  assert(batches.every(codes => codes.length <= 20));
  const requested = batches.flat();

  assert.deepEqual([...requested].sort(), [...expected].sort());
});

test('lazy payload descriptions match the shared HS4 catalogue', async () => {
  // Codes and labels are one contract because the bulk and lazy producers
  // write the same Redis payload. Deriving only the code list still lets the
  // user-facing description drift when catalogue metadata changes.
  const metadata = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', 'scripts', 'shared', 'comtrade-strategic-products.json'),
      'utf8',
    ),
  ) as {
    products: Array<{ bilateralHs4Code?: string; bilateralLabel?: string; label: string }>;
  };
  const bilateralProducts = metadata.products.filter(
    (product): product is { bilateralHs4Code: string; bilateralLabel?: string; label: string } => (
      typeof product.bilateralHs4Code === 'string'
    ),
  );

  for (const product of bilateralProducts) {
    upstreamData = [{
      cmdCode: product.bilateralHs4Code,
      partnerCode: '156',
      primaryValue: 1000,
      period: Number(recentPeriod()),
    }];

    const result = await lazyFetchBilateralHs4('DE');
    assert.equal(
      result?.products[0]?.description,
      HS4_LABELS[product.bilateralHs4Code],
      `description drifted for HS4 ${product.bilateralHs4Code}`,
    );
  }
});

test('lazy fallback reports empty (not products) when upstream returns zero rows', async () => {
  const result = await lazyFetchBilateralHs4('DE');

  assert.ok(result, 'expected a result rather than the in-flight null');
  assert.deepEqual(result.products, []);
});
