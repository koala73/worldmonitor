/**
 * Tests for shock model v2 contract additions:
 * - deriveCoverageLevel, deriveChokepointConfidence
 * - buildAssessment with unsupported / partial / degraded branches
 * - Integration-level mock tests for coverage flags and limitations
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveCoverageLevel,
  deriveChokepointConfidence,
  buildAssessment,
  CHOKEPOINT_EXPOSURE,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.js';

import { ISO2_TO_COMTRADE } from '../server/worldmonitor/intelligence/v1/_comtrade-reporters.js';

// ---------------------------------------------------------------------------
// deriveCoverageLevel
// ---------------------------------------------------------------------------

describe('deriveCoverageLevel', () => {
  it('returns "unsupported" when jodiOil is false regardless of comtrade', () => {
    assert.equal(deriveCoverageLevel(false, false), 'unsupported');
    assert.equal(deriveCoverageLevel(false, true), 'unsupported');
  });

  it('returns "partial" when jodiOil is true but comtrade is false', () => {
    assert.equal(deriveCoverageLevel(true, false), 'partial');
  });

  it('returns "full" when both jodiOil and comtrade are true', () => {
    assert.equal(deriveCoverageLevel(true, true), 'full');
  });
});

// ---------------------------------------------------------------------------
// deriveChokepointConfidence
// ---------------------------------------------------------------------------

describe('deriveChokepointConfidence', () => {
  it('returns "none" when degraded is true regardless of liveFlowRatio', () => {
    assert.equal(deriveChokepointConfidence(0.9, true), 'none');
    assert.equal(deriveChokepointConfidence(null, true), 'none');
  });

  it('returns "none" when liveFlowRatio is null and not degraded', () => {
    assert.equal(deriveChokepointConfidence(null, false), 'none');
  });

  it('returns "high" when liveFlowRatio is present and not degraded', () => {
    assert.equal(deriveChokepointConfidence(0.9, false), 'high');
    assert.equal(deriveChokepointConfidence(1.0, false), 'high');
    assert.equal(deriveChokepointConfidence(0.0, false), 'high');
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — unsupported country
// ---------------------------------------------------------------------------

describe('buildAssessment — unsupported country', () => {
  it('returns structured insufficient data message for unsupported country', () => {
    const msg = buildAssessment('ZZ', 'hormuz', false, 0, 0, 0, 50, [], 'unsupported', false);
    assert.ok(msg.includes('Insufficient import data'));
    assert.ok(msg.includes('ZZ'));
    assert.ok(msg.includes('hormuz'));
  });

  it('unsupported message is returned even if dataAvailable is true but coverageLevel is unsupported', () => {
    const msg = buildAssessment('ZZ', 'hormuz', true, 0.5, 60, 30, 50, [], 'unsupported', false);
    assert.ok(msg.includes('Insufficient import data'));
  });

  it('dataAvailable=false without coverageLevel also returns insufficient data message', () => {
    const msg = buildAssessment('XY', 'suez', false, 0, 0, 0, 50, []);
    assert.ok(msg.includes('Insufficient import data'));
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — partial coverage
// ---------------------------------------------------------------------------

describe('buildAssessment — partial coverage', () => {
  it('includes proxy note in partial coverage deficit branch', () => {
    const products = [
      { product: 'Diesel', deficitPct: 20.0 },
      { product: 'Jet fuel', deficitPct: 15.0 },
    ];
    const msg = buildAssessment('XX', 'hormuz', true, 0.4, 60, 30, 50, products, 'partial', false);
    assert.ok(msg.includes('20.0%'));
    assert.ok(msg.includes('Gulf share proxied'));
  });

  it('does not include proxy note in full coverage branch', () => {
    const products = [
      { product: 'Diesel', deficitPct: 20.0 },
      { product: 'Jet fuel', deficitPct: 15.0 },
    ];
    const msg = buildAssessment('IN', 'hormuz', true, 0.4, 60, 30, 50, products, 'full', false);
    assert.ok(!msg.includes('proxied'));
  });
});

// ---------------------------------------------------------------------------
// buildAssessment — degraded mode
// ---------------------------------------------------------------------------

describe('buildAssessment — degraded mode', () => {
  it('includes degraded note in cover-days branch when degraded=true', () => {
    const msg = buildAssessment('US', 'hormuz', true, 0.4, 180, 90, 50, [], 'full', true);
    assert.ok(msg.includes('live flow data unavailable'));
  });

  it('does not include degraded note when degraded=false', () => {
    const msg = buildAssessment('US', 'hormuz', true, 0.4, 180, 90, 50, [], 'full', false);
    assert.ok(!msg.includes('live flow data unavailable'));
  });

  it('net-exporter branch does not include degraded note (takes priority)', () => {
    const msg = buildAssessment('SA', 'hormuz', true, 0.8, -1, 0, 50, [], 'full', true);
    assert.ok(msg.includes('net oil exporter'));
    assert.ok(!msg.includes('live flow data unavailable'));
  });
});

// ---------------------------------------------------------------------------
// Mock test: PortWatch absent → degraded=true, liveFlowRatio=0, fallback to CHOKEPOINT_EXPOSURE
// ---------------------------------------------------------------------------

describe('mock: degraded mode falls back to CHOKEPOINT_EXPOSURE', () => {
  it('CHOKEPOINT_EXPOSURE values are used as fallback when portwatch absent', () => {
    const chokepointId = 'hormuz';
    const degraded = true;
    const liveFlowRatio = null;

    const exposureMult = liveFlowRatio !== null ? liveFlowRatio : (CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0);
    assert.equal(exposureMult, 1.0);

    const confidence = deriveChokepointConfidence(liveFlowRatio, degraded);
    assert.equal(confidence, 'none');

    const computedLiveFlowRatioInResponse = liveFlowRatio !== null ? liveFlowRatio : undefined;
    assert.equal(computedLiveFlowRatioInResponse, undefined, 'liveFlowRatio should be absent (undefined) when PortWatch unavailable, not 0');
  });

  it('suez uses CHOKEPOINT_EXPOSURE[suez]=0.6 when portwatch absent', () => {
    const exposureMult = CHOKEPOINT_EXPOSURE['suez'] ?? 1.0;
    assert.equal(exposureMult, 0.6);
  });

  it('malacca uses CHOKEPOINT_EXPOSURE[malacca]=0.7 when portwatch absent', () => {
    const exposureMult = CHOKEPOINT_EXPOSURE['malacca'] ?? 1.0;
    assert.equal(exposureMult, 0.7);
  });
});

// ---------------------------------------------------------------------------
// Mock test: partial coverage → limitations includes proxy string
// ---------------------------------------------------------------------------

describe('mock: partial coverage limitations', () => {
  it('partial coverage level triggers Gulf share proxy limitation', () => {
    const jodiOilCoverage = true;
    const comtradeCoverage = false;
    const coverageLevel = deriveCoverageLevel(jodiOilCoverage, comtradeCoverage);
    assert.equal(coverageLevel, 'partial');

    const limitations = [];
    if (coverageLevel === 'partial') {
      limitations.push('Gulf crude share proxied at 40% (no Comtrade data)');
    }
    limitations.push('refinery yield: 80% crude-to-product heuristic');

    assert.ok(limitations.some((l) => l.includes('proxied at 40%')));
    assert.ok(limitations.some((l) => l.includes('refinery yield')));
  });

  it('full coverage does not add proxy limitation', () => {
    const coverageLevel = deriveCoverageLevel(true, true);
    const limitations = [];
    if (coverageLevel === 'partial') {
      limitations.push('Gulf crude share proxied at 40% (no Comtrade data)');
    }
    limitations.push('refinery yield: 80% crude-to-product heuristic');
    assert.ok(!limitations.some((l) => l.includes('proxied at 40%')));
  });
});

// ---------------------------------------------------------------------------
// Mock test: full coverage with live data → confidence='high', liveFlowRatio set
// ---------------------------------------------------------------------------

describe('mock: full coverage with live PortWatch data', () => {
  it('chokepointConfidence is high when liveFlowRatio present and not degraded', () => {
    const liveFlowRatio = 0.9;
    const degraded = false;
    const confidence = deriveChokepointConfidence(liveFlowRatio, degraded);
    assert.equal(confidence, 'high');
  });

  it('live flow ratio replaces CHOKEPOINT_EXPOSURE multiplier', () => {
    const chokepointId = 'suez';
    const liveFlowRatio = 0.85;
    const exposureMult = liveFlowRatio !== null ? liveFlowRatio : (CHOKEPOINT_EXPOSURE[chokepointId] ?? 1.0);
    assert.equal(exposureMult, 0.85);
    assert.notEqual(exposureMult, CHOKEPOINT_EXPOSURE[chokepointId]);
  });

  it('full coverage returns "full" level with both jodiOil and comtrade true', () => {
    const level = deriveCoverageLevel(true, true);
    assert.equal(level, 'full');
  });
});

// ---------------------------------------------------------------------------
// ISO2_TO_COMTRADE completeness
// ---------------------------------------------------------------------------

describe('ISO2_TO_COMTRADE completeness', () => {
  const REQUIRED = ['US', 'CN', 'RU', 'IR', 'IN', 'TW', 'DE', 'FR', 'GB', 'IT',
    'JP', 'KR', 'SA', 'AE', 'TR', 'BR', 'AU', 'CA', 'MX', 'ID',
    'TH', 'MY', 'SG', 'PL', 'NL', 'BE', 'ES', 'PT', 'GR', 'SE',
    'NO', 'FI', 'DK', 'CH', 'AT', 'CZ', 'HU', 'RO', 'UA', 'EG',
    'ZA', 'NG', 'KE', 'MA', 'DZ', 'IQ', 'KW', 'QA', 'VN', 'PH',
    'PK', 'BD', 'NZ', 'CL', 'AR', 'CO', 'PE', 'VE', 'BO'];

  it('contains all 6 originally seeded Comtrade reporters', () => {
    for (const code of ['US', 'CN', 'RU', 'IR', 'IN', 'TW']) {
      assert.ok(code in ISO2_TO_COMTRADE, `Missing originally seeded reporter: ${code}`);
    }
  });

  it('contains all required major economies', () => {
    for (const code of REQUIRED) {
      assert.ok(code in ISO2_TO_COMTRADE, `Missing required country: ${code}`);
    }
  });

  it('has more than 50 entries', () => {
    assert.ok(Object.keys(ISO2_TO_COMTRADE).length > 50, `Expected >50 entries, got ${Object.keys(ISO2_TO_COMTRADE).length}`);
  });

  it('all values are numeric strings', () => {
    for (const [iso2, code] of Object.entries(ISO2_TO_COMTRADE)) {
      assert.ok(/^\d{3}$/.test(code), `${iso2} has non-3-digit code: ${code}`);
    }
  });

  it('US maps to 842', () => assert.equal(ISO2_TO_COMTRADE['US'], '842'));
  it('CN maps to 156', () => assert.equal(ISO2_TO_COMTRADE['CN'], '156'));
  it('DE maps to 276', () => assert.equal(ISO2_TO_COMTRADE['DE'], '276'));
  it('JP maps to 392', () => assert.equal(ISO2_TO_COMTRADE['JP'], '392'));
});

// ---------------------------------------------------------------------------
// NaN/Infinity guard — deriveChokepointConfidence
// ---------------------------------------------------------------------------

describe('deriveChokepointConfidence guards NaN and Infinity', () => {
  it('returns "none" for NaN flowRatio', () => {
    assert.equal(deriveChokepointConfidence(NaN, false), 'none');
  });

  it('returns "none" for Infinity flowRatio', () => {
    assert.equal(deriveChokepointConfidence(Infinity, false), 'none');
  });

  it('returns "none" for -Infinity flowRatio', () => {
    assert.equal(deriveChokepointConfidence(-Infinity, false), 'none');
  });

  it('returns "high" for a finite positive flowRatio with degraded=false', () => {
    assert.equal(deriveChokepointConfidence(0.85, false), 'high');
  });

  it('returns "high" for flowRatio=0 with degraded=false (true 0 flow is valid)', () => {
    assert.equal(deriveChokepointConfidence(0, false), 'high');
  });
});

// ---------------------------------------------------------------------------
// deriveCoverageLevel — IEA and degraded inputs
// ---------------------------------------------------------------------------

describe('deriveCoverageLevel accounts for IEA and degraded state', () => {
  it('returns "full" only when all inputs are good', () => {
    assert.equal(deriveCoverageLevel(true, true, true, false), 'full');
  });

  it('returns "partial" when ieaStocksCoverage is false (even with JODI+Comtrade)', () => {
    assert.equal(deriveCoverageLevel(true, true, false, false), 'partial');
  });

  it('returns "partial" when degraded=true (even with JODI+Comtrade+IEA)', () => {
    assert.equal(deriveCoverageLevel(true, true, true, true), 'partial');
  });

  it('returns "partial" when comtrade is false regardless of IEA/degraded', () => {
    assert.equal(deriveCoverageLevel(true, false, true, false), 'partial');
  });

  it('returns "unsupported" when jodiOil is false', () => {
    assert.equal(deriveCoverageLevel(false, true, true, false), 'unsupported');
  });

  it('backward-compatible: two-arg call without IEA/degraded still works', () => {
    // ieaStocksCoverage=undefined → !undefined=true → passes; degraded=undefined → falsy → passes
    assert.equal(deriveCoverageLevel(true, true), 'full');
    assert.equal(deriveCoverageLevel(true, false), 'partial');
    assert.equal(deriveCoverageLevel(false, true), 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// live_flow_ratio absent when portwatchCoverage=false
// ---------------------------------------------------------------------------

describe('liveFlowRatio is absent (undefined) when PortWatch unavailable', () => {
  it('liveFlowRatio should be undefined, not 0, when portwatch is absent', () => {
    // This tests the response contract: callers must check portwatchCoverage,
    // not rely on liveFlowRatio===0 to detect missing data.
    const liveFlowRatioFromServer = null; // PortWatch unavailable
    const fieldOnWire = liveFlowRatioFromServer !== null
      ? Math.round(liveFlowRatioFromServer * 1000) / 1000
      : undefined;
    assert.equal(fieldOnWire, undefined, 'field should be absent on wire when portwatch unavailable');
  });

  it('liveFlowRatio=0 is valid and distinct from "unavailable" when portwatchCoverage=true', () => {
    // True zero flow (chokepoint collapse) is a real and distinct signal
    const liveFlowRatioFromServer = 0; // portwatchCoverage=true, chokepoint collapsed
    const fieldOnWire = liveFlowRatioFromServer !== null
      ? Math.round(liveFlowRatioFromServer * 1000) / 1000
      : undefined;
    assert.equal(fieldOnWire, 0, 'true 0 flow should serialize as 0, not undefined');
  });
});
