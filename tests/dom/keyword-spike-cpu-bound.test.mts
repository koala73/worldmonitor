/**
 * A feed can publish headlines whose titles carry thousands of distinct terms.
 * Every term then holds the same few headlines, and each spike check used to
 * rebuild a lower-cased `source|title` key for every headline of every term:
 * terms x headlines x title length of main-thread work, repeated on every
 * ingest for as long as the headlines stay in the rolling window (a
 * single-source spike never sets its cooldown). Ingest now bounds the title
 * length, which bounds the terms one headline can create.
 *
 * This runs the REAL ingest -> spike pipeline and times the repeat ingest.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { ingestHeadlines, updateTrendingConfig } from '@/services/trending-keywords';

describe('keyword spike checks stay cheap for headlines with thousands of terms', () => {
  beforeAll(() => {
    updateTrendingConfig({ blockedTerms: [], minSpikeCount: 5, spikeMultiplier: 3, autoSummarize: false });
  });

  it('does not rescan every title once per term on each ingest', () => {
    const terms = Array.from({ length: 10_000 }, (_, i) => `zq${i.toString(36).padStart(5, 'a')}`);
    const title = terms.join(' ');
    const now = Date.now();
    ingestHeadlines(Array.from({ length: 20 }, (_, i) => ({
      source: 'Feed',
      title: `${title} ${i}`,
      link: `https://feed.test/${i}`,
      pubDate: new Date(now - i * 1000),
    })));

    const started = performance.now();
    ingestHeadlines([{ source: 'Other', title: 'Quiet harbour reopens', link: 'https://other.test/1', pubDate: new Date(now) }]);
    const elapsed = performance.now() - started;

    expect(elapsed, `repeat ingest took ${elapsed.toFixed(0)} ms`).toBeLessThan(500);
  });
});
