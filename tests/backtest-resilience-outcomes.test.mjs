import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAuc,
  checkGate,
  detectFxStress,
  detectSovereignStress,
  detectPowerOutages,
  detectFoodCrisis,
  detectRefugeeSurges,
  detectSanctionsShocks,
  detectConflictSpillover,
  findFalseNegatives,
  findFalsePositives,
  EVENT_FAMILIES,
  SOVEREIGN_STRESS_COUNTRIES_2024_2025,
  AUC_THRESHOLD,
  GATE_WIDTH,
} from '../scripts/backtest-resilience-outcomes.mjs';

describe('computeAuc', () => {
  it('returns 1.0 for perfect separation', () => {
    const predictions = [0.9, 0.8, 0.7, 0.1, 0.2, 0.3];
    const labels = [true, true, true, false, false, false];
    const auc = computeAuc(predictions, labels);
    assert.equal(auc, 1.0);
  });

  it('returns 0.0 for perfectly inverted predictions', () => {
    const predictions = [0.1, 0.2, 0.3, 0.9, 0.8, 0.7];
    const labels = [true, true, true, false, false, false];
    const auc = computeAuc(predictions, labels);
    assert.equal(auc, 0.0);
  });

  it('returns approximately 0.5 for random predictions', () => {
    const predictions = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const labels = [true, true, true, false, false, false];
    const auc = computeAuc(predictions, labels);
    assert.ok(Math.abs(auc - 0.5) < 0.01, `Expected ~0.5, got ${auc}`);
  });

  it('returns 0.5 when all labels are the same', () => {
    const predictions = [0.9, 0.8, 0.7];
    const labelsAllTrue = [true, true, true];
    const labelsAllFalse = [false, false, false];
    assert.equal(computeAuc(predictions, labelsAllTrue), 0.5);
    assert.equal(computeAuc(predictions, labelsAllFalse), 0.5);
  });

  it('returns 0.5 for empty arrays', () => {
    assert.equal(computeAuc([], []), 0.5);
  });

  it('handles two-element case correctly', () => {
    const auc = computeAuc([0.9, 0.1], [true, false]);
    assert.equal(auc, 1.0);
  });

  it('handles ties in predictions', () => {
    const predictions = [0.8, 0.8, 0.2, 0.2];
    const labels = [true, false, true, false];
    const auc = computeAuc(predictions, labels);
    assert.ok(Math.abs(auc - 0.5) < 0.01, `Tied predictions with balanced labels should give ~0.5, got ${auc}`);
  });
});

describe('checkGate', () => {
  it('passes when AUC meets threshold exactly', () => {
    assert.ok(checkGate(0.75, 0.75, 0.03));
  });

  it('passes when AUC is above threshold', () => {
    assert.ok(checkGate(0.80, 0.75, 0.03));
  });

  it('passes when AUC is within gate width below threshold', () => {
    assert.ok(checkGate(0.74, 0.75, 0.03));
    assert.ok(checkGate(0.72, 0.75, 0.03));
  });

  it('fails when AUC is below threshold minus gate width', () => {
    assert.ok(!checkGate(0.71, 0.75, 0.03));
    assert.ok(!checkGate(0.50, 0.75, 0.03));
  });

  it('boundary: exactly at threshold minus gate width passes', () => {
    assert.ok(checkGate(0.72, 0.75, 0.03));
  });

  it('boundary: just below threshold minus gate width fails', () => {
    assert.ok(!checkGate(0.7199, 0.75, 0.03));
  });
});

describe('event detectors', () => {
  describe('detectFxStress', () => {
    it('detects country with >15% depreciation from object format', () => {
      const data = {
        AR: { series: [{ value: 100 }, { value: 80 }] },
        US: { series: [{ value: 100 }, { value: 98 }] },
      };
      const labels = detectFxStress(data, ['AR', 'US']);
      assert.equal(labels.get('AR'), true);
      assert.equal(labels.get('US'), false);
    });

    it('returns empty map for null data', () => {
      const labels = detectFxStress(null, []);
      assert.equal(labels.size, 0);
    });

    it('handles array format with yoyChange in percentage points', () => {
      const data = [
        { country: 'TR', yoyChange: -20 },
        { country: 'JP', yoyChange: -5 },
      ];
      const labels = detectFxStress(data, ['TR', 'JP']);
      assert.equal(labels.get('TR'), true);
      assert.equal(labels.get('JP'), false);
    });
  });

  describe('detectSovereignStress', () => {
    it('returns hardcoded reference list', () => {
      const labels = detectSovereignStress(null, []);
      assert.ok(labels.get('AR'));
      assert.ok(labels.get('LK'));
      assert.ok(labels.get('GH'));
      assert.equal(labels.get('US'), undefined);
    });

    it('has the expected number of countries', () => {
      const labels = detectSovereignStress(null, []);
      assert.equal(labels.size, SOVEREIGN_STRESS_COUNTRIES_2024_2025.size);
    });
  });

  describe('detectPowerOutages', () => {
    it('flags countries with outages affecting >= 1M', () => {
      const data = {
        events: [
          { country: 'NG', affected: 5_000_000 },
          { country: 'DE', affected: 500_000 },
        ],
      };
      const labels = detectPowerOutages(data, ['NG', 'DE']);
      assert.equal(labels.get('NG'), true);
      assert.equal(labels.has('DE'), false);
    });

    it('returns empty for null data', () => {
      assert.equal(detectPowerOutages(null, []).size, 0);
    });
  });

  describe('detectFoodCrisis', () => {
    it('detects IPC Phase 3+ from object format', () => {
      const data = {
        countries: {
          SO: { ipcPhase: 4 },
          FR: { ipcPhase: 1 },
        },
      };
      const labels = detectFoodCrisis(data, ['SO', 'FR']);
      assert.equal(labels.get('SO'), true);
      assert.equal(labels.has('FR'), false);
    });

    it('detects from text classification', () => {
      const data = [
        { country: 'YE', classification: 'Phase 4 - Emergency' },
      ];
      const labels = detectFoodCrisis(data, ['YE']);
      assert.equal(labels.get('YE'), true);
    });
  });

  describe('detectRefugeeSurges', () => {
    it('detects countries with >= 100k displacement', () => {
      const data = [
        { country: 'UA', newDisplacement: 500_000 },
        { country: 'FR', newDisplacement: 1_000 },
      ];
      const labels = detectRefugeeSurges(data, ['UA', 'FR']);
      assert.equal(labels.get('UA'), true);
      assert.equal(labels.has('FR'), false);
    });

    it('handles object format with country keys', () => {
      const data = { SD: 200_000, CH: 5_000 };
      const labels = detectRefugeeSurges(data, ['SD', 'CH']);
      assert.equal(labels.get('SD'), true);
      assert.equal(labels.has('CH'), false);
    });
  });

  describe('detectSanctionsShocks', () => {
    it('detects countries with sanctions from object format', () => {
      const data = { RU: 150, IR: 80, FR: 0 };
      const labels = detectSanctionsShocks(data, ['RU', 'IR', 'FR']);
      assert.equal(labels.get('RU'), true);
      assert.equal(labels.get('IR'), true);
      assert.equal(labels.has('FR'), false);
    });
  });

  describe('detectConflictSpillover', () => {
    it('detects countries with conflict events', () => {
      const data = {
        events: [
          { country: 'SD', type: 'battle' },
          { country: 'SD', type: 'violence' },
          { country: 'ML', type: 'battle' },
        ],
      };
      const labels = detectConflictSpillover(data, ['SD', 'ML']);
      assert.equal(labels.get('SD'), true);
      assert.equal(labels.get('ML'), true);
    });

    it('handles country-count object format', () => {
      const data = { MM: 45, TH: 0 };
      const labels = detectConflictSpillover(data, ['MM', 'TH']);
      assert.equal(labels.get('MM'), true);
      assert.equal(labels.has('TH'), false);
    });
  });
});

describe('findFalseNegatives', () => {
  it('returns high-resilience countries that experienced events', () => {
    const scores = new Map([['US', 85], ['SG', 90], ['BD', 30], ['ET', 25]]);
    const labels = new Map([['SG', true], ['BD', true], ['ET', false]]);
    const result = findFalseNegatives(scores, labels, 2);
    assert.deepEqual(result, ['SG', 'BD']);
  });

  it('returns empty array when no positives', () => {
    const scores = new Map([['US', 85]]);
    const labels = new Map([['US', false]]);
    assert.deepEqual(findFalseNegatives(scores, labels), []);
  });
});

describe('findFalsePositives', () => {
  it('returns low-resilience countries that survived', () => {
    const scores = new Map([['US', 85], ['BD', 30], ['ET', 25], ['SO', 15]]);
    const labels = new Map([['US', false], ['BD', false], ['SO', true]]);
    const result = findFalsePositives(scores, labels, ['US', 'BD', 'ET', 'SO'], 2);
    assert.deepEqual(result, ['ET', 'BD']);
  });
});

describe('output shape', () => {
  it('EVENT_FAMILIES has exactly 7 entries', () => {
    assert.equal(EVENT_FAMILIES.length, 7);
  });

  it('each family has required fields', () => {
    for (const family of EVENT_FAMILIES) {
      assert.equal(typeof family.id, 'string');
      assert.equal(typeof family.label, 'string');
      assert.equal(typeof family.description, 'string');
      assert.equal(typeof family.detect, 'function');
      assert.ok(['live', 'hardcoded'].includes(family.dataSource));
    }
  });

  it('family IDs are unique', () => {
    const ids = EVENT_FAMILIES.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('expected family IDs are present', () => {
    const ids = new Set(EVENT_FAMILIES.map((f) => f.id));
    assert.ok(ids.has('fx-stress'));
    assert.ok(ids.has('sovereign-stress'));
    assert.ok(ids.has('power-outages'));
    assert.ok(ids.has('food-crisis'));
    assert.ok(ids.has('refugee-surges'));
    assert.ok(ids.has('sanctions-shocks'));
    assert.ok(ids.has('conflict-spillover'));
  });
});

describe('constants', () => {
  it('AUC_THRESHOLD is 0.75', () => {
    assert.equal(AUC_THRESHOLD, 0.75);
  });

  it('GATE_WIDTH is 0.03', () => {
    assert.equal(GATE_WIDTH, 0.03);
  });

  it('sovereign stress reference list is non-empty', () => {
    assert.ok(SOVEREIGN_STRESS_COUNTRIES_2024_2025.size > 0);
  });
});
