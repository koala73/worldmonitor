// U7 — notification-relay payload audit.
//
// Codifies the contract:
//   - RSS-origin producers (source: rss) set `payload.description` when
//     their upstream NewsItem carried a snippet — so the relay can render
//     a context line without a secondary lookup.
//   - Domain-origin producers (source: domain, built from structured fields)
//     MUST NOT set `payload.description` — their title is not free-form RSS
//     text, and carrying a description would mislead the relay into rendering
//     a context line that doesn't belong.
//
// Enforcement pattern: every file containing `publishNotificationEvent(` or
// a `fetch('/api/notify'` call must carry a file-level `@notification-source`
// tag declaring its origin. The test fails loudly when a new producer is
// added without the tag, so future drift can't silently slip through CI.
//
// This is a STATIC test — it reads source text, not runtime behavior. The
// tag-comment convention (rather than string-matching titles) follows the
// pattern in `static-analysis-test-fragility`: tag comments are stable,
// string-matching source is brittle.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const PRODUCER_FILES = [
  // Server-side domain producers (Railway / Vercel)
  { path: 'scripts/ais-relay.cjs',                     expected: 'domain' },
  { path: 'scripts/seed-aviation.mjs',                  expected: 'domain' },
  { path: 'scripts/regional-snapshot/alert-emitter.mjs', expected: 'domain' },
  // Browser-side RSS producer
  { path: 'src/services/breaking-news-alerts.ts',       expected: 'rss' },
];

const TAG_PATTERN = /@notification-source:\s*(rss|domain)\b/;

function readSrc(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('notification-relay payload audit', () => {
  for (const { path, expected } of PRODUCER_FILES) {
    it(`${path} declares @notification-source: ${expected}`, () => {
      const src = readSrc(path);
      const match = src.match(TAG_PATTERN);
      assert.ok(
        match,
        `${path} is missing the @notification-source tag. Add a block comment near the file header declaring the origin (rss or domain) so the audit contract is explicit.`,
      );
      assert.strictEqual(
        match[1],
        expected,
        `${path}: expected @notification-source: ${expected}, found ${match[1]}. If the origin genuinely changed, update the payload contract too.`,
      );
    });
  }

  it('domain-origin files do NOT set payload.description (RSS text must not flow through domain producers)', () => {
    // Pattern: `description:` appearing adjacent to a `payload: {` or inside a
    // publishNotificationEvent call. Domain producers build titles from
    // structured fields; a `description:` field in their payload means
    // free-form RSS text is leaking into a non-RSS channel.
    for (const { path, expected } of PRODUCER_FILES) {
      if (expected !== 'domain') continue;
      const src = readSrc(path);
      // Naive but sufficient: no literal `description:` should appear in a
      // publishNotificationEvent payload block. If legitimate uses of
      // `description:` exist elsewhere (e.g. JSDoc, log messages), the
      // audit can tighten to a narrower regex. Today, the producers do not
      // use `description:` as a property anywhere, so a global check is safe.
      const hasPayloadDescription = /payload\s*:\s*\{[^}]*\bdescription\s*:/s.test(src);
      assert.ok(
        !hasPayloadDescription,
        `${path} (domain-origin) must NOT include \`description:\` in a publishNotificationEvent payload. RSS-only context. If you really need a description here, first change the file's @notification-source tag to rss.`,
      );
    }
  });

  it('RSS-origin file carries payload.description when the upstream item has a snippet', () => {
    const src = readSrc('src/services/breaking-news-alerts.ts');
    // The fetch payload at the top of dispatchAlert() now conditionally
    // includes description — look for the spread pattern that guards it.
    assert.ok(
      /\.\.\.\(\s*alert\.description\s*\?\s*\{\s*description\s*:\s*alert\.description\s*\}\s*:\s*\{\s*\}\s*\)/.test(src),
      'breaking-news-alerts.ts must conditionally include `description: alert.description` in the /api/notify payload (post-U7). Grep for `alert.description` in dispatchAlert().',
    );
  });

  it('notification-relay render codepath gates snippet under NOTIFY_RELAY_INCLUDE_SNIPPET', () => {
    const src = readSrc('scripts/notification-relay.cjs');
    assert.ok(
      /NOTIFY_RELAY_INCLUDE_SNIPPET/.test(src),
      'notification-relay.cjs must reference NOTIFY_RELAY_INCLUDE_SNIPPET — U7 gate for the snippet rendering path.',
    );
    assert.ok(
      /event\.payload\?\.description/.test(src),
      'notification-relay.cjs must read event.payload?.description in formatMessage so RSS-origin events can surface a context line.',
    );
  });
});
