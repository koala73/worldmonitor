import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHINA_NEWS_SOURCE_NAMES,
  buildChinaNewsCoverage,
} from '../scripts/_china-news-coverage.mjs';
import { preserveChinaNewsCoverageInLkg } from '../scripts/seed-insights.mjs';

const GENERATED_AT = '2026-07-14T12:00:00.000Z';

test('China news coverage treats completed dated feeds as available without depending on global ranking', () => {
  const coverage = buildChinaNewsCoverage({ en: {
    generatedAt: GENERATED_AT,
    // list-feed-digest intentionally records only exceptional feed states;
    // absence means the feed completed with at least one dated item.
    feedStatuses: {},
  }, zh: { generatedAt: GENERATED_AT, feedStatuses: {} } });

  assert.equal(coverage.countryCode, 'CN');
  assert.deepEqual(coverage.sources, CHINA_NEWS_SOURCE_NAMES.map((source) => ({
    source,
    status: 'available',
    observedAt: GENERATED_AT,
  })));
});

test('China news coverage preserves per-source outage truth instead of publishing a global success', () => {
  const coverage = buildChinaNewsCoverage({ en: {
    generatedAt: GENERATED_AT,
    feedStatuses: {
      Xinhua: 'timeout',
    },
  }, zh: {
    generatedAt: GENERATED_AT,
    feedStatuses: {
      'MIIT (China)': 'partial-undated',
      'MOFCOM (China)': 'all-undated',
    },
  } });

  assert.deepEqual(coverage.sources, [
    { source: 'Xinhua', status: 'unavailable', reason: 'timeout' },
    { source: 'MIIT (China)', status: 'available', observedAt: GENERATED_AT, reason: 'partial-undated' },
    { source: 'MOFCOM (China)', status: 'unavailable', reason: 'all-undated' },
  ]);
});

test('China news coverage refuses to mint a fresh source observation from an undated digest', () => {
  const coverage = buildChinaNewsCoverage({ en: { feedStatuses: {} }, zh: { feedStatuses: {} } });

  assert.deepEqual(
    coverage.sources,
    CHINA_NEWS_SOURCE_NAMES.map((source) => ({
      source,
      status: 'unavailable',
      reason: 'digest_timestamp_missing',
    })),
  );
});

test('China news coverage marks Chinese-language sources unavailable when their locale digest is absent', () => {
  const coverage = buildChinaNewsCoverage({
    en: { generatedAt: GENERATED_AT, feedStatuses: {} },
  });

  assert.deepEqual(coverage.sources, [
    { source: 'Xinhua', status: 'available', observedAt: GENERATED_AT },
    { source: 'MIIT (China)', status: 'unavailable', reason: 'digest_unavailable' },
    { source: 'MOFCOM (China)', status: 'unavailable', reason: 'digest_unavailable' },
  ]);
});

test('LKG global brief preservation still publishes fresh China source evidence', () => {
  const existing = { status: 'ok', topStories: [{ primaryTitle: 'Last-known-good brief' }] };
  const chinaNewsCoverage = buildChinaNewsCoverage({
    en: { generatedAt: GENERATED_AT, feedStatuses: {} },
    zh: { generatedAt: GENERATED_AT, feedStatuses: {} },
  });

  assert.deepEqual(preserveChinaNewsCoverageInLkg(existing, chinaNewsCoverage), {
    ...existing,
    chinaNewsCoverage,
  });
  assert.deepEqual(existing, { status: 'ok', topStories: [{ primaryTitle: 'Last-known-good brief' }] });
});
