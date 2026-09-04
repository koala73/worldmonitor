// Regression tests for middleware.ts's bot-UA gate.
//
// Pins the contract around the `/api/brief/carousel/` carve-out
// shipped in PR #3196: social-platform image fetchers
// (Slack/Telegram/Discord/LinkedIn/etc.) must be able to download
// the carousel PNGs even though their UAs contain "bot" and thus
// match BOT_UA, while the generic bot gate must still 403 plain
// scrapers on every other API path.
//
// Without this test the allowlist is the kind of policy that
// silently regresses on future middleware edits — Telegram's
// sendMediaGroup failure mode ("WEBPAGE_CURL_FAILED") does not
// surface as a CI failure anywhere else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import middleware from '../middleware';
import { WEB_DASHBOARD_VARIANTS } from '../src/config/variant-dashboard-html';
import { VARIANT_META } from '../src/config/variant-meta';

const vercelConfig = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../vercel.json'), 'utf-8'),
) as { headers?: Array<{ source: string; headers?: Array<{ key: string; value: string }> }> };

const TELEGRAM_BOT_UA = 'TelegramBot (like TwitterBot)';
const SLACKBOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const DISCORDBOT_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const LINKEDINBOT_UA = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
const GENERIC_CURL_UA = 'curl/8.1.2';
const GENERIC_SCRAPER_UA = 'Mozilla/5.0 (compatible; SomeRandomBot/1.2)';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Slot format: YYYY-MM-DD-HHMM — per compose run, matches the
// carousel route's ISSUE_DATE_RE and the signer's slot regex.
const CAROUSEL_PATH = '/api/brief/carousel/user_abc/2026-04-19-0800/0';
// Bare YYYY-MM-DD (the pre-slot shape) must no longer match, so digest
// links that predate the slot rollout naturally fall into the bot gate
// instead of silently leaking the allowlist.
const LEGACY_DATE_ONLY_CAROUSEL_PATH = '/api/brief/carousel/user_abc/2026-04-19/0';
const OTHER_API_PATH = '/api/notifications';
const MALFORMED_CAROUSEL_PATH = '/api/brief/carousel/admin/dashboard';

function call(pathOrUrl: string, ua: string, headers: Record<string, string> = {}): Response | void {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://www.worldmonitor.app${pathOrUrl}`;
  const req = new Request(url, {
    headers: {
      ...(ua ? { 'user-agent': ua } : {}),
      ...headers,
    },
  });
  return middleware(req) as Response | void;
}

describe('middleware variant root user agents', () => {
  it('passes browsers and AI crawlers to the same production redirect', () => {
    for (const variant of WEB_DASHBOARD_VARIANTS) {
      const root = new URL(VARIANT_META[variant].url).origin;
      assert.equal(call(root, CHROME_UA), undefined);
      assert.equal(call(root, 'Mozilla/5.0 GPTBot/1.1'), undefined);
    }
  });

  it('keeps social preview metadata variant-specific', async () => {
    const res = call('https://tech.worldmonitor.app/', SLACKBOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<meta property="og:title" content="Tech Monitor/);
    assert.match(html, /<link rel="canonical" href="https:\/\/tech\.worldmonitor\.app\/dashboard"/);
    assert.doesNotMatch(html, /application\/ld\+json/);
  });
});

describe('middleware bot gate / keyed API clients', () => {
  const KEYED_API_PATH = '/api/forecast/v1/get-forecast-scorecard';
  const USER_API_KEY = `wm_${'a'.repeat(40)}`;
  const ENTERPRISE_API_KEY = `wm_${'b'.repeat(48)}`;

  it('passes a 40-hex user API key through when curl would otherwise be blocked', () => {
    const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': USER_API_KEY });
    assert.equal(res, undefined, 'the gateway, not the UA gate, must validate a well-shaped user key');
  });

  it('passes a 48-hex enterprise API key through when curl would otherwise be blocked', () => {
    const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': ENTERPRISE_API_KEY });
    assert.equal(res, undefined, 'the gateway, not the UA gate, must validate a well-shaped enterprise key');
  });

  it('still blocks malformed and overlong wm_ keys with a curl UA', () => {
    for (const apiKey of [`wm_${'c'.repeat(39)}`, `wm_${'d'.repeat(65)}`, 'wm_not-hex']) {
      const res = call(KEYED_API_PATH, GENERIC_CURL_UA, { 'x-worldmonitor-key': apiKey });
      assert.ok(res instanceof Response, `${apiKey} must not bypass the UA gate`);
      assert.equal(res.status, 403);
    }
  });
});

describe('middleware bot gate / carousel allowlist', () => {
  it('passes TelegramBot through on the carousel route (the PR #3196 fix)', () => {
    const res = call(CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.equal(res, undefined, 'Telegram must be able to fetch carousel images');
  });

  it('passes Slackbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, SLACKBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes Discordbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, DISCORDBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes LinkedInBot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, LINKEDINBOT_UA);
    assert.equal(res, undefined);
  });

  it('still 403s curl on the carousel route (bot gate protects from non-social UAs)', () => {
    const res = call(CAROUSEL_PATH, GENERIC_CURL_UA);
    assert.ok(res instanceof Response, 'should return a Response, not pass through');
    assert.equal(res.status, 403);
  });

  it('still 403s a generic "bot" UA on the carousel route', () => {
    const res = call(CAROUSEL_PATH, GENERIC_SCRAPER_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on non-carousel API routes (allowlist is scoped, not global)', () => {
    const res = call(OTHER_API_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on malformed carousel paths (regex enforces route shape)', () => {
    const res = call(MALFORMED_CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s missing UA on the carousel route (short-UA guard)', () => {
    const res = call(CAROUSEL_PATH, '');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('passes normal browsers through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('passes normal browsers through on any API route', () => {
    const res = call(OTHER_API_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('does not accept page 3+ on the carousel route (pageFromIndex only has 0/1/2)', () => {
    const res = call('/api/brief/carousel/user_abc/2026-04-19-0800/3', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response, 'out-of-range page must hit the bot gate');
    assert.equal(res.status, 403);
  });

  it('does not accept non-slot segments on the carousel route', () => {
    const res = call('/api/brief/carousel/user_abc/today/0', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('does not accept the pre-slot YYYY-MM-DD shape (slot rollout parity)', () => {
    // Once the composer moves to slot URLs, legacy date-only paths
    // should NOT leak the social allowlist — they correspond to
    // expired pre-rollout links whose Redis keys no longer exist.
    const res = call(LEGACY_DATE_ONLY_CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── PUBLIC_API_PATHS allowlist (secret-authed internal endpoints) ────────────
// The middleware's "no UA or suspiciously short" 403 guard (middleware.ts:
// ~L183) blocks Node/undici default-UA callers. Internal endpoints that carry
// their own Bearer-auth must be in PUBLIC_API_PATHS to bypass the gate.
//
// History:
//   - /api/seed-contract-probe hit this 2026-04-15 (UptimeRobot + ops curl).
//   - /api/internal/brief-why-matters hit this 2026-04-21 immediately after
//     PR #3248 merge — every Railway cron call returned 403 and silently
//     fell back to legacy Gemini. No functional breakage (3-layer fallback
//     absorbed it) but the new feature never ran in prod.
//
// These tests pin the allowlist so a future middleware refactor (e.g. the
// BOT_UA regex being narrowed, or PUBLIC_API_PATHS being reorganized) can't
// silently drop an entry.

describe('middleware PUBLIC_API_PATHS — secret-authed internal endpoints bypass UA gate', () => {
  // UAs that would normally 403 on any other API route.
  const EMPTY_UA = '';
  const UNDICI_UA = 'undici';          // Too short (<10 chars) — triggers short-UA 403.
  const CURL_UA = GENERIC_CURL_UA;     // Matches curl/ in BOT_UA regex.

  const TRIGGERS = [
    { label: 'empty UA (middleware short-UA gate)', ua: EMPTY_UA },
    { label: 'short UA (Node undici default-ish)', ua: UNDICI_UA },
    { label: 'curl UA (BOT_UA regex hit)', ua: CURL_UA },
  ];

  const ALLOWED_PATHS = [
    '/api/version',
    '/api/health',
    '/api/seed-contract-probe',
    '/api/internal/brief-why-matters',
    '/api/llms.txt',
    '/api/product-catalog',
    '/api/download.md',
  ];

  for (const path of ALLOWED_PATHS) {
    for (const { label, ua } of TRIGGERS) {
      it(`${path} bypasses the UA gate (${label})`, () => {
        const res = call(path, ua);
        assert.equal(res, undefined, `${path} must pass through the middleware (no 403); its own auth gate handles access`);
      });
    }
  }

  // Negative case: a sibling path that is NOT in the allowlist must still 403
  // under EACH of the 3 triggers. This catches a future refactor that moves
  // the PUBLIC_API_PATHS check later in the chain (e.g. behind a broadened
  // prefix-match) and might let one of the trigger UAs slip through on a
  // sibling path without this suite failing. Pin all three guard paths.
  const SIBLING_PATHS = [
    '/api/internal/brief-why-matters-v2',     // near-miss suffix
    '/api/internal/',                          // directory only
    '/api/internal/other',                     // different leaf
  ];

  for (const path of SIBLING_PATHS) {
    for (const { label, ua } of TRIGGERS) {
      it(`${path} does NOT bypass the UA gate — ${label}`, () => {
        const res = call(path, ua);
        assert.ok(res instanceof Response, `${path} must still hit the 403 guard under ${label}`);
        assert.equal(res.status, 403);
      });
    }
  }
});

// ── /api/llms.txt agent-discovery bypass ─────────────────────────────────────
// The section-level llms.txt for the developer/API surface lives at
// public/api/llms.txt, so it is served under the /api/* namespace where the
// middleware's BOT_UA gate 403s crawlers. AI crawlers are the entire audience
// for an llms.txt, so the bypass must let them through — otherwise the file is
// published but unreadable by the agents it exists to serve.

describe('middleware /api/llms.txt — AI crawlers reach the agent-discovery file', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'GPTBot', ua: 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
    { label: 'PerplexityBot', ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
    { label: 'CCBot', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
    { label: 'generic scraper', ua: GENERIC_SCRAPER_UA },
    { label: 'empty UA', ua: '' },
  ];

  for (const { label, ua } of CRAWLER_UAS) {
    it(`passes ${label} through to /api/llms.txt`, () => {
      const res = call('/api/llms.txt', ua);
      assert.equal(res, undefined, '/api/llms.txt must pass through the bot gate for AI crawlers');
    });
  }

  it('still 403s a crawler on a sibling /api path (bypass is exact, not a prefix)', () => {
    const res = call('/api/llms', 'CCBot/2.0 (https://commoncrawl.org/faq/)');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── /api/download.md markdown-URL-fallback bypass ────────────────────────────
// Homepage download badges are sampled as a "content page". Agent-readiness
// scanners then request /api/download.md. The twin is a static file under
// public/api/, so it lives in the /api/* namespace where BOT_UA 403s crawlers
// unless this path is on PUBLIC_API_PATHS.

describe('middleware /api/download.md — markdown-URL-fallback crawlers reach the twin', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'python-requests', ua: 'python-requests/2.31' },
    { label: 'curl UA', ua: 'curl/8.7.1' },
    { label: 'empty UA', ua: '' },
  ];

  for (const { label, ua } of CRAWLER_UAS) {
    it(`passes ${label} through to /api/download.md`, () => {
      const res = call('/api/download.md', ua);
      assert.equal(res, undefined, '/api/download.md must pass through the bot gate for markdown-fallback crawlers');
    });
  }

  it('still 403s a crawler on GET /api/download (bypass is exact, not a prefix)', () => {
    const res = call('/api/download', 'CCBot/2.0 (https://commoncrawl.org/faq/)');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// The protocol is site-wide `/{page}` → `/{page}.md`, not one sampled URL.
// GET/HEAD /api/**/*.md must pass the bot gate; POST must not inherit that bypass.
describe('middleware /api/*.md — site-wide markdown URL-fallback twins bypass the bot gate', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'python-requests', ua: 'python-requests/2.31' },
    { label: 'empty UA', ua: '' },
  ];

  for (const path of ['/api/health.md', '/api/v1/foo.md', '/api/download.md']) {
    for (const { label, ua } of CRAWLER_UAS) {
      it(`passes ${label} through to GET ${path}`, () => {
        const res = call(path, ua);
        assert.equal(res, undefined, `${path} must pass through the bot gate for markdown-fallback crawlers`);
      });
    }
  }

  it('still 403s a crawler on POST /api/health.md (bypass is GET/HEAD only)', () => {
    const url = 'https://www.worldmonitor.app/api/health.md';
    const req = new Request(url, {
      method: 'POST',
      headers: { 'user-agent': 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
    });
    const res = middleware(req);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── /api/product-catalog public-pricing bypass ──────────────────────────────
// The keyless read-only pricing catalog is advertised as service-meta in
// /.well-known/api-catalog; agents evaluating the product are its primary
// audience. An agent-journey run (#4854) hit the UA gate here and concluded
// the endpoint did not exist. DELETE (cache purge) stays protected by the
// endpoint's own auth — the middleware bypass only skips UA filtering.

describe('middleware /api/product-catalog — agents reach the public pricing catalog', () => {
  const CRAWLER_UAS = [
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    { label: 'GPTBot', ua: 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
    { label: 'python-requests', ua: 'python-requests/2.31' },
    { label: 'empty UA', ua: '' },
  ];

  for (const { label, ua } of CRAWLER_UAS) {
    it(`passes ${label} through to /api/product-catalog`, () => {
      const res = call('/api/product-catalog', ua);
      assert.equal(res, undefined, '/api/product-catalog must pass through the bot gate; it is a public discovery surface');
    });
  }

  it('still 403s a crawler on a sibling /api path (bypass is exact, not a prefix)', () => {
    const res = call('/api/product', 'CCBot/2.0 (https://commoncrawl.org/faq/)');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

// ── /mcp variant-subdomain canonicalization ──────────────────────────────────
// The MCP endpoint's canonical URL is apex (`https://worldmonitor.app/mcp`).
// GET/HEAD requests from variant subdomains are redirected there so discovery
// signals don't fragment across tech/finance/etc. POST/OPTIONS continue to the
// /api/mcp rewrite unchanged so MCP clients configured against a variant host
// still handshake correctly.

describe('middleware /mcp — variant subdomains redirect to apex, POST stays', () => {
  it('redirects GET /mcp from tech.worldmonitor.app to apex', () => {
    const res = call('https://tech.worldmonitor.app/mcp', CHROME_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://worldmonitor.app/mcp');
  });

  it('redirects HEAD /mcp from finance.worldmonitor.app to apex', () => {
    const req = new Request('https://finance.worldmonitor.app/mcp', { method: 'HEAD' });
    const res = middleware(req) as Response | void;
    assert.ok(res instanceof Response);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://worldmonitor.app/mcp');
  });

  it('redirects /mcp from every variant subdomain', () => {
    for (const host of ['tech', 'finance', 'commodity', 'happy', 'energy']) {
      const res = call(`https://${host}.worldmonitor.app/mcp`, CHROME_UA);
      assert.ok(res instanceof Response, `${host} must redirect`);
      assert.equal(res.status, 308, `${host} redirect status`);
      assert.equal(res.headers.get('location'), 'https://worldmonitor.app/mcp', `${host} redirect location`);
    }
  });

  it('does NOT redirect GET /mcp from apex or www', () => {
    assert.equal(call('https://worldmonitor.app/mcp', CHROME_UA), undefined);
    assert.equal(call('https://www.worldmonitor.app/mcp', CHROME_UA), undefined);
  });

  it('does NOT redirect POST /mcp from a variant subdomain (MCP handshake)', () => {
    const req = new Request('https://tech.worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'user-agent': CHROME_UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const res = middleware(req) as Response | void;
    assert.equal(res, undefined, 'POST /mcp must fall through to the /api/mcp rewrite');
  });

  it('does NOT redirect OPTIONS /mcp from a variant subdomain', () => {
    const req = new Request('https://tech.worldmonitor.app/mcp', {
      method: 'OPTIONS',
      headers: { 'user-agent': CHROME_UA },
    });
    const res = middleware(req) as Response | void;
    assert.equal(res, undefined, 'OPTIONS /mcp must fall through to the /api/mcp rewrite');
  });

  it('does NOT redirect variant transport GETs with SSE or replay headers', () => {
    const mixedCaseSse = new Request('https://tech.worldmonitor.app/mcp', {
      headers: { Accept: 'Text/Event-Stream' },
    });
    assert.equal(middleware(mixedCaseSse), undefined, 'mixed-case SSE Accept must fall through to the transport');

    const replay = new Request('https://tech.worldmonitor.app/mcp', {
      headers: { Accept: 'application/json', 'Last-Event-ID': 'stream:0' },
    });
    assert.equal(middleware(replay), undefined, 'Last-Event-ID replay must stay on the session host');
  });

  it('redirects when SSE is explicitly unacceptable', () => {
    const req = new Request('https://tech.worldmonitor.app/mcp', {
      headers: { Accept: 'text/event-stream;q=0, text/html' },
    });
    const res = middleware(req) as Response | void;
    assert.ok(res instanceof Response);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://worldmonitor.app/mcp');
  });
});

// #7660: `/?<map state>` 308'd to `/dashboard?<the same map state>`, forwarding
// the query into its own redirect. Because any lat/lon/zoom/layer combination
// is a distinct URL, every shared or bookmarked map link became a permanent
// entry in Search Console's "Page with redirect" bucket — 301 of the 1,000
// exported URLs, from only 111 distinct param strings, and the bucket grew
// 199 -> 1,271 in three months.
//
// The canonical is already the param-free `/dashboard`, so a crawler loses
// nothing by being sent straight there. Humans keep the state: those params
// are what makes a shared legacy root link still open the right view. The
// collapse is therefore User-Agent-conditioned (the #7380 pattern), which is
// why the response must carry Vary + no-store — without them a shared cache
// could replay the crawler's stripped Location to a human.
describe('legacy root map-state links (#7660)', () => {
  const MAP_STATE =
    'lat=20.0000&lon=0.0000&zoom=1.00&view=global&timeRange=7d&layers=conflicts%2Cbases';
  const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  it('sends a crawler to the param-free /dashboard document', () => {
    const res = call(`/?${MAP_STATE}`, GOOGLEBOT_UA);
    assert.ok(res instanceof Response, 'crawler must be redirected');
    assert.equal(res.status, 308);
    assert.equal(
      res.headers.get('location'),
      'https://www.worldmonitor.app/dashboard',
      'the map state must not be forwarded into the redirect'
    );
    assert.match(res.headers.get('vary') ?? '', /User-Agent/i);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  it('collapses attribution params and map state in a single hop', () => {
    const res = call(`/?ref=affiliate&${MAP_STATE}&utm_source=newsletter`, GOOGLEBOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.headers.get('location'), 'https://www.worldmonitor.app/dashboard');
  });

  it('keeps the map state for humans', () => {
    const res = call(`/?${MAP_STATE}`, CHROME_UA);
    assert.ok(res instanceof Response, 'legacy root deep links must still reach the dashboard');
    assert.equal(res.status, 308);
    assert.equal(
      res.headers.get('location'),
      `https://www.worldmonitor.app/dashboard?${MAP_STATE}`,
      'a shared legacy link must still open the view it encodes'
    );
  });

  it('closes every caching layer on BOTH branches', () => {
    // One request URL, two Locations, chosen by User-Agent. A 308 is cacheable
    // by default (RFC 9110 §15.4.9), so a cache that stored either branch
    // without the key would replay it to the other's client — serving the
    // crawler the parameterised URL this change exists to keep it off, or
    // stripping a human's map state.
    //
    // `Cache-Control` alone is insufficient here: vercel.json gives `/` a
    // CDN-Cache-Control of `public, s-maxage=600`, and the CDN directives take
    // priority over Cache-Control for the shared cache. And per RFC 9111, Vary
    // on one response cannot protect a sibling that omitted it — so every
    // layer, on both branches.
    for (const [label, ua] of [
      ['crawler', GOOGLEBOT_UA],
      ['human', CHROME_UA],
    ] as const) {
      const res = call(`/?${MAP_STATE}`, ua);
      assert.ok(res instanceof Response, `${label} must be redirected`);
      assert.match(res.headers.get('vary') ?? '', /User-Agent/i, `${label} branch must declare Vary`);
      for (const [header, expected] of [
        ['cache-control', 'private, no-store'],
        ['cdn-cache-control', 'no-store'],
        ['vercel-cdn-cache-control', 'no-store'],
      ] as const) {
        assert.equal(
          res.headers.get(header),
          expected,
          `${label} branch must set ${header}: a layer left open can store one UA's Location and replay it to the other`
        );
      }
    }
  });

  it('overrides the s-maxage the / route would otherwise apply', () => {
    // The concrete number this defends against. If vercel.json ever drops the
    // CDN cache on `/`, this assertion becomes trivially true rather than
    // wrong — but while the cache exists, the middleware must out-rank it.
    const rootRule = (vercelConfig.headers ?? []).find((entry: { source: string }) => entry.source === '/');
    const cdn = (rootRule?.headers ?? []).find((h: { key: string }) => h.key === 'CDN-Cache-Control');
    if (!cdn) return;
    assert.match(cdn.value, /s-maxage=\d+/, 'expected the / route to carry a shared-cache lifetime');
    const res = call(`/?${MAP_STATE}`, GOOGLEBOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(
      res.headers.get('cdn-cache-control'),
      'no-store',
      `the / route caches for ${cdn.value} at the CDN; the UA-conditioned redirect must opt out`
    );
  });

  it('leaves /dashboard?<map state> alone for everyone', () => {
    // The canonical tag already consolidates these and robots.txt keeps
    // crawlers off them. Redirecting would manufacture the very redirects
    // this change removes.
    assert.equal(call(`/dashboard?${MAP_STATE}`, GOOGLEBOT_UA), undefined);
    assert.equal(call(`/dashboard?${MAP_STATE}`, CHROME_UA), undefined);
  });

  it('does not touch a param-free root request', () => {
    assert.equal(call('/', GOOGLEBOT_UA), undefined);
    assert.equal(call('/', CHROME_UA), undefined);
  });

  // #7660 raised this as a "serious problem if it ever fires": agents.md warns
  // that default HTTP-library UAs may be challenged with 403, and Search
  // Console reported 26 URLs "blocked due to access forbidden". The gate is
  // scoped to /api/* by an early return, so no content path can 403 a search
  // crawler — but nothing asserted it, and the early return is one edit away
  // from being reordered.
  it('never 403s a search crawler on a content path', () => {
    const CRAWLERS = [
      GOOGLEBOT_UA,
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    ];
    const CONTENT_PATHS = [
      '/',
      '/dashboard',
      '/pro',
      '/countries/iran/',
      '/chokepoints/strait-of-hormuz/',
      '/compare/iran-vs-israel/',
      '/llms.txt',
      '/sitemap.xml',
    ];
    for (const ua of CRAWLERS) {
      for (const path of CONTENT_PATHS) {
        const res = call(path, ua);
        if (res instanceof Response) {
          assert.notEqual(res.status, 403, `${path} must not 403 a crawler (${ua.slice(0, 40)}…)`);
        }
      }
    }
  });
});
