import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDigestCoverage, type FeedAttemptOutcome } from '../server/worldmonitor/news/v1/_attempts';
import { __testing__ as digestTesting } from '../server/worldmonitor/news/v1/list-feed-digest';

const here = dirname(fileURLToPath(import.meta.url));
const digestSource = readFileSync(
  resolve(here, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
  'utf-8',
);

const ENTRIES = [
  { attemptId: 'politics:0', category: 'politics' },
  { attemptId: 'politics:1', category: 'politics' },
  { attemptId: 'tech:2', category: 'tech' },
] as const;

const ALL_OK = new Map<string, FeedAttemptOutcome>([
  ['politics:0', 'completed'],
  ['politics:1', 'completed'],
  ['tech:2', 'empty'],
]);

const BASE = {
  entries: ENTRIES,
  attemptOutcomes: ALL_OK,
  itemsServed: 5,
  publisherSources: ['BBC', 'Guardian', 'BBC', 'Ars', 'Guardian'],
  deadlineAborted: false,
  servingStale: false,
  drops: { perFeedCap: 2, undated: 1, freshnessFloor: 3, perCategoryCap: 4 },
  buildStartMs: Date.UTC(2026, 7, 22, 12, 0, 0),
} as const;

describe('digest coverage block (#7085)', () => {
  it('classifies complete when every category has a completed feed and no deadline abort', () => {
    const cov = buildDigestCoverage({ ...BASE });
    assert.equal(cov.state, 'complete');
    assert.equal(cov.categoryCompleted, 2);
    assert.equal(cov.categoryTotal, 2);
    assert.deepEqual(cov.categoryStates, { politics: 'ok', tech: 'ok' });
  });

  it('classifies partial when the global deadline aborted the build', () => {
    const cov = buildDigestCoverage({ ...BASE, deadlineAborted: true });
    assert.equal(cov.state, 'partial');
  });

  it('classifies partial when a configured category has no completed feed', () => {
    const cov = buildDigestCoverage({
      ...BASE,
      attemptOutcomes: new Map<string, FeedAttemptOutcome>([
        ['politics:0', 'completed'],
        ['politics:1', 'completed'],
        // Hacker News never ran — the whole tech category is missing.
        ['tech:2', 'not-started'],
      ]),
    });
    assert.equal(cov.state, 'partial');
    assert.deepEqual(cov.categoryStates, { politics: 'ok', tech: 'missing' });
    assert.equal(cov.feedCompleted, 2);
    assert.equal(cov.feedTotal, 3);
  });

  for (const failedOutcome of [
    'direct-timeout',
    'relay-failure',
    'aborted-by-deadline',
    'other-fetch-failure',
    'negative-cache',
    'not-started',
  ] satisfies FeedAttemptOutcome[]) {
    it(`does not count ${failedOutcome} as completed coverage`, () => {
      const cov = buildDigestCoverage({
        ...BASE,
        attemptOutcomes: new Map<string, FeedAttemptOutcome>([
          ['politics:0', 'completed'],
          ['politics:1', 'completed'],
          ['tech:2', failedOutcome],
        ]),
      });
      assert.equal(cov.state, 'partial');
      assert.equal(cov.feedCompleted, 2);
      assert.deepEqual(cov.categoryStates, { politics: 'ok', tech: 'missing' });
    });
  }

  it('classifies unavailable when no items were served', () => {
    const cov = buildDigestCoverage({ ...BASE, itemsServed: 0, publisherSources: [] });
    assert.equal(cov.state, 'unavailable');
    assert.equal(cov.itemsServed, 0);
    assert.equal(cov.publisherCount, 0);
  });

  it('classifies stale when accepted older content is served (forward-compat with #7084)', () => {
    const cov = buildDigestCoverage({ ...BASE, servingStale: true });
    assert.equal(cov.state, 'stale');
  });

  it('counts distinct publishers of the SERVED items, not feeds or parsed items', () => {
    const cov = buildDigestCoverage({ ...BASE });
    // 5 served items, 3 normalized publisher families.
    assert.equal(cov.publisherCount, 3);
    assert.equal(cov.itemsServed, 5);
  });

  it('carries per-gate drop counts under their documented names', () => {
    const cov = buildDigestCoverage({ ...BASE });
    assert.equal(cov.droppedFeedCap, 2);
    assert.equal(cov.droppedUndated, 1);
    assert.equal(cov.droppedFreshness, 3);
    assert.equal(cov.droppedCategoryCap, 4);
  });

  it('stamps attemptedAt from the build, distinct from content generatedAt', () => {
    const cov = buildDigestCoverage({ ...BASE });
    assert.equal(cov.attemptedAt, '2026-08-22T12:00:00.000Z');
  });

  it('emits only counts, closed vocabulary, and timestamps — no URLs, hosts, or raw errors', () => {
    const cov = buildDigestCoverage({ ...BASE });
    const flat = JSON.stringify(cov);
    for (const banned of ['http', '://', 'Error', 'relay', 'example.com', 'feed.url']) {
      assert.ok(!flat.includes(banned), `coverage block must not leak ${banned}`);
    }
    assert.ok(['complete', 'partial', 'stale', 'unavailable'].includes(cov.state));
  });
});

describe('list-feed-digest coverage wiring (#7085)', () => {
  it('builds the response coverage through the pure classifier', () => {
    assert.match(digestSource, /buildDigestCoverage\(\{/);
    assert.match(digestSource, /servingStale: false/);
  });

  it('normalizes served items to publisher families before counting them', () => {
    assert.match(digestSource, /publisherFamilyFor\(item\.originPublisher \|\| item\.source\)/);
  });

  it('returns the coverage block on the digest response', () => {
    assert.match(digestSource, /generatedAt: new Date\(\)\.toISOString\(\),[\s\S]{0,80}coverage,/);
  });

  it('gives the empty fallback an explicit unavailable coverage block', () => {
    assert.match(digestSource, /state: 'unavailable'/);
  });

  it('marks retained content stale for both null and thrown build failures', () => {
    const fallbackCalls = digestSource.match(/markFallbackCoverageStale\(fallback, attemptedAt\)/g) ?? [];
    assert.equal(fallbackCalls.length, 2);
  });

  it('preserves retained content identity and counts while replacing attempt identity', () => {
    const retained = {
      categories: { politics: { items: [] } },
      feedStatuses: { Reuters: 'ok' },
      generatedAt: '2026-08-22T10:00:00.000Z',
      coverage: {
        state: 'complete',
        attemptedAt: '2026-08-22T10:00:00.000Z',
        itemsServed: 7,
        publisherCount: 3,
        feedTotal: 5,
        feedCompleted: 5,
        categoryTotal: 2,
        categoryCompleted: 2,
        categoryStates: { politics: 'ok', tech: 'ok' },
        droppedFeedCap: 1,
        droppedUndated: 2,
        droppedFreshness: 3,
        droppedCategoryCap: 4,
      },
    };

    const stale = digestTesting.markFallbackCoverageStale(
      retained,
      '2026-08-22T10:05:00.000Z',
    );

    assert.notEqual(stale, retained);
    assert.equal(stale.categories, retained.categories);
    assert.equal(stale.feedStatuses, retained.feedStatuses);
    assert.equal(stale.generatedAt, retained.generatedAt);
    assert.equal(stale.coverage?.state, 'stale');
    assert.equal(stale.coverage?.attemptedAt, '2026-08-22T10:05:00.000Z');
    assert.equal(stale.coverage?.itemsServed, 7);
    assert.equal(stale.coverage?.publisherCount, 3);
    assert.equal(stale.coverage?.feedTotal, 5);
    assert.equal(stale.coverage?.categoryStates, retained.coverage.categoryStates);
    assert.equal(retained.coverage.state, 'complete');
    assert.equal(retained.coverage.attemptedAt, '2026-08-22T10:00:00.000Z');
  });

  it('reconstructs conservative stale coverage for retained pre-coverage content', () => {
    const retained = {
      categories: {
        politics: { items: [{ source: 'Reuters' }] },
        tech: { items: [] },
      },
      feedStatuses: { Reuters: 'ok' },
      generatedAt: '2026-08-22T10:00:00.000Z',
    } as never;

    const stale = digestTesting.markFallbackCoverageStale(
      retained,
      '2026-08-22T10:05:00.000Z',
    );

    assert.equal(stale.coverage?.state, 'stale');
    assert.equal(stale.coverage?.itemsServed, 1);
    assert.equal(stale.coverage?.publisherCount, 1);
    assert.equal(stale.coverage?.feedTotal, 0);
    assert.equal(stale.coverage?.feedCompleted, 0);
    assert.equal(stale.coverage?.categoryTotal, 2);
    assert.equal(stale.coverage?.categoryCompleted, 1);
    assert.deepEqual(stale.coverage?.categoryStates, { politics: 'ok', tech: 'missing' });
  });

  it('keeps the public feedStatuses map unchanged (no competing health model)', () => {
    // The coarse per-feed statuses stay; coverage is an aggregate block,
    // not a second per-feed vocabulary.
    assert.match(digestSource, /feedStatuses\[feed\.name\] = 'empty'/);
    assert.ok(!digestSource.includes('feedHealth'));
  });
});
