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
  // Drives the extractionCoverage summary in the output. The floor is
  // intentionally conservative so adding a new Core-tier indicator
  // without an extractor triggers a failing test instead of silently
  // shrinking influence coverage.
  const plan = buildIndicatorExtractionPlan(INDICATOR_REGISTRY);
  const coreTotal = plan.filter((p) => p.tier === 'core').length;
  const coreImplemented = plan.filter((p) => p.tier === 'core' && p.extractionStatus === 'implemented').length;
  assert.ok(
    coreImplemented / coreTotal >= 0.45,
    `core-tier extraction coverage fell below 45%: ${coreImplemented}/${coreTotal}`,
  );
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
