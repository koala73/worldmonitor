// Executable coverage for the on-demand bilateral-HS4 fallback.
//
// The route and period wiring here was previously guarded only by grepping the
// module's source text, which cannot tell whether the live request actually
// uses them — a refactor that built the URL from a different constant would
// still match the substring. These tests drive the real exported function with
// a mocked fetch and assert the request that leaves the process.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { recentPeriod } from '../scripts/shared/comtrade-period.mjs';
import { lazyFetchBilateralHs4 } from '../server/worldmonitor/supply-chain/v1/_bilateral-hs4-lazy.js';

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls: string[] = [];
let upstreamData: unknown[] = [];

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
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    fetchCalls.push(href);
    if (!href.includes('comtradeapi.un.org')) {
      // Stub Upstash REST so the code path is identical either way.
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: upstreamData }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test('lazy fallback requests the stable HS preview route', async () => {
  await lazyFetchBilateralHs4('DE');

  assert.equal(comtradeCalls().length, 1, 'expected exactly one upstream request');
  assert.equal(new URL(comtradeCalls()[0]).pathname, '/public/v1/preview/C/A/HS');
});

test('lazy fallback sends an explicit annual period', async () => {
  // Omitting `period` is what made Comtrade answer 200 with count=0 and drop
  // every country — the outage this PR exists to fix.
  await lazyFetchBilateralHs4('DE');

  const period = new URL(comtradeCalls()[0]).searchParams.get('period');
  assert.equal(period, recentPeriod());
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
  const metadata = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', 'scripts', 'shared', 'comtrade-strategic-products.json'),
      'utf8',
    ),
  ) as { products: Array<{ bilateralHs4Code?: string }> };
  const expected = [...new Set(
    metadata.products.map(p => p.bilateralHs4Code).filter(Boolean),
  )];

  await lazyFetchBilateralHs4('DE');
  const requested = (new URL(comtradeCalls()[0]).searchParams.get('cmdCode') ?? '').split(',');

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
      product.bilateralLabel ?? product.label,
      `description drifted for HS4 ${product.bilateralHs4Code}`,
    );
  }
});

test('lazy fallback reports empty (not products) when upstream returns zero rows', async () => {
  const result = await lazyFetchBilateralHs4('DE');

  assert.ok(result, 'expected a result rather than the in-flight null');
  assert.deepEqual(result.products, []);
});
