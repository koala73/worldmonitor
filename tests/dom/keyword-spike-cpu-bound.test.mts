/**
 * A feed can publish headlines whose titles carry thousands of distinct terms.
 * Every term then holds the same few headlines, and each spike check used to
 * rebuild a lower-cased `source|title` key for every headline of every term:
 * terms x headlines x title length of main-thread work, repeated on every
 * ingest for as long as the headlines stay in the rolling window (a
 * single-source spike never sets its cooldown). Term extraction now reads only
 * the start of a title, which bounds the terms one headline can create, while
 * the headline itself (identity, evidence) stays whole.
 *
 * These run the REAL ingest -> spike -> signal pipeline.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { CorrelationSignal } from '@/services/correlation';
import {
  drainTrendingSignals,
  getTrackedTermCount,
  ingestHeadlines,
  updateTrendingConfig,
} from '@/services/trending-keywords';

async function drainSpikeFor(term: RegExp): Promise<CorrelationSignal> {
  const seen: CorrelationSignal[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    seen.push(...drainTrendingSignals());
    const match = seen.find(signal => signal.type === 'keyword_spike' && term.test(String(signal.data.term ?? '')));
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`no keyword_spike matching ${term}`);
}

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
    // Uncapped, these titles fill all 10,000 tracked-term slots.
    expect(getTrackedTermCount()).toBeLessThan(1_000);

    const started = performance.now();
    ingestHeadlines([{ source: 'Other', title: 'Quiet harbour reopens', link: 'https://other.test/1', pubDate: new Date(now) }]);
    const elapsed = performance.now() - started;

    expect(elapsed, `repeat ingest took ${elapsed.toFixed(0)} ms`).toBeLessThan(2000);
  });

  it('keeps long headlines whole: same 500-char prefix, different stories', async () => {
    const prefix = `Officials in Quillmoor ${'regional council report '.repeat(30)}`;
    expect(prefix.length).toBeGreaterThan(500);
    const sources = ['Reuters', 'Reuters', 'AP', 'AP', 'BBC'];
    const now = Date.now();
    const headlines = sources.map((source, i) => ({
      source,
      title: `${prefix}story ${i}`,
      link: `https://long.test/${i}`,
      pubDate: new Date(now - i * 1000),
    }));
    ingestHeadlines(headlines);

    const signal = await drainSpikeFor(/quillmoor/i);
    const titles = (signal.data.articles ?? []).map(article => article.title).sort();
    expect(titles).toEqual(headlines.map(headline => headline.title).sort());
  });
});
