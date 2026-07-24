import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatAdvisory,
  formatTrend,
  instabilityBand,
  liveRiskViewModel,
} from '../scripts/crawlable-live-tools.mjs';

const NOW = Date.UTC(2026, 6, 24, 12);

describe('crawlable country live-risk tool', () => {
  it('uses the canonical CII score bands', () => {
    assert.equal(instabilityBand(0), 'Low');
    assert.equal(instabilityBand(31), 'Normal');
    assert.equal(instabilityBand(51), 'Elevated');
    assert.equal(instabilityBand(66), 'High');
    assert.equal(instabilityBand(81), 'Critical');
    assert.equal(instabilityBand(101), null);
    assert.equal(instabilityBand(null), null);
    assert.equal(instabilityBand(''), null);
    assert.equal(instabilityBand(true), null);
  });

  it('formats trend and advisory tokens for readers', () => {
    assert.equal(formatTrend(2.4, 'TREND_DIRECTION_RISING'), 'Rising +2.4');
    assert.equal(formatTrend(-1.2, 'TREND_DIRECTION_FALLING'), 'Falling -1.2');
    assert.equal(formatTrend(0, 'TREND_DIRECTION_STABLE'), 'Stable');
    assert.equal(formatAdvisory('reconsider'), 'Reconsider Travel');
    assert.equal(formatAdvisory('caution'), 'Exercise Increased Caution');
    assert.equal(formatAdvisory(''), 'Not present');
  });

  it('builds a labelled view model without treating structural resilience as live risk', () => {
    const computedAt = Date.UTC(2026, 6, 24, 10, 0, 0);
    const view = liveRiskViewModel({
      advisoryLevel: 'reconsider',
      sanctionsActive: true,
      sanctionsCount: 12,
      fetchedAt: computedAt,
      upstreamUnavailable: false,
      cii: {
        combinedScore: 71.34,
        dynamicScore: 3.2,
        trend: 'TREND_DIRECTION_RISING',
        computedAt,
        methodologyVersion: 'v8',
      },
    }, computedAt + 60_000);

    assert.deepEqual(view, {
      score: '71.3',
      band: 'High',
      trend: 'Rising +3.2',
      advisory: 'Reconsider Travel',
      sanctions: '12 designated entities',
      computedAt,
      methodologyVersion: 'v8',
    });
  });

  it('fails closed when the API has no authoritative current score', () => {
    assert.throws(
      () => liveRiskViewModel({ upstreamUnavailable: true }),
      /upstream is temporarily unavailable/,
    );
    assert.throws(
      () => liveRiskViewModel({ upstreamUnavailable: false, cii: undefined }),
      /No current instability score/,
    );
    assert.throws(
      () => liveRiskViewModel({ upstreamUnavailable: false, cii: { combinedScore: null } }),
      /No current instability score/,
    );
  });

  it('fails closed when the current score has no fresh authoritative timestamp', () => {
    const payload = {
      fetchedAt: NOW,
      upstreamUnavailable: false,
      cii: {
        combinedScore: 71,
        computedAt: NOW,
      },
    };

    for (const fetchedAt of [
      0,
      NOW + (6 * 60 * 1_000),
      NOW - (49 * 60 * 60 * 1_000),
    ]) {
      assert.throws(
        () => liveRiskViewModel({
          ...payload,
          fetchedAt,
          cii: { ...payload.cii, computedAt: fetchedAt },
        }, NOW),
        /timestamp is unavailable, stale, or invalid/i,
      );
    }
  });
});
