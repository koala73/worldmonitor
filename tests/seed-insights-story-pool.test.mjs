import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterItems, selectTopStories } from '../scripts/_clustering.mjs';
import * as seedInsights from '../scripts/seed-insights.mjs';

const NOW = Date.parse('2026-10-26T12:00:00Z');
// Distinct vocabulary per headline so each item forms its own cluster.
const WORDS = ['harbor', 'quarry', 'violin', 'glacier', 'turnip', 'lantern', 'meadow', 'saddle', 'pebble', 'orchid'];
const COUNTRIES = ['Brazil', 'Kenya', 'Norway', 'Vietnam', 'Chile', 'Ghana', 'Japan', 'Nepal', 'Fiji', 'Oman'];
function items(count) {
  return seedInsights.normalizeDigestItemsForInsights(Array.from({ length: count }, (_, i) => ({
    title: `${COUNTRIES[i % COUNTRIES.length]} ${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]} report number ${i}`,
    source: `Outlet ${i}`,
    link: `https://example.com/story-${i}`,
    publishedAt: NOW - i * 60_000,
    importanceScore: 10 + i,
  })));
}

describe('seed-insights story pool', () => {
  it('keeps every cluster, not only the top-story selection, ranked by effective importance', () => {
    const clusters = clusterItems(items(20));
    const top = selectTopStories(clusters, 8, {});
    const pool = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: '2026-10-26T12:00:00.000Z' });

    assert.equal(pool.clusterCount, clusters.length);
    assert.equal(pool.stories.length, clusters.length);
    assert.ok(pool.stories.length > top.length, 'the pool must reach past the top-story cap');
    assert.equal(pool.droppedForSize, 0);
    assert.equal(pool.generatedAt, '2026-10-26T12:00:00.000Z');
    const scores = pool.stories.map(story => story.effectiveImportanceScore);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    for (const story of pool.stories) {
      assert.equal(typeof story.primaryTitle, 'string');
      assert.ok(Array.isArray(story.countryCodes) && story.countryCodes.length > 0, story.primaryTitle);
      assert.equal(Object.hasOwn(story, 'velocity'), false, 'constant placeholder is not stored');
    }
  });

  it('publishes the same story shape as the top-story list', () => {
    const clusters = clusterItems(items(3));
    const selected = { ...clusters[0], importanceScore: 1, effectiveImportanceScore: 1 };
    const { velocity: _velocity, ...expected } = seedInsights.enrichInsightStory(selected);
    const pool = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x' });
    const pooled = pool.stories.find(story => story.primaryLink === selected.primaryLink);
    assert.deepEqual(Object.keys(pooled).sort(), Object.keys(expected).sort());
  });

  it('caps member headlines and drops the lowest-ranked stories past the byte budget', () => {
    const clusters = clusterItems(items(20));
    clusters[0].memberTitles = Array.from({ length: 30 }, (_, i) => `member headline ${i}`);
    const full = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x' });
    assert.ok(full.stories.every(story => story.memberTitles.length <= seedInsights.STORY_POOL_MAX_MEMBER_TITLES));

    const maxBytes = Math.floor(Buffer.byteLength(JSON.stringify(full.stories)) / 2);
    const capped = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x', maxBytes });
    assert.ok(Buffer.byteLength(JSON.stringify(capped.stories)) <= maxBytes);
    assert.equal(capped.stories.length + capped.droppedForSize, clusters.length);
    assert.ok(capped.droppedForSize > 0);
    assert.deepEqual(capped.stories, full.stories.slice(0, capped.stories.length), 'the kept stories are the highest ranked');
  });

  it('stops at the first story past the byte budget instead of back-filling smaller lower-ranked ones', () => {
    const clusters = clusterItems(items(20));
    const ranked = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x' }).stories;
    const second = clusters.find(cluster => cluster.primaryLink === ranked[1].primaryLink);
    second.memberTitles = second.memberTitles.map(() => 'oversized member headline '.repeat(400));
    const full = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x' });
    assert.equal(full.stories[1].primaryLink, second.primaryLink, 'the oversized story keeps its rank');

    // Room for the first story and any small one, but not the oversized second.
    const maxBytes = Buffer.byteLength(JSON.stringify([full.stories[0], full.stories[2]])) + 1;
    const capped = seedInsights.buildStoryPool(clusters, { nowMs: NOW, generatedAt: 'x', maxBytes });
    assert.deepEqual(capped.stories, [full.stories[0]]);
    assert.equal(capped.droppedForSize, clusters.length - 1);
  });

  it('keeps the pool out of the canonical insights payload and inside the LKG copy', () => {
    const storyPool = { generatedAt: 'x', clusterCount: 1, droppedForSize: 0, stories: [] };
    const published = seedInsights.publishInsightsPayload({ topStories: [{}], storyPool, chinaNewsCoverage: {} });
    assert.equal(Object.hasOwn(published, 'storyPool'), false);
    assert.equal(Object.hasOwn(published, 'chinaNewsCoverage'), false);
    assert.deepEqual(seedInsights.preserveStoryPoolInLkg({ topStories: [{}] }, storyPool).storyPool, storyPool);
    assert.deepEqual(seedInsights.preserveStoryPoolInLkg({ topStories: [{}] }, null), { topStories: [{}] });
  });
});
