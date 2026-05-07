// Phase 8 — carousel URL parsing + page index helpers + renderer smoke.
//
// After the @vercel/og refactor (PR #3210), the full render path
// actually runs cleanly in Node via tsx — ImageResponse wraps satori
// + resvg-wasm and both work in plain Node. So in addition to the
// pure plumbing tests (URL derivation + page index mapping) we now
// end-to-end each of the three layouts, asserting PNG magic bytes
// and a plausible byte range. This catches Satori tree-shape
// regressions, font-load breakage, and resvg-wasm init issues long
// before they'd surface in a Vercel deploy.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageFromIndex, renderCarouselImageResponse } from '../server/_shared/brief-carousel-render.ts';

// Import the URL helper via dynamic eval of the private function.
// The digest cron is .mjs; we re-declare the same logic here to lock
// the behaviour. If the cron's copy drifts, this test stops guarding
// the contract and should be migrated to shared import.
//
// Kept in-sync via a grep assertion at the bottom of this file.
function carouselUrlsFrom(magazineUrl) {
  try {
    const u = new URL(magazineUrl);
    const m = u.pathname.match(/^\/api\/brief\/([^/]+)\/(\d{4}-\d{2}-\d{2}-\d{4})\/?$/);
    if (!m) return null;
    const [, userId, issueSlot] = m;
    const token = u.searchParams.get('t');
    if (!token) return null;
    return [0, 1, 2].map(
      (p) => `${u.origin}/api/brief/carousel/${userId}/${issueSlot}/${p}?t=${token}`,
    );
  } catch {
    return null;
  }
}

describe('pageFromIndex', () => {
  it('maps 0 → cover, 1 → threads, 2 → story', () => {
    assert.equal(pageFromIndex(0), 'cover');
    assert.equal(pageFromIndex(1), 'threads');
    assert.equal(pageFromIndex(2), 'story');
  });

  it('returns null for out-of-range indices', () => {
    assert.equal(pageFromIndex(-1), null);
    assert.equal(pageFromIndex(3), null);
    assert.equal(pageFromIndex(100), null);
    assert.equal(pageFromIndex(Number.NaN), null);
  });
});

describe('carouselUrlsFrom', () => {
  const magazine = 'https://www.worldmonitor.app/api/brief/user_abc/2026-04-18-0800?t=XXX';

  it('derives three signed carousel URLs from a valid magazine URL', () => {
    const urls = carouselUrlsFrom(magazine);
    assert.ok(urls);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18-0800/0?t=XXX');
    assert.equal(urls[1], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18-0800/1?t=XXX');
    assert.equal(urls[2], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18-0800/2?t=XXX');
  });

  it('preserves origin (localhost, preview deploys, etc.)', () => {
    const urls = carouselUrlsFrom('http://localhost:3000/api/brief/user_a/2026-04-18-1300?t=T');
    assert.equal(urls[0], 'http://localhost:3000/api/brief/carousel/user_a/2026-04-18-1300/0?t=T');
  });

  it('returns null for a URL without a token', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/brief/user_a/2026-04-18-0800'), null);
  });

  it('returns null when the path is not the magazine route', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/dashboard?t=X'), null);
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/other/path/2026-04-18-0800?t=X'), null);
  });

  it('returns null when the slot is date-only (no HHMM suffix)', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/brief/user_a/2026-04-18?t=X'), null);
  });

  it('returns null when slot is not YYYY-MM-DD-HHMM', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/brief/user_a/today?t=X'), null);
  });

  it('returns null on garbage input without throwing', () => {
    assert.equal(carouselUrlsFrom('not a url'), null);
    assert.equal(carouselUrlsFrom(''), null);
    assert.equal(carouselUrlsFrom(null), null);
  });
});

describe('carouselUrlsFrom — contract parity with seed-digest-notifications.mjs', () => {
  it('the cron embeds the same function body (guards drift)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__d, '../scripts/seed-digest-notifications.mjs'), 'utf-8');
    assert.match(src, /function carouselUrlsFrom\(magazineUrl\)/, 'cron must export carouselUrlsFrom');
    assert.match(src, /\/api\/brief\/carousel\/\$\{userId\}\/\$\{issueSlot\}\/\$\{p\}\?t=\$\{token\}/, 'cron path template must match test fixture');
  });
});

// REGRESSION: PR #3174 review P1. The edge route MUST NOT return
// a 200 placeholder PNG on render failure. A 1x1 blank cached 7d
// immutable by Telegram/CDN would lock in a broken preview for
// the life of the brief. Only 200s serve PNG bytes; every failure
// path is a non-2xx JSON with no-cache.
describe('carousel route — no placeholder PNG on failure', () => {
  it('the route source never serves image/png on the render-failed path', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../api/brief/carousel/[userId]/[issueDate]/[page].ts'),
      'utf-8',
    );
    // Old impl had errorPng() returning a 1x1 transparent PNG at 200 +
    // 7d cache. If that pattern ever comes back, this test fails.
    assert.doesNotMatch(src, /\berrorPng\b/, 'errorPng helper must not be reintroduced');
    // Render-failed branch must return 503 with noStore.
    assert.match(
      src,
      /render_failed.{0,200}503.{0,400}noStore:\s*true/s,
      'render failure must 503 with no-store',
    );
  });

  it('FONT_URL uses a Satori-parseable format (ttf / otf / woff — NOT woff2)', async () => {
    // REGRESSION: an earlier head shipped a woff2 URL. Satori parses
    // ttf / otf / woff only — a woff2 buffer throws on every render,
    // the route returns 503, the carousel never delivers. Lock the
    // format here so a future swap can't regress.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../server/_shared/brief-carousel-render.ts'),
      'utf-8',
    );
    const fontUrlMatch = src.match(/const FONT_URL\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(fontUrlMatch, 'FONT_URL constant must exist');
    const url = fontUrlMatch[1];
    assert.doesNotMatch(url, /\.woff2($|\?|#)/i, 'woff2 is NOT supported by Satori — use ttf/otf/woff');
    assert.match(url, /\.(ttf|otf|woff)($|\?|#)/i, 'FONT_URL must end in .ttf, .otf, or .woff');
  });

  it('the renderer honestly declares Google Fonts as a runtime dependency', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __d = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      resolve(__d, '../server/_shared/brief-carousel-render.ts'),
      'utf-8',
    );
    // Earlier comment lied about a "safe embedded/fallback path" that
    // didn't exist. The corrected comment must either honestly declare
    // the CDN dependency OR actually ship an embedded fallback font.
    const hasHonestDependency =
      /RUNTIME DEPENDENCY/i.test(src) || /hard runtime dependency/i.test(src);
    const hasEmbeddedFallback = /const EMBEDDED_FONT_BASE64/.test(src);
    assert.ok(
      hasHonestDependency || hasEmbeddedFallback,
      'font loading must EITHER declare the CDN dependency OR ship an embedded fallback',
    );
  });
});

// ── End-to-end renderer smoke ───────────────────────────────────────────
//
// Exercises @vercel/og's ImageResponse against each layout. Catches:
//   - Satori tree-shape regressions (bad style/children keys throw)
//   - Font fetch breakage (jsdelivr down, wrong format, etc.)
//   - resvg-wasm init failure (rare but has happened)
//   - PNG output corruption (wrong magic, zero bytes)
//
// Hits the real jsdelivr CDN for the Noto Serif TTF. Same network
// footprint as the rest of the data suite (which calls FRED, IMF,
// etc.). If that ever becomes a problem, swap loadFont() to an
// embedded base64 TTF per the comment in brief-carousel-render.ts.

const SAMPLE_ENVELOPE = {
  version: 1,
  issuedAt: Date.now(),
  data: {
    issue: '001',
    dateLong: '19 April 2026',
    user: { name: 'Test User' },
    digest: {
      greeting: 'Good morning',
      lead: 'A sample lead line that gives the reader the day in one sentence.',
      threads: [
        { tag: 'MIDDLE EAST', teaser: 'Iran re-closes the Strait of Hormuz' },
        { tag: 'UKRAINE', teaser: 'Kyiv authorities investigate terror attack' },
        { tag: 'LEBANON', teaser: 'French UNIFIL peacekeeper killed in attack' },
      ],
    },
    stories: [
      {
        category: 'Geopolitics',
        country: 'IR',
        threatLevel: 'HIGH',
        headline: 'Iran closes Strait of Hormuz again, cites US blockade',
        source: 'Reuters',
      },
    ],
  },
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function assertRendersPng(page) {
  const res = await renderCarouselImageResponse(SAMPLE_ENVELOPE, page);
  assert.equal(res.status, 200, `${page}: status should be 200`);
  assert.equal(
    res.headers.get('content-type'),
    'image/png',
    `${page}: content-type must be image/png`,
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.byteLength > 5_000, `${page}: PNG body should be > 5KB, got ${buf.byteLength}`);
  assert.ok(buf.byteLength < 500_000, `${page}: PNG body should be < 500KB, got ${buf.byteLength}`);
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    assert.equal(buf[i], PNG_MAGIC[i], `${page}: byte ${i} should be PNG magic 0x${PNG_MAGIC[i].toString(16)}, got 0x${buf[i].toString(16)}`);
  }
}

describe('renderCarouselImageResponse', () => {
  it('renders the cover page to a valid PNG', async () => {
    await assertRendersPng('cover');
  });

  it('renders the threads page to a valid PNG', async () => {
    await assertRendersPng('threads');
  });

  it('renders the story page to a valid PNG', async () => {
    await assertRendersPng('story');
  });

  it('rejects a structurally empty envelope', async () => {
    await assert.rejects(
      () => renderCarouselImageResponse({}, 'cover'),
      /invalid envelope/,
    );
  });

  it('threads the extraHeaders argument onto the Response', async () => {
    const res = await renderCarouselImageResponse(SAMPLE_ENVELOPE, 'cover', {
      'X-Test-Marker': 'carousel-smoke',
      'Referrer-Policy': 'no-referrer',
    });
    assert.equal(res.headers.get('x-test-marker'), 'carousel-smoke');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  it('keeps @vercel/og default Cache-Control (extraHeaders must NOT override it)', async () => {
    // ImageResponse APPENDS rather than overrides Cache-Control when
    // the caller passes one via headers. Guards the route handler
    // choice to rely on @vercel/og's 1-year immutable default instead
    // of stacking our own. If @vercel/og ever changes this semantics,
    // this test fails and the route needs a review.
    const res = await renderCarouselImageResponse(SAMPLE_ENVELOPE, 'cover', {
      'Cache-Control': 'public, max-age=60',
    });
    const cc = res.headers.get('cache-control') ?? '';
    assert.ok(
      cc.includes('max-age=31536000'),
      `expected @vercel/og's default 1-year cache to survive, got "${cc}"`,
    );
  });
});
