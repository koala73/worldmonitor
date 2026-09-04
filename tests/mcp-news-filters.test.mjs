// U2 — free-text query + importance threshold on the news tools (R11, R12).
//
// Two behaviours here are easy to get subtly wrong and are asserted directly:
//   1. Narrowing must run BEFORE the cap. Filtering after capping takes the
//      first N items and matches within them, so a match sitting past the cap
//      silently disappears — the tool would report "no results" for a story it
//      actually holds.
//   2. `min_importance: 0` is a REAL floor, not an absent filter. argNum
//      returns 0 for an explicit zero and null for absent; a story carrying no
//      score must fail a 0 floor rather than being coerced to 0 and passing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const newsTool = CACHE_TOOLS.find((tool) => tool.name === 'get_news_intelligence');

function story(overrides = {}) {
  return {
    primaryTitle: 'Generic headline',
    primarySource: 'Reuters',
    memberTitles: [],
    effectiveImportanceScore: 50,
    category: 'general',
    countryCode: 'US',
    isAlert: false,
    ...overrides,
  };
}

function envelope(topStories) {
  return { insights: { topStories } };
}

describe('get_news_intelligence — query and min_importance (U2)', () => {
  it('exposes both parameters in its input schema', () => {
    assert.equal(typeof newsTool?._postFilter, 'function');
    const props = newsTool.inputSchema.properties;
    assert.ok(props.query, 'query must be declared');
    assert.ok(props.min_importance, 'min_importance must be declared');
  });

  it('keeps only stories matching the query and drops the rest', () => {
    const data = envelope([
      story({ primaryTitle: 'Strikes near Kharkiv intensify' }),
      story({ primaryTitle: 'Oil prices steady' }),
      story({ primaryTitle: 'Kharkiv power grid restored' }),
      story({ primaryTitle: 'Central bank holds rates' }),
      story({ primaryTitle: 'Shipping delays in the Red Sea' }),
    ]);

    newsTool._postFilter(data, { query: 'kharkiv' });

    assert.equal(data.insights.topStories.length, 2);
    assert.ok(data.insights.topStories.every((s) => /kharkiv/i.test(s.primaryTitle)));
  });

  it('matches case-insensitively on both the term and the field', () => {
    const data = envelope([story({ primaryTitle: 'NATO Summit Opens' })]);
    newsTool._postFilter(data, { query: 'NaTo SuMMit' });
    assert.equal(data.insights.topStories.length, 1);
  });

  it('matches a clustered member headline, not just the promoted primary', () => {
    const data = envelope([
      story({
        primaryTitle: 'Regional tensions rise',
        memberTitles: ['Regional tensions rise', 'Naval blockade reported at the strait'],
      }),
      story({ primaryTitle: 'Unrelated market note', memberTitles: ['Unrelated market note'] }),
    ]);

    newsTool._postFilter(data, { query: 'blockade' });

    assert.equal(data.insights.topStories.length, 1);
    assert.equal(data.insights.topStories[0].primaryTitle, 'Regional tensions rise');
  });

  it('returns an empty list — not the unfiltered list — when nothing matches', () => {
    const data = envelope([story({ primaryTitle: 'A' }), story({ primaryTitle: 'B' })]);
    newsTool._postFilter(data, { query: 'zzz-no-such-term' });
    assert.equal(data.insights.topStories.length, 0);
    assert.ok(data.insights, 'the envelope itself must survive an empty match');
  });

  it('narrows before capping, so a match past the cap still surfaces', () => {
    // Four matches spread through a longer list; the first two entries do NOT
    // match. Filtering after a limit of 2 would return zero.
    const data = envelope([
      story({ primaryTitle: 'noise one' }),
      story({ primaryTitle: 'noise two' }),
      story({ primaryTitle: 'target alpha' }),
      story({ primaryTitle: 'target bravo' }),
      story({ primaryTitle: 'target charlie' }),
      story({ primaryTitle: 'target delta' }),
    ]);

    newsTool._postFilter(data, { query: 'target', limit: 2 });

    assert.equal(data.insights.topStories.length, 2);
    assert.ok(
      data.insights.topStories.every((s) => s.primaryTitle.startsWith('target')),
      'the cap must be drawn from the matches, not from the head of the raw list',
    );
  });

  it('applies min_importance as an inclusive floor', () => {
    const data = envelope([
      story({ primaryTitle: 'low', effectiveImportanceScore: 20 }),
      story({ primaryTitle: 'edge', effectiveImportanceScore: 70 }),
      story({ primaryTitle: 'high', effectiveImportanceScore: 90 }),
    ]);

    newsTool._postFilter(data, { min_importance: 70 });

    assert.deepEqual(
      data.insights.topStories.map((s) => s.primaryTitle).sort(),
      ['edge', 'high'],
    );
  });

  it('returns empty when the threshold exceeds every score', () => {
    const data = envelope([
      story({ effectiveImportanceScore: 10 }),
      story({ effectiveImportanceScore: 40 }),
    ]);
    newsTool._postFilter(data, { min_importance: 95 });
    assert.equal(data.insights.topStories.length, 0);
  });

  it('treats min_importance: 0 as a real floor that a scoreless story fails', () => {
    const data = envelope([
      story({ primaryTitle: 'scored', effectiveImportanceScore: 0 }),
      story({ primaryTitle: 'unscored', effectiveImportanceScore: undefined }),
    ]);

    newsTool._postFilter(data, { min_importance: 0 });

    assert.deepEqual(
      data.insights.topStories.map((s) => s.primaryTitle),
      ['scored'],
      'an explicit 0 must filter; a story with no score must not be coerced to 0',
    );
  });

  it('excludes a scoreless story whenever a threshold is set', () => {
    const data = envelope([
      story({ primaryTitle: 'has-score', effectiveImportanceScore: 80 }),
      story({ primaryTitle: 'no-score', effectiveImportanceScore: undefined }),
    ]);
    newsTool._postFilter(data, { min_importance: 50 });
    assert.deepEqual(data.insights.topStories.map((s) => s.primaryTitle), ['has-score']);
  });

  it('intersects query and threshold rather than unioning them', () => {
    const data = envelope([
      story({ primaryTitle: 'kharkiv strike', effectiveImportanceScore: 90 }),
      story({ primaryTitle: 'kharkiv weather', effectiveImportanceScore: 10 }),
      story({ primaryTitle: 'oil selloff', effectiveImportanceScore: 95 }),
    ]);

    newsTool._postFilter(data, { query: 'kharkiv', min_importance: 50 });

    assert.deepEqual(data.insights.topStories.map((s) => s.primaryTitle), ['kharkiv strike']);
  });

  it('leaves output identical to today when neither parameter is passed', () => {
    const stories = [story({ primaryTitle: 'a' }), story({ primaryTitle: 'b' })];
    const data = envelope(stories.map((s) => ({ ...s })));
    newsTool._postFilter(data, {});
    assert.equal(data.insights.topStories.length, 2);
  });
});

describe('get_news_intelligence credibility normalization (#6597)', () => {
  it('reapplies the high-risk cap to stored scores', () => {
    const data = envelope([
      story({ primarySource: 'RT', credibilityScore: 84, uniqueSourceCount: 5 }),
    ]);

    newsTool._postFilter(data, {});

    assert.equal(data.insights.topStories[0].credibilityScore, 40);
  });

  it('recomputes missing, non-numeric, and out-of-range stored scores', () => {
    const data = envelope([
      story({ primaryTitle: 'missing', primarySource: 'Reuters' }),
      story({ primaryTitle: 'string', primarySource: 'Reuters', credibilityScore: '99' }),
      story({ primaryTitle: 'too-high', primarySource: 'Reuters', credibilityScore: 140 }),
    ]);

    newsTool._postFilter(data, {});

    assert.deepEqual(
      data.insights.topStories.map(entry => entry.credibilityScore),
      [84, 84, 84],
    );
  });
});
