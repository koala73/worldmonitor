// Live CORS preflight smoke test against production.
//
// Gated behind LIVE_SMOKE=1 so it does NOT run in the default PR test gate —
// fetching live api.worldmonitor.app from CI would false-positive during
// deploys, network blips, or Cloudflare incidents.
//
// Run manually before/after a Worker deploy:
//   LIVE_SMOKE=1 tsx --test tests/cors-preflight-live.test.mjs
//
// Or wire into a scheduled GitHub Action / Vercel cron if you want continuous
// canary coverage.
//
// What this catches:
//   - `Access-Control-Allow-Credentials: true` missing from OPTIONS preflight
//     (the 2026-05-27 outage — see worldmonitor-architecture-gotchas/reference/
//      cloudflare-worker-overrides-vercel-cors-for-preflight.md).
//   - Origin echo broken (preflight echoes `https://worldmonitor.app` for an
//     allowed origin → browsers reject as mismatched).
//   - Worker bypassed entirely (Vercel fallback served instead — would still
//     pass on healthy days but blow up if/when the Worker is re-enabled).
//
// This test deliberately mirrors what a real browser does for CORS preflight,
// so a failure here is a strong signal of a real user-facing outage.

import { strict as assert } from 'node:assert';
import test from 'node:test';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.worldmonitor.app';

// Endpoints we hit. /api/health is canonical (always available, no auth).
// Add a representative second one to catch route-specific Worker rules if
// anyone ever adds them.
const ENDPOINTS = [
  'https://api.worldmonitor.app/api/health',
  'https://api.worldmonitor.app/api/bootstrap?tier=fast',
];

const SHOULD_RUN = process.env.LIVE_SMOKE === '1';

if (!SHOULD_RUN) {
  test('LIVE smoke gated — set LIVE_SMOKE=1 to run', { skip: true }, () => {});
}

for (const url of ENDPOINTS) {
  test(`OPTIONS ${url} returns ACAC: true for ${ORIGIN}`, { skip: !SHOULD_RUN }, async () => {
    const resp = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'User-Agent': BROWSER_UA,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    // Drain body so the socket can be reused.
    await resp.arrayBuffer();

    assert.equal(
      resp.status,
      204,
      `Preflight should be 204 No Content; got ${resp.status}`,
    );
    assert.equal(
      resp.headers.get('access-control-allow-origin'),
      ORIGIN,
      'ACAO must echo the request origin (NOT https://worldmonitor.app fallback, NOT *)',
    );
    assert.equal(
      resp.headers.get('access-control-allow-credentials'),
      'true',
      'ACAC must be present; missing it breaks every credentials:include request site-wide',
    );
    // Cloudflare may append `accept-encoding` to Vary for compression keying,
    // so check that `Origin` is included (case-insensitive) rather than
    // asserting exact equality.
    const vary = (resp.headers.get('vary') || '').toLowerCase();
    assert.ok(
      vary.split(',').map((s) => s.trim()).includes('origin'),
      `Vary header must include Origin so caches key on origin; got: ${resp.headers.get('vary')}`,
    );
    const acah = resp.headers.get('access-control-allow-headers') || '';
    for (const required of ['Authorization', 'X-WorldMonitor-Key', 'X-Api-Key', 'X-Pro-Key', 'X-Widget-Key']) {
      assert.ok(
        acah.toLowerCase().includes(required.toLowerCase()),
        `ACAH must include ${required}; got: ${acah}`,
      );
    }
  });
}
