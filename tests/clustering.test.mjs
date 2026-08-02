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

  // #5947: production ran 35 consecutive INSIGHTS_SYNTHESIS_MISSING_CLUSTER
  // rejections while 11 corroborated clusters sat in the corpus. The brief's
  // lead requires a corroborated cluster, but selection admits single-source
  // alerts (isAlert / score > 100) and ranks by score * recencyWeight — and
  // corroborated clusters are inherently OLDER (a second source takes time to
  // arrive), so recency systematically pushes them out. On an alert-heavy news
  // cycle every top-8 slot went to a single-source alert and the brief could
  // never publish. Selection must guarantee the brief's own precondition
  // whenever the corpus can satisfy it.
  describe('brief-lead reservation (#5947)', () => {
    const now = Date.now();
    const ageISO = (hours) => new Date(now - hours * 3600_000).toISOString();
    // Fresh, high-intensity single-source alerts — the Iran/Ukraine cycle that
    // swept production's top-8 (effective scores ~145-170 here).
    const alertClusters = Array.from({ length: 12 }, (_, i) => ({
      primaryTitle: `Iran war latest: missile attack kills troops in massive airstrike on base ${i}`,
      primarySource: `Alert Wire ${i}`,
      primaryLink: `http://alert-${i}`,
      sources: [`Alert Wire ${i}`],
      sourceCount: 1,
      isAlert: true,
      pubDate: ageISO(0.1),
      lastUpdated: ageISO(0.1),
    }));
    // Corroborated but lower-intensity and older, so score * recencyWeight
    // ranks it below every alert (effective score ~81) — production's
    // 4-source avalanche story sat at rank 9+ for the same reason.
    const corroborated = {
      primaryTitle: 'Mountaineer killed in Pakistan avalanche, his company confirms',
      primarySource: 'BBC World',
      primaryLink: 'http://corroborated',
      sources: ['BBC World', 'CNN', 'Sky News', 'CBS News'],
      sourceCount: 4,
      isAlert: false,
      pubDate: ageISO(6),
      lastUpdated: ageISO(6),
    };

    it('keeps a corroborated cluster in top stories when alerts sweep the ranking', () => {
      const stats = {};
      const top = selectTopStories([...alertClusters, corroborated], 8, stats);
      assert.equal(top.length, 8);
      // Assert the premise too: if scoring drifts so the corroborated cluster
      // ranks top-8 on merit, this test would still pass while silently no
      // longer exercising the reservation.
      assert.equal(stats.briefEligiblePromoted, true, 'fixture must still force the reservation path');
      assert.ok(
        top.some(isBriefLeadEligible),
        'top stories must retain a brief-eligible cluster when one exists in the corpus',
      );
    });

    it('yields a usable brief lead instead of MISSING_CLUSTER', () => {
      const stats = {};
      const top = selectTopStories([...alertClusters, corroborated], 8, stats);
      assert.equal(stats.briefEligiblePromoted, true, 'fixture must still force the reservation path');
      const lead = pickBriefCluster(top);
      assert.notEqual(lead, null, 'pickBriefCluster must not return null when the corpus has a corroborated cluster');
      assert.equal(lead.primarySource, 'BBC World');
    });

    it('reserves the highest-ranked eligible candidate, not just any', () => {
      const weaker = {
        ...corroborated,
        primaryTitle: 'Local council approves a new footpath in a quiet village',
        primarySource: 'Village Gazette',
        primaryLink: 'http://weaker',
        sources: ['Village Gazette', 'County Wire'],
        pubDate: ageISO(14),
        lastUpdated: ageISO(14),
      };
      const stats = {};
      const top = selectTopStories([...alertClusters, weaker, corroborated], 8, stats);
      assert.equal(stats.briefEligibleConsidered, 2);
      assert.equal(stats.briefEligiblePromoted, true);
      const eligible = top.filter(isBriefLeadEligible);
      assert.equal(eligible.length, 1, 'exactly one slot is reserved');
      assert.equal(
        eligible[0].primarySource,
        'BBC World',
        'the better-ranked eligible cluster must win the reserved slot',
      );
    });

    it('reports the reservation in selection stats', () => {
      const stats = {};
      selectTopStories([...alertClusters, corroborated], 8, stats);
      assert.equal(stats.briefEligibleConsidered, 1);
      assert.equal(stats.briefEligiblePromoted, true);
    });

    it('does not promote when the top stories already carry a corroborated cluster', () => {
      const stats = {};
      const top = selectTopStories([corroborated, ...alertClusters.slice(0, 3)], 8, stats);
      assert.ok(top.some(isBriefLeadEligible));
      assert.equal(stats.briefEligiblePromoted, false);
    });

    it('leaves a genuinely uncorroborated corpus degraded', () => {
      const stats = {};
      const top = selectTopStories(alertClusters, 8, stats);
      assert.equal(top.length, 8);
      assert.equal(stats.briefEligibleConsidered, 0);
      assert.equal(stats.briefEligiblePromoted, false);
      assert.equal(pickBriefCluster(top), null);
    });

    it('respects the per-source cap while promoting', () => {
      // 5 same-source candidates against 8 slots: the cap must bind and drop
      // 2, otherwise this asserts nothing (the slots would run out first).
      const capped = Array.from({ length: 5 }, (_, i) => ({
        primaryTitle: `Iran war latest: missile attack kills troops in airstrike variant ${i}`,
        primarySource: 'Capped Wire',
        primaryLink: `http://capped-${i}`,
        sources: ['Capped Wire', 'Second Wire'],
        sourceCount: 2,
        isAlert: true,
        pubDate: ageISO(0.1),
        lastUpdated: ageISO(0.1),
      }));
      const stats = {};
      const top = selectTopStories([...alertClusters.slice(0, 3), ...capped], 8, stats);
      const fromCapped = top.filter(s => s.primarySource === 'Capped Wire').length;
      assert.equal(fromCapped, 3, 'per-source cap must admit exactly MAX_PER_SOURCE');
      assert.ok(stats.sourceCapDropped >= 2, `cap must actually bind, got ${stats.sourceCapDropped}`);
      assert.ok(top.some(isBriefLeadEligible));
    });

    it('does not claim a promotion when no slot exists', () => {
      const stats = {};
      const top = selectTopStories([...alertClusters, corroborated], 0, stats);
      assert.deepEqual(top, []);
      assert.equal(stats.briefEligiblePromoted, false, 'no slot means no promotion to report');
    });

    it('gives the single available slot to the corroborated cluster', () => {
      const stats = {};
      const top = selectTopStories([...alertClusters, corroborated], 1, stats);
      assert.equal(top.length, 1);
      assert.equal(stats.briefEligiblePromoted, true);
      assert.equal(top[0].primarySource, 'BBC World');
    });

    it('reserves a slot for an entity-corroborated single-source cluster', () => {
      // isBriefLeadEligible has two arms; the >=2-sources arm is covered above.
      // Corroboration must be EARNED through computeEntityCorroboration (which
      // selectTopStories recomputes, resetting any hand-set flag), so these two
      // single-source clusters share the iran+deal bigram inside the 24h window.
      const entityPair = [
        {
          primaryTitle: 'Iran deal talks resume in Geneva',
          primarySource: 'Wire Desk',
          primaryLink: 'http://entity-a',
          sources: ['Wire Desk'],
          sourceCount: 1,
          isAlert: false,
          pubDate: ageISO(6),
          lastUpdated: ageISO(6),
          memberTitles: ['Iran deal talks resume in Geneva'],
        },
        {
          primaryTitle: 'Officials say Iran deal framework is close',
          primarySource: 'Second Desk',
          primaryLink: 'http://entity-b',
          sources: ['Second Desk'],
          sourceCount: 1,
          isAlert: false,
          pubDate: ageISO(6),
          lastUpdated: ageISO(6),
          memberTitles: ['Officials say Iran deal framework is close'],
        },
      ];
      const stats = {};
      const top = selectTopStories([...alertClusters, ...entityPair], 8, stats);
      assert.equal(stats.briefEligiblePromoted, true);
      const lead = pickBriefCluster(top);
      assert.notEqual(lead, null, 'entity corroboration alone must satisfy the reservation');
      assert.equal(lead.entityCorroboration, true);
      assert.equal(lead.sources.length, 1, 'this arm covers single-source entity corroboration');
    });
  });
});
