import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCKED_PREVIEW,
  collectDimensionConfidences,
  formatBaselineStress,
  formatDimensionConfidence,
  formatResilienceChange30d,
  formatResilienceConfidence,
  formatResilienceDataVersion,
  getImputationClassIcon,
  getImputationClassLabel,
  getResilienceDimensionLabel,
  getResilienceDomainLabel,
  getResilienceTrendArrow,
  getResilienceVisualLevel,
  getStalenessLabel,
} from '../src/components/resilience-widget-utils';
import type { ResilienceScoreResponse } from '../src/services/resilience';

const baseResponse: ResilienceScoreResponse = {
  countryCode: 'US',
  overallScore: 73,
  baselineScore: 82,
  stressScore: 58,
  stressFactor: 0.21,
  level: 'high',
  domains: [
    { id: 'economic', score: 80, weight: 0.22, dimensions: [
      { id: 'macroFiscal', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 },
    ] },
  ],
  trend: 'rising',
  change30d: 2.4,
  lowConfidence: false,
  imputationShare: 0,
  dataVersion: '2026-04-03',
};

test('getResilienceVisualLevel maps the score thresholds from the widget spec', () => {
  assert.equal(getResilienceVisualLevel(80), 'very_high');
  assert.equal(getResilienceVisualLevel(79), 'high');
  assert.equal(getResilienceVisualLevel(60), 'high');
  assert.equal(getResilienceVisualLevel(59), 'moderate');
  assert.equal(getResilienceVisualLevel(20), 'low');
  assert.equal(getResilienceVisualLevel(19), 'very_low');
  assert.equal(getResilienceVisualLevel(Number.NaN), 'unknown');
});

test('getResilienceTrendArrow renders the expected glyphs', () => {
  assert.equal(getResilienceTrendArrow('rising'), '↑');
  assert.equal(getResilienceTrendArrow('falling'), '↓');
  assert.equal(getResilienceTrendArrow('stable'), '→');
  assert.equal(getResilienceTrendArrow('unknown'), '→');
});

test('getResilienceDomainLabel keeps the deep-dive shorthand labels stable', () => {
  assert.equal(getResilienceDomainLabel('economic'), 'Economic');
  assert.equal(getResilienceDomainLabel('infrastructure'), 'Infra & Supply');
  assert.equal(getResilienceDomainLabel('social-governance'), 'Social & Gov');
  assert.equal(getResilienceDomainLabel('health-food'), 'Health & Food');
  assert.equal(getResilienceDomainLabel('custom-domain'), 'custom-domain');
});

test('formatResilienceConfidence shows sparse-data copy when low confidence is set', () => {
  assert.equal(formatResilienceConfidence(baseResponse), 'Coverage 90% ✓');
  assert.equal(
    formatResilienceConfidence({ ...baseResponse, lowConfidence: true }),
    'Low confidence — sparse data',
  );
});

test('formatResilienceChange30d preserves explicit sign formatting', () => {
  assert.equal(formatResilienceChange30d(2.41), '30d +2.4');
  assert.equal(formatResilienceChange30d(-1.26), '30d -1.3');
  assert.equal(formatResilienceChange30d(0), '30d 0.0');
});

test('formatBaselineStress renders the expected breakdown string (no Impact)', () => {
  assert.equal(formatBaselineStress(72.1, 58.3), 'Baseline: 72 | Stress: 58');
  assert.equal(formatBaselineStress(80, 100), 'Baseline: 80 | Stress: 100');
  assert.equal(formatBaselineStress(50, 0), 'Baseline: 50 | Stress: 0');
  assert.equal(formatBaselineStress(NaN, 50), 'Baseline: 0 | Stress: 50');
});

// T1.4 Phase 1 of the country-resilience reference-grade upgrade plan.
// dataVersion is sourced from the Railway static-seed job's seed-meta key
// (fetchedAt → ISO date in _shared.ts buildResilienceScore). The widget
// renders a footer label so analysts can see how fresh the underlying
// source data is; a missing or malformed dataVersion returns an empty
// string so the caller skips rendering rather than showing a dangling label.
test('formatResilienceDataVersion renders a label for a valid ISO date', () => {
  assert.equal(formatResilienceDataVersion('2026-04-11'), 'Data 2026-04-11');
  assert.equal(formatResilienceDataVersion('2024-01-01'), 'Data 2024-01-01');
});

test('formatResilienceDataVersion returns empty for missing or malformed dataVersion', () => {
  assert.equal(formatResilienceDataVersion(''), '');
  assert.equal(formatResilienceDataVersion(null), '');
  assert.equal(formatResilienceDataVersion(undefined), '');
  // Guard against partially-formatted or non-ISO strings that the fallback
  // path in _shared.ts should never emit but downstream code should still
  // reject defensively:
  assert.equal(formatResilienceDataVersion('2026-04'), '');
  assert.equal(formatResilienceDataVersion('04/11/2026'), '');
  assert.equal(formatResilienceDataVersion('not-a-date'), '');
});

test('formatResilienceDataVersion rejects regex-valid but calendar-invalid dates (PR #2943 review)', () => {
  // Regex `/^\d{4}-\d{2}-\d{2}$/` accepts these strings but they are not
  // real calendar dates. A stale or corrupted Redis key could emit one,
  // and without the round-trip check the widget would render it unchecked.
  assert.equal(formatResilienceDataVersion('9999-99-99'), '');
  assert.equal(formatResilienceDataVersion('2024-13-45'), '');
  assert.equal(formatResilienceDataVersion('2024-00-15'), '');
  // February 30th parses as a real Date in JS but not the same string
  // when round-tripped through toISOString; the round-trip check catches
  // this slip, so `2024-02-30` silently rolling to `2024-03-01` is rejected.
  assert.equal(formatResilienceDataVersion('2024-02-30'), '');
  assert.equal(formatResilienceDataVersion('2024-02-31'), '');
  // Legitimate calendar dates still pass.
  assert.equal(formatResilienceDataVersion('2024-02-29'), 'Data 2024-02-29'); // leap year
  assert.equal(formatResilienceDataVersion('2023-02-28'), 'Data 2023-02-28');
});

test('baseResponse includes dataVersion (regression for T1.4 wiring)', () => {
  // Guards against a future change that accidentally drops the dataVersion
  // field from the service response shape. The scorer writes it from the
  // seed-meta key; the widget footer renders it via formatResilienceDataVersion.
  assert.equal(typeof baseResponse.dataVersion, 'string');
  assert.ok(baseResponse.dataVersion.length > 0, 'baseResponse should carry a non-empty dataVersion for regression coverage');
  assert.equal(formatResilienceDataVersion(baseResponse.dataVersion), `Data ${baseResponse.dataVersion}`);
});

// T1.6 Phase 1 of the country-resilience reference-grade upgrade plan.
// Per-dimension confidence helpers. The widget renders a compact
// coverage grid below the 5-domain rows using these helpers; each
// scorer dimension must have a stable display label and a consistent
// status classification.

test('getResilienceDimensionLabel returns short stable labels for all 19 dimensions', () => {
  assert.equal(getResilienceDimensionLabel('macroFiscal'), 'Macro');
  assert.equal(getResilienceDimensionLabel('currencyExternal'), 'Currency');
  assert.equal(getResilienceDimensionLabel('tradeSanctions'), 'Trade');
  assert.equal(getResilienceDimensionLabel('cyberDigital'), 'Cyber');
  assert.equal(getResilienceDimensionLabel('logisticsSupply'), 'Logistics');
  assert.equal(getResilienceDimensionLabel('infrastructure'), 'Infra');
  assert.equal(getResilienceDimensionLabel('energy'), 'Energy');
  assert.equal(getResilienceDimensionLabel('governanceInstitutional'), 'Gov');
  assert.equal(getResilienceDimensionLabel('socialCohesion'), 'Social');
  assert.equal(getResilienceDimensionLabel('borderSecurity'), 'Border');
  assert.equal(getResilienceDimensionLabel('informationCognitive'), 'Info');
  assert.equal(getResilienceDimensionLabel('healthPublicService'), 'Health');
  assert.equal(getResilienceDimensionLabel('foodWater'), 'Food');
  assert.equal(getResilienceDimensionLabel('fiscalSpace'), 'Fiscal');
  assert.equal(getResilienceDimensionLabel('reserveAdequacy'), 'Reserves');
  assert.equal(getResilienceDimensionLabel('externalDebtCoverage'), 'Ext Debt');
  assert.equal(getResilienceDimensionLabel('importConcentration'), 'Imports');
  assert.equal(getResilienceDimensionLabel('stateContinuity'), 'Continuity');
  assert.equal(getResilienceDimensionLabel('fuelStockDays'), 'Fuel');
  // Unknown dimension IDs fall through to the raw ID so the render
  // never silently drops a row.
  assert.equal(getResilienceDimensionLabel('unknownDim'), 'unknownDim');
});

test('formatDimensionConfidence classifies observed-heavy dimensions as observed', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 0.9,
    imputedWeight: 0.1,
  });
  assert.equal(result.label, 'Macro');
  assert.equal(result.coveragePct, 90);
  assert.equal(result.status, 'observed');
  assert.equal(result.absent, false);
});

test('formatDimensionConfidence classifies partial dimensions (mixed observed and imputed)', () => {
  const result = formatDimensionConfidence({
    id: 'currencyExternal',
    coverage: 0.55,
    observedWeight: 0.4,
    imputedWeight: 0.6,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.coveragePct, 55);
  assert.equal(result.absent, false);
});

test('formatDimensionConfidence classifies all-imputed dimensions as imputed', () => {
  const result = formatDimensionConfidence({
    id: 'tradeSanctions',
    coverage: 0.3,
    observedWeight: 0,
    imputedWeight: 1,
  });
  assert.equal(result.status, 'imputed');
  assert.equal(result.coveragePct, 30);
  assert.equal(result.absent, false);
});

test('formatDimensionConfidence handles absent dimensions (no data at all)', () => {
  const result = formatDimensionConfidence({
    id: 'borderSecurity',
    coverage: 0,
    observedWeight: 0,
    imputedWeight: 0,
  });
  assert.equal(result.status, 'absent');
  assert.equal(result.coveragePct, 0);
  assert.equal(result.absent, true);
});

test('formatDimensionConfidence clamps out-of-range coverage and guards against NaN', () => {
  // Coverage above 1 is clamped to 100%.
  const high = formatDimensionConfidence({
    id: 'energy',
    coverage: 1.5,
    observedWeight: 1,
    imputedWeight: 0,
  });
  assert.equal(high.coveragePct, 100);

  // Negative coverage is clamped to 0%.
  const negative = formatDimensionConfidence({
    id: 'energy',
    coverage: -0.3,
    observedWeight: 1,
    imputedWeight: 0,
  });
  assert.equal(negative.coveragePct, 0);

  // NaN fields fall through to 0 weight and absent status without throwing.
  const nanResult = formatDimensionConfidence({
    id: 'energy',
    coverage: Number.NaN,
    observedWeight: Number.NaN,
    imputedWeight: Number.NaN,
  });
  assert.equal(nanResult.coveragePct, 0);
  assert.equal(nanResult.status, 'absent');
  assert.equal(nanResult.absent, true);
});

test('collectDimensionConfidences preserves scorer order across domains and dimensions', () => {
  const domains = [
    {
      dimensions: [
        { id: 'macroFiscal', coverage: 0.9, observedWeight: 0.9, imputedWeight: 0.1 },
        { id: 'currencyExternal', coverage: 0.8, observedWeight: 0.75, imputedWeight: 0.25 },
      ],
    },
    {
      dimensions: [
        { id: 'governanceInstitutional', coverage: 0.95, observedWeight: 1.0, imputedWeight: 0 },
      ],
    },
  ];
  const result = collectDimensionConfidences(domains);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'macroFiscal');
  assert.equal(result[1].id, 'currencyExternal');
  assert.equal(result[2].id, 'governanceInstitutional');
  // Labels are resolved for every entry.
  assert.equal(result[0].label, 'Macro');
  assert.equal(result[2].label, 'Gov');
});

test('collectDimensionConfidences returns an empty list for an empty response', () => {
  assert.deepEqual(collectDimensionConfidences([]), []);
  assert.deepEqual(collectDimensionConfidences([{ dimensions: [] }]), []);
});

// PR #2949 review followup: the gated LOCKED_PREVIEW must populate
// the per-dimension confidence grid so locked users see a blurred
// representative card instead of a blank gap between the domain rows
// and the footer. If a future edit accidentally drops a dimension
// from the preview, this regression test fails loudly.
test('LOCKED_PREVIEW populates all 19 dimensions for the gated preview (PR #2949 review)', () => {
  const all = collectDimensionConfidences(LOCKED_PREVIEW.domains);
  assert.equal(all.length, 19, `locked preview should carry all 19 dimensions, got ${all.length}`);
  // Every cell should resolve to a short label (no raw IDs leaking through).
  for (const dim of all) {
    assert.ok(
      dim.label.length > 0 && dim.label !== dim.id,
      `${dim.id} should resolve to a short display label in the preview, got "${dim.label}"`,
    );
  }
  // Every dimension in the preview should have non-absent status so
  // the blurred grid renders a meaningful visual, never a row of empty
  // "n/a" cells.
  for (const dim of all) {
    assert.notEqual(
      dim.status,
      'absent',
      `${dim.id} should not be absent in the locked preview (all fixture values are populated)`,
    );
  }
});

// T1.6 full grid (PR 3 of 5): formatDimensionConfidence must surface
// the new imputationClass and freshness fields from PR 1 / PR 2 as
// typed nulls when unset or unknown, and the label/glyph helpers must
// map every four-class / three-level value without throwing.

test('formatDimensionConfidence normalizes imputationClass=stable-absence', () => {
  const result = formatDimensionConfidence({
    id: 'borderSecurity',
    coverage: 0,
    observedWeight: 0,
    imputedWeight: 1,
    imputationClass: 'stable-absence',
  });
  assert.equal(result.imputationClass, 'stable-absence');
});

test('formatDimensionConfidence coerces empty imputationClass to null', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    imputationClass: '',
  });
  assert.equal(result.imputationClass, null);
});

test('formatDimensionConfidence coerces unknown imputationClass to null (defensive)', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    imputationClass: 'lol-nope',
  });
  assert.equal(result.imputationClass, null);
});

test('formatDimensionConfidence normalizes freshness.staleness=fresh', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    freshness: { staleness: 'fresh', lastObservedAtMs: 1712000000000 },
  });
  assert.equal(result.staleness, 'fresh');
});

test('formatDimensionConfidence coerces empty freshness.staleness to null', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    freshness: { staleness: '', lastObservedAtMs: 1712000000000 },
  });
  assert.equal(result.staleness, null);
});

test('formatDimensionConfidence coerces freshness.lastObservedAtMs string to number', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    freshness: { staleness: 'fresh', lastObservedAtMs: '1712000000000' },
  });
  assert.equal(result.lastObservedAtMs, 1712000000000);
});

test('formatDimensionConfidence treats lastObservedAtMs=0 as null (no data)', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
    freshness: { staleness: 'fresh', lastObservedAtMs: 0 },
  });
  assert.equal(result.lastObservedAtMs, null);
});

test('formatDimensionConfidence handles missing freshness and imputationClass fields', () => {
  const result = formatDimensionConfidence({
    id: 'macroFiscal',
    coverage: 0.9,
    observedWeight: 1,
    imputedWeight: 0,
  });
  assert.equal(result.imputationClass, null);
  assert.equal(result.staleness, null);
  assert.equal(result.lastObservedAtMs, null);
});

test('getImputationClassIcon returns the correct glyph for each class', () => {
  assert.equal(getImputationClassIcon('stable-absence'), '\u2713');
  assert.equal(getImputationClassIcon('unmonitored'), '?');
  assert.equal(getImputationClassIcon('source-failure'), '!');
  assert.equal(getImputationClassIcon('not-applicable'), '\u2014');
  assert.equal(getImputationClassIcon(null), '');
});

test('getImputationClassLabel returns a non-empty string for each class', () => {
  for (const c of ['stable-absence', 'unmonitored', 'source-failure', 'not-applicable'] as const) {
    const label = getImputationClassLabel(c);
    assert.ok(label.length > 0, `${c} should have a tooltip label`);
  }
  // Null still returns a descriptive fallback (never an empty string)
  // so the widget tooltip never breaks assembly.
  assert.ok(getImputationClassLabel(null).length > 0);
});

test('getStalenessLabel returns a non-empty string for each level', () => {
  for (const s of ['fresh', 'aging', 'stale'] as const) {
    const label = getStalenessLabel(s);
    assert.ok(label.length > 0, `${s} should have a tooltip label`);
  }
  assert.ok(getStalenessLabel(null).length > 0);
});

test('LOCKED_PREVIEW smoke: at least one dimension has imputationClass and one has staleness set (PR 3 / T1.6)', () => {
  const all = collectDimensionConfidences(LOCKED_PREVIEW.domains);
  const withClass = all.filter((d) => d.imputationClass != null);
  const withStaleness = all.filter((d) => d.staleness != null);
  assert.ok(
    withClass.length >= 1,
    `locked preview should exercise at least one imputation class, got ${withClass.length}`,
  );
  assert.ok(
    withStaleness.length >= 1,
    `locked preview should exercise at least one staleness level, got ${withStaleness.length}`,
  );
  // Non-fresh staleness should appear at least once so the preview
  // visibly shows off the aging/stale color variants.
  const nonFresh = withStaleness.filter((d) => d.staleness !== 'fresh');
  assert.ok(
    nonFresh.length >= 1,
    `locked preview should exercise at least one non-fresh staleness level, got ${nonFresh.length}`,
  );
});
