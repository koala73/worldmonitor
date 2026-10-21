/**
 * #6428 — the user-visible corroboration count reports PUBLISHERS.
 *
 * Every "N sources" string the dashboard shows is a claim that N independent
 * outlets carried the story. The counts feeding those strings were article
 * counts (`sourceCount`) or feed-label counts, so one newsroom shipping the
 * same wire through several of its own feeds rendered as several sources.
 *
 * These assert the count each surface actually reads, not the map — the map's
 * own contract lives in tests/publisher-families.test.mjs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterNewsCore } from '../shared/news-clustering-core.js';
import {
  normalizeClusterStories,
  normalizeServerInsightStories,
} from '../src/components/threat-timeline-utils';
import type { ClusteredEvent } from '../src/types';

const ONE_STORY = 'Missile attack kills troops in border strike officials say';

function item(source: string, suffix = '') {
  return {
    source,
    title: `${ONE_STORY}${suffix}`,
    link: `https://example.test/${encodeURIComponent(source)}${encodeURIComponent(suffix)}`,
    pubDate: new Date('2026-08-10T10:00:00Z'),
    isAlert: false,
  };
}

const tierOf = (source: string) => (source.startsWith('Reuters') || source.startsWith('BBC') ? 1 : 2);

describe('clusterNewsCore publisher count (#6428)', () => {
  it('separates article volume from publisher breadth', () => {
    const clusters = clusterNewsCore(
      [
        item('Reuters World'),
        item('Reuters US', ' amid warnings'),
        item('Reuters Business', ' officials add'),
        item('BBC World', ' say officials'),
      ],
      tierOf,
    );

    assert.equal(clusters.length, 1, 'fixture must cluster into one story or this asserts nothing');
    assert.equal(clusters[0]!.sourceCount, 4, 'sourceCount stays the article count — velocity reads it');
    assert.equal(
      clusters[0]!.uniquePublisherCount,
      2,
      'three Reuters feeds are one publisher; with the BBC that is two',
    );
  });

  it('counts one outlet republishing itself once', () => {
    const clusters = clusterNewsCore(
      [item('Al Jazeera'), item('Al Jazeera', ' updated')],
      tierOf,
    );
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.sourceCount, 2);
    assert.equal(clusters[0]!.uniquePublisherCount, 1);
  });

  it('counts genuinely independent outlets in full', () => {
    const clusters = clusterNewsCore(
      [item('Reuters World'), item('BBC World', ' say officials'), item('Al Jazeera', ' reports')],
      tierOf,
    );
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.uniquePublisherCount, 3);
  });
});

describe('threat timeline "N sources" (#6428)', () => {
  const cluster = (overrides: Partial<ClusteredEvent>): ClusteredEvent => ({
    id: 'c1',
    primaryTitle: ONE_STORY,
    primarySource: 'Reuters World',
    primaryLink: 'https://example.test/a',
    sourceCount: 6,
    uniquePublisherCount: 1,
    topSources: [{ name: 'Reuters World', tier: 1, url: 'https://example.test/a' }],
    allItems: [],
    firstSeen: new Date('2026-08-10T09:00:00Z'),
    lastUpdated: new Date('2026-08-10T10:00:00Z'),
    isAlert: false,
    ...overrides,
  });

  it('reports publishers for a client cluster, not articles', () => {
    const [single] = normalizeClusterStories([cluster({})]);
    assert.equal(single!.sourceCount, 1, 'six Reuters articles are one publisher');

    const [multi] = normalizeClusterStories([cluster({ id: 'c2', uniquePublisherCount: 3 })]);
    assert.equal(multi!.sourceCount, 3);
  });

  it('reports publishers for a server story, not articles', () => {
    const base = {
      primaryTitle: ONE_STORY,
      primarySource: 'Reuters World',
      primaryLink: 'https://example.test/a',
      pubDate: '2026-08-10T10:00:00Z',
      sourceCount: 9,
      importanceScore: 100,
      velocity: { level: 'normal', sourcesPerHour: 0 },
      isAlert: false,
      category: 'general',
      threatLevel: 'medium',
      countryCode: null,
    };

    const [story] = normalizeServerInsightStories({
      generatedAt: '2026-08-10T10:05:00Z',
      topStories: [{ ...base, uniqueSourceCount: 2 }],
    } as Parameters<typeof normalizeServerInsightStories>[0]);
    assert.equal(story!.sourceCount, 2, 'nine articles across two publishers is "2 sources"');

    // Fail closed rather than fall back to the article count when a payload
    // cached before #6428 carries no publisher count at all.
    const [legacy] = normalizeServerInsightStories({
      generatedAt: '2026-08-10T10:05:00Z',
      topStories: [base],
    } as Parameters<typeof normalizeServerInsightStories>[0]);
    assert.equal(legacy!.sourceCount, 1, 'no publisher count must render no corroboration claim');
  });
});
