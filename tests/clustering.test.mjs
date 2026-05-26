import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterItems,
  computeEntityCorroboration,
  isBriefLeadEligible,
  scoreImportance,
  selectTopStories,
} from '../scripts/_clustering.mjs';
import { pickBriefCluster } from '../scripts/_insights-brief.mjs';

describe('_clustering.mjs', () => {
  describe('clusterItems', () => {
    it('groups similar titles into one cluster', () => {
      const items = [
        { title: 'Iran launches missile strikes on targets in Syria overnight', source: 'Reuters', link: 'http://a' },
        { title: 'Iran launches missile strikes on targets in Syria overnight says officials', source: 'AP', link: 'http://b' },
      ];
      const clusters = clusterItems(items);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].sourceCount, 2);
    });

    it('keeps different titles as separate clusters', () => {
      const items = [
        { title: 'Iran launches missile strikes on targets in Syria', source: 'Reuters', link: 'http://a' },
        { title: 'Stock market rallies on tech earnings report', source: 'CNBC', link: 'http://b' },
      ];
      const clusters = clusterItems(items);
      assert.equal(clusters.length, 2);
    });

    it('returns empty array for empty input', () => {
      assert.deepEqual(clusterItems([]), []);
    });

    it('preserves primaryTitle from highest-tier source', () => {
      const items = [
        { title: 'Iran strikes Syria overnight', source: 'Blog', link: 'http://b', tier: 5 },
        { title: 'Iran strikes Syria overnight confirms officials', source: 'Reuters', link: 'http://a', tier: 1 },
      ];
      const clusters = clusterItems(items);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].primarySource, 'Reuters');
    });
  });

  describe('scoreImportance', () => {
    it('scores military/violence headlines higher than business', () => {
      const military = { primaryTitle: 'Troops deployed after missile attack in Ukraine', sourceCount: 2 };
      const business = { primaryTitle: 'Tech startup raises funding in quarterly earnings', sourceCount: 2 };
      assert.ok(scoreImportance(military) > scoreImportance(business));
    });

    it('gives combo bonus for flashpoint + violence', () => {
      const flashpointViolence = { primaryTitle: 'Iran crackdown killed dozens in Tehran protests', sourceCount: 1 };
      const violenceOnly = { primaryTitle: 'Crackdown killed dozens in protests', sourceCount: 1 };
      assert.ok(scoreImportance(flashpointViolence) > scoreImportance(violenceOnly));
    });

    it('demotes business context', () => {
      const pure = { primaryTitle: 'Strike hits military targets', sourceCount: 1 };
      const business = { primaryTitle: 'Strike hits military targets says CEO in earnings call', sourceCount: 1 };
      assert.ok(scoreImportance(pure) > scoreImportance(business));
    });

    it('does not make alerts brief-lead eligible without corroboration', () => {
      const noAlert = { primaryTitle: 'Earthquake hits region', sourceCount: 1, isAlert: false };
      const alert = { primaryTitle: 'Earthquake hits region', sourceCount: 1, isAlert: true };
      assert.equal(scoreImportance(alert), scoreImportance(noAlert));
      assert.equal(isBriefLeadEligible(alert), false);
    });

    it('does not treat generic business deals as diplomacy', () => {
      const top = selectTopStories([
        {
          primaryTitle: 'Apple closes deal for new supplier contract',
          primarySource: 'Reuters',
          primaryLink: 'http://apple',
          sources: ['Reuters'],
          sourceCount: 1,
          sourceTier: 1,
          isAlert: false,
        },
      ]);
      assert.equal(top.length, 0);
    });
  });

  describe('selectTopStories', () => {
    it('returns at most maxCount stories', () => {
      const clusters = Array.from({ length: 20 }, (_, i) => ({
        primaryTitle: `War conflict attack story number ${i}`,
        primarySource: `Source${i % 5}`,
        primaryLink: `http://${i}`,
        sourceCount: 3,
        isAlert: false,
      }));
      const top = selectTopStories(clusters, 5);
      assert.ok(top.length <= 5);
    });

    it('filters out low-scoring single-source non-alert stories', () => {
      const clusters = [
        { primaryTitle: 'Nice weather today', primarySource: 'Blog', primaryLink: 'http://a', sourceCount: 1, isAlert: false },
      ];
      const top = selectTopStories(clusters, 8);
      assert.equal(top.length, 0);
    });

    it('includes high-scoring single-source stories', () => {
      const clusters = [
        { primaryTitle: 'Iran missile attack kills dozens in massive airstrike', primarySource: 'Reuters', primaryLink: 'http://a', sourceCount: 1, isAlert: false },
      ];
      const top = selectTopStories(clusters, 8);
      assert.equal(top.length, 1);
    });

    it('limits per-source diversity', () => {
      const clusters = Array.from({ length: 10 }, (_, i) => ({
        primaryTitle: `War attack missile strike story ${i}`,
        primarySource: 'SameSource',
        primaryLink: `http://${i}`,
        sourceCount: 2,
        isAlert: false,
      }));
      const top = selectTopStories(clusters, 8);
      assert.ok(top.length <= 3);
    });

    it('elevates split US-Iran deal coverage into top 5 and brief lead via entity corroboration', () => {
      const now = Date.now();
      const fresh = new Date(now - 30 * 60_000).toISOString();
      const stale = new Date(now - 30 * 3600_000).toISOString();
      const items = [
        {
          title: 'US and Iran close deal to ease Hormuz tensions',
          source: 'Reuters',
          link: 'http://deal-1',
          pubDate: fresh,
          importanceScore: 62,
          threat: { level: 'medium', source: 'llm', category: 'geopolitical' },
        },
        {
          title: 'Iran deal could calm oil markets after Hormuz alarm',
          source: 'AP News',
          link: 'http://deal-2',
          pubDate: fresh,
          importanceScore: 60,
          threat: { level: 'medium', source: 'llm', category: 'geopolitical' },
        },
        {
          title: 'Axios: US-Iran deal averts immediate Hormuz disruption',
          source: 'Axios',
          link: 'http://deal-3',
          pubDate: fresh,
          importanceScore: 59,
          threat: { level: 'medium', source: 'llm', category: 'geopolitical' },
        },
        {
          title: 'BBC World reports Iran deal talks lower Gulf risk',
          source: 'BBC World',
          link: 'http://deal-4',
          pubDate: fresh,
          importanceScore: 58,
          threat: { level: 'medium', source: 'llm', category: 'geopolitical' },
        },
        {
          title: 'Reuters World: Iran deal framework discussed with US officials',
          source: 'Reuters World',
          link: 'http://deal-5',
          pubDate: fresh,
          importanceScore: 57,
          threat: { level: 'medium', source: 'llm', category: 'geopolitical' },
        },
        {
          title: 'Missile attack kills dozens as troops strike border city',
          source: 'Unknown Wire',
          link: 'http://stale-1',
          pubDate: stale,
          importanceScore: 75,
          isAlert: true,
          threat: { level: 'critical', source: 'keyword', category: 'conflict' },
        },
        {
          title: 'Iran missile attack kills dozens in airstrike',
          source: 'Unknown Wire 2',
          link: 'http://stale-2',
          pubDate: stale,
          importanceScore: 74,
          isAlert: true,
          threat: { level: 'critical', source: 'keyword', category: 'conflict' },
        },
      ];

      const clusters = clusterItems(items);
      const top = selectTopStories(clusters, 5);
      const deal = top.find(story => /iran/i.test(story.primaryTitle) && /deal/i.test(story.primaryTitle));
      assert.ok(deal, 'expected at least one US-Iran deal cluster in the top 5');
      assert.equal(deal.entityCorroboration, true);

      const lead = pickBriefCluster(top);
      assert.ok(lead, 'expected a corroborated brief lead');
      assert.match(lead.primaryTitle, /iran/i);
      assert.match(lead.primaryTitle, /deal/i);
    });

    it('does not entity-corroborate Reuters-only reposts', () => {
      const now = Date.now();
      const clusters = clusterItems([
        { title: 'US and Iran close deal to ease Hormuz tensions', source: 'Reuters', link: 'http://a', pubDate: new Date(now).toISOString() },
        { title: 'Iran deal may ease Hormuz pressure', source: 'Reuters', link: 'http://b', pubDate: new Date(now).toISOString() },
        { title: 'US-Iran deal calms oil market fears', source: 'Reuters', link: 'http://c', pubDate: new Date(now).toISOString() },
      ]);
      computeEntityCorroboration(clusters, now);
      assert.equal(clusters.some(c => c.entityCorroboration), false);
      assert.equal(pickBriefCluster(selectTopStories(clusters, 8)), null);
    });

    it('does not entity-corroborate stale diplomacy pairs older than 24h', () => {
      const now = Date.now();
      const old = new Date(now - 25 * 3600_000).toISOString();
      const clusters = clusterItems([
        { title: 'US and Iran close deal to ease Hormuz tensions', source: 'Reuters', link: 'http://a', pubDate: old },
        { title: 'Iran deal may ease Hormuz pressure', source: 'AP News', link: 'http://b', pubDate: old },
      ]);
      computeEntityCorroboration(clusters, now);
      assert.equal(clusters.some(c => c.entityCorroboration), false);
    });
  });
});
