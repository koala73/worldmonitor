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
    // Real seed-fx-yoy.mjs payload shape:
    //   { rates: [{ countryCode, currency, currentRate, yearAgoRate, yoyChange,
    //                drawdown24m, peakRate, peakDate, troughRate, troughDate,
    //                asOf, yearAgo }] }
    it('detects country with <=-15% drawdown24m from the FX payload', () => {
      const data = {
        rates: [
          { countryCode: 'AR', currency: 'ARS', drawdown24m: -38.4, yoyChange: -13.2 },
          { countryCode: 'EG', currency: 'EGP', drawdown24m: -22.4, yoyChange: -6.7 },
          { countryCode: 'NG', currency: 'NGN', drawdown24m: -20.9, yoyChange: 17.3 },
          { countryCode: 'JP', currency: 'JPY', drawdown24m: -10.0, yoyChange: -9.6 },
        ],
      };
      const labels = detectFxStress(data);
      assert.equal(labels.get('AR'), true, 'Argentina drawdown 38% — flagged');
      assert.equal(labels.get('EG'), true, 'Egypt drawdown 22% — flagged (YoY would have missed this)');
      assert.equal(labels.get('NG'), true, 'Nigeria drawdown 21% — flagged (YoY shows recovery, drawdown captures crisis)');
      assert.equal(labels.get('JP'), false, 'Japan drawdown 10% — below threshold');
    });

    it('falls back to yoyChange when drawdown24m is absent', () => {
      const data = {
        rates: [
          { countryCode: 'AR', currency: 'ARS', yoyChange: -22.4 },
          { countryCode: 'JP', currency: 'JPY', yoyChange: -3.0 },
        ],
      };
      const labels = detectFxStress(data);
      assert.equal(labels.get('AR'), true);
      assert.equal(labels.get('JP'), false);
    });

    it('falls back to legacy BIS realChange field for back-compat', () => {
      const data = {
        rates: [
          { countryCode: 'TR', realEer: 55.1, realChange: -22.4, date: '2026-02' },
          { countryCode: 'JP', realEer: 67.0, realChange: -0.5,  date: '2026-02' },
        ],
      };
      const labels = detectFxStress(data);
      assert.equal(labels.get('TR'), true);
      assert.equal(labels.get('JP'), false);
    });

    it('returns empty map for null or malformed data', () => {
      assert.equal(detectFxStress(null).size, 0);
      assert.equal(detectFxStress({}).size, 0);
      assert.equal(detectFxStress({ rates: 'not-an-array' }).size, 0);
    });

    it('resolves full country names via resolveIso2 when countryCode is absent', () => {
      const data = { rates: [{ country: 'Turkey', drawdown24m: -27.9 }] };
      const labels = detectFxStress(data);
      assert.equal(labels.get('TR'), true);
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
    // Real seed-internet-outages.mjs shape: { outages: [{ country: "Iraq", detectedAt, ... }] }
    // Any appearance in the Cloudflare Radar outage feed flags the country as
    // infrastructure-stressed; the feed is very sparse (typically a few events
    // globally per week) so a threshold > 1 would zero out the signal entirely.
    it('flags countries that appear in the outage feed (full-name → ISO2)', () => {
      const data = {
        outages: [
          { country: 'Iraq', detectedAt: 1775539800000 },
          { country: 'Russian Federation', detectedAt: 1775626200000 },
          { country: 'Iran', detectedAt: 1775539800000 },
        ],
      };
      const labels = detectPowerOutages(data);
      assert.equal(labels.get('IQ'), true);
      assert.equal(labels.get('RU'), true, 'Russian Federation normalized to RU');
      assert.equal(labels.get('IR'), true);
    });

    it('returns empty for null data or unrecognized country names', () => {
      assert.equal(detectPowerOutages(null).size, 0);
      assert.equal(detectPowerOutages({ outages: [{ country: 'Westeros' }] }).size, 0);
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
    // Real seed-displacement-summary.mjs shape:
    //   { summary: { year, countries: [{ code: "AFG" (ISO3), totalDisplaced, refugees, ... }] } }
    it('detects >= 100k displaced from the nested summary.countries array with ISO3 codes', () => {
      const data = {
        summary: {
          year: 2026,
          countries: [
            { code: 'UKR', name: 'Ukraine', totalDisplaced: 6_000_000 },
            { code: 'AFG', name: 'Afghanistan', totalDisplaced: 500_000 },
            { code: 'FRA', name: 'France', totalDisplaced: 50_000 },
          ],
        },
      };
      const labels = detectRefugeeSurges(data);
      assert.equal(labels.get('UA'), true, 'Ukraine flagged (ISO3 UKR normalized to UA, 6M displaced)');
      assert.equal(labels.get('AF'), true, 'Afghanistan flagged (500k displaced >= 100k)');
      assert.equal(labels.has('FR'), false, 'France below threshold (50k < 100k)');
    });

    it('returns empty for null data or missing summary wrapper', () => {
      assert.equal(detectRefugeeSurges(null).size, 0);
      assert.equal(detectRefugeeSurges({}).size, 0);
      assert.equal(detectRefugeeSurges({ summary: {} }).size, 0);
    });
  });

  describe('detectSanctionsShocks', () => {
    // Real seed-sanctions-pressure.mjs shape: { ISO2: entryCount, ... }
    // Absolute threshold of 100 entities isolates comprehensive-sanctions
    // targets from financial hubs that merely host sanctioned entities.
    it('flags only countries above the 100-entity threshold', () => {
      const data = {
        RU: 8000, IR: 1200, KP: 800, CU: 600, SY: 500, VE: 450, BY: 400, MM: 350,
        // Financial hubs with sub-threshold counts (Q3 gate would have flagged these):
        GB: 90, CH: 80, DE: 70, US: 60, AE: 50,
        // Long tail of incidental nexus entities:
        FR: 30, JP: 15, CA: 10, AU: 8, IT: 5, NL: 3,
      };
      const labels = detectSanctionsShocks(data);
      assert.equal(labels.get('RU'), true, 'Russia: 8000 entries, comprehensive sanctions');
      assert.equal(labels.get('IR'), true, 'Iran: 1200 entries, comprehensive sanctions');
      assert.equal(labels.get('KP'), true, 'North Korea: 800 entries');
      assert.equal(labels.get('MM'), true, 'Myanmar: 350 entries — comprehensive sanctions');
      assert.equal(labels.has('GB'), false, 'UK: 90 entries below threshold — financial hub, not target');
      assert.equal(labels.has('CH'), false, 'Switzerland: 80 entries below threshold');
      assert.equal(labels.has('FR'), false, 'France: noise level');
      assert.equal(labels.size, 8, 'exactly the 8 comprehensive-sanctions targets');
    });

    it('flags nothing in a tiny-payload edge case (no country above threshold)', () => {
      const data = { US: 90, GB: 50, FR: 20, DE: 10 };
      const labels = detectSanctionsShocks(data);
      assert.equal(labels.size, 0, 'no country above threshold — none flagged');
    });

    it('returns empty for null data', () => {
      assert.equal(detectSanctionsShocks(null).size, 0);
      assert.equal(detectSanctionsShocks({}).size, 0);
    });
  });

  describe('detectConflictSpillover', () => {
    // Real seed-ucdp-events.mjs shape:
    //   { events: [{ id, dateStart, country: "Somalia" (full name),
    //                sideA, sideB, deathsBest, ... }], fetchedAt, totalRaw }
    it('counts events per country (resolving full-name to ISO2) and flags >= 3 events', () => {
      const data = {
        events: [
          { country: 'Somalia', sideA: 'Government of Somalia', sideB: 'Al-Shabaab', deathsBest: 5 },
          { country: 'Somalia', sideA: 'Government of Somalia', sideB: 'Al-Shabaab', deathsBest: 3 },
          { country: 'Somalia', sideA: 'Government of Somalia', sideB: 'Al-Shabaab', deathsBest: 1 },
          { country: 'Mali',    sideA: 'Government of Mali',    sideB: 'JNIM',         deathsBest: 4 },
        ],
      };
      const labels = detectConflictSpillover(data);
      assert.equal(labels.get('SO'), true,  'Somalia: 3 events — flagged');
      assert.equal(labels.has('ML'), false, 'Mali: 1 event < threshold');
    });

    it('returns empty for null data or unrecognized country names', () => {
      assert.equal(detectConflictSpillover(null).size, 0);
      assert.equal(detectConflictSpillover({ events: [{ country: 'Westeros' }] }).size, 0);
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
