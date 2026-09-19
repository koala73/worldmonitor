import { describe, expect, it } from 'vitest';

import { detectConvergence } from '@/services/analysis-core';
import type { ClusteredEventCore } from '../../shared/news-clustering-core.js';

describe('source convergence window', () => {
  it('describes the 60-minute filter, including items older than 30 minutes', () => {
    const publishedAt = new Date(Date.now() - 45 * 60 * 1000);
    const sources = [
      ['Reuters', 'wire'],
      ['State Dept', 'gov'],
      ['Jane\'s', 'intel'],
    ] as const;
    const allItems = sources.map(([source]) => ({
      source,
      title: 'Border clash draws official statements',
      link: `https://example.test/${source}`,
      pubDate: publishedAt,
      isAlert: false,
    }));
    const event: ClusteredEventCore = {
      id: 'border-clash',
      primaryTitle: 'Border clash draws official statements',
      primarySource: 'Reuters',
      primaryLink: allItems[0]!.link,
      sourceCount: allItems.length,
      uniquePublisherCount: allItems.length,
      topSources: [],
      allItems,
      firstSeen: publishedAt,
      lastUpdated: publishedAt,
      isAlert: false,
    };
    const types = new Map<string, 'wire' | 'gov' | 'intel'>(sources);
    const signals = detectConvergence(
      [event],
      (source) => types.get(source) ?? 'other',
      () => false,
      () => undefined,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.description).toContain('3 sources in 60m');
    expect(signals[0]?.description).not.toContain('30m');
  });
});
