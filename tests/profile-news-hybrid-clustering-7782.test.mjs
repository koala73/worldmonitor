import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_BUDGET_MS,
  LONG_TASK_MS,
  isGateCase,
  summarize,
} from '../scripts/profile-news-hybrid-clustering-7782.mjs';

describe('hybrid clustering measurement gate (#7782)', () => {
  it('does not treat the pathological shared-token case as a go signal', () => {
    assert.equal(isGateCase('representative-digest'), true);
    assert.equal(isGateCase('high-diversity-1500'), true);
    assert.equal(isGateCase('high-diversity-1000'), true);
    assert.equal(isGateCase('shared-token-stress-1500'), false);
  });

  it('uses frame and long-task budgets from the issue', () => {
    assert.equal(FRAME_BUDGET_MS, 16.7);
    assert.equal(LONG_TASK_MS, 50);
  });

  it('summarizes an odd sample set without claiming a frame miss under 16.7ms', () => {
    const stats = summarize([14.5, 14.1, 16.0, 13.2, 14.7, 15.1, 14.4, 14.8, 15.0]);
    assert.equal(stats.n, 9);
    assert.ok(stats.median < FRAME_BUDGET_MS);
    assert.ok(stats.max < LONG_TASK_MS);
  });
});

import { runInNewContext } from 'node:vm';
import { bundleProfileInput, budgetEvidence } from '../scripts/news-clustering-profile-input.mjs';

it('counts tail crossings even when the median is below budget', () => {
  const evidence = budgetEvidence([10, 11, 12, 13, 14, 15, 16, 18, 20]);
  assert.equal(evidence.frameBudgetExceededCount, 2);
  assert.equal(evidence.repeatableBudgetExceedance, true);
  assert.equal(evidence.exceedsLongTask, false);
  assert.equal(budgetEvidence([12, 12, 18]).repeatableBudgetExceedance, false);
  assert.equal(budgetEvidence([50]).longTaskBudgetExceededCount, 1);
});

it('profiles the actual client conversion, including metadata and nondefault source tiers', () => {
  const api = runInNewContext(bundleProfileInput() + '; NewsClustering');
  const item = api.protoItemToNewsItem({
    source: 'Reuters', title: 'An event', link: 'https://fixture.test/1',
    publishedAt: 1788673162000, isAlert: true, importanceScore: 42,
    credibilityScore: 0, corroborationCount: 3,
    storyMeta: { phase: 'STORY_PHASE_DEVELOPING', firstSeen: 1, mentionCount: 4, sourceCount: 3 },
    threat: { level: 'THREAT_LEVEL_HIGH', category: 'diplomatic', confidence: 0.9, source: 'llm' },
    location: { latitude: 12, longitude: 34 }, locationName: 'Place', snippet: 'Full description', tickers: ['ABC'],
  });
  assert.equal(item.pubDate.getTime(), 1788673162000);
  assert.equal(item.storyMeta.phase, 'developing');
  assert.equal(item.threat.level, 'high');
  assert.equal(item.credibilityScore, 0);
  assert.equal(item.importanceScore, 42);
  assert.equal(item.corroborationCount, 3);
  assert.equal(item.lat, 12);
  assert.equal(item.lon, 34);
  assert.equal(item.locationName, 'Place');
  assert.equal(item.snippet, 'Full description');
  assert.equal(item.tickers[0], 'ABC');
  assert.equal(api.getSourceTier('Reuters'), 1);
  assert.equal(api.getSourceTier('Unknown fixture publisher'), 4);
});
