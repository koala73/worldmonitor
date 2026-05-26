import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract `parseRetryAfterSeconds` from src/utils/cloud-prefs-sync.ts and
// run it standalone. The full module imports browser-only globals; this
// test focuses on the pure-function piece. Same regex+Function pattern the
// other src-extraction tests use (csp-filter, sentry-beforesend).
const src = readFileSync(resolve(__dirname, '../src/utils/cloud-prefs-sync.ts'), 'utf-8');
const constsBlock = src.match(/const RETRY_AFTER_MIN_SEC[\s\S]*?const RETRY_AFTER_DEFAULT_SEC[^\n]+/);
assert.ok(constsBlock, 'RETRY_AFTER_* constants must exist in cloud-prefs-sync.ts');
const fnMatch = src.match(/export function parseRetryAfterSeconds\(headers: Headers\): number \{([\s\S]*?)\n\}/);
assert.ok(fnMatch, 'parseRetryAfterSeconds must exist in cloud-prefs-sync.ts');

const fnBody = constsBlock[0] + ';\n' + fnMatch[1].trim();
// eslint-disable-next-line no-new-func
const parseRetryAfterSeconds = new Function('headers', fnBody);

const mkHeaders = (value) => {
  const h = new Headers();
  if (value !== undefined) h.set('Retry-After', value);
  return h;
};

describe('parseRetryAfterSeconds', () => {
  describe('delta-seconds form', () => {
    it('parses a small integer', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('5')), 5);
    });

    it('parses a larger integer', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('30')), 30);
    });

    it('clamps to RETRY_AFTER_MIN_SEC for 0', () => {
      // 0 means "retry immediately" per RFC, but that risks a retry storm
      // if the server is misbehaving. Floor at 1s.
      assert.equal(parseRetryAfterSeconds(mkHeaders('0')), 1);
    });

    it('clamps to RETRY_AFTER_MAX_SEC for very large values', () => {
      // Some servers send huge values during planned outages. Cap at 60s
      // so sync isn't stranded for minutes.
      assert.equal(parseRetryAfterSeconds(mkHeaders('3600')), 60);
    });

    it('handles whitespace around the value', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('  7  ')), 7);
    });
  });

  describe('HTTP-date form', () => {
    it('converts a future date to delta-seconds', () => {
      const futureMs = Date.now() + 8000;
      const dateStr = new Date(futureMs).toUTCString();
      const result = parseRetryAfterSeconds(mkHeaders(dateStr));
      // Allow ±1s tolerance for the round-trip through Date.toUTCString
      assert.ok(result >= 7 && result <= 9, `expected ~8s, got ${result}s`);
    });

    it('clamps a past date to RETRY_AFTER_MIN_SEC', () => {
      const pastDate = new Date(Date.now() - 60000).toUTCString();
      assert.equal(parseRetryAfterSeconds(mkHeaders(pastDate)), 1);
    });

    it('clamps a far-future date to RETRY_AFTER_MAX_SEC', () => {
      const farFuture = new Date(Date.now() + 999999999).toUTCString();
      assert.equal(parseRetryAfterSeconds(mkHeaders(farFuture)), 60);
    });
  });

  describe('missing or malformed → default', () => {
    it('returns RETRY_AFTER_DEFAULT_SEC when header is absent', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders(undefined)), 5);
    });

    it('returns default for a non-numeric / non-date string', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('soon-please')), 5);
    });

    it('returns default for empty string', () => {
      // Empty header is treated as absent by Headers.set, but the regex
      // won't match either — defensive double-check.
      assert.equal(parseRetryAfterSeconds(mkHeaders('')), 5);
    });

    it('returns default for negative-number form (not a valid delta-seconds)', () => {
      // RFC delta-seconds is digits-only; "-5" would parse via Number()
      // but our `^\d+$` regex correctly rejects it. The HTTP-date branch
      // is then gated on a 4-digit year + a `:` separator, so "-5" can't
      // sneak through as Date.parse("-5") returning year -5 BCE.
      assert.equal(parseRetryAfterSeconds(mkHeaders('-5')), 5);
    });

    it('returns default for a date-shaped string lacking a time component', () => {
      // Defensive: "2025-01-01" would Date.parse() as midnight Jan 1.
      // The colon-required gate excludes it, falling into default rather
      // than letting Date.parse interpret a date-only string and clamp
      // to MIN/MAX based on now's distance from Jan 1.
      assert.equal(parseRetryAfterSeconds(mkHeaders('2025-01-01')), 5);
    });
  });
});
