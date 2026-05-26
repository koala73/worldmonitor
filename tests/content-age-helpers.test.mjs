// Unit tests for scripts/_content-age-helpers.mjs — the shared content-age
// extractor introduced for issue #3845 (frozen-upstream detection).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { periodTokenToMs, tokensToContentMeta, DAY_MIN } from '../scripts/_content-age-helpers.mjs';

test('DAY_MIN is one day in minutes', () => {
  assert.equal(DAY_MIN, 1440);
});

test('periodTokenToMs parses each SDMX granularity to a UTC instant', () => {
  assert.equal(periodTokenToMs('2026-05-18'), Date.UTC(2026, 4, 18));
  assert.equal(periodTokenToMs('2026-03'), Date.UTC(2026, 2, 1));      // monthly → 1st of month
  assert.equal(periodTokenToMs('2024-Q4'), Date.UTC(2024, 9, 1));      // quarterly → 1st of quarter
  assert.equal(periodTokenToMs('2024-Q1'), Date.UTC(2024, 0, 1));
  assert.equal(periodTokenToMs('2024'), Date.UTC(2024, 0, 1));         // annual → 1st of year
  // Full ISO datetime parses to that exact instant.
  assert.equal(periodTokenToMs('2026-05-18T14:00:00Z'), Date.parse('2026-05-18T14:00:00Z'));
});

test('periodTokenToMs returns null for unparseable / out-of-range tokens', () => {
  // `2026-05-18garbage` exercises the (?:T|$) anchor — a date PREFIX with
  // trailing garbage must be rejected, not silently accepted.
  for (const bad of ['', '   ', 'not-a-date', '2026-13', '2026-Q5', '2026-00',
                     '2026-05-18garbage', '2026-05-18-extra', null, undefined, 42, {}]) {
    assert.equal(periodTokenToMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('tokensToContentMeta reduces a list to {newestItemAt, oldestItemAt}', () => {
  const now = Date.UTC(2026, 4, 21);
  const meta = tokensToContentMeta(['2026-05-01', '2026-05-18', '2026-04-10'], now);
  assert.deepEqual(meta, {
    newestItemAt: Date.UTC(2026, 4, 18),
    oldestItemAt: Date.UTC(2026, 3, 10),
  });
});

test('tokensToContentMeta accepts a single (non-array) token', () => {
  const now = Date.UTC(2026, 4, 21);
  const meta = tokensToContentMeta('2026-05-18', now);
  assert.deepEqual(meta, { newestItemAt: Date.UTC(2026, 4, 18), oldestItemAt: Date.UTC(2026, 4, 18) });
});

test('tokensToContentMeta drops future-dated tokens beyond 1h skew tolerance', () => {
  const now = Date.UTC(2026, 4, 21);
  // A token a full year in the future is dropped; the past token still counts.
  const meta = tokensToContentMeta(['2026-05-10', '2027-05-10'], now);
  assert.deepEqual(meta, { newestItemAt: Date.UTC(2026, 4, 10), oldestItemAt: Date.UTC(2026, 4, 10) });
});

test('tokensToContentMeta returns null when nothing datable survives — health reads this as STALE_CONTENT', () => {
  const now = Date.UTC(2026, 4, 21);
  assert.equal(tokensToContentMeta([], now), null);
  assert.equal(tokensToContentMeta(['garbage', null, undefined], now), null);
  assert.equal(tokensToContentMeta(['2099-01-01'], now), null); // all future
});

test('tokensToContentMeta skips unparseable tokens but keeps the valid ones', () => {
  const now = Date.UTC(2026, 4, 21);
  const meta = tokensToContentMeta(['2026-05-18', 'garbage', null, '2026-05-01'], now);
  assert.deepEqual(meta, {
    newestItemAt: Date.UTC(2026, 4, 18),
    oldestItemAt: Date.UTC(2026, 4, 1),
  });
});
