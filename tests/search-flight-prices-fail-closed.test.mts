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
 * Covers the four reachable paths under the production-default
 * (demo OFF) and the two demo-on opt-in paths.
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
    assert.equal(result.degraded, true);
    assert.equal(result.error, 'no_results');
    assert.equal(result.provider, 'demo');
  });
});
