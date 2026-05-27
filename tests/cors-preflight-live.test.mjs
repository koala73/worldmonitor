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

// Public-CORS paths that the Worker MUST pass through to Vercel unchanged.
// External MCP clients (https://claude.ai, https://claude.com) hit these and
// must receive the Vercel function's own CORS policy (typically ACAO: * for
// OAuth/MCP), not the Worker's worldmonitor.app-only echo.
const PUBLIC_CORS_PROBES = [
  { url: 'https://api.worldmonitor.app/api/mcp', origin: 'https://claude.ai' },
  { url: 'https://api.worldmonitor.app/api/oauth/register', origin: 'https://claude.com' },
  { url: 'https://api.worldmonitor.app/api/oauth-protected-resource', origin: 'https://claude.ai' },
];

for (const { url, origin } of PUBLIC_CORS_PROBES) {
  test(`OPTIONS ${url} from ${origin} bypasses Worker → Vercel ACAO survives`, { skip: !SHOULD_RUN }, async () => {
    const resp = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'User-Agent': BROWSER_UA,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    await resp.arrayBuffer();
    // Acceptance: the response must NOT echo the canonical worldmonitor.app
    // fallback (which would mean the Worker short-circuited and the external
    // client gets blocked). Either ACAO: * OR ACAO echoes the request origin
    // is fine — both are valid public-CORS dispositions.
    const acao = resp.headers.get('access-control-allow-origin');
    assert.ok(
      acao === '*' || acao === origin,
      `Public-CORS path ${url} returned ACAO=${acao} for Origin=${origin}; expected '*' or echo. Worker is short-circuiting when it should bypass.`,
    );
  });
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

    // Worker's Allow-Methods MUST be a superset of every method any api/*
    // route advertises. api/product-catalog.js advertises 'GET, DELETE,
    // OPTIONS' on its preflight, so DELETE belongs in the global Worker list.
    // Missing it silently breaks browser-origin product-catalog purges in
    // prod — exactly the regression that PR review caught locally.
    const acam = (resp.headers.get('access-control-allow-methods') || '')
      .split(',').map((s) => s.trim().toUpperCase());
    for (const required of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      assert.ok(
        acam.includes(required),
        `ACAM must include ${required}; got: ${acam.join(', ')}`,
      );
    }
  });
}
