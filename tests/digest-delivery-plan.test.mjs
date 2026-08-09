import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDigestDeliveryPlan } from '../scripts/lib/digest-delivery-plan.mjs';

const rawStories = [
  {
    mergedHashes: ['dropped-cluster'],
    hash: 'dropped-hash',
    title: 'Dropped from the capped brief',
    severity: 'medium',
    sources: ['Wire A', 'Wire B', 'Wire C'],
    link: 'https://example.com/dropped',
  },
  {
    mergedHashes: ['kept-cluster'],
    hash: 'kept-hash',
    title: 'Kept by the capped brief',
    severity: 'high',
    sources: ['Wire D', 'Wire E', 'Wire F', 'Wire G', 'Wire H', 'Wire I'],
    link: 'https://example.com/kept',
  },
];

describe('digest delivery plan', () => {
  it('uses the capped envelope slice for formatters, webhook, U4, and U5 while retaining raw source counts', () => {
    const briefStories = [{
      clusterId: 'kept-cluster',
      headline: 'Kept by the capped brief',
      threatLevel: 'high',
      source: 'Wire D',
      sourceUrl: 'https://example.com/kept',
      description: 'The capped story.',
    }];

    const plan = buildDigestDeliveryPlan({ briefStories, rawStories });

    assert.deepEqual(plan.formatterStories, [{
      title: 'Kept by the capped brief',
      severity: 'high',
      sources: ['Wire D'],
      link: 'https://example.com/kept',
      description: 'The capped story.',
      phase: 'sustained',
      hash: 'kept-cluster',
    }]);
    assert.strictEqual(plan.cooldownIterableStories, briefStories);
    assert.equal(plan.sourceCountByClusterId.get('kept-cluster'), 6);
    assert.equal(plan.sourceCountByClusterId.get('dropped-cluster'), 3);
  });

  it('normalizes raw stories for every delivery consumer when compose misses', () => {
    const plan = buildDigestDeliveryPlan({ briefStories: undefined, rawStories });

    assert.strictEqual(plan.formatterStories, rawStories);
    assert.deepEqual(plan.cooldownIterableStories, [
      {
        clusterId: 'dropped-cluster',
        threatLevel: 'medium',
        source: 'Wire A',
        sourceUrl: 'https://example.com/dropped',
        headline: 'Dropped from the capped brief',
      },
      {
        clusterId: 'kept-cluster',
        threatLevel: 'high',
        source: 'Wire D',
        sourceUrl: 'https://example.com/kept',
        headline: 'Kept by the capped brief',
      },
    ]);
    assert.equal(plan.sourceCountByClusterId.get('kept-cluster'), 6);
  });
});
