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
    // Lock the function signature + the key line that builds the
    // carousel path. If either drifts, move the impl into a shared
    // .mjs and import it from both the cron and this test.
    assert.match(src, /function carouselUrlsFrom\(magazineUrl\)/, 'cron must export carouselUrlsFrom');
    assert.match(src, /\/api\/brief\/carousel\/\$\{userId\}\/\$\{issueDate\}\/\$\{p\}\?t=\$\{token\}/, 'cron path template must match test fixture');
  });
});
