// get_news_intelligence story filters search the seeder's story pool (every
// scored cluster of the run), not only the 8 top stories. A country filter
// over the 8 returned two or zero stories for heavily covered countries.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((entry) => entry.name === 'get_news_intelligence');
const NOW = Date.now();

const story = (title, overrides = {}) => ({
  primaryTitle: title, primarySource: 'Example Wire', memberTitles: [title], sources: ['Example Wire'],
  effectiveImportanceScore: 50, category: 'general', countryCode: null, countryCodes: [], isAlert: false, ...overrides,
});
const top = [story('Top story one', { countryCodes: ['US'], countryCode: 'US' }), story('Top story two')];
const poolStories = [
  ...top,
  story('Kenya election count continues', { countryCodes: ['KE'], countryCode: 'KE', effectiveImportanceScore: 40 }),
  story('Floods in Kenya and Uganda', { countryCodes: ['KE', 'UG'], countryCode: 'KE', effectiveImportanceScore: 30, isAlert: true }),
  story('Uganda budget passes', { countryCodes: ['UG'], countryCode: 'UG', effectiveImportanceScore: 20 }),
];
const pool = (overrides = {}) => ({
  generatedAt: new Date(NOW - 5 * 60_000).toISOString(), clusterCount: 6, droppedForSize: 1, stories: poolStories, ...overrides,
});
const data = (storyPool = pool()) => ({ insights: { status: 'ok', topStories: structuredClone(top) }, 'story-pool': structuredClone(storyPool) });
const titles = (result) => result.insights.topStories.map((s) => s.primaryTitle);

describe('get_news_intelligence story pool', () => {
  it('reads the pool key under its own label', () => {
    assert.ok(tool._cacheKeys.includes('news:insights:v1:pool'));
    assert.equal(tool._cacheLabels['news:insights:v1:pool'], 'story-pool');
  });

  it('searches the whole pool for a country, ranked, and says so', () => {
    const result = tool._postFilter(data(), { country: 'KE' });
    assert.deepEqual(titles(result), ['Kenya election count continues', 'Floods in Kenya and Uganda']);
    assert.deepEqual(result.insights.storyScope, {
      source: 'story-pool', poolStories: 5, poolClusters: 6, droppedForSize: 1, generatedAt: pool().generatedAt,
    });
    assert.equal(Object.hasOwn(result, 'story-pool'), false, 'the raw pool never reaches the caller');
  });

  it('applies every story filter to the pool', () => {
    assert.deepEqual(titles(tool._postFilter(data(), { query: 'uganda' })), ['Floods in Kenya and Uganda', 'Uganda budget passes']);
    assert.deepEqual(titles(tool._postFilter(data(), { alerts_only: true })), ['Floods in Kenya and Uganda']);
    assert.deepEqual(titles(tool._postFilter(data(), { min_importance: 40 })), ['Top story one', 'Top story two', 'Kenya election count continues']);
    assert.deepEqual(titles(tool._postFilter(data(), { country: 'UG', limit: 1 })), ['Floods in Kenya and Uganda']);
  });

  it('keeps the dashboard top stories when no story filter is set', () => {
    for (const params of [{}, { topic: 'conflict' }, { limit: 5 }]) {
      const result = tool._postFilter(data(), params);
      assert.deepEqual(titles(result), ['Top story one', 'Top story two']);
      assert.equal(Object.hasOwn(result.insights, 'storyScope'), false);
      assert.equal(Object.hasOwn(result, 'story-pool'), false);
    }
  });

  it('falls back to the top stories and names why when the pool is missing, malformed or old', () => {
    for (const [storyPool, reason] of [
      [null, 'story-pool-unavailable'],
      [{ stories: 'nope' }, 'story-pool-unavailable'],
      [pool({ generatedAt: 'not a date' }), 'story-pool-unavailable'],
      [pool({ generatedAt: new Date(NOW - 61 * 60_000).toISOString() }), 'story-pool-stale'],
    ]) {
      const result = tool._postFilter(data(storyPool), { country: 'US' });
      assert.deepEqual(titles(result), ['Top story one'], reason);
      assert.deepEqual(result.insights.storyScope, { source: 'top-stories', reason });
    }
  });

  it('documents the scope in the output schema and the description', () => {
    const insights = tool.outputSchema.anyOf?.[0]?.properties?.data?.properties?.insights
      ?? tool.outputSchema.properties.data.properties.insights;
    assert.ok(insights.properties.storyScope, 'storyScope must be declared');
    assert.match(tool.description, /search every scored story/);
  });
});
