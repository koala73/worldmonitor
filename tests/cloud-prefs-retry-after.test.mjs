import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTemporaryCloudPrefsStatus, parseRetryAfterSeconds } from '../src/utils/cloud-prefs-retry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../src/utils/cloud-prefs-sync.ts'), 'utf-8');

const postCloudPrefsBody = (() => {
  const start = src.indexOf('async function postCloudPrefs');
  assert.notEqual(start, -1, 'postCloudPrefs must exist in cloud-prefs-sync.ts');
  const end = src.indexOf('// ── Core logic', start);
  assert.notEqual(end, -1, 'postCloudPrefs should end before the core logic section');
  return src.slice(start, end);
})();

const mkHeaders = (value) => {
  const h = new Headers();
  if (value !== undefined) h.set('Retry-After', value);
  return h;
};

describe('temporary cloud prefs statuses', () => {
  it('treats 429 and 503 as retryable temporary failures', () => {
    assert.equal(isTemporaryCloudPrefsStatus(429), true);
    assert.equal(isTemporaryCloudPrefsStatus(503), true);
  });

  it('does not route auth, conflict, or generic server errors through the retry path', () => {
    assert.equal(isTemporaryCloudPrefsStatus(401), false);
    assert.equal(isTemporaryCloudPrefsStatus(409), false);
    assert.equal(isTemporaryCloudPrefsStatus(500), false);
  });

  it('postCloudPrefs uses the temporary-status retry path before generic errors', () => {
    assert.match(
      postCloudPrefsBody,
      /if \(isTemporaryCloudPrefsStatus\(res\.status\)\) throw new ServiceUnavailableError\(parseRetryAfterSeconds\(res\.headers\), res\.status\);/,
      'POST 429 must throw ServiceUnavailableError so uploadNow honors Retry-After instead of stranding the write in error state',
    );
    assert.ok(
      postCloudPrefsBody.includes("if (!res.ok) throw new Error(`post prefs: ${res.status}`);"),
      'generic non-OK handling must remain after the temporary retry branch',
    );
  });
});

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
      assert.equal(parseRetryAfterSeconds(mkHeaders('')), 5);
    });

    it('returns default for negative-number form (not a valid delta-seconds)', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('-5')), 5);
    });

    it('returns default for a date-shaped string lacking a time component', () => {
      assert.equal(parseRetryAfterSeconds(mkHeaders('2026-01-01')), 5);
    });
  });
});
