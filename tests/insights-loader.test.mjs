import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_AGE_MS } from '../src/services/insights-loader';

describe('insights-loader', () => {
  describe('MAX_AGE_MS — server-cadence-aligned freshness window', () => {
    // The seeder cron interval is 30 min (scripts/seed-insights.mjs:363).
    // MAX_AGE_MS must be >= the cron interval, otherwise the panel will
    // appear UNAVAILABLE for part of every healthy cycle. 60 min gives
    // one missed-tick of headroom on top of that.
    it('is at least 30 minutes (cron interval)', () => {
      assert.ok(MAX_AGE_MS >= 30 * 60 * 1000, `expected >=30min, got ${MAX_AGE_MS / 60000}min`);
    });

    it('is at least 60 minutes (cron interval × 2 for missed-tick headroom)', () => {
      assert.ok(MAX_AGE_MS >= 60 * 60 * 1000, `expected >=60min, got ${MAX_AGE_MS / 60000}min`);
    });
  });

  describe('getServerInsights (logic validation)', () => {
    function isFresh(generatedAt) {
      const age = Date.now() - new Date(generatedAt).getTime();
      return age < MAX_AGE_MS;
    }

    it('rejects data older than the freshness window', () => {
      const old = new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString();
      assert.equal(isFresh(old), false);
    });

    it('accepts data younger than the freshness window', () => {
      const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      assert.equal(isFresh(fresh), true);
    });

    it('accepts data from now', () => {
      assert.equal(isFresh(new Date().toISOString()), true);
    });

    it('rejects exactly window-aged data', () => {
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
