import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDigestCoverage } from '../server/worldmonitor/news/v1/_attempts';

const here = dirname(fileURLToPath(import.meta.url));
const digestSource = readFileSync(
  resolve(here, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
  'utf-8',
);

const ENTRIES = [
  { category: 'politics', feed: { name: 'BBC World' } },
  { category: 'politics', feed: { name: 'Guardian World' } },
  { category: 'tech', feed: { name: 'Hacker News' } },
] as const;

const ALL_OK = new Map<string, string>([
  ['BBC World', 'completed'],
  ['Guardian World', 'completed'],
  ['Hacker News', 'zero-items'],
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
      attemptOutcomes: new Map([
        ['BBC World', 'completed'],
        ['Guardian World', 'completed'],
        // Hacker News never ran — the whole tech category is missing.
        ['Hacker News', 'not-started'],
      ]),
    });
    assert.equal(cov.state, 'partial');
    assert.deepEqual(cov.categoryStates, { politics: 'ok', tech: 'missing' });
    assert.equal(cov.feedCompleted, 2);
    assert.equal(cov.feedTotal, 3);
  });

  it('classifies unavailable when no items were served', () => {
    const cov = buildDigestCoverage({ ...BASE, itemsServed: 0, publisherSources: [] });
    assert.equal(cov.state, 'unavailable');
    assert.equal(cov.itemsServed, 0);
    assert.equal(cov.publisherCount, 0);
  });

  it('classifies stale when accepted older content is served (#7084)', () => {
    const cov = buildDigestCoverage({
      ...BASE,
      servingStale: true,
      staleReason: 'empty-rebuild',
      staleAcceptedAtMs: BASE.buildStartMs - 90_000,
      nowMs: BASE.buildStartMs,
    });
    assert.equal(cov.state, 'stale');
    assert.equal(cov.servedStale, true);
    assert.equal(cov.staleReason, 'empty-rebuild');
    assert.equal(cov.staleAgeSeconds, 90);
  });

  it('marks fresh builds with the empty stale fields', () => {
    const cov = buildDigestCoverage({ ...BASE });
    assert.equal(cov.servedStale, false);
    assert.equal(cov.staleAgeSeconds, 0);
    assert.equal(cov.staleReason, '');
  });

  it('counts distinct publishers of the SERVED items, not feeds or parsed items', () => {
    const cov = buildDigestCoverage({ ...BASE });
    // 5 served items, 3 distinct publisher labels.
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

  it('returns the coverage block on the digest response', () => {
    assert.match(digestSource, /generatedAt: new Date\(\)\.toISOString\(\),[\s\S]{0,80}coverage,/);
  });

  it('gives the empty fallback an explicit unavailable coverage block', () => {
    assert.match(digestSource, /state: 'unavailable'/);
  });

  it('keeps the public feedStatuses map unchanged (no competing health model)', () => {
    // The coarse per-feed statuses stay; coverage is an aggregate block,
    // not a second per-feed vocabulary.
    assert.match(digestSource, /feedStatuses\[feed\.name\] = 'empty'/);
    assert.ok(!digestSource.includes('feedHealth'));
  });
});
