// Contract test for the registry-driven per-indicator extraction plan
// used by scripts/compare-resilience-current-vs-proposed.mjs. Pins two
// acceptance-apparatus invariants:
//
//   1. Every indicator in INDICATOR_REGISTRY has a corresponding
//      EXTRACTION_RULES row (implemented OR not-implemented with a
//      reason). No silent omissions.
//   2. All six repair-plan construct-risk indicators (energy mix +
//      electricity consumption + energy import dependency + WGI
//      sub-pillars + recovery fiscal indicators) are 'implemented'
//      in the harness, so PR 1 / PR 3 / PR 4 can measure
//      pre-vs-post effective-influence against their baselines.

import test from 'node:test';
import assert from 'node:assert/strict';

const scriptMod = await import('../scripts/compare-resilience-current-vs-proposed.mjs');
const registryMod = await import('../server/worldmonitor/resilience/v1/_indicator-registry.ts');

const { buildIndicatorExtractionPlan, applyExtractionRule, EXTRACTION_RULES } = scriptMod;
const { INDICATOR_REGISTRY } = registryMod;

test('every INDICATOR_REGISTRY entry has an EXTRACTION_RULES row', () => {
  const missing = INDICATOR_REGISTRY.filter((spec) => !(spec.id in EXTRACTION_RULES));
  assert.deepEqual(
    missing.map((s) => s.id),
    [],
    'new indicator(s) added to INDICATOR_REGISTRY without adding an EXTRACTION_RULES entry; ' +
      'add an extractor or an explicit { type: "not-implemented", reason }',
  );
});

test('extraction plan row exists for every registry entry', () => {
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  assert.equal(plan.length, INDICATOR_REGISTRY.length);
  for (const entry of plan) {
    assert.ok(['implemented', 'not-implemented', 'unregistered-in-harness'].includes(entry.extractionStatus));
  }
});

test('"not-implemented" rows carry a reason string', () => {
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  for (const entry of plan) {
    if (entry.extractionStatus === 'not-implemented') {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.length > 0,
        `indicator ${entry.indicator} marked not-implemented but has no reason`,
      );
    }
  }
});

test('all construct-risk indicators flagged by the repair plan are implemented', () => {
  // The repair plan §3.1–§3.2, §4.3, §4.4 specifically names these
  // indicators as the ones whose effective influence must be
  // measurable pre- and post-change. If any becomes 'not-implemented',
  // the acceptance apparatus for that PR evaporates. IDs match
  // INDICATOR_REGISTRY exactly — the registry renames macroFiscal
  // fiscal-space sub-indicators with a `recovery*` prefix when they
  // live in the fiscalSpace dimension.
  const mustBeImplemented = [
    'gasShare',
    'coalShare',
    'renewShare',
    'electricityConsumption',
    'energyImportDependency',
    'govRevenuePct',
    'recoveryGovRevenue',
    'recoveryFiscalBalance',
    'recoveryDebtToGdp',
    'recoveryReserveMonths',
    'recoveryDebtToReserves',
    'recoveryImportHhi',
  ];
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const byId = Object.fromEntries(plan.map((p) => [p.indicator, p]));
  for (const id of mustBeImplemented) {
    assert.ok(byId[id], `construct-risk indicator ${id} is not in the extraction plan`);
    assert.equal(
      byId[id].extractionStatus,
      'implemented',
      `construct-risk indicator ${id} must be extractable; got "${byId[id].extractionStatus}": ${byId[id].reason ?? ''}`,
    );
  }
});

test('core-tier indicator coverage meets a minimum floor', () => {
  // Drives the extractionCoverage summary in the output. Floor raised
  // after wiring the exported scorer-aggregate helpers (summarizeCyber,
  // summarizeOutages, summarizeGps, summarizeUcdp, summarizeUnrest,
  // getThreatSummaryScore, getCountryDisplacement, countTradeRestrictions,
  // countTradeBarriers). The only Core-tier indicators still unextracted
  // are those whose scorer inputs are genuinely global scalars
  // (shippingStress, transitDisruption, energyPriceStress) or require
  // unexported time-series helpers (fxVolatility, fxDeviation,
  // aquastatWaterAvailability, householdDebtService, etc.).
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const coreTotal = plan.filter((p) => p.tier === 'core').length;
  const coreImplemented = plan.filter((p) => p.tier === 'core' && p.extractionStatus === 'implemented').length;
  assert.ok(
    coreImplemented / coreTotal >= 0.80,
    `core-tier extraction coverage fell below 80%: ${coreImplemented}/${coreTotal}`,
  );
});

test('the three "no per-country variance" indicators stay not-implemented with correct reason', () => {
  // shippingStress / transitDisruption / energyPriceStress are
  // scorer-level GLOBAL scalars — Pearson(global, overall) is 0 or
  // NaN by construction. They must NOT be marked implemented: any
  // future implementation that appears to extract them is wrong
  // unless it re-expresses them as per-country effective contribution.
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const byId = Object.fromEntries(plan.map((p) => [p.indicator, p]));
  for (const id of ['shippingStress', 'transitDisruption', 'energyPriceStress']) {
    assert.equal(byId[id]?.extractionStatus, 'not-implemented', `${id} should stay not-implemented (no per-country variance)`);
    assert.match(byId[id].reason, /no per-country variance|global/i);
  }
});

test('applyExtractionRule — static-path navigates nested object fields', () => {
  const rule = { type: 'static-path', path: ['iea', 'energyImportDependency', 'value'] };
  const sources = { staticRecord: { iea: { energyImportDependency: { value: 42 } } } };
  assert.equal(applyExtractionRule(rule, sources, 'AE'), 42);
});

test('applyExtractionRule — recovery-country-field uses .countries[iso2].<field>', () => {
  const rule = { type: 'recovery-country-field', key: 'resilience:recovery:fiscal-space:v1', field: 'govRevenuePct' };
  const sources = { fiscalSpace: { countries: { AE: { govRevenuePct: 30 } } } };
  assert.equal(applyExtractionRule(rule, sources, 'AE'), 30);
});

test('applyExtractionRule — static-wgi reads .wgi.indicators[code].value', () => {
  // WGI keys are World-Bank standard codes (VA.EST, PV.EST, etc.)
  const rule = { type: 'static-wgi', code: 'RL.EST' };
  const sources = { staticRecord: { wgi: { indicators: { 'RL.EST': { value: 1.2 } } } } };
  assert.equal(applyExtractionRule(rule, sources, 'DE'), 1.2);
});

test('applyExtractionRule — static-wgi-mean averages all six WGI sub-pillars', () => {
  const rule = { type: 'static-wgi-mean' };
  const sources = { staticRecord: { wgi: { indicators: {
    'VA.EST': { value: 1.0 },
    'PV.EST': { value: -1.0 },
    'GE.EST': { value: 0.5 },
    'RQ.EST': { value: -0.5 },
    'RL.EST': { value: 2.0 },
    'CC.EST': { value: 0.0 },
  } } } };
  assert.equal(applyExtractionRule(rule, sources, 'DE'), (1.0 + -1.0 + 0.5 + -0.5 + 2.0 + 0.0) / 6);
});

test('applyExtractionRule — missing values return null (pairwise-drop contract)', () => {
  const rule = { type: 'static-path', path: ['iea', 'energyImportDependency', 'value'] };
  assert.equal(applyExtractionRule(rule, {}, 'AE'), null);
  assert.equal(applyExtractionRule(rule, { staticRecord: null }, 'AE'), null);
  assert.equal(applyExtractionRule(rule, { staticRecord: { iea: null } }, 'AE'), null);
});

test('applyExtractionRule — not-implemented rules short-circuit to null', () => {
  const rule = { type: 'not-implemented', reason: 'test' };
  assert.equal(applyExtractionRule(rule, {}, 'AE'), null);
});

test('applyExtractionRule — summarize-cyber wires through exported scorer helper', () => {
  const rule = { type: 'summarize-cyber' };
  const cyber = { threats: [{ country: 'AE', severity: 'CRITICALITY_LEVEL_CRITICAL' }] };
  // Pass a stub helper to prove the rule dispatches through it.
  const helpers = {
    summarizeCyber: (raw, cc) => ({
      weightedCount: raw.threats.filter((t) => t.country === cc).length * 3,
    }),
  };
  assert.equal(applyExtractionRule(rule, { cyber }, 'AE', helpers), 3);
  // Without the helper available, rule falls back to null.
  assert.equal(applyExtractionRule(rule, { cyber }, 'AE', {}), null);
});

test('applyExtractionRule — summarize-outages-penalty computes 4/2/1 weighting', () => {
  const rule = { type: 'summarize-outages-penalty' };
  const outages = { outages: [] };
  const helpers = {
    summarizeOutages: () => ({ total: 1, major: 2, partial: 3 }),
  };
  // penalty = 1*4 + 2*2 + 3*1 = 11
  assert.equal(applyExtractionRule(rule, { outages }, 'AE', helpers), 11);
});

test('applyExtractionRule — displacement-field reads per-country entry by field name', () => {
  const rule = { type: 'displacement-field', field: 'totalDisplaced' };
  const displacement = {};
  const helpers = {
    getCountryDisplacement: () => ({ totalDisplaced: 12345, hostTotal: 678 }),
  };
  assert.equal(applyExtractionRule(rule, { displacement }, 'SY', helpers), 12345);
});

test('applyExtractionRule — count-trade-restrictions uses scorer-exported counter', () => {
  const rule = { type: 'count-trade-restrictions' };
  const tradeRestrictions = { restrictions: [] };
  const helpers = { countTradeRestrictions: () => 5 };
  assert.equal(applyExtractionRule(rule, { tradeRestrictions }, 'AE', helpers), 5);
  // Zero coerces to null (pairwise-drop contract for empty signals).
  assert.equal(applyExtractionRule(rule, { tradeRestrictions }, 'AE', { countTradeRestrictions: () => 0 }), null);
});

test('applyExtractionRule — imported-fossil-dependence recomputes the scorer composite', () => {
  // PR 1 §3.2: the scorer computes
  //   importedFossilDependence = fossilElectricityShare × max(netImports, 0) / 100
  // Extractor MUST recompute the same composite, otherwise gate-9's
  // effective-influence measurement for this indicator is wrong for
  // every net-exporter (composite collapses to 0) and under-reports
  // every net-importer (modulated by netImports).
  const rule = { type: 'imported-fossil-dependence-composite' };

  // Net importer: fossilShare 80% × max(60, 0) / 100 = 48
  const netImporter = {
    staticRecord: { iea: { energyImportDependency: { value: 60 } } },
    bulkV1: {
      'resilience:fossil-electricity-share:v1': { countries: { AE: { value: 80 } } },
    },
  };
  assert.equal(applyExtractionRule(rule, netImporter, 'AE'), 48);

  // Net exporter: max(-40, 0) = 0 → composite = 0 regardless of fossilShare
  const netExporter = {
    staticRecord: { iea: { energyImportDependency: { value: -40 } } },
    bulkV1: {
      'resilience:fossil-electricity-share:v1': { countries: { NO: { value: 90 } } },
    },
  };
  assert.equal(applyExtractionRule(rule, netExporter, 'NO'), 0);

  // Missing either input → null
  assert.equal(applyExtractionRule(rule, { staticRecord: null, bulkV1: {} }, 'XX'), null);
  assert.equal(applyExtractionRule(rule, {
    staticRecord: { iea: { energyImportDependency: { value: 50 } } },
    bulkV1: { 'resilience:fossil-electricity-share:v1': { countries: {} } },
  }, 'XX'), null);
});

test('applyExtractionRule — aquastat stress vs availability gated by indicator tag', () => {
  // Mirror scoreAquastatValue in _dimension-scorers.ts: both indicators
  // share .aquastat.value, but the .aquastat.indicator tag classifies
  // which family the reading belongs to. A stress-family country must
  // NOT contribute a reading to the availability extractor, and vice
  // versa, otherwise the Pearson correlation mixes two different
  // construct scales.
  const stressRule = { type: 'static-aquastat-stress' };
  const availabilityRule = { type: 'static-aquastat-availability' };

  const stressCountry = { staticRecord: { aquastat: { value: 42, indicator: 'Water stress (withdrawal/availability)' } } };
  const availabilityCountry = { staticRecord: { aquastat: { value: 1500, indicator: 'Renewable water availability per capita' } } };
  const unknownCountry = { staticRecord: { aquastat: { value: 99, indicator: 'Some unrecognised tag' } } };
  const missingCountry = { staticRecord: { aquastat: { value: null, indicator: 'stress' } } };

  // Stress-tagged country: only the stress extractor returns the value.
  assert.equal(applyExtractionRule(stressRule, stressCountry, 'AE'), 42);
  assert.equal(applyExtractionRule(availabilityRule, stressCountry, 'AE'), null);

  // Availability-tagged country: only the availability extractor returns.
  assert.equal(applyExtractionRule(availabilityRule, availabilityCountry, 'DE'), 1500);
  assert.equal(applyExtractionRule(stressRule, availabilityCountry, 'DE'), null);

  // Unknown tag: neither extractor returns (pairwise-drop).
  assert.equal(applyExtractionRule(stressRule, unknownCountry, 'XX'), null);
  assert.equal(applyExtractionRule(availabilityRule, unknownCountry, 'XX'), null);

  // Missing value: null regardless of tag.
  assert.equal(applyExtractionRule(stressRule, missingCountry, 'XX'), null);
});
