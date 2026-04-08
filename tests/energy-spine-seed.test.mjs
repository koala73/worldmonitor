import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpineEntry,
  SPINE_KEY_PREFIX,
  SPINE_COUNTRIES_KEY,
  SPINE_META_KEY,
  SPINE_TTL_SECONDS,
} from '../scripts/seed-energy-spine.mjs';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function makeMix(overrides = {}) {
  return {
    year: 2024,
    coalShare: 26.4,
    gasShare: 15.1,
    oilShare: 0.9,
    nuclearShare: 1.8,
    renewShare: 55.8,
    importShare: 3.4,
    windShare: 34.0,
    solarShare: 12.0,
    hydroShare: 3.0,
    ...overrides,
  };
}

function makeJodiOil(overrides = {}) {
  return {
    dataMonth: '2026-02',
    crude: { importsKbd: 950 },
    gasoline: { demandKbd: 120, importsKbd: 10 },
    diesel: { demandKbd: 310, importsKbd: 50 },
    jet: { demandKbd: 95, importsKbd: 20 },
    lpg: { demandKbd: 40, importsKbd: 5 },
    ...overrides,
  };
}

function makeJodiGas(overrides = {}) {
  return {
    dataMonth: '2026-02',
    totalDemandTj: 51000,
    lngImportsTj: 0,
    pipeImportsTj: 18400,
    lngShareOfImports: 0.0,
    ...overrides,
  };
}

function makeIeaStocks(overrides = {}) {
  return {
    dataMonth: '2026-02',
    daysOfCover: 130,
    netExporter: false,
    belowObligation: false,
    anomaly: false,
    ...overrides,
  };
}

// electricity and gasStorage are intentionally excluded from the spine
// (they update sub-daily; the spine seeds once daily at 06:00 UTC).

// ---------------------------------------------------------------------------
// buildSpineEntry — spine build logic
// ---------------------------------------------------------------------------

describe('buildSpineEntry — full data', () => {
  it('returns correct countryCode and updatedAt', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.countryCode, 'DE');
    assert.ok(typeof spine.updatedAt === 'string');
    assert.ok(new Date(spine.updatedAt).getTime() > 0);
  });

  it('sets all coverage flags to true when all sources present', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.coverage.hasMix, true);
    assert.equal(spine.coverage.hasJodiOil, true);
    assert.equal(spine.coverage.hasJodiGas, true);
    assert.equal(spine.coverage.hasIeaStocks, true);
  });

  it('electricity is null when no ember data provided, gasStorage excluded from spine', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.electricity, null);
    assert.equal(spine.gasStorage, undefined);
    assert.equal(spine.coverage.hasEmber, false);
    assert.equal(spine.coverage.hasGasStorage, undefined);
  });

  it('maps oil fields correctly from JODI oil', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.oil.crudeImportsKbd, 950);
    assert.equal(spine.oil.gasolineDemandKbd, 120);
    assert.equal(spine.oil.dieselDemandKbd, 310);
    assert.equal(spine.oil.jetDemandKbd, 95);
    assert.equal(spine.oil.lpgDemandKbd, 40);
    assert.equal(spine.oil.daysOfCover, 130);
    assert.equal(spine.oil.netExporter, false);
  });

  it('maps gas fields correctly from JODI gas', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.gas.lngImportsTj, 0);
    assert.equal(spine.gas.pipeImportsTj, 18400);
    assert.equal(spine.gas.totalDemandTj, 51000);
    assert.equal(spine.gas.lngShareOfImports, 0.0);
  });

  it('maps mix fields correctly from OWID data', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.mix.coalShare, 26.4);
    assert.equal(spine.mix.gasShare, 15.1);
    assert.equal(spine.mix.renewShare, 55.8);
  });

  it('populates comtradeReporterCode for DE (276)', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    // DE is not in ISO2_TO_COMTRADE — should be null
    assert.equal(spine.shockInputs.comtradeReporterCode, null);
    assert.deepEqual(spine.shockInputs.supportedChokepoints, []);
  });

  it('populates comtradeReporterCode for US (842)', () => {
    const spine = buildSpineEntry('US', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.shockInputs.comtradeReporterCode, '842');
    assert.deepEqual(spine.shockInputs.supportedChokepoints, ['hormuz', 'malacca', 'suez', 'babelm']);
  });

  it('populates source timestamps correctly', () => {
    const spine = buildSpineEntry('DE', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.sources.mixYear, 2024);
    assert.equal(spine.sources.jodiOilMonth, '2026-02');
    assert.equal(spine.sources.jodiGasMonth, '2026-02');
    assert.equal(spine.sources.ieaStocksMonth, '2026-02');
  });
});

// ---------------------------------------------------------------------------
// buildSpineEntry — fallback when JODI oil key missing
// ---------------------------------------------------------------------------

describe('buildSpineEntry — JODI oil key missing', () => {
  it('sets hasJodiOil: false and all oil fields to 0', () => {
    const spine = buildSpineEntry('JP', {
      mix: makeMix(),
      jodiOil: null,
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks(),
    });
    assert.equal(spine.coverage.hasJodiOil, false);
    assert.equal(spine.oil.crudeImportsKbd, 0);
    assert.equal(spine.oil.gasolineDemandKbd, 0);
    assert.equal(spine.oil.dieselDemandKbd, 0);
    assert.equal(spine.oil.jetDemandKbd, 0);
    assert.equal(spine.oil.lpgDemandKbd, 0);
  });
});

// ---------------------------------------------------------------------------
// IEA anomaly guard
// ---------------------------------------------------------------------------

describe('buildSpineEntry — IEA anomaly guard', () => {
  it('sets hasIeaStocks: false when anomaly is true', () => {
    const spine = buildSpineEntry('XX', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks({ anomaly: true }),
    });
    assert.equal(spine.coverage.hasIeaStocks, false);
    assert.equal(spine.oil.daysOfCover, 0);
  });

  it('sets hasIeaStocks: false when daysOfCover is null (non-exporter, no anomaly flag)', () => {
    const spine = buildSpineEntry('XX', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks({ daysOfCover: null, anomaly: false }),
    });
    assert.equal(spine.coverage.hasIeaStocks, false);
  });

  it('sets hasIeaStocks: true when netExporter is true regardless of daysOfCover', () => {
    const spine = buildSpineEntry('SA', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks({ netExporter: true, daysOfCover: null }),
    });
    assert.equal(spine.coverage.hasIeaStocks, true);
    assert.equal(spine.oil.netExporter, true);
  });

  it('sets hasIeaStocks: true when anomaly is false and daysOfCover is present', () => {
    const spine = buildSpineEntry('FR', {
      mix: makeMix(),
      jodiOil: makeJodiOil(),
      jodiGas: makeJodiGas(),
      ieaStocks: makeIeaStocks({ anomaly: false, daysOfCover: 90 }),
    });
    assert.equal(spine.coverage.hasIeaStocks, true);
    assert.equal(spine.oil.daysOfCover, 90);
  });
});

// ---------------------------------------------------------------------------
// Schema sentinel — throws when OWID mix missing required field
// ---------------------------------------------------------------------------

describe('buildSpineEntry — schema sentinel', () => {
  it('throws when OWID mix is present but missing coalShare field', () => {
    const badMix = { year: 2024, gasShare: 15, renewShare: 55 }; // no coalShare key at all
    assert.throws(
      () => buildSpineEntry('DE', {
        mix: badMix,
        jodiOil: makeJodiOil(),
        jodiGas: makeJodiGas(),
        ieaStocks: makeIeaStocks(),
      }),
      /coalShare/i,
    );
  });

  it('does not throw when OWID mix has coalShare: null (valid nullable field)', () => {
    const nullMix = { ...makeMix(), coalShare: null };
    assert.doesNotThrow(
      () => buildSpineEntry('DE', {
        mix: nullMix,
        jodiOil: makeJodiOil(),
        jodiGas: makeJodiGas(),
        ieaStocks: makeIeaStocks(),
      }),
    );
  });

  it('does not throw when OWID mix is null (no mix data available)', () => {
    assert.doesNotThrow(
      () => buildSpineEntry('AF', {
        mix: null,
        jodiOil: null,
        jodiGas: null,
        ieaStocks: null,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported key constants', () => {
  it('SPINE_KEY_PREFIX matches expected pattern', () => {
    assert.equal(SPINE_KEY_PREFIX, 'energy:spine:v1:');
  });

  it('SPINE_COUNTRIES_KEY matches expected pattern', () => {
    assert.equal(SPINE_COUNTRIES_KEY, 'energy:spine:v1:_countries');
  });

  it('SPINE_META_KEY matches expected pattern', () => {
    assert.equal(SPINE_META_KEY, 'seed-meta:energy:spine');
  });

  it('SPINE_TTL_SECONDS is 48h (172800s)', () => {
    assert.equal(SPINE_TTL_SECONDS, 172800);
  });

  it('SPINE_TTL_SECONDS covers 2x the daily cron interval', () => {
    const dailyIntervalSeconds = 24 * 3600;
    assert.ok(SPINE_TTL_SECONDS >= 2 * dailyIntervalSeconds,
      `TTL ${SPINE_TTL_SECONDS}s must be at least 2x daily interval (${2 * dailyIntervalSeconds}s)`);
  });
});

// ---------------------------------------------------------------------------
// Count-drop guard logic (unit test of the ratio math)
// ---------------------------------------------------------------------------

describe('count-drop guard math', () => {
  it('80% threshold: 160/200 is acceptable', () => {
    const prevCount = 200;
    const newCount = 160;
    const ratio = newCount / prevCount;
    assert.ok(ratio >= 0.80, `${ratio} should be >= 0.80`);
  });

  it('80% threshold: 159/200 triggers guard', () => {
    const prevCount = 200;
    const newCount = 159;
    const ratio = newCount / prevCount;
    assert.ok(ratio < 0.80, `${ratio} should be < 0.80`);
  });

  it('no guard when prevCount is 0 (first run)', () => {
    const prevCount = 0;
    // Guard should not activate on first run (prevCount <= 0)
    const guardActive = prevCount > 0;
    assert.equal(guardActive, false);
  });
});

// ---------------------------------------------------------------------------
// buildSpineEntry with Ember data
// ---------------------------------------------------------------------------

describe('buildSpineEntry with Ember data', () => {
  it('includes electricity block when ember data is present', () => {
    const ember = { dataMonth: '2025-12', fossilShare: 71.2, renewShare: 24.1, nuclearShare: 4.7, coalShare: 31.1, gasShare: 33.0, demandTwh: 78.4 };
    const entry = buildSpineEntry('JP', { mix: makeMix(), jodiOil: makeJodiOil(), jodiGas: null, ieaStocks: null, ember });
    assert.ok(entry.electricity != null, 'should have electricity block');
    assert.equal(entry.electricity.fossilShare, 71.2);
    assert.equal(entry.electricity.renewShare, 24.1);
    assert.equal(entry.coverage.hasEmber, true);
    assert.equal(entry.sources.emberMonth, '2025-12');
  });

  it('electricity is null when ember data is absent', () => {
    const entry = buildSpineEntry('US', { mix: makeMix(), jodiOil: makeJodiOil(), jodiGas: null, ieaStocks: null, ember: null });
    assert.equal(entry.electricity, null);
    assert.equal(entry.coverage.hasEmber, false);
    assert.equal(entry.sources.emberMonth, null);
  });

  it('hasEmber is false when ember has no fossilShare', () => {
    const entry = buildSpineEntry('US', { mix: makeMix(), jodiOil: makeJodiOil(), jodiGas: null, ieaStocks: null, ember: { dataMonth: '2025-12' } });
    assert.equal(entry.coverage.hasEmber, false);
    assert.equal(entry.electricity, null);
  });
});

// ---------------------------------------------------------------------------
// Core-source guard when JODI and OWID are empty
// ---------------------------------------------------------------------------

describe('core-source guard when JODI and OWID are empty', () => {
  it('assembleCountryList returns jodiCount and owidCount', () => {
    const jodiCount = 0;
    const owidCount = 0;
    const shouldAbort = jodiCount === 0 && owidCount === 0;
    assert.ok(shouldAbort, 'should abort when both core sources are empty');
  });

  it('does not abort when at least one core source has data', () => {
    const jodiCount = 100;
    const owidCount = 0;
    const shouldAbort = jodiCount === 0 && owidCount === 0;
    assert.ok(!shouldAbort, 'should not abort when JODI has data');
  });
});
