// Issue #11274 finding 286: the panel read "GPS jamming detected: 341
// high-interference hexagons in Other" and "Risk score spike: SA CII score 64".
// classifyRegion() files every hex outside its boxes under 'other', and CII
// scores carry an ISO2 code, so both reached the headline unresolved.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractGpsJamming, extractRiskScoreSpike } from '../scripts/seed-cross-source-signals.mjs';
import { classifyRegion } from '../scripts/_gpsjam-parse.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from '../scripts/_cii-risk-cache-keys.mjs';
import { REGIONS, isSignalInRegion } from '../scripts/shared/geography.js';

const hex = (lat, lon) => ({ lat, lon, level: 'high', region: classifyRegion(lat, lon), pct: 30, npAvg: 0.3 });
const gpsSignals = (hexes) => extractGpsJamming({
  'intelligence:gpsjam:v2': { hexes, fetchedAt: new Date().toISOString() },
});

describe('GPS jamming signal locations', () => {
  it('places catch-all hexes by the country under them', () => {
    const riyadh = Array.from({ length: 3 }, () => hex(24.7, 46.7));
    const yangon = Array.from({ length: 2 }, () => hex(16.8, 96.2));
    assert.equal(riyadh[0].region, 'other');
    assert.equal(yangon[0].region, 'other');

    const signals = gpsSignals([...yangon, ...riyadh]);

    assert.deepEqual(signals.map((s) => s.summary), [
      'GPS jamming detected: 3 high-interference hexagons in Middle East',
      'GPS jamming detected: 2 high-interference hexagons in East Asia',
    ]);
  });

  it('drops catch-all hexes that lie in no resolvable country', () => {
    const midAtlantic = hex(30, -40);
    assert.equal(midAtlantic.region, 'other');
    assert.deepEqual(gpsSignals([midAtlantic]), []);
  });

  it('names a theater for every classifyRegion box', () => {
    const boxes = [
      [35, 50], [33, 36], [30, 32], [48, 30], [60, 40], [39, 35], [34, 70], [15, 48],
      [5, 40], [18, 30], [30, 5], [60, 10], [45, 5], [4, 100], [35, 120], [40, -100],
    ];
    const theaters = boxes.map(([lat, lon]) => {
      const h = hex(lat, lon);
      assert.notEqual(h.region, 'other', `${lat},${lon} sits inside a classifyRegion box`);
      return gpsSignals([h])[0]?.theater;
    });
    assert.equal(new Set(boxes.map(([lat, lon]) => classifyRegion(lat, lon))).size, boxes.length);
    for (const theater of theaters) {
      assert.ok(REGIONS.some((r) => isSignalInRegion(theater, r)), `${theater} belongs to a dashboard region`);
    }
  });
});

describe('risk score spike locations', () => {
  it('names the country and its theater instead of the ISO2 code', () => {
    const signals = extractRiskScoreSpike({
      [CII_RISK_SCORE_CACHE_KEYS.stale]: {
        ciiScores: [
          { region: 'SA', combinedScore: 64, trend: 'TREND_DIRECTION_RISING' },
          { region: 'CN', combinedScore: 82, trend: 'TREND_DIRECTION_STABLE' },
          { region: 'US', combinedScore: 85, trend: 'TREND_DIRECTION_STABLE' },
        ],
      },
    });

    assert.deepEqual(signals.map((s) => [s.theater, s.summary]), [
      ['Middle East', 'Risk score spike: Saudi Arabia CII score 64 — trend rising'],
      ['East Asia', 'Risk score spike: China CII score 82 — trend elevated'],
      ['North America', 'Risk score spike: United States CII score 85 — trend elevated'],
    ]);
  });
});
