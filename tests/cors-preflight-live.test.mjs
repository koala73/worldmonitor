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
//   - Public bootstrap URLs served with the credentialed header shape at the
//     edge (#7308, #7311), which the origin's own guard cannot see.
//
// This test deliberately mirrors what a real browser does for CORS preflight,
// so a failure here is a strong signal of a real user-facing outage.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  assertPublicBootstrapCorsHeaders,
  assertPublicBootstrapSharedCacheHeaders,
} from './helpers/public-bootstrap-contract.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CRAWLER_UA = 'Twitterbot/1.0';
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

// The one guard that reads the bytes users actually receive on the public
// bootstrap tiers. api/bootstrap-auth.test.mjs proves api/bootstrap.js builds
// this shape; it calls handler() directly, so it is blind to everything the
// edge does afterwards — the Worker's CORS stamp and, since #7292, a KV path
// that mints the response at the POP without touching the handler at all.
// #7308 lived in exactly that blind spot for weeks.
for (const tier of ['fast', 'slow']) {
  test(`GET public ${tier} bootstrap tier serves the public header shape through the edge`, { skip: !SHOULD_RUN }, async () => {
    const url = `https://api.worldmonitor.app/api/bootstrap?tier=${tier}&public=1`;
    // A browser UA is required or Cloudflare answers 403. The Origin is sent
    // because that is what a real dashboard load does — and echoing it back
    // instead of `*` is precisely the drift this asserts against.
    const resp = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': BROWSER_UA } });
    await resp.arrayBuffer();
    assert.equal(resp.status, 200, `public ${tier} tier should serve 200; got ${resp.status}`);

    const source = resp.headers.get('x-worldmonitor-bootstrap-source');
    assertPublicBootstrapCorsHeaders({ assert, resp, label: `public ${tier} tier (source=${source || 'origin'})` });

    if (source === 'kv') {
      // Deliberate, and asserted so it stays a decision. Rationale:
      // workers/api-cors-preflight/src/kv-serve.js#serveFromKv.
      assert.match(
        resp.headers.get('cache-control') || '', /\bno-store\b/,
        'the KV-served tier is browser-no-store by design (the POP-local KV read is the cache)',
      );
      // Note this branch is chosen by a header browser JS cannot read (it is not in the Worker's
      // Expose-Headers). Fine from Node; a browser-context canary would silently take the origin
      // branch and assert a CDN shield against KV-minted bytes.
      assert.equal(
        resp.headers.get('cdn-cache-control'), null,
        'a KV-minted response must not advertise a CDN lifetime no shared cache will honour',
      );
    } else {
      // Origin fallback (hedged/miss/stale, or the KV kill-switch): this one
      // really does sit behind Vercel's CDN, so its shield must survive the
      // Worker's header rewrite intact.
      assertPublicBootstrapSharedCacheHeaders({ assert, resp, label: `public ${tier} tier via origin` });
    }
  });

  test(`OPTIONS public ${tier} bootstrap tier preflight matches its own GET`, { skip: !SHOULD_RUN }, async () => {
    // The preflight and the response are one contract. Advertising
    // Allow-Credentials on the leg that clears a request whose answer is ACAO `*`
    // with no credentials is the same split #7308 was filed about.
    const resp = await fetch(`https://api.worldmonitor.app/api/bootstrap?tier=${tier}&public=1`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'User-Agent': BROWSER_UA,
        'Access-Control-Request-Method': 'GET',
      },
    });
    await resp.arrayBuffer();
    assert.equal(resp.headers.get('access-control-allow-origin'), '*', `public ${tier} preflight ACAO must be '*'`);
    assert.equal(
      resp.headers.get('access-control-allow-credentials'), null,
      `public ${tier} preflight must not advertise credentials for a public URL`,
    );
  });
}

const PUBLIC_SINGLE_KEY_PROBES = [
  ['weather', 'weatherAlerts'],
  ['on-demand', 'forecasts'],
];

for (const [label, key] of PUBLIC_SINGLE_KEY_PROBES) {
  const url = `https://api.worldmonitor.app/api/bootstrap?keys=${key}&public=1`;

  test(`GET marked ${label} bootstrap serves the public header shape through the edge`, { skip: !SHOULD_RUN }, async () => {
    const resp = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': BROWSER_UA } });
    await resp.arrayBuffer();
    assert.equal(resp.status, 200, `marked ${label} bootstrap should serve 200; got ${resp.status}`);
    assertPublicBootstrapCorsHeaders({ assert, resp, label: `marked ${label} bootstrap` });
    assertPublicBootstrapSharedCacheHeaders({ assert, resp, label: `marked ${label} bootstrap` });
  });

  test(`OPTIONS marked ${label} bootstrap preflight matches its GET`, { skip: !SHOULD_RUN }, async () => {
    const resp = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'User-Agent': BROWSER_UA,
        'Access-Control-Request-Method': 'GET',
      },
    });
    await resp.arrayBuffer();
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  });
}

test('GET marked non-public bootstrap key stays credentialed', { skip: !SHOULD_RUN }, async () => {
  const resp = await fetch('https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes&public=1', {
    headers: { Origin: ORIGIN, 'User-Agent': BROWSER_UA },
  });
  await resp.arrayBuffer();
  assert.equal(resp.status, 401);
  assert.equal(resp.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

test('GET /api/story keeps cacheable crawler HTML isolated from browser redirects', { skip: !SHOULD_RUN }, async () => {
  // The unique query string guarantees a cold cache key. Both requests use the
  // exact same URL and run back-to-back from one runner, so a Worker that ignores
  // Vary: User-Agent will cache the crawler 200 and incorrectly replay it to the
  // browser request instead of returning the origin's redirect.
  const probe = new URL('https://api.worldmonitor.app/api/story');
  probe.searchParams.set('c', 'US');
  probe.searchParams.set('t', 'ciianalysis');
  probe.searchParams.set('ts', `cors-live-${Date.now()}-${process.pid}`);

  const crawlerResp = await fetch(probe, {
    redirect: 'manual',
    headers: { 'User-Agent': CRAWLER_UA },
  });
  await crawlerResp.arrayBuffer();
  assert.equal(crawlerResp.status, 200, 'crawler should receive cacheable story HTML');
  const crawlerVary = (crawlerResp.headers.get('vary') || '')
    .split(',').map((name) => name.trim().toLowerCase());
  assert.ok(
    crawlerVary.includes('user-agent'),
    `crawler response must vary by User-Agent; got: ${crawlerResp.headers.get('vary')}`,
  );

  const browserResp = await fetch(probe, {
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA },
  });
  await browserResp.arrayBuffer();
  const crawlerColo = crawlerResp.headers.get('cf-ray')?.split('-').at(-1);
  const browserColo = browserResp.headers.get('cf-ray')?.split('-').at(-1);
  assert.ok(crawlerColo, 'crawler response must include a Cloudflare colo in CF-Ray');
  assert.equal(
    browserColo,
    crawlerColo,
    `both cache probes must hit the same Cloudflare colo; crawler=${crawlerColo}, browser=${browserColo}`,
  );
  assert.equal(
    browserResp.status,
    302,
    `browser should receive the story redirect, not cached crawler HTML; CF-Cache-Status=${browserResp.headers.get('cf-cache-status')}`,
  );
});
