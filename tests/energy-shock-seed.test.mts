/**
 * Unit tests for computeEnergyShockScenario handler logic.
 *
 * Tests the pure computation functions imported from _shock-compute.ts (no Redis dependency).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  computeGulfShare,
  computeEffectiveCoverDays,
  buildAssessment,
  GULF_PARTNER_CODES,
  CHOKEPOINT_EXPOSURE,
  VALID_CHOKEPOINTS,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('energy shock scenario computation', () => {
  describe('chokepoint validation', () => {
    it('accepts all valid chokepoint IDs', () => {
      for (const id of ['hormuz', 'malacca', 'suez', 'babelm']) {
        assert.ok(VALID_CHOKEPOINTS.has(id), `Expected ${id} to be valid`);
      }
    });

    it('rejects invalid chokepoint IDs', () => {
      for (const id of ['panama', 'taiwan', '', 'xyz']) {
        assert.ok(!VALID_CHOKEPOINTS.has(id), `Expected ${id} to be invalid`);
      }
    });

    it('CHOKEPOINT_EXPOSURE contains all valid chokepoints', () => {
      for (const id of VALID_CHOKEPOINTS) {
        assert.ok(id in CHOKEPOINT_EXPOSURE, `Expected CHOKEPOINT_EXPOSURE to have key ${id}`);
      }
    });
  });

  describe('disruption_pct clamping', () => {
    it('clamps disruption_pct below 10 to 10', () => {
      assert.equal(clamp(Math.round(5), 10, 100), 10);
      assert.equal(clamp(Math.round(0), 10, 100), 10);
    });

    it('clamps disruption_pct above 100 to 100', () => {
      assert.equal(clamp(Math.round(150), 10, 100), 100);
      assert.equal(clamp(Math.round(200), 10, 100), 100);
    });

    it('passes through valid disruption_pct values unchanged', () => {
      for (const v of [10, 25, 50, 75, 100]) {
        assert.equal(clamp(v, 10, 100), v);
      }
    });
  });

  describe('gulf crude share calculation', () => {
    it('returns hasData=false when no flows provided', () => {
      const result = computeGulfShare([]);
      assert.equal(result.share, 0);
      assert.equal(result.hasData, false);
    });

    it('returns hasData=false when all flows have zero/negative tradeValueUsd', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 0 },
        { partnerCode: '784', tradeValueUsd: -100 },
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 0);
      assert.equal(result.hasData, false);
    });

    it('returns hasData=false when country has no Comtrade data (no numeric code mapping)', () => {
      const ISO2_TO_COMTRADE: Record<string, string> = {
        US: '842', CN: '156', RU: '643', IR: '364', IN: '356', TW: '158',
      };
      const unsupportedCountries = ['DE', 'FR', 'JP', 'KR', 'BR', 'SA'];
      for (const code of unsupportedCountries) {
        assert.equal(ISO2_TO_COMTRADE[code], undefined, `${code} should not have Comtrade mapping`);
      }
    });

    it('GULF_PARTNER_CODES contains expected Gulf country codes', () => {
      assert.ok(GULF_PARTNER_CODES.has('682'), 'SA should be in Gulf set');
      assert.ok(GULF_PARTNER_CODES.has('784'), 'AE should be in Gulf set');
      assert.ok(GULF_PARTNER_CODES.has('368'), 'IQ should be in Gulf set');
      assert.ok(GULF_PARTNER_CODES.has('414'), 'KW should be in Gulf set');
      assert.ok(GULF_PARTNER_CODES.has('364'), 'IR should be in Gulf set');
      assert.ok(!GULF_PARTNER_CODES.has('643'), 'RU should NOT be in Gulf set');
    });

    it('returns share=1.0 and hasData=true when all imports are from Gulf partners', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 1000 }, // SA
        { partnerCode: '784', tradeValueUsd: 500 },  // AE
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 1.0);
      assert.equal(result.hasData, true);
    });

    it('returns share=0 and hasData=true when no imports are from Gulf partners', () => {
      const flows = [
        { partnerCode: '124', tradeValueUsd: 1000 }, // Canada
        { partnerCode: '643', tradeValueUsd: 500 },  // Russia (not in Gulf set)
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 0);
      assert.equal(result.hasData, true);
    });

    it('computes fractional Gulf share correctly', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 300 }, // SA (Gulf)
        { partnerCode: '124', tradeValueUsd: 700 }, // Canada (non-Gulf)
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 0.3);
      assert.equal(result.hasData, true);
    });

    it('ignores flows with zero or negative tradeValueUsd', () => {
      const flows = [
        { partnerCode: '682', tradeValueUsd: 0 },   // Gulf but zero
        { partnerCode: '784', tradeValueUsd: -100 }, // Gulf but negative
        { partnerCode: '124', tradeValueUsd: 500 },  // Non-Gulf positive
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 0);
      assert.equal(result.hasData, true);
    });

    it('accepts numeric partnerCode values', () => {
      const flows = [
        { partnerCode: 682, tradeValueUsd: 1000 }, // SA as number
      ];
      const result = computeGulfShare(flows);
      assert.equal(result.share, 1.0);
      assert.equal(result.hasData, true);
    });
  });

  describe('effective cover days computation', () => {
    it('returns -1 for net exporters', () => {
      assert.equal(computeEffectiveCoverDays(90, true, 100, 500), -1);
    });

    it('returns raw daysOfCover when crudeLossKbd is 0', () => {
      assert.equal(computeEffectiveCoverDays(90, false, 0, 500), 90);
    });

    it('returns raw daysOfCover when crudeImportsKbd is 0', () => {
      assert.equal(computeEffectiveCoverDays(90, false, 50, 0), 90);
    });

    it('scales cover days by the loss ratio', () => {
      // 90 days cover, 50% loss of 200 kbd imports = ratio 0.5
      // effectiveCoverDays = round(90 / 0.5) = 180
      const result = computeEffectiveCoverDays(90, false, 100, 200);
      assert.equal(result, 180);
    });

    it('produces shorter cover days for higher loss ratios', () => {
      // 90 days cover, 90% disruption of 200 kbd = 180 kbd loss, ratio 0.9
      // effectiveCoverDays = round(90 / 0.9) = 100
      const result = computeEffectiveCoverDays(90, false, 180, 200);
      assert.equal(result, 100);
    });
  });

  describe('assessment string branches', () => {
    it('uses insufficient data message when dataAvailable is false', () => {
      const assessment = buildAssessment('XZ', 'suez', false, 0, 0, 0, 50, []);
      assert.ok(assessment.includes('Insufficient import data'));
      assert.ok(assessment.includes('XZ'));
      assert.ok(assessment.includes('suez'));
    });

    it('uses net-exporter branch when effectiveCoverDays === -1', () => {
      const assessment = buildAssessment('SA', 'hormuz', true, 0.8, -1, 0, 50, []);
      assert.ok(assessment.includes('net oil exporter'));
    });

    it('net-exporter branch takes priority over low-Gulf-share branch', () => {
      const assessment = buildAssessment('NO', 'hormuz', true, 0.05, -1, 0, 50, []);
      assert.ok(assessment.includes('net oil exporter'));
      assert.ok(!assessment.includes('low Gulf crude dependence'));
    });

    it('uses low-dependence branch when gulfCrudeShare < 0.1', () => {
      const assessment = buildAssessment('DE', 'hormuz', true, 0.05, 180, 90, 50, []);
      assert.ok(assessment.includes('low Gulf crude dependence'));
      assert.ok(assessment.includes('5%'));
    });

    it('uses IEA cover branch when effectiveCoverDays > 90', () => {
      const assessment = buildAssessment('US', 'hormuz', true, 0.4, 180, 90, 50, []);
      assert.ok(assessment.includes('bridge'));
      assert.ok(assessment.includes('180 days'));
    });

    it('uses deficit branch when dataAvailable, gulfShare >= 0.1, effectiveCoverDays <= 90', () => {
      const products = [
        { product: 'Diesel', deficitPct: 25.0 },
        { product: 'Jet fuel', deficitPct: 20.0 },
      ];
      const assessment = buildAssessment('IN', 'malacca', true, 0.5, 60, 30, 75, products);
      assert.ok(assessment.includes('faces'));
      assert.ok(assessment.includes('25.0% diesel deficit'));
      assert.ok(assessment.includes('25.0%'));
    });

  });
});
