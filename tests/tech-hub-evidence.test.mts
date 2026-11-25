import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ClusteredEvent, EventCategory } from '../src/types/index.ts';
import { aggregateTechActivity } from '../src/services/tech-activity.ts';

function cluster(primaryTitle: string, primarySource: string, primaryLink: string, category: EventCategory): ClusteredEvent {
  return {
    id: primaryTitle,
    primaryTitle,
    primarySource,
    primaryLink,
    sourceCount: 1,
    uniquePublisherCount: 1,
    topSources: [],
    allItems: [],
    firstSeen: new Date('2026-11-25T00:00:00Z'),
    lastUpdated: new Date('2026-11-25T01:00:00Z'),
    isAlert: false,
    threat: { level: 'low', category, confidence: 0.9, source: 'llm' },
  };
}

const hubCities = (clusters: ClusteredEvent[]) => aggregateTechActivity(clusters).map(a => a.city).sort();

describe('tech hub evidence', () => {
  it('does not place an ordinary use of a product word at a tech hub', () => {
    const crash = cluster(
      'Crews search for 6 aboard a small plane that crashed into the Gulf of Mexico, officials say',
      'AP News', 'https://apnews.com/article/plane-crash', 'disaster',
    );
    assert.deepEqual(hubCities([crash]), []);
  });

  it('still places a story that names the company', () => {
    const baidu = cluster('Baidu Search adds ERNIE answers', 'Reuters', 'https://www.reuters.com/x', 'tech');
    const google = cluster('Google denies mass layoffs in India, says only 30 Google Cloud roles affected', 'Exchange4Media', 'https://example.com/g', 'tech');
    assert.deepEqual(hubCities([baidu, google]), ['Beijing', 'Mountain View']);
  });

  it('ignores a city that only appears in the publisher byline', () => {
    const parks = cluster(
      'Opposition MPs say they want answers on planned Parks Canada cuts, layoffs - Toronto Star',
      'Toronto Star', 'https://www.thestar.com/politics/parks.html', 'tech',
    );
    const coal = cluster(
      '[SMM Coal Flash] PLN Plans to Divest Five Coal Mining Subsidiaries Under Group - Shanghai Metals Market',
      'Commodities News', 'https://news.google.com/rss/articles/CBMi', 'tech',
    );
    assert.deepEqual(hubCities([parks, coal]), []);
  });

  it('counts a city mention only for a technology story', () => {
    const shooting = cluster('One man dead after shooting during a home invasion in midtown Toronto', 'CBC', 'https://www.cbc.ca/news/x', 'conflict');
    const startups = cluster('MSS Supports Eight Deep-Tech Startups in Raising Funds in Berlin', 'Startup News', 'https://example.com/berlin', 'tech');
    assert.deepEqual(hubCities([shooting, startups]), ['Berlin']);
  });
});
