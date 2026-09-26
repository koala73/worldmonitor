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
import { PUBLISHER_FAMILIES } from '../shared/publisher-families.js';

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

describe('get_news_intelligence corroboration (#6419)', () => {
  it('derives each top story state from its outlet names', () => {
    const data = envelope([
      story({ primaryTitle: 'one wire', sources: ['Reuters World', 'Reuters US'] }),
      story({ primaryTitle: 'aggregators', sources: ['The Verge', 'Hacker News'] }),
      story({ primaryTitle: 'mixed', sources: ['The Verge', 'BBC World'] }),
      story({ primaryTitle: 'legacy' }),
      story({ primaryTitle: 'malformed', sources: 'Reuters' }),
    ]);

    newsTool._postFilter(data, {});

    assert.deepEqual(data.insights.topStories.map(entry => entry.corroboration), [
      { state: 'single-publisher', publishers: 1 },
      { state: 'tier4-only', publishers: 2 },
      { state: 'corroborated', publishers: 2 },
      { state: 'unknown', publishers: null },
      { state: 'unknown', publishers: null },
    ]);
  });

  it('trusts the digest publisher count over the labels that survived the category cap', () => {
    const data = envelope([
      story({ primaryTitle: 'capped', sources: ['Reuters World'], corroborationCount: 3 }),
    ]);

    newsTool._postFilter(data, {});

    assert.deepEqual(data.insights.topStories[0].corroboration, { state: 'corroborated', publishers: 3 });
    assert.equal(data.insights.topStories[0].publishers.length, 1);
    assert.equal(data.insights.topStories[0].publishersUnlisted, 2, 'the roster names 1 of the 3 publishers the verdict counts');
  });
});

describe('get_news_intelligence publisher roster (#6419 step 3)', () => {
  it('lists each top story publisher with its declared tier from the same labels as corroboration', () => {
    const data = envelope([
      story({ primaryTitle: 'mixed', sources: ['The Verge', 'Reuters World', 'Reuters US', 'Unreviewed Local Desk'] }),
      story({ primaryTitle: 'legacy' }),
      story({ primaryTitle: 'malformed', sources: 'Reuters' }),
    ]);

    newsTool._postFilter(data, {});

    const [mixed, legacy, malformed] = data.insights.topStories;
    assert.deepEqual(mixed.publishers, [
      { name: 'Reuters', tier: 1, labels: ['Reuters World', 'Reuters US'], labelsUnlisted: 0 },
      { name: 'The Verge', tier: 4, labels: ['The Verge'], labelsUnlisted: 0 },
      { name: 'Unreviewed Local Desk', tier: null, labels: ['Unreviewed Local Desk'], labelsUnlisted: 0 },
    ]);
    assert.equal(mixed.publishersUnlisted, 0);
    assert.deepEqual([legacy.publishers, legacy.publishersUnlisted], [[], 0]);
    assert.deepEqual([malformed.publishers, malformed.publishersUnlisted], [[], 0]);
  });

  it('documents the roster in the output schema', () => {
    const storySchema = newsTool.outputSchema.properties.data.properties.insights.properties.topStories.items;
    assert.deepEqual(storySchema.properties.publishers.items.required, ['name', 'tier', 'labels', 'labelsUnlisted']);
    assert.deepEqual(storySchema.properties.publishers.items.properties.tier.enum, [1, 2, 3, 4, null]);
    assert.equal(storySchema.properties.publishersUnlisted.type, 'integer');
  });
  it('bounds eight stories of full rosters to an eighth of the output budget', () => {
    const caseVariant = (base, variant) => [...base]
      .map((char, index) => (index < 6 && (variant >> index) & 1 ? char.toUpperCase() : char)).join('');
    // Ten families per story, past the eight-publisher cap: Reuters with all
    // twelve curated labels, and nine uncurated families of six case variants
    // of one long label each, past the four-label cap.
    const sources = [
      ...PUBLISHER_FAMILIES.reuters.labels,
      ...Array.from({ length: 9 }, (_, family) => Array.from(
        { length: 6 },
        (_, variant) => caseVariant(`desk${family}-${'d'.repeat(500)}`, variant),
      )).flat(),
    ];
    const data = envelope(Array.from({ length: 8 }, (_, i) => story({ primaryTitle: `story ${i}`, sources })));

    newsTool._postFilter(data, {});

    const stories = data.insights.topStories;
    assert.equal(stories.length, 8);
    for (const top of stories) {
      assert.equal(top.publishers.length, 8);
      assert.equal(top.publishersUnlisted, 2);
      for (const publisher of top.publishers) {
        assert.ok(publisher.labels.length <= 4);
        assert.ok(Buffer.byteLength(publisher.name, 'utf8') <= 40);
        assert.ok(publisher.labels.every((label) => Buffer.byteLength(label, 'utf8') <= 40));
      }
    }
    const rosterBytes = stories.reduce((sum, top) => sum
      + Buffer.byteLength(JSON.stringify({ publishers: top.publishers, publishersUnlisted: top.publishersUnlisted }), 'utf8'), 0);
    // The seeded story fields around it are served as stored; the roster is
    // the part this tool adds, so its worst case is what the budget must absorb.
    assert.ok(
      rosterBytes <= newsTool._outputBudgetBytes / 8,
      `eight full rosters cost ${rosterBytes} bytes; keep them within an eighth of the ${newsTool._outputBudgetBytes}-byte budget`,
    );
  });
});
