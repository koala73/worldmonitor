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
 *   - upstream_error       (fetchTp returned null — HTTP error, network
 *                           failure, or success:false body; cached as
 *                           NEG_SENTINEL for 2 min by cachedFetchJson)
 *   - no_results           (upstream returned a successful empty payload
 *                           for this route; cached for the full 1-2h TTL)
 *   - ok                   (provider returned ≥1 quote)
 *
 * #3795 review-2 follow-up: prior draft swallowed null → [] inside the
 * cachedFetchJson fetcher, which collapsed upstream failures into
 * no_results AND cached them for 1-2 hours. The provider now passes
 * null through unchanged and surfaces `upstreamFailed: boolean` on its
 * result so the handler can distinguish the two states.
 *
 * Covers all reachable handler paths under default-off and demo-on,
 * plus a source-grep regression on the service-layer breaker fallback.
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

// Successful upstream response with no data — distinct from upstream failure.
function stubUpstreamSuccessEmpty(): FetchFn {
  return async () =>
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

// HTTP 500 → fetchTp inside the provider returns null → handler sees upstreamFailed.
function stubUpstreamHttp500(): FetchFn {
  return async () =>
    new Response('upstream exploded', { status: 500 });
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

  it('upstream returns 200 + empty data → degraded:true, error:no_results (genuine empty route)', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubUpstreamSuccessEmpty();
    const result = await searchFlightPrices(CTX, REQ);
    assert.equal(result.quotes.length, 0);
    assert.equal(result.isDemoMode, false);
    assert.equal(result.isIndicative, false);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'no_results', 'genuine empty must NOT be reported as upstream_error');
    assert.equal(result.provider, 'travelpayouts_data');
  });

  it('upstream HTTP 500 → degraded:true, error:upstream_error (#3795 review-2)', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubUpstreamHttp500();
    const result = await searchFlightPrices(CTX, REQ);
    assert.equal(result.quotes.length, 0);
    assert.equal(result.isDemoMode, false);
    assert.equal(result.isIndicative, false);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'upstream_error', 'HTTP failures MUST surface as upstream_error, not no_results');
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

  it('demo opt-in + upstream success-but-empty → demo quotes + error:no_results', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubUpstreamSuccessEmpty();
    const result = await searchFlightPrices(CTX, REQ);
    assert.ok(result.quotes.length > 0);
    assert.equal(result.isDemoMode, true);
    assert.equal(result.isIndicative, true);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'no_results');
    assert.equal(result.provider, 'demo');
  });

  it('demo opt-in + upstream HTTP 500 → demo quotes + error:upstream_error (#3795 review-2)', async () => {
    process.env.TRAVELPAYOUTS_API_TOKEN = 'fake-token';
    globalThis.fetch = stubUpstreamHttp500();
    const result = await searchFlightPrices(CTX, REQ);
    assert.ok(result.quotes.length > 0);
    assert.equal(result.isDemoMode, true);
    assert.equal(result.isIndicative, true);
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'upstream_error');
    assert.equal(result.provider, 'demo');
  });
});

// Service-layer circuit-breaker fallback regression (#3795 review).
// The handler is reached via fetch(/api/aviation/v1/search-flight-prices)
// inside src/services/aviation/index.ts. If THAT call throws (network
// down, gateway 5xx, JSON parse error), the breaker returns a static
// fallback object — the ONLY path through which the UI ever sees the
// breaker-side error:'upstream_error'.
//
// We can't import the service module from node:test because it pulls in
// a Vite-runtime chain that uses `import.meta.env.DEV` at module load
// (the `test-import-vite-env-dev-transitive` trap documented in
// ~/.claude/skills/test-ci-gotchas/). Use the source-grep regression
// pattern instead (also from test-ci-gotchas as
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
    assert.match(
      source,
      /breakerPrices\.execute\([\s\S]{0,2000}?shouldCache:\s*\(r\)\s*=>\s*r\.quotes\.length\s*>\s*0\s*&&\s*!r\.degraded/,
      'fetchFlightPrices must pass shouldCache:(r)=>r.quotes.length>0 && !r.degraded to avoid pinning degraded responses in the persistent cache (#3795 P1)',
    );
  });

  it('breakerPrices.execute opts into evictOnRefreshFailure so degraded states surface (#3795 review-2)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/services/aviation/index.ts', import.meta.url),
      'utf8',
    );
    // Without this option, SWR would preserve previously-good quotes
    // forever even after the server starts returning degraded — the
    // exact stale-display bug the reviewer caught on the first review pass.
    assert.match(
      source,
      /breakerPrices\.execute\([\s\S]{0,2000}?evictOnRefreshFailure:\s*true/,
      'fetchFlightPrices must opt into evictOnRefreshFailure:true so SWR refresh that fails shouldCache evicts the stale entry instead of pinning it (#3795 review-2 P1)',
    );
  });
});
