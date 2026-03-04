import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDisruptionScore,
  scoreToStatus,
  computeHHI,
  riskRating,
  detectSpike,
  SEVERITY_SCORE,
  THREAT_LEVEL,
  warningComponent,
  aisComponent,
} from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';
import {
  resolveChokepointId,
  isThreatConfigFresh,
  THREAT_CONFIG_LAST_REVIEWED,
} from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';

describe('Chokepoint scoring', () => {
  it('computes disruption score as threat + warnings + ais, capped at 100', () => {
    // threat=0, 3 warnings (15), severity 2 (10) → 25
    assert.equal(computeDisruptionScore(0, 3, 2), 25);
    // threat=30 (high), 3 warnings (15), severity 3 (15) → 60
    assert.equal(computeDisruptionScore(THREAT_LEVEL.high, 3, 3), 60);
    // war_zone=70, 3 warnings (15), severity 3 (15) → 100
    assert.equal(computeDisruptionScore(THREAT_LEVEL.war_zone, 3, 3), 100);
    // overflow clamps to 100
    assert.equal(computeDisruptionScore(THREAT_LEVEL.war_zone, 10, 3), 100);
    // all zeros → 0
    assert.equal(computeDisruptionScore(0, 0, 0), 0);
  });

  it('maps score to status correctly', () => {
    assert.equal(scoreToStatus(0), 'green');
    assert.equal(scoreToStatus(15), 'green');
    assert.equal(scoreToStatus(19), 'green');
    assert.equal(scoreToStatus(20), 'yellow');
    assert.equal(scoreToStatus(45), 'yellow');
    assert.equal(scoreToStatus(49), 'yellow');
    assert.equal(scoreToStatus(50), 'red');
    assert.equal(scoreToStatus(65), 'red');
    assert.equal(scoreToStatus(100), 'red');
  });

  it('has correct severity enum keys', () => {
    assert.equal(SEVERITY_SCORE['AIS_DISRUPTION_SEVERITY_LOW'], 1);
    assert.equal(SEVERITY_SCORE['AIS_DISRUPTION_SEVERITY_ELEVATED'], 2);
    assert.equal(SEVERITY_SCORE['AIS_DISRUPTION_SEVERITY_HIGH'], 3);
  });
});

describe('HHI computation', () => {
  it('returns 10000 for pure monopoly', () => {
    assert.equal(computeHHI([100]), 10000);
  });

  it('returns 2500 for four equal producers', () => {
    assert.equal(computeHHI([25, 25, 25, 25]), 2500);
  });

  it('returns 0 for empty array', () => {
    assert.equal(computeHHI([]), 0);
  });

  it('handles two equal producers', () => {
    assert.equal(computeHHI([50, 50]), 5000);
  });
});

describe('Risk rating', () => {
  it('maps HHI to correct risk levels', () => {
    assert.equal(riskRating(1499), 'low');
    assert.equal(riskRating(1500), 'moderate');
    assert.equal(riskRating(2499), 'moderate');
    assert.equal(riskRating(2500), 'high');
    assert.equal(riskRating(4999), 'high');
    assert.equal(riskRating(5000), 'critical');
    assert.equal(riskRating(5001), 'critical');
    assert.equal(riskRating(10000), 'critical');
  });
});

describe('Spike detection', () => {
  it('detects spike when value > mean + 2*stdDev', () => {
    assert.equal(detectSpike([100, 102, 98, 101, 99, 100, 103, 97, 100, 500]), true);
  });

  it('returns false for stable series', () => {
    assert.equal(detectSpike([100, 101, 99, 100]), false);
  });

  it('returns false for empty array', () => {
    assert.equal(detectSpike([]), false);
  });

  it('returns false for too few values', () => {
    assert.equal(detectSpike([100, 200]), false);
  });

  it('handles ShippingRatePoint objects', () => {
    const points = [
      { date: '2024-01-01', value: 100 },
      { date: '2024-01-08', value: 102 },
      { date: '2024-01-15', value: 98 },
      { date: '2024-01-22', value: 101 },
      { date: '2024-01-29', value: 99 },
      { date: '2024-02-05', value: 100 },
      { date: '2024-02-12', value: 103 },
      { date: '2024-02-19', value: 97 },
      { date: '2024-02-26', value: 100 },
      { date: '2024-03-04', value: 500 },
    ];
    assert.equal(detectSpike(points), true);
  });
});

describe('Chokepoint assignment', () => {
  it('matches explicit chokepoint names', () => {
    assert.equal(
      resolveChokepointId({ text: 'Convoy delays reported in the Suez Canal transit corridor' }),
      'suez',
    );
    assert.equal(
      resolveChokepointId({ text: 'New advisory issued for Strait of Hormuz tanker traffic' }),
      'hormuz',
    );
  });

  it('does not classify a single broad regional token', () => {
    assert.equal(
      resolveChokepointId({ text: 'General security alert for Red Sea traffic' }),
      null,
    );
  });

  it('uses nearest location when text has no match', () => {
    assert.equal(
      resolveChokepointId({
        text: '',
        location: { latitude: 26.6, longitude: 56.2 }, // near Hormuz
      }),
      'hormuz',
    );
  });

  it('text evidence beats nearby location (P2 regression)', () => {
    assert.equal(
      resolveChokepointId({
        text: 'Houthi drone strike near Bab el-Mandeb strait',
        location: { latitude: 30.4, longitude: 32.3 }, // near Suez
      }),
      'bab_el_mandeb',
    );
  });
});

describe('Threat config freshness', () => {
  it('is fresh within the max-age window', () => {
    const reviewedAtMs = Date.parse(THREAT_CONFIG_LAST_REVIEWED);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    assert.equal(isThreatConfigFresh(reviewedAtMs + ninetyDaysMs), true);
  });

  it('becomes stale after the max-age window', () => {
    const reviewedAtMs = Date.parse(THREAT_CONFIG_LAST_REVIEWED);
    const oneHundredTwentyOneDaysMs = 121 * 24 * 60 * 60 * 1000;
    assert.equal(isThreatConfigFresh(reviewedAtMs + oneHundredTwentyOneDaysMs), false);
  });
});
