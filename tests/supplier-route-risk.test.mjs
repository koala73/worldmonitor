import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSupplierRouteRisk,
  computeAlternativeSuppliers,
  chokepointScoreEvidence,
} from '../src/utils/supplier-route-risk.ts';

describe('computeSupplierRouteRisk', () => {
  it('detects Hormuz as transit chokepoint for Gulf exporters to India', () => {
    const scores = new Map([['hormuz_strait', 80], ['malacca_strait', 10]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);

    const hormuz = risk.transitChokepoints.find(cp => cp.chokepointId === 'hormuz_strait');
    assert.ok(hormuz, 'Should detect Hormuz on SA-to-IN route');
    assert.equal(hormuz.disruptionScore, 80);
    assert.ok(!risk.transitChokepoints.some(cp => cp.chokepointId === 'malacca_strait'), 'The India leg ends before Malacca');
  });

  it('marks route as critical when Hormuz disruptionScore is 80', () => {
    const scores = new Map([['hormuz_strait', 80]]);
    const risk = computeSupplierRouteRisk('SA', 'IN', scores);
    assert.equal(risk.riskLevel, 'critical');
    assert.ok(risk.recommendation.includes('Hormuz'));
    assert.ok(risk.recommendation.includes('Consider alternative'));
  });

  it('does not turn shared transoceanic routes into a Canada-US route', () => {
    const scores = new Map([['hormuz_strait', 90], ['suez', 85]]);
    const risk = computeSupplierRouteRisk('CA', 'US', scores);
    assert.equal(risk.riskLevel, 'unknown');
    assert.deepEqual(risk.routeIds, []);
    assert.deepEqual(risk.transitChokepoints, []);
  });

  for (const [exporter, importer] of [['AU', 'JP'], ['FR', 'DE'], ['CZ', 'DE'], ['AT', 'JP'], ['US', 'BR'], ['JP', 'JP']]) {
    it(`withholds a full corridor for ${exporter}-${importer} when its endpoints do not connect the pair`, () => {
      for (const [from, to] of [[exporter, importer], [importer, exporter]]) {
        const risk = computeSupplierRouteRisk(from, to, new Map([['hormuz_strait', 90], ['suez', 90]]));
        assert.equal(risk.riskLevel, 'unknown');
        assert.deepEqual(risk.routeIds, []);
        assert.deepEqual(risk.transitChokepoints, []);
      }
    });
  }

  it('retains cross-region corridor models and keeps Canada-Japan unresolved', () => {
    assert.deepEqual(computeSupplierRouteRisk('QA', 'JP', new Map()).routeIds, ['qatar-asia-lng']);
    assert.ok(computeSupplierRouteRisk('CN', 'DE', new Map()).routeIds.includes('china-europe-suez'));
    assert.ok(computeSupplierRouteRisk('US', 'DE', new Map()).routeIds.includes('transatlantic'));
    const canadaJapan = computeSupplierRouteRisk('CA', 'JP', new Map());
    assert.deepEqual(canadaJapan.routeIds, []);
    assert.equal(canadaJapan.riskLevel, 'unknown');
  });

  it('retains the China-Africa corridor and Malacca exposure for coastal African members', () => {
    for (const country of ['KE', 'TZ', 'NG']) {
      for (const [from, to] of [['CN', country], [country, 'CN']]) {
        const risk = computeSupplierRouteRisk(from, to, new Map([['malacca_strait', 80]]));
        assert.deepEqual(risk.routeIds, ['china-africa']);
        assert.equal(risk.riskLevel, 'critical');
        assert.deepEqual(risk.transitChokepoints.map(cp => cp.chokepointId), ['malacca_strait']);
      }
    }
    assert.equal(computeSupplierRouteRisk('KE', 'NG', new Map()).riskLevel, 'unknown');
    assert.equal(computeSupplierRouteRisk('CN', 'UG', new Map()).riskLevel, 'unknown');
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
    const risk = computeSupplierRouteRisk('SA', 'IN', scores, true);
    assert.equal(risk.riskLevel, 'safe');
  });

  it('returns maxDisruptionScore correctly', () => {
    const scores = new Map([['hormuz_strait', 45], ['malacca_strait', 20]]);
    const risk = computeSupplierRouteRisk('QA', 'JP', scores);
    assert.equal(risk.maxDisruptionScore, 45);
  });
});

// #7990: a modeled chokepoint with no current observation is missing evidence,
// not a measured zero, and must never make a route safe or a safe alternative.
describe('missing or non-current disruption evidence', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const fresh = new Date(NOW - 5 * 60_000).toISOString();
  const cnQa = [
    { partnerCode: 156, partnerIso2: 'CN', value: 600, share: 0.6 },
    { partnerCode: 634, partnerIso2: 'QA', value: 400, share: 0.4 },
  ];

  it('keeps a modeled route unknown when none of its chokepoints are measured', () => {
    const risk = computeSupplierRouteRisk('QA', 'JP', new Map(), true);
    assert.deepEqual(risk.routeIds, ['qatar-asia-lng']);
    assert.equal(risk.riskLevel, 'unknown');
    assert.equal(risk.unknownReason, 'unmeasured');
    assert.deepEqual(risk.transitChokepoints.map(cp => cp.disruptionScore), [null, null]);
    assert.equal(risk.maxDisruptionScore, null);
    assert.match(risk.recommendation, /no current disruption data/i);
    assert.doesNotMatch(risk.recommendation, /avoids/);
  });

  it('keeps a route unknown when one modeled chokepoint is missing and the measured one is zero', () => {
    const risk = computeSupplierRouteRisk('QA', 'JP', new Map([['malacca_strait', 0]]), true);
    assert.equal(risk.riskLevel, 'unknown');
    assert.equal(risk.unknownReason, 'unmeasured');
    assert.deepEqual(risk.transitChokepoints.map(cp => [cp.chokepointId, cp.disruptionScore]), [['hormuz_strait', null], ['malacca_strait', 0]]);
    assert.equal(risk.maxDisruptionScore, 0);
    assert.match(risk.recommendation, /Hormuz/);
  });

  it('marks a fully measured, current, low-risk route safe (control)', () => {
    const risk = computeSupplierRouteRisk('QA', 'JP', new Map([['hormuz_strait', 0], ['malacca_strait', 0]]), true);
    assert.equal(risk.riskLevel, 'safe');
    assert.equal(risk.unknownReason, null);
  });

  it('does not mark complete scores safe when the snapshot is not current', () => {
    const scores = new Map([['hormuz_strait', 0], ['malacca_strait', 0]]);
    assert.equal(computeSupplierRouteRisk('QA', 'JP', scores, false).riskLevel, 'unknown');
    assert.equal(computeSupplierRouteRisk('QA', 'JP', scores).riskLevel, 'unknown', 'currency must be asserted, not assumed');
    assert.equal(computeSupplierRouteRisk('QA', 'JP', scores, false).unknownReason, 'unmeasured');
  });

  it('still reports measured critical and elevated evidence when other chokepoints are missing or stale', () => {
    assert.equal(computeSupplierRouteRisk('QA', 'JP', new Map([['hormuz_strait', 90]]), false).riskLevel, 'critical');
    assert.equal(computeSupplierRouteRisk('QA', 'JP', new Map([['malacca_strait', 50]]), true).riskLevel, 'at_risk');
  });

  for (const [score, level] of [[30, 'safe'], [31, 'at_risk'], [69, 'at_risk'], [70, 'critical']]) {
    it(`classifies a fully measured score of ${score} as ${level}`, () => {
      assert.equal(computeSupplierRouteRisk('QA', 'JP', new Map([['hormuz_strait', score], ['malacca_strait', 0]]), true).riskLevel, level);
    });
  }

  it('explains a complete but non-current snapshot instead of naming missing chokepoints', () => {
    const risk = computeSupplierRouteRisk('QA', 'JP', new Map([['hormuz_strait', 0], ['malacca_strait', 0]]), false);
    assert.match(risk.recommendation, /not current/);
  });

  it('keeps a modeled route with no chokepoints safe regardless of snapshot currency', () => {
    // transatlantic has no waypoints, so there is no disruption score to be missing or stale.
    for (const current of [true, false]) {
      const risk = computeSupplierRouteRisk('US', 'DE', new Map(), current);
      assert.deepEqual(risk.transitChokepoints, []);
      assert.equal(risk.riskLevel, 'safe');
    }
  });

  it('keeps no-route and missing-evidence unknowns distinct', () => {
    assert.equal(computeSupplierRouteRisk('CA', 'JP', new Map(), true).unknownReason, 'no_route');
    assert.equal(computeSupplierRouteRisk('QA', 'JP', new Map(), true).unknownReason, 'unmeasured');
  });

  it('does not suggest an unmeasured route as a safe alternative to a measured critical one', () => {
    for (const current of [true, false]) {
      const [cn, qa] = computeAlternativeSuppliers(cnQa, 'JP', new Map([['taiwan_strait', 90]]), current);
      assert.equal(cn.risk.riskLevel, 'critical');
      assert.equal(qa.risk.riskLevel, 'unknown');
      assert.equal(cn.safeAlternative, null);
    }
  });

  it('suggests a fully measured current low-risk route as an alternative (control)', () => {
    const scores = new Map([['taiwan_strait', 90], ['hormuz_strait', 0], ['malacca_strait', 0]]);
    assert.equal(computeAlternativeSuppliers(cnQa, 'JP', scores, true)[0].safeAlternative, 'QA');
    assert.equal(computeAlternativeSuppliers(cnQa, 'JP', scores, false)[0].safeAlternative, null);
  });

  describe('chokepointScoreEvidence', () => {
    const cps = [{ id: 'hormuz_strait', disruptionScore: 0 }, { id: 'malacca_strait', disruptionScore: 12 }];

    it('treats a fresh, available snapshot as current', () => {
      const ev = chokepointScoreEvidence({ chokepoints: cps, fetchedAt: fresh, upstreamUnavailable: false }, NOW);
      assert.equal(ev.current, true);
      assert.deepEqual([...ev.scores], [['hormuz_strait', 0], ['malacca_strait', 12]]);
    });

    for (const [label, resp] of [
      ['upstream-unavailable', { chokepoints: cps, fetchedAt: fresh, upstreamUnavailable: true }],
      ['stale', { chokepoints: cps, fetchedAt: '2020-01-01T00:00:00Z', upstreamUnavailable: false }],
      ['undated', { chokepoints: cps, fetchedAt: '', upstreamUnavailable: false }],
      ['unparseable-date', { chokepoints: cps, fetchedAt: 'yesterday', upstreamUnavailable: false }],
      ['future-dated', { chokepoints: cps, fetchedAt: new Date(NOW + 60 * 60_000).toISOString(), upstreamUnavailable: false }],
    ]) {
      it(`keeps scores but marks a ${label} snapshot not current`, () => {
        const ev = chokepointScoreEvidence(resp, NOW);
        assert.equal(ev.current, false);
        assert.equal(ev.scores.get('malacca_strait'), 12);
      });
    }

    for (const [label, offsetMs, current] of [
      ['exactly 60 minutes old', -60 * 60_000, true],
      ['one second past 60 minutes', -(60 * 60_000 + 1000), false],
      ['5 minutes ahead (clock skew)', 5 * 60_000, true],
      ['one second past the skew allowance', 5 * 60_000 + 1000, false],
    ]) {
      it(`treats a snapshot ${label} as current=${current}`, () => {
        const ev = chokepointScoreEvidence({ chokepoints: cps, fetchedAt: new Date(NOW + offsetMs).toISOString(), upstreamUnavailable: false }, NOW);
        assert.equal(ev.current, current);
      });
    }

    it('drops non-finite scores instead of reading them as zero', () => {
      const ev = chokepointScoreEvidence({ chokepoints: [{ id: 'hormuz_strait', disruptionScore: Number.NaN }, { id: 'malacca_strait' }], fetchedAt: fresh, upstreamUnavailable: false }, NOW);
      assert.equal(ev.scores.size, 0);
    });
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

// #7990 route coverage: corridors measured as unknown on the 2026-10-29 caches.
describe('sourced corridor additions', () => {
  const ids = (risk) => risk.transitChokepoints.map(cp => cp.chokepointId).sort();

  it('Iraqi crude to India crosses Hormuz and stops before Malacca', () => {
    const risk = computeSupplierRouteRisk('IQ', 'IN', new Map([['hormuz_strait', 80], ['malacca_strait', 0]]), true);
    assert.ok(risk.routeIds.includes('gulf-asia-oil'));
    assert.deepEqual(ids(risk), ['hormuz_strait']);
    assert.equal(risk.riskLevel, 'critical');
  });

  it('Iraq to Japan carries Hormuz and Malacca, like the other Gulf producers', () => {
    const iq = computeSupplierRouteRisk('IQ', 'JP', new Map(), true);
    const sa = computeSupplierRouteRisk('SA', 'JP', new Map(), true);
    assert.deepEqual(ids(iq), ids(sa));
    assert.deepEqual(ids(iq), ['hormuz_strait', 'malacca_strait']);
  });

  for (const importer of ['JP', 'KR']) {
    it(`US to ${importer} is modeled through both coasts and inherits Panama`, () => {
      const risk = computeSupplierRouteRisk('US', importer, new Map([['panama', 75]]), true);
      assert.deepEqual([...risk.routeIds].sort(), ['us-gulf-asia-panama', 'us-west-northeast-asia']);
      // The West Coast leg crosses no modeled chokepoint; the Gulf leg keeps
      // Panama, so the pair cannot read safe while Panama is disrupted.
      assert.deepEqual(ids(risk), ['panama']);
      assert.equal(risk.riskLevel, 'critical');
    });

    it(`US to ${importer} is safe only with a current, measured low Panama score`, () => {
      assert.equal(computeSupplierRouteRisk('US', importer, new Map([['panama', 10]]), true).riskLevel, 'safe');
      assert.equal(computeSupplierRouteRisk('US', importer, new Map(), true).riskLevel, 'unknown');
      assert.equal(computeSupplierRouteRisk(importer, 'US', new Map([['panama', 10]]), true).riskLevel, 'safe');
    });
  }

  it('leaves unsourced pairs unknown', () => {
    for (const [exp, imp] of [['CA', 'JP'], ['AU', 'JP'], ['US', 'IN'], ['RU', 'IN']]) {
      const risk = computeSupplierRouteRisk(exp, imp, new Map(), true);
      assert.deepEqual(risk.routeIds, [], `${exp}->${imp}`);
      assert.equal(risk.unknownReason, 'no_route');
    }
  });

  it('does not move the existing corridors of the touched countries', () => {
    assert.deepEqual(computeSupplierRouteRisk('CN', 'US', new Map(), true).routeIds,
      ['china-us-west', 'china-us-east-suez', 'china-us-east-panama']);
    assert.deepEqual(computeSupplierRouteRisk('QA', 'JP', new Map(), true).routeIds, ['qatar-asia-lng']);
    assert.deepEqual(computeSupplierRouteRisk('US', 'DE', new Map(), true).routeIds, ['transatlantic']);
  });
});
