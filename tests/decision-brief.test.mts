import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionBrief } from '../src/utils/decision-brief.ts';
import type { DecisionBriefCapture, DecisionBriefSelection } from '../src/types/decision-brief.ts';
import { computeGasDisruption } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';

const selection: DecisionBriefSelection = { countryCode: 'DE', countryName: 'Germany', chokepointId: 'hormuz_strait', fuelMode: 'gas', baselinePct: 50, comparisonPct: 100 };
function captures(code = 'DE', lng = 41318, demand = 467224): [DecisionBriefCapture, DecisionBriefCapture] {
  return [50, 100].map(disruptionPct => ({ retrievedAt: '2026-09-10T10:00:00Z', response: {
    countryCode: code, chokepointId: 'hormuz_strait', disruptionPct, gulfCrudeShare: 0, crudeLossKbd: 0, products: [], effectiveCoverDays: 0,
    assessment: '', dataAvailable: true, jodiOilCoverage: false, comtradeCoverage: false, ieaStocksCoverage: false, portwatchCoverage: false,
    coverageLevel: 'partial', limitations: [], degraded: true, chokepointConfidence: '',
    gasSensitivity: { lngImportsTj: lng, totalDemandTj: demand, ...computeGasDisruption(lng, demand, 'hormuz_strait', disruptionPct)!, dataAvailable: true, assessment: '30% assumed route exposure.', dataSource: 'JODI', dataMonth: '2026-05', modelBasis: 'assumed_route_sensitivity' },
  } })) as [DecisionBriefCapture, DecisionBriefCapture];
}

test('oil route evidence withholds a proxy and retains covered Comtrade values', () => {
  const data = captures();
  for (const { response } of data) {
    response.jodiOilCoverage = true;
    response.gulfCrudeShare = 0.4;
    response.crudeLossKbd = 100;
  }
  data[1].response.comtradeCoverage = true;
  const s = buildDecisionBrief({ ...selection, fuelMode: 'oil' }, data);
  assert.equal(s.evidence.find(e => e.id === 'baseline-route')!.value, null);
  assert.equal(s.evidence.find(e => e.id === 'comparison-route')!.value, 40);
  assert.match(s.unknowns.join(' '), /baseline: Comtrade route exposure is unavailable.*fixed proxy/);
  assert.deepEqual(s.results.map(r => r.loss), [100, 100]);
  assert.equal(s.comparison.delta, null);
});

test('Germany shared basis retains exact corrected gas results and evidence-specific action', () => {
  const s = buildDecisionBrief(selection, captures());
  assert.deepEqual(s.results.map(r => r.loss), [6197.7, 12395.4]);
  assert.deepEqual(s.results.map(r => r.demandPct), [1.3, 2.7]);
  assert.equal(s.comparison.delta, 6197.7);
  assert.match(s.action.text, /Compare Germany's supply obligations and alternative origins/);
  assert.match(s.action.constraint, /Country-specific supplier and route exposure/);
  assert.match(s.action.trigger, /updated source observations/);
  assert(s.action.references.every(ref => s.evidence.some(e => e.id === ref)));
  assert.match(s.assumptions.join(' '), /30% assumed/);
});

test('second country composes with its own values and missing baseline changes the next action', () => {
  const selected = { ...selection, countryCode: 'JP', countryName: 'Japan' };
  const data = captures('JP', 100000, 500000);
  const good = buildDecisionBrief(selected, data);
  assert.deepEqual(good.results.map(r => r.loss), [15000, 30000]);
  assert(!JSON.stringify(good).includes('Germany'));
  delete data[0].response.gasSensitivity;
  const missing = buildDecisionBrief(selected, data);
  assert.equal(missing.results[0].loss, null);
  assert.equal(missing.comparison.delta, null);
  assert.match(missing.action.text, /Recover recorded LNG imports, positive gas demand/);
  assert.match(missing.action.text, /Withhold a procurement conclusion/);
  assert.notEqual(missing.action.trigger, good.action.trigger);
});

for (const change of ['month', 'lng', 'demand', 'source', 'source-differs', 'source-both-blank', 'share', 'model', 'country', 'route', 'severity', 'unknown-date', 'legacy']) {
  test(`withholds delta for ${change} mismatch`, () => {
    const data = captures(); const r = data[1].response; const g = r.gasSensitivity!;
    // Both captures blank: equality holds ('' === ''), so the non-empty check is the
    // only term left that can withhold the delta. Blanking just one capture would trip
    // the equality term instead and leave this guard untested.
    if (change === 'source-both-blank') { data[0].response.gasSensitivity!.dataSource = ''; g.dataSource = ''; }
    if (change === 'month') g.dataMonth = '2026-06';
    if (change === 'lng') g.lngImportsTj++;
    if (change === 'demand') g.totalDemandTj++;
    if (change === 'source') g.dataSource = '';
    // Two provenance bases that are each individually valid but disagree, so the
    // equality term is exercised by a real mismatch rather than only by a blank value.
    if (change === 'source-differs') g.dataSource = 'jodi_annual';
    // Neither capture sets lngShareOfImports in the fixture, so both are undefined and
    // compare equal; this is the only case that gives that conjunct teeth.
    if (change === 'share') g.lngShareOfImports = 0.9;
    if (change === 'model') g.modelBasis = 'legacy';
    if (change === 'country') r.countryCode = 'JP';
    if (change === 'route') r.chokepointId = 'suez';
    if (change === 'severity') r.disruptionPct = 25;
    if (change === 'unknown-date') g.dataMonth = '';
    if (change === 'legacy') r.gasImpact = {} as never;
    assert.equal(buildDecisionBrief(selection, data).comparison.delta, null);
  });
}

test('old storage retains its own date and is explicitly excluded from comparison', () => {
  const data = captures();
  data[0].response.gasSensitivity!.storage = { gasTwh: 30, fillPct: 50, date: '2025-01-02', trend: '', scope: 'national' };
  const s = buildDecisionBrief(selection, data);
  assert.equal(s.evidence.find(e => e.id === 'baseline-storage')?.observedAt, '2025-01-02');
  assert.match(s.comparison.reason, /Storage is context only/);
  assert.match(s.unknowns.join(' '), /no closure/);
});

test('unavailable gas fields cannot become observed zero and invalid demand suppresses results', () => {
  const data = captures();
  data[0].response.gasSensitivity!.dataAvailable = false;
  data[0].response.gasSensitivity!.lngImportsTj = 0;
  data[1].response.gasSensitivity!.totalDemandTj = 0;
  const s = buildDecisionBrief(selection, data);
  assert.deepEqual(s.results.map(r => r.loss), [null, null]);
  assert.equal(s.evidence.find(e => e.id === 'baseline-lng')!.value, null);
});

test('recorded zero is distinct from missing baseline', () => {
  const s = buildDecisionBrief(selection, captures('DE', 0));
  assert.deepEqual(s.results.map(r => r.loss), [0, 0]);
  assert.match(s.action.text, /modeled zero/);
  assert.equal(s.comparison.delta, 0);
});

// U2 uses the actual builder and route mapping with controlled bilateral records.
test('commodity comparison preserves Qatar origin blockage and recorded US constraints', async () => {
  const module = await import('../src/utils/decision-brief.ts');
  assert.equal(typeof module.buildCommodityBrief, 'function', 'commodity comparison builder must exist');
  const data = {
    retrievedAt: '2026-09-10T10:00:00Z',
    products: { iso2: 'JP', fetchedAt: '2026-09-09', products: [{ hs4: '2804', description: 'Hydrogen and rare gases', totalValue: 1000, year: 2024, topExporters: [
      { partnerCode: 634, partnerIso2: 'QA', share: 0.6, value: 600 },
      { partnerCode: 842, partnerIso2: 'US', share: 0.3, value: 300 },
      { partnerCode: 999, partnerIso2: 'ZZ', share: 0.1, value: 100 },
    ] }] },
    vulnerabilities: { iso2: 'JP', country: 'Japan', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
    production: null,
  };
  const s = module.buildCommodityBrief({ countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' }, data);
  assert.equal(s.candidates.find(c => c.origin === 'QA')?.routeState, 'exposed');
  assert.equal(s.candidates.find(c => c.origin === 'ZZ')?.routeState, 'unknown');
  assert.equal(s.candidates[0]?.origin, 'US');
  assert.match(s.action.text, /US/);
  assert.match(s.action.constraint, /capacity.*qualification.*price.*lead time/i);
  assert.match(s.caveats.join(' '), /hospital/);
  assert.equal(s.evidence.find(e => e.id === 'share-JP-2804-QA')?.value, 60);
  assert.equal(s.evidence.find(e => e.id === 'share-JP-2804-QA')?.observedAt, '2024');
  assert(s.action.references.every(ref => s.evidence.some(e => e.id === ref)));
});

test('commodity missing products, country mismatch and invalid shares remain explicit', async () => {
  const { buildCommodityBrief } = await import('../src/utils/decision-brief.ts');
  const selected = { countryCode: 'JP', countryName: 'Japan', commodityId: 'helium', chokepointId: 'hormuz_strait' };
  const data = { retrievedAt: '2026-09-10', products: { iso2: 'JP', fetchedAt: '', products: [] }, vulnerabilities: { iso2: 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null };
  const missing = buildCommodityBrief(selected, data);
  assert.equal(missing.candidates.length, 0);
  assert.match(missing.action.text, /No recorded HS 2804/);
  assert.match(missing.context, /No zero exposure/);
  assert.throws(() => buildCommodityBrief({ ...selected, countryCode: 'DE' }, data), /country/);
  const invalid = buildCommodityBrief(selected, { ...data, products: { ...data.products, products: [{ hs4: '2804', description: '', totalValue: 100, year: 0, topExporters: [{ partnerCode: 842, partnerIso2: 'US', share: NaN, value: 100 }] }] } });
  assert.equal(invalid.evidence[0]?.value, null);
  assert.equal(invalid.evidence[0]?.observedAt, null);
  assert.match(invalid.action.text, /No positive recorded share/);
});

test('commodity ordering uses known routes and exact zero remains different from unknown', async () => {
  const { buildCommodityBrief } = await import('../src/utils/decision-brief.ts');
  const selected = { countryCode: 'DE', countryName: 'Germany', commodityId: 'wheat', chokepointId: 'suez' };
  const data = { retrievedAt: '2026-09-10', products: { iso2: 'DE', fetchedAt: '', products: [{ hs4: '1001', description: '', totalValue: 100, year: 2024, topExporters: [
    { partnerCode: 156, partnerIso2: 'CN', share: 0.6, value: 60 }, { partnerCode: 842, partnerIso2: 'US', share: 0.4, value: 40 }, { partnerCode: 124, partnerIso2: 'CA', share: 0, value: 0 },
  ] }] }, vulnerabilities: { iso2: 'DE', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null };
  const blocked = buildCommodityBrief(selected, data);
  assert.equal(blocked.candidates[0]?.origin, 'US');
  assert.equal(blocked.candidates.find(c => c.origin === 'CN')?.routeState, 'exposed');
  assert.equal(blocked.evidence.find(e => e.id === 'share-DE-1001-CA')?.value, 0);
  const hormuz = buildCommodityBrief({ ...selected, chokepointId: 'hormuz_strait' }, data);
  assert.equal(hormuz.candidates[0]?.origin, 'CN');
  assert.deepEqual(hormuz.evidence, blocked.evidence);
  assert.deepEqual(hormuz.capture, blocked.capture);
});

test('a heading recovered on demand reports its own fetch time as the source fetch time', async () => {
  const { buildCommodityBrief } = await import('../src/utils/decision-brief.ts');
  const selected = { countryCode: 'DE', countryName: 'Germany', commodityId: 'helium', chokepointId: 'hormuz_strait' };
  const exporters = [{ partnerCode: 842, partnerIso2: 'US', share: 0.4, value: 400 }];
  const recovered = { hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold', fetchedAt: '2026-09-11T12:00:00.000Z', topExporters: exporters };
  const base = { retrievedAt: '2026-09-11T12:00:05.000Z', vulnerabilities: { iso2: 'DE', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null };
  // The catalogue fetch failed and nothing is stored: the response carries no
  // fetch time, but the recovered heading does, and that is the evidence shown.
  const cold = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '', products: [recovered] } });
  assert.match(cold.coverage.join('\n'), /Source fetched: 2026-09-11T12:00:00\.000Z \(HS 2804 recovered on demand; stored catalogue: none\)/);
  assert.doesNotMatch(cold.coverage.join('\n'), /Source fetched: unknown/);
  // A stale catalogue behind a recovered heading: both times are stated, the
  // heading's first, so the brief is not dated by rows it does not show.
  const stale = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '2026-07-27T16:47:53.750Z', products: [recovered] } });
  assert.match(stale.coverage.join('\n'), /Source fetched: 2026-09-11T12:00:00\.000Z \(HS 2804 recovered on demand; stored catalogue: 2026-07-27T16:47:53\.750Z\)/);
  // A stored row has no fetch time of its own and keeps the payload's.
  const stored = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '2026-09-09T00:00:00.000Z', products: [{ ...recovered, fetchedAt: undefined }] } });
  assert.match(stored.coverage.join('\n'), /Source fetched: 2026-09-09T00:00:00\.000Z\. Capture retrieved/);
});

test('a recovered heading names its own retrieval route, with the stored catalogue beside it', async () => {
  const { buildCommodityBrief } = await import('../src/utils/decision-brief.ts');
  const selected = { countryCode: 'DE', countryName: 'Germany', commodityId: 'helium', chokepointId: 'hormuz_strait' };
  const row = { hs4: '2804', description: '', totalValue: 1000, year: 2024, partnerBasis: 'share_threshold', fetchedAt: '2026-09-11T12:00:00.000Z',
    topExporters: [{ partnerCode: 842, partnerIso2: 'US', share: 0.4, value: 400 }] };
  const evidence = (state: string, source: string, recoveredHs4s: string[]) =>
    ({ state, source, requestedHs4s: [], missingHs4s: [], lastAttemptAt: '', lastAttemptState: 'observed', recoveredHs4s });
  const base = { retrievedAt: '2026-09-11T12:00:05.000Z', vulnerabilities: { iso2: 'DE', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true }, production: null };
  // Nothing stored: the heading is the whole answer, and its route is the preview.
  const cold = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '', products: [row],
    evidence: evidence('partial', 'UN Comtrade public preview (single-heading recovery)', ['2804']) } });
  assert.match(cold.coverage.join('\n'), /Cache state: partial\. Source: UN Comtrade public preview \(HS 2804 recovered on demand\)\./);
  // A stale catalogue behind it: its state and source describe the other
  // headings, so they are labelled as the stored catalogue's.
  const stale = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '2026-07-27T16:47:53.750Z', products: [row],
    evidence: evidence('stale_preserved', 'UN Comtrade bilateral HS4', ['2804']) } });
  assert.match(stale.coverage.join('\n'), /Cache state: stale_preserved \(stored catalogue\)\. Source: UN Comtrade public preview \(HS 2804 recovered on demand\); stored catalogue: UN Comtrade bilateral HS4\./);
  // A stored row keeps the payload's own state and source.
  const stored = buildCommodityBrief(selected, { ...base, products: { iso2: 'DE', fetchedAt: '2026-09-09T00:00:00.000Z', products: [{ ...row, fetchedAt: undefined }],
    evidence: evidence('observed', 'UN Comtrade bilateral HS4', []) } });
  assert.match(stored.coverage.join('\n'), /Cache state: observed\. Source: UN Comtrade bilateral HS4\./);
});

// U5. The threshold partner list, volume, supplier scale, the hub flag and the
// mineral leg all reach the snapshot from the same builder pass, so one case
// pins the whole mapping without a DOM.
test('commodity evidence depth maps volume, scale, hub flag and world production', async () => {
  const { buildCommodityBrief } = await import('../src/utils/decision-brief.ts');
  const selected = { countryCode: 'JP', countryName: 'Japan', commodityId: 'cobalt', chokepointId: 'hormuz_strait' };
  const data = {
    retrievedAt: '2026-09-10T10:00:00Z',
    products: {
      iso2: 'JP', fetchedAt: '2026-09-09',
      products: [{
        hs4: '8105', description: 'Cobalt', totalValue: 1000, year: 2024, denominatorBasis: 'reported_world',
        partnerBasis: 'share_threshold', omittedPartnerCount: 12, omittedPartnerShare: 0.042,
        topExporters: [
          { partnerCode: 528, partnerIso2: 'NL', share: 0.4, value: 400, netWeightKg: 839, netWeightEstimated: true, quantity: 4, quantityUnitCode: 12 },
          { partnerCode: 180, partnerIso2: 'CD', share: 0.3, value: 300, scale: { worldExportsUsd: 2_100_000_000, rank: 1, year: 2024, reporterCount: 118, unrankedReporterCount: 22 } },
          // Comtrade reports an unmeasured weight as 0; that is "not reported".
          { partnerCode: 124, partnerIso2: 'CA', share: 0.2, value: 200, netWeightKg: 0, quantity: 0 },
        ],
      }],
      evidence: { state: 'fresh', source: 'UN Comtrade bilateral HS4', requestedHs4s: ['8105'], missingHs4s: [], lastAttemptAt: '', lastAttemptState: 'observed', recoveredHs4s: [], worldExportsFetchedAt: '2026-09-08T00:00:00Z' },
    },
    vulnerabilities: { iso2: 'JP', country: 'Japan', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true },
    production: {
      commodities: [{
        commodityId: 'cobalt', commodity: 'Cobalt', year: 2024, unit: 't', sources: ['usgs-mcs'],
        mine: { year: 2024, unit: 't', hhi: 0, withheldCount: 0, countries: [{ iso2: 'CD', country: 'DR Congo', share: 76.2, output: 220000, withheld: false, estimated: false, residual: false }] },
      }],
      countries: [], fetchedAt: '2026-09-01T00:00:00Z', upstreamUnavailable: false, dataYear: 2024,
    },
  };
  const s = buildCommodityBrief(selected, data);
  const nl = s.candidates.find(c => c.origin === 'NL');
  assert.equal(nl?.netWeightKg, 839);
  assert.equal(nl?.netWeightEstimated, true);
  assert.equal(nl?.quantityUnit, 'm³');
  assert.equal(nl?.transitHub, true);
  const ca = s.candidates.find(c => c.origin === 'CA');
  assert.equal(ca?.netWeightKg, null);
  assert.equal(ca?.quantity, null);
  assert.equal(ca?.quantityUnit, null);
  assert.equal(ca?.transitHub, false);
  assert.deepEqual(s.candidates.find(c => c.origin === 'CD')?.scale, { worldExportsUsd: 2_100_000_000, worldExportsKg: null, rank: 1, year: 2024, reporterCount: 118, unrankedReporterCount: 22 });
  assert.deepEqual(s.candidates.find(c => c.origin === 'CD')?.production, { sharePct: 76.2, stage: 'mine', source: 'USGS MCS', restricted: false });
  assert.equal(s.candidates.find(c => c.origin === 'NL')?.production, null);
  assert.match(s.coverage.join(' '), /Origins listed: partners holding at least 1% of the denominator, padded to 5 and capped at 25 \(3 listed; 12 omitted holding 4\.2% combined\)/);
  assert.match(s.coverage.join(' '), /Possible transit hubs among listed origins: Netherlands \(NL\)/);
  assert.match(s.coverage.join(' '), /world exports of HS 8105 fetched 2026-09-08T00:00:00Z/);
  // Late filers are left out of the ranking, which moves every rank below them.
  assert.match(s.coverage.join(' '), /22 reporters whose newest HS 8105 filing is older are not ranked/);
  assert.match(s.coverage.join(' '), /World production: mine-stage shares from USGS MCS/);
  // R5: NL is the only origin whose modeled route avoids the blocked chokepoint,
  // so the hub preference (which never crosses route-state tiers) cannot skip
  // it; the action names NL and says the flag could not be avoided.
  assert.equal(s.candidates[0]?.origin, 'NL');
  assert.notEqual(s.candidates[1]?.routeState, s.candidates[0]?.routeState);
  assert.match(s.action.text, /Validate NL's/);
  assert.match(s.action.text, /Every eligible origin with this route state is flagged a possible transit hub/);
  assert.deepEqual(JSON.parse(JSON.stringify(s.candidates)), s.candidates);
});
