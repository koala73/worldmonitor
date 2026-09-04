import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterItems } from '../scripts/_clustering.mjs';
import * as seedInsights from '../scripts/seed-insights.mjs';

describe('seed-insights credibility propagation (#6597)', () => {
  it('preserves the digest score through normalization and clustering', () => {
    const normalized = seedInsights.normalizeDigestItemsForInsights([{
      title: 'Reuters reports a major diplomatic development',
      source: 'Reuters',
      link: 'https://example.com/story',
      publishedAt: 1785405900000,
      credibilityScore: 84,
      importanceScore: 70,
    }]);

    assert.equal(normalized[0].credibilityScore, 84);
    const clusters = clusterItems(normalized);
    assert.equal(clusters[0].credibilityScore, 84);
  });

  it('keeps pre-rollout items without a fabricated stored score', () => {
    const normalized = seedInsights.normalizeDigestItemsForInsights([{
      title: 'Legacy digest item without credibility metadata',
      source: 'Legacy Feed',
      link: 'https://example.com/legacy',
      publishedAt: 1785405900000,
    }]);

    assert.equal(Object.hasOwn(normalized[0], 'credibilityScore'), false);
  });
});
