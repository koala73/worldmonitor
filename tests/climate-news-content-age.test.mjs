// Sprint 3a — Climate-news content-age contract.
//
// Tests import the SAME climateNewsContentMeta the seeder runs, so a future
// shape change in `_climate-news-helpers.mjs` fails tests instead of silently
// drifting. nowMs is injected with FIXED_NOW for deterministic skew-limit
// behavior (no wall-clock dependence on loaded CI runners).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  climateNewsContentMeta,
  CLIMATE_NEWS_MAX_CONTENT_AGE_MIN,
} from '../scripts/_climate-news-helpers.mjs';

const FIXED_NOW = 1700000000000;     // 2023-11-14T22:13:20.000Z — stable test "now"

test('CLIMATE_NEWS_MAX_CONTENT_AGE_MIN is 7 days', () => {
  assert.equal(CLIMATE_NEWS_MAX_CONTENT_AGE_MIN, 7 * 24 * 60);
});

test('contentMeta returns null on empty items array', () => {
  assert.equal(climateNewsContentMeta({ items: [] }, FIXED_NOW), null);
});

test('contentMeta returns null when items field is missing', () => {
  assert.equal(climateNewsContentMeta({}, FIXED_NOW), null);
});

test('contentMeta picks newest and oldest from valid publishedAt', () => {
  const NEWEST = FIXED_NOW - 1 * 86400_000;
  const MID = FIXED_NOW - 3 * 86400_000;
  const OLDEST = FIXED_NOW - 6 * 86400_000;
  const data = {
    items: [
      { publishedAt: MID },
      { publishedAt: NEWEST },
      { publishedAt: OLDEST },
    ],
  };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  assert.equal(cm.newestItemAt, NEWEST);
  assert.equal(cm.oldestItemAt, OLDEST);
});

test('contentMeta excludes items with publishedAt = 0 (defensive — seeder filter should have already dropped these)', () => {
  const REAL = FIXED_NOW - 86400_000;
  const data = { items: [{ publishedAt: 0 }, { publishedAt: REAL }] };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  assert.equal(cm.newestItemAt, REAL);
  assert.equal(cm.oldestItemAt, REAL);
});

test('contentMeta excludes items with non-numeric publishedAt', () => {
  const REAL = FIXED_NOW - 86400_000;
  const data = {
    items: [
      { publishedAt: 'not-a-number' },
      { publishedAt: null },
      { publishedAt: undefined },
      { publishedAt: NaN },
      { publishedAt: REAL },
    ],
  };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  assert.equal(cm.newestItemAt, REAL);
  assert.equal(cm.oldestItemAt, REAL);
});

test('contentMeta excludes future-dated items beyond 1h clock-skew tolerance', () => {
  const REAL_RECENT = FIXED_NOW - 2 * 86400_000;
  const FUTURE = FIXED_NOW + 2 * 60 * 60 * 1000;     // 2h ahead of NOW — beyond tolerance
  const data = {
    items: [
      { publishedAt: FUTURE },
      { publishedAt: REAL_RECENT },
    ],
  };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  assert.equal(cm.newestItemAt, REAL_RECENT, 'future-dated item beyond 1h tolerance excluded');
});

test('contentMeta accepts items within 1h clock-skew tolerance', () => {
  const NEAR_FUTURE = FIXED_NOW + 5 * 60 * 1000;     // 5min ahead — well inside 1h tolerance
  const data = { items: [{ publishedAt: NEAR_FUTURE }] };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  assert.equal(cm.newestItemAt, NEAR_FUTURE);
});

test('pilot threshold: 8-day-old newest item would trip STALE_CONTENT', () => {
  // If the freshest item is 8 days old, the budget (7 days) is exceeded —
  // /api/health classifyKey would emit STALE_CONTENT.
  const EIGHT_DAYS_AGO = FIXED_NOW - 8 * 86400_000;
  const data = { items: [{ publishedAt: EIGHT_DAYS_AGO }] };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin > CLIMATE_NEWS_MAX_CONTENT_AGE_MIN, `${Math.round(ageMin)}min > budget ${CLIMATE_NEWS_MAX_CONTENT_AGE_MIN}min — STALE_CONTENT would fire`);
});

test('pilot threshold: 3-day-old items are within 7-day budget (no false positive on normal cadence)', () => {
  const THREE_DAYS_AGO = FIXED_NOW - 3 * 86400_000;
  const data = { items: [{ publishedAt: THREE_DAYS_AGO }] };
  const cm = climateNewsContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin < CLIMATE_NEWS_MAX_CONTENT_AGE_MIN, '3d < 7d — STALE_CONTENT does NOT fire');
});
