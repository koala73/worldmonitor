import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterItems, scoreImportance, selectTopStories } from '../scripts/_clustering.mjs';

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

    it('adds alert bonus', () => {
      const noAlert = { primaryTitle: 'Earthquake hits region', sourceCount: 1, isAlert: false };
      const alert = { primaryTitle: 'Earthquake hits region', sourceCount: 1, isAlert: true };
      assert.ok(scoreImportance(alert) > scoreImportance(noAlert));
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
  });
});
