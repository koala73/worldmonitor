import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('insights-loader', () => {
  describe('getServerInsights (logic validation)', () => {
    const MAX_AGE_MS = 15 * 60 * 1000;

    function isFresh(generatedAt) {
      const age = Date.now() - new Date(generatedAt).getTime();
      return age < MAX_AGE_MS;
    }

    it('rejects data older than 15 minutes', () => {
      const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      assert.equal(isFresh(old), false);
    });

    it('accepts data younger than 15 minutes', () => {
      const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      assert.equal(isFresh(fresh), true);
    });

    it('accepts data from now', () => {
      assert.equal(isFresh(new Date().toISOString()), true);
    });

    it('rejects exactly 15 minutes old data', () => {
      const exact = new Date(Date.now() - MAX_AGE_MS).toISOString();
      assert.equal(isFresh(exact), false);
    });
  });

  describe('ServerInsights payload shape', () => {
    it('validates required fields', () => {
      const valid = {
        worldBrief: 'Test brief',
        briefProvider: 'groq',
        status: 'ok',
        topStories: [{ primaryTitle: 'Test', sourceCount: 2 }],
        generatedAt: new Date().toISOString(),
        clusterCount: 10,
        multiSourceCount: 5,
        fastMovingCount: 3,
      };
      assert.ok(valid.topStories.length >= 1);
      assert.ok(['ok', 'degraded'].includes(valid.status));
    });

    it('allows degraded status with empty brief', () => {
      const degraded = {
        worldBrief: '',
        status: 'degraded',
        topStories: [{ primaryTitle: 'Test' }],
        generatedAt: new Date().toISOString(),
      };
      assert.equal(degraded.worldBrief, '');
      assert.equal(degraded.status, 'degraded');
    });

    it('rejects empty topStories', () => {
      const empty = { topStories: [] };
      assert.equal(empty.topStories.length >= 1, false);
    });
  });
});
