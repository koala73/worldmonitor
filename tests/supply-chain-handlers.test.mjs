import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDisruptionScore,
  scoreToStatus,
  computeHHI,
  riskRating,
  detectSpike,
  SEVERITY_SCORE,
} from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

describe('Chokepoint scoring', () => {
  it('computes disruption score with cap at 100', () => {
    assert.equal(computeDisruptionScore(3, 2), Math.min(100, 3 * 15 + 2 * 30));
    assert.equal(computeDisruptionScore(5, 3), 100);
    assert.equal(computeDisruptionScore(0, 0), 0);
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
