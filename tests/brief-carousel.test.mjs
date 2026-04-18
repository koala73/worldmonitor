// Phase 8 — carousel URL parsing + page index helpers.
//
// We do NOT test the PNG render here — Satori needs a font buffer and
// @resvg/resvg-wasm needs a WASM init, both of which require a
// browser-or-edge runtime context. The render path is verified via
// the smoke-test route during deploy validation. These tests lock
// the pure plumbing: carousel URL derivation + page index mapping.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageFromIndex } from '../server/_shared/brief-carousel-render.ts';

// Import the URL helper via dynamic eval of the private function.
// The digest cron is .mjs; we re-declare the same logic here to lock
// the behaviour. If the cron's copy drifts, this test stops guarding
// the contract and should be migrated to shared import.
//
// Kept in-sync via a grep assertion at the bottom of this file.
function carouselUrlsFrom(magazineUrl) {
  try {
    const u = new URL(magazineUrl);
    const m = u.pathname.match(/^\/api\/brief\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/?$/);
    if (!m) return null;
    const [, userId, issueDate] = m;
    const token = u.searchParams.get('t');
    if (!token) return null;
    return [0, 1, 2].map(
      (p) => `${u.origin}/api/brief/carousel/${userId}/${issueDate}/${p}?t=${token}`,
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
  const magazine = 'https://www.worldmonitor.app/api/brief/user_abc/2026-04-18?t=XXX';

  it('derives three signed carousel URLs from a valid magazine URL', () => {
    const urls = carouselUrlsFrom(magazine);
    assert.ok(urls);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18/0?t=XXX');
    assert.equal(urls[1], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18/1?t=XXX');
    assert.equal(urls[2], 'https://www.worldmonitor.app/api/brief/carousel/user_abc/2026-04-18/2?t=XXX');
  });

  it('preserves origin (localhost, preview deploys, etc.)', () => {
    const urls = carouselUrlsFrom('http://localhost:3000/api/brief/user_a/2026-04-18?t=T');
    assert.equal(urls[0], 'http://localhost:3000/api/brief/carousel/user_a/2026-04-18/0?t=T');
  });

  it('returns null for a URL without a token', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/brief/user_a/2026-04-18'), null);
  });

  it('returns null when the path is not the magazine route', () => {
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/dashboard?t=X'), null);
    assert.equal(carouselUrlsFrom('https://worldmonitor.app/api/other/path/2026-04-18?t=X'), null);
  });

  it('returns null when issueDate is not YYYY-MM-DD', () => {
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
    assert.match(src, /\/api\/brief\/carousel\/\$\{userId\}\/\$\{issueDate\}\/\$\{p\}\?t=\$\{token\}/, 'cron path template must match test fixture');
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
