/**
 * Regression for issue #3756: the flight-price search route silently fell
 * back to randomized demo quotes whenever TRAVELPAYOUTS_API_TOKEN was
 * missing, the upstream call failed, or the provider returned zero
 * results. UI labelled this with a single 11px "Indicative prices"
 * footnote, indistinguishable from live data at a glance.
 *
 * Fix: demo data now requires explicit AVIATION_DEMO_PRICES=1 opt-in.
 * Default path fails closed with distinct degraded discriminators:
 *   - missing_credentials  (no token configured)
 *   - no_results           (provider returned empty; also covers upstream
 *                           failures because the Travelpayouts provider
 *                           catches fetch errors internally and surfaces
 *                           them as empty data — see handler comment)
 *   - upstream_error       (reserved for synchronous handler failures
 *                           that bubble up out of the provider)
 *   - ok                   (provider returned ≥1 quote)
 *
 * Covers the four reachable handler paths (default-off and demo-on)
 * plus the service-layer circuit-breaker fallback shape (#3795 review).
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ServerContext,
  SearchFlightPricesRequest,
} from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { searchFlightPrices } from '../server/worldmonitor/aviation/v1/search-flight-prices.ts';

type FetchFn = typeof fetch;
const originalFetch: FetchFn | undefined = globalThis.fetch;
const originalToken = process.env.TRAVELPAYOUTS_API_TOKEN;
const originalDemo = process.env.AVIATION_DEMO_PRICES;

const CTX: ServerContext = {
  request: new Request('https://example.com/'),
  pathParams: {},
  headers: {},
};
const REQ: SearchFlightPricesRequest = {
  origin: 'IST',
  destination: 'LHR',
  departureDate: '2026-08-15',
  returnDate: '',
  adults: 1,
  cabin: 'CABIN_CLASS_ECONOMY',
  nonstopOnly: false,
  maxResults: 5,
  currency: 'usd',
  market: '',
};

// Travelpayouts shape: { success: true, data: [...] } for the v2/v3 APIs.
// An empty data array means "no results for this route"; the provider's
// fetchTp wrapper also collapses HTTP/network errors into empty data, so
// the same stub covers both no_results and the swallowed-upstream-error
// case in the current provider implementation.
function stubEmptyUpstream(): FetchFn {
  return async () =>
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

after(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalToken == null) delete process.env.TRAVELPAYOUTS_API_TOKEN;
  else process.env.TRAVELPAYOUTS_API_TOKEN = originalToken;
  if (originalDemo == null) delete process.env.AVIATION_DEMO_PRICES;
  else process.env.AVIATION_DEMO_PRICES = originalDemo;
});

describe('searchFlightPrices — fail-closed default (#3756)', () => {
  beforeEach(() => {
    delete process.env.AVIATION_DEMO_PRICES;
  });

  it('missing credentials → degraded:true, error:missing_credentials, no quotes', async () => {
    delete process.env.TRAVELPAYOUTS_API_TOKEN;
    const result = await searchFlightPrices(CTX, REQ);
    assert.equal(result.quotes.length, 0, 'must NOT return synthetic quotes without a token');
    assert.equal(result.isDemoMode, false, 'must NOT be marked demo (would mislead UI)');
    assert.equal(result.isIndicative, false, 'empty degraded responses must not be marked indicative');
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'missing_credentials');
    assert.equal(result.provider, 'none');
  });

  it('upstream returns empty (or fails — same path) → degraded:true, error:no_results, no quotes', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubEmptyUpstream();
    const result = await searchFlightPrices(CTX, REQ);
    assert.equal(result.quotes.length, 0, 'must NOT fall back to synthetic quotes on empty upstream');
    assert.equal(result.isDemoMode, false);
    assert.equal(result.isIndicative, false);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'no_results');
    assert.equal(result.provider, 'travelpayouts_data');
  });
});

describe('searchFlightPrices — demo opt-in (#3756)', () => {
  beforeEach(() => {
    process.env.AVIATION_DEMO_PRICES = '1';
  });

  it('demo opt-in + missing credentials → demo quotes flagged isDemoMode:true', async () => {
    delete process.env.TRAVELPAYOUTS_API_TOKEN;
    const result = await searchFlightPrices(CTX, REQ);
    assert.ok(result.quotes.length > 0, 'demo path must return synthetic quotes');
    assert.equal(result.isDemoMode, true, 'demo opt-in MUST set isDemoMode so UI shows banner');
    assert.equal(result.isIndicative, true, 'demo quotes are indicative by definition');
    assert.equal(result.degraded, true, 'demo is still a degraded state — provider missing');
    assert.equal(result.error, 'missing_credentials');
    assert.equal(result.provider, 'demo');
  });

  it('demo opt-in + upstream empty → demo quotes flagged isDemoMode:true with error:no_results', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubEmptyUpstream();
    const result = await searchFlightPrices(CTX, REQ);
    assert.ok(result.quotes.length > 0);
    assert.equal(result.isDemoMode, true);
    assert.equal(result.isIndicative, true);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'no_results');
    assert.equal(result.provider, 'demo');
  });
});

// Service-layer circuit-breaker fallback regression (#3795 review).
// The handler is reached via fetch(/api/aviation/v1/search-flight-prices)
// inside src/services/aviation/index.ts. If THAT call throws (network
// down, gateway 5xx, JSON parse error), the breaker returns a static
// fallback object — the ONLY path through which the UI ever sees
// error:'upstream_error', since the server-side `upstream_error` branch
// is unreachable with the current Travelpayouts provider (see handler
// TODO comment).
//
// We can't import the service module from node:test because it pulls in
// a Vite-runtime chain that uses `import.meta.env.DEV` at module load
// (the `test-import-vite-env-dev-transitive` trap documented in
// ~/.claude/skills/test-ci-gotchas/). Use the source-grep regression
// pattern instead (also documented in test-ci-gotchas as
// `source-grep-regression-test-for-unexercisable-defensive-branch`):
// assert that the fallback object in the service has the safety-critical
// shape — never demo, always degraded, surfaces upstream_error.
describe('fetchFlightPrices — service-layer circuit-breaker fallback (#3795)', () => {
  it('breaker fallback shape is safety-critical: never demo, always degraded, error:upstream_error', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/services/aviation/index.ts', import.meta.url),
      'utf8',
    );
    // Locate the fallback object literal: `const fallback = { ... };`
    // Match a short slice (≤500 chars after the const) — the literal is
    // a single inline object.
    const fallbackMatch = source.match(/const fallback = (\{[^}]+\});/);
    assert.ok(fallbackMatch, 'expected to find `const fallback = { ... }` in fetchFlightPrices');
    const lit = fallbackMatch[1];
    assert.match(lit, /isDemoMode:\s*false/, 'fallback MUST set isDemoMode:false — never inject synthetic data on breaker trip');
    assert.match(lit, /degraded:\s*true/, 'fallback MUST set degraded:true so UI shows a message');
    assert.match(lit, /error:\s*['"]upstream_error['"]/, 'fallback MUST surface error:upstream_error so UI renders the "provider unavailable" branch');
    assert.match(lit, /quotes:\s*\[\s*\]/, 'fallback MUST be empty');
  });

  it('breakerPrices.execute call includes shouldCache predicate that rejects degraded/empty (#3795 P1)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/services/aviation/index.ts', import.meta.url),
      'utf8',
    );
    // Without shouldCache, the breaker's persistCache:true would pin a
    // degraded response in IndexedDB for the 10 min TTL, leaving the UI
    // stuck on "credentials required" after the operator restored the
    // token. See PR #3795 review (P1).
    assert.match(
      source,
      /breakerPrices\.execute\([\s\S]{0,1500}?shouldCache:\s*\(r\)\s*=>\s*r\.quotes\.length\s*>\s*0\s*&&\s*!r\.degraded/,
      'fetchFlightPrices must pass shouldCache:(r)=>r.quotes.length>0 && !r.degraded to avoid pinning degraded responses in the persistent cache (#3795 P1)',
    );
  });
});
