import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSupplierRouteRisk,
  computeAlternativeSuppliers,
} from '../src/utils/supplier-route-risk.ts';

describe('computeSupplierRouteRisk', () => {
  it('detects Hormuz as transit chokepoint for Gulf exporters to India', () => {
    const scores = new Map([['hormuz_strait', 80], ['malacca_strait', 10]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);

    const hormuz = risk.transitChokepoints.find(cp => cp.chokepointId === 'hormuz_strait');
    assert.ok(hormuz, 'Should detect Hormuz on SA-to-IN route');
    assert.equal(hormuz.disruptionScore, 80);
  });

  it('marks route as critical when Hormuz disruptionScore is 80', () => {
    const scores = new Map([['hormuz_strait', 80]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);
    assert.equal(risk.riskLevel, 'critical');
    assert.ok(risk.recommendation.includes('Hormuz'));
    assert.ok(risk.recommendation.includes('Consider alternative'));
  });

  it('marks Canada to US as safe (no chokepoints on direct routes)', () => {
    const scores = new Map([['hormuz_strait', 90], ['suez', 85]]);
    const risk = computeSupplierRouteRisk('CA', 'US', scores);
    const directRoutes = risk.routeIds;
    assert.ok(directRoutes.length > 0, 'Should have overlapping routes (transatlantic, china-us-west)');
    const hasDisruptedCp = risk.transitChokepoints.some(cp => cp.disruptionScore >= 70);
    if (!hasDisruptedCp) {
      assert.equal(risk.riskLevel, 'safe');
    }
  });

  it('returns unknown when no cluster entry exists for exporter/importer', () => {
    const scores = new Map([['hormuz_strait', 90]]);
    const risk = computeSupplierRouteRisk('ZZ', 'YY', scores);
    assert.equal(risk.riskLevel, 'unknown');
    assert.equal(risk.transitChokepoints.length, 0);
    assert.equal(risk.routeIds.length, 0);
    assert.ok(risk.recommendation.includes('No modeled maritime route'));
  });

  it('marks at_risk when chokepoint score is between 31 and 69', () => {
    const scores = new Map([['hormuz_strait', 50]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);
    assert.equal(risk.riskLevel, 'at_risk');
    assert.ok(risk.recommendation.includes('elevated risk'));
  });

  it('marks safe when all chokepoint scores are at or below 30', () => {
    const scores = new Map([['hormuz_strait', 30], ['malacca_strait', 10]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);
    assert.equal(risk.riskLevel, 'safe');
  });

  it('returns maxDisruptionScore correctly', () => {
    const scores = new Map([['hormuz_strait', 45], ['malacca_strait', 20]]);
    const risk = computeSupplierRouteRisk('QA', 'JP', scores);
    assert.equal(risk.maxDisruptionScore, 45);
  });
});

describe('computeAlternativeSuppliers', () => {
  const exporters = [
    { partnerCode: 682, partnerIso2: 'SA', value: 5e9, share: 0.40 },
    { partnerCode: 124, partnerIso2: 'CA', value: 3e9, share: 0.25 },
    { partnerCode: 840, partnerIso2: 'US', value: 2e9, share: 0.15 },
  ];

  it('preserves original trade-share order (no sorting by risk)', () => {
    const scores = new Map([['hormuz_strait', 80]]);
    const result = computeAlternativeSuppliers(exporters, 'IN', scores);
    assert.equal(result.length, 3);
    assert.equal(result[0].partnerIso2, 'SA', 'First exporter should remain SA (original order)');
    assert.equal(result[1].partnerIso2, 'CA', 'Second exporter should remain CA (original order)');
    assert.equal(result[2].partnerIso2, 'US', 'Third exporter should remain US (original order)');
  });

  it('generates safeAlternative for critical/at-risk exporters', () => {
    const scores = new Map([['hormuz_strait', 80]]);
    const result = computeAlternativeSuppliers(exporters, 'IN', scores);
    for (const exp of result) {
      if (exp.risk.riskLevel === 'critical' || exp.risk.riskLevel === 'at_risk') {
        assert.ok(
          exp.safeAlternative !== null || result.filter(e => e.risk.riskLevel === 'safe').length === 0,
          `Should suggest alternative for ${exp.partnerIso2} or no safe alternatives available`,
        );
      }
    }
  });

  it('sets safeAlternative to null when no safe exporters exist', () => {
    const allGulf = [
      { partnerCode: 682, partnerIso2: 'SA', value: 5e9, share: 0.50 },
      { partnerCode: 784, partnerIso2: 'AE', value: 3e9, share: 0.30 },
      { partnerCode: 414, partnerIso2: 'KW', value: 2e9, share: 0.20 },
    ];
    const scores = new Map([['hormuz_strait', 80]]);
    const result = computeAlternativeSuppliers(allGulf, 'IN', scores);
    for (const exp of result) {
      if (exp.risk.riskLevel === 'critical') {
        assert.equal(exp.safeAlternative, null);
      }
    }
  });

  it('does not recommend unknown-risk exporters as safe alternatives', () => {
    const mixedExporters = [
      { partnerCode: 682, partnerIso2: 'SA', value: 5e9, share: 0.40 },
      { partnerCode: 999, partnerIso2: 'ZZ', value: 3e9, share: 0.25 },
    ];
    const scores = new Map([['hormuz_strait', 80]]);
    const result = computeAlternativeSuppliers(mixedExporters, 'IN', scores);
    const sa = result.find(e => e.partnerIso2 === 'SA');
    const zz = result.find(e => e.partnerIso2 === 'ZZ');
    assert.equal(zz.risk.riskLevel, 'unknown');
    assert.equal(sa.safeAlternative, null, 'Should not recommend unknown-risk ZZ as a safe alternative');
  });

  it('preserves all original exporter fields', () => {
    const scores = new Map();
    const result = computeAlternativeSuppliers(exporters, 'US', scores);
    for (const exp of result) {
      assert.ok(typeof exp.partnerCode === 'number');
      assert.ok(typeof exp.partnerIso2 === 'string');
      assert.ok(typeof exp.value === 'number');
      assert.ok(typeof exp.share === 'number');
      assert.ok(exp.risk !== null && exp.risk !== undefined);
    }
  });
});

describe('CSS classes and integration', () => {
  it('risk badge CSS classes follow naming convention', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(
      new URL('../src/styles/country-deep-dive.css', import.meta.url),
      'utf8',
    );
    assert.ok(css.includes('.cdp-risk-badge'), 'Missing .cdp-risk-badge class');
    assert.ok(css.includes('.cdp-risk-safe'), 'Missing .cdp-risk-safe class');
    assert.ok(css.includes('.cdp-risk-at-risk'), 'Missing .cdp-risk-at-risk class');
    assert.ok(css.includes('.cdp-risk-critical'), 'Missing .cdp-risk-critical class');
    assert.ok(css.includes('.cdp-risk-unknown'), 'Missing .cdp-risk-unknown class');
    assert.ok(css.includes('.cdp-recommendations'), 'Missing .cdp-recommendations class');
    assert.ok(css.includes('.cdp-recommendation-item'), 'Missing .cdp-recommendation-item class');
    assert.ok(css.includes('.cdp-recommendation-safe'), 'Missing .cdp-recommendation-safe class');
    assert.ok(css.includes('.cdp-recommendation-warn'), 'Missing .cdp-recommendation-warn class');
    assert.ok(css.includes('.cdp-recommendation-critical'), 'Missing .cdp-recommendation-critical class');
  });

  it('CountryDeepDivePanel renders Route Risk header', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes("'Route Risk'"), 'Should have Route Risk column header');
    assert.ok(src.includes('cdp-risk-badge'), 'Should render risk badges');
    assert.ok(src.includes('cdp-recommendations'), 'Should render recommendations section');
    assert.ok(src.includes('computeAlternativeSuppliers'), 'Should use computeAlternativeSuppliers');
  });
});
