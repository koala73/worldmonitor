// `ensureHydrated()` fetches a key through its own CDN-shielded public URL,
// `/api/bootstrap?keys=<name>&public=1`, sent with `credentials: 'omit'`.
//
// The server serves that URL publicly for ONE key drawn from the on-demand
// tier (isPublicOnDemandBootstrapRequest, api/bootstrap.js). For any other key
// it falls through to validateApiKey, sees no credential — the request omitted
// them — and answers 401 {"error":"API key required"}. Verified against
// production 2026-07-27:
//
//   ?keys=crossStraitActivity&public=1   no cookie -> 401
//   ?keys=crossStraitActivity&public=1   w/ cookie -> 200
//   ?keys=chinaDecisionSignals&public=1  no cookie -> 200   (on-demand)
//
// So a non-on-demand key can never be served by this URL, and the request is
// guaranteed-dead work. Worse, it is not inert: the wm-session interceptor only
// waves through credential-less bootstrap reads whose key IS on-demand
// (PUBLIC_ON_DEMAND_BOOTSTRAP_KEYS, wm-session.ts), so this one enters session
// recovery — which mints a fresh cookie and replays a request that omits
// credentials, gets the same 401, and reports `wm_session_route_401`. That is
// WORLDMONITOR-XP: 100% of its events were route `/api/bootstrap`, ~125/hr,
// each one blaming the anonymous session for a request that never presented it.
//
// `crossStraitActivity` is the live instance — a `slow`-tier key that
// MilitaryCorrelationPanel re-reads through ensureHydrated() after
// getHydratedData() has drained it.

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { ensureHydrated } from '../src/services/bootstrap.ts';
import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';

const ON_DEMAND = new Set(bootstrapTierKeyNames('on-demand'));

const originalFetch = globalThis.fetch;
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    // Mirror production: the public URL only serves on-demand keys.
    const key = new URL(url, 'https://api.worldmonitor.app').searchParams.get('keys') ?? '';
    if (!ON_DEMAND.has(key)) {
      return new Response(JSON.stringify({ error: 'API key required' }), { status: 401 });
    }
    return new Response(JSON.stringify({ data: { [key]: { ok: true } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ensureHydrated public on-demand key guard (WORLDMONITOR-XP)', () => {
  it('does not issue a guaranteed-401 public read for a key outside the on-demand tier', async () => {
    assert.equal(
      ON_DEMAND.has('crossStraitActivity'),
      false,
      'precondition: crossStraitActivity is a slow-tier key, so the public URL cannot serve it',
    );

    const value = await ensureHydrated('crossStraitActivity');

    assert.equal(value, undefined, 'callers already treat a miss as "fall back to your own path"');
    assert.deepEqual(
      requested,
      [],
      'no request may be issued: the public URL provably 401s for this key, and the '
      + 'wm-session interceptor turns that 401 into a mint + replay + wm_session_route_401 report',
    );
  });

  it('still fetches keys the public on-demand URL genuinely serves', async () => {
    // Guard rail: the fix keys off the registry, so every real on-demand key
    // must keep its CDN-cached path. A fix that simply stopped fetching would
    // pass the test above and silently disable #5300 hydration everywhere.
    const onDemandKey = 'chinaDecisionSignals';
    assert.equal(ON_DEMAND.has(onDemandKey), true, 'precondition: this key IS on-demand');

    const value = await ensureHydrated(onDemandKey);

    assert.deepEqual(value, { ok: true }, 'the on-demand payload still hydrates');
    assert.equal(requested.length, 1, 'exactly one CDN read');
    assert.match(requested[0] ?? '', /\/api\/bootstrap\?keys=chinaDecisionSignals&public=1$/);
  });
});
