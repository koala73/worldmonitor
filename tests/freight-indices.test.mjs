import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSseIndexResponse } from '../scripts/seed-supply-chain-trade.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const seedSrc = readFileSync(resolve(root, 'scripts/seed-supply-chain-trade.mjs'), 'utf-8');

// ─── Extract parsers from seed source for functional testing ───
// We eval the relevant functions in isolation so we can feed them test data.

// Extract and eval accumulateHistory (multiline, ends at closing brace at col 0)
const accHistBlock = seedSrc.match(/function accumulateHistory\([\s\S]+?\n\}/)?.[0];
const accumulateHistory = new Function(`return ${accHistBlock}`)();

// Extract BDI parser logic into a testable function
// (regex patterns + parsing loop from fetchBDI)
function parseBDIFromHtml(html) {
  const BDI_INDEX_MAP = [
    { label: 'Dry', id: 'BDI', name: 'BDI - Baltic Dry Index' },
    { label: 'Capesize', id: 'BCI', name: 'BCI - Baltic Capesize Index' },
    { label: 'Panamax', id: 'BPI', name: 'BPI - Baltic Panamax Index' },
    { label: 'Supramax', id: 'BSI', name: 'BSI - Baltic Supramax Index' },
    { label: 'Handysize', id: 'BHSI', name: 'BHSI - Baltic Handysize Index' },
  ];
  const indices = [];
  for (const cfg of BDI_INDEX_MAP) {
    const patterns = [
      new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
      new RegExp(`${cfg.id}[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
      new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?([\\d,]+)\\s*points`, 'i'),
    ];
    let currentValue = null;
    for (const re of patterns) {
      const m = html.match(re);
      if (m) { currentValue = parseFloat(m[1].replace(/,/g, '')); break; }
    }
    if (currentValue == null || !Number.isFinite(currentValue)) continue;
    let changePct = 0;
    let previousValue = currentValue;
    const deltaRe = new RegExp(`${cfg.id}\\)?[^.]*?(increased|decreased|gained|lost|dropped|rose)\\s+by\\s+([\\d,]+)\\s+points`, 'i');
    const deltaMatch = html.match(deltaRe);
    if (deltaMatch) {
      const delta = parseFloat(deltaMatch[2].replace(/,/g, ''));
      const isNeg = /decreased|lost|dropped/i.test(deltaMatch[1]);
      const signedDelta = isNeg ? -delta : delta;
      previousValue = currentValue - signedDelta;
      changePct = previousValue !== 0 ? (signedDelta / previousValue) * 100 : 0;
    }
    indices.push({
      indexId: cfg.id, name: cfg.name, currentValue, previousValue,
      changePct, unit: 'index', history: [], spikeAlert: false,
    });
  }
  return indices;
}

// The SSE parser is the REAL exported seeder function, not a re-implementation —
// a mirrored copy drifts silently from production (#6066).
const parseSSEResponse = parseSseIndexResponse;

// ─── SSE (SCFI/CCFI) parser tests with fixture data ───

const SCFI_FIXTURE = {
  data: {
    currentDate: '2026-03-13',
    lastDate: '2026-03-06',
    lineDataList: [
      {
        properties: { lineName_EN: 'Comprehensive Index', unit_EN: '' },
        currentContent: 1710.35,
        lastContent: 1489.19,
        absolute: 221.16,
        percentage: 14.85,
        dataItemTypeName: 'SCFI_T',
      },
      {
        properties: { lineName_EN: 'Europe', unit_EN: 'USD/TEU' },
        currentContent: 2500,
        lastContent: 2400,
        percentage: 4.17,
        dataItemTypeName: 'SCFI_S01',
      },
    ],
  },
};

const CCFI_FIXTURE = {
  data: {
    currentDate: '2026-03-13',
    lastDate: '2026-03-06',
    lineDataList: [
      {
        properties: { lineName_EN: 'Composite Index' },
        currentContent: 1072.16,
        lastContent: 1054.38,
        percentage: 1.69,
        dataItemTypeName: 'CCFI_T',
      },
    ],
  },
};

describe('SCFI parser (functional)', () => {
  it('extracts composite by dataItemTypeName, ignoring route lines', () => {
    const result = parseSSEResponse(SCFI_FIXTURE, 'SCFI', 'SCFI_T', 'SCFI - Shanghai Container Freight', 'index');
    assert.equal(result.length, 1);
    assert.equal(result[0].indexId, 'SCFI');
    assert.equal(result[0].currentValue, 1710.35);
    assert.equal(result[0].previousValue, 1489.19);
    assert.equal(result[0].changePct, 14.85);
    assert.equal(result[0].unit, 'index');
  });

  it('returns empty array for missing dataItemTypeName', () => {
    const result = parseSSEResponse(SCFI_FIXTURE, 'SCFI', 'NONEXISTENT', 'test', 'index');
    assert.equal(result.length, 0);
  });

  it('returns empty array for malformed response', () => {
    assert.equal(parseSSEResponse({}, 'SCFI', 'SCFI_T', 'test', 'index').length, 0);
    assert.equal(parseSSEResponse(null, 'SCFI', 'SCFI_T', 'test', 'index').length, 0);
    assert.equal(parseSSEResponse({ data: {} }, 'SCFI', 'SCFI_T', 'test', 'index').length, 0);
  });

  it('handles missing percentage field by computing from values', () => {
    const fixture = {
      data: { lineDataList: [{ dataItemTypeName: 'SCFI_T', currentContent: 110, lastContent: 100 }] },
    };
    const result = parseSSEResponse(fixture, 'SCFI', 'SCFI_T', 'test', 'index');
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0].changePct - 10) < 0.01, `Expected ~10%, got ${result[0].changePct}`);
  });
});

describe('CCFI parser (functional)', () => {
  it('extracts CCFI composite correctly', () => {
    const result = parseSSEResponse(CCFI_FIXTURE, 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index');
    assert.equal(result.length, 1);
    assert.equal(result[0].indexId, 'CCFI');
    assert.equal(result[0].currentValue, 1072.16);
    assert.equal(result[0].changePct, 1.69);
    assert.equal(result[0].unit, 'index');
  });
});

// ─── Decision-grade period change (#6066) ───
//
// `periodChangePct` feeds the China activity-nowcast freight family, so it must
// fail closed: published-or-derived from SSE's own envelope, never fabricated.

describe('SSE period-over-period change contract (#6066)', () => {
  const parse = (line, data = {}) => parseSseIndexResponse(
    { data: { lineDataList: [{ dataItemTypeName: 'CCFI_T', ...line }], ...data } },
    'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index',
  )[0];

  it('publishes the exchange percentage with its basis and prior period', () => {
    const index = parseSSEResponse(CCFI_FIXTURE, 'CCFI', 'CCFI_T', 'test', 'index')[0];
    assert.equal(index.periodChangePct, 1.69);
    assert.equal(index.periodChangeBasis, 'publisher_reported');
    assert.equal(index.priorPeriodValue, 1054.38);
    assert.equal(index.priorPeriodDate, '2026-03-06');
  });

  it('derives the change from the published prior level when SSE omits its percentage', () => {
    const index = parse({ currentContent: 110, lastContent: 100 });
    assert.ok(Math.abs(index.periodChangePct - 10) < 1e-9, `got ${index.periodChangePct}`);
    assert.equal(index.periodChangeBasis, 'derived_from_prior_period_level');
    assert.equal(index.priorPeriodValue, 100);
  });

  it('keeps a published zero move directional-eligible rather than treating it as missing', () => {
    const index = parse({ currentContent: 900, lastContent: 900, percentage: 0 });
    assert.equal(index.periodChangePct, 0);
    assert.equal(index.periodChangeBasis, 'publisher_reported');
  });

  it('publishes no change when SSE ships a level with no comparable prior', () => {
    for (const line of [
      { currentContent: 900 },
      { currentContent: 900, lastContent: null },
      { currentContent: 900, lastContent: 0 },
      { currentContent: 900, lastContent: 'n/a' },
      { currentContent: 900, percentage: 'n/a' },
    ]) {
      const index = parse(line);
      assert.equal(index.periodChangePct, null, JSON.stringify(line));
      assert.equal(index.periodChangeBasis, null, JSON.stringify(line));
      // The legacy display field still fabricates a flat 0 — which is exactly
      // why the decision path must not consume it.
      assert.equal(index.changePct, 0, JSON.stringify(line));
    }
  });

  it('reports no prior period when SSE ships a non-numeric prior level', () => {
    for (const lastContent of [undefined, null, 'n/a', Number.NaN]) {
      assert.equal(parse({ currentContent: 900, lastContent }).priorPeriodValue, null,
        String(lastContent));
    }
  });
});

// ─── BDI parser tests with HTML fixture snapshots ───

const BDI_HTML_INCREASED = `
<p>The Baltic Dry Index (BDI) increased by 46 points to reach 1,972 points.</p>
<p>The Baltic Capesize Index (BCI) increased by 120 points to reach 2,709 points.</p>
<p>The Baltic Panamax Index (BPI) decreased by 15 points to 1,558 points.</p>
<p>The Baltic Supramax Index (BSI) rose by 8 points to 1,245 points.</p>
<p>The Baltic Handysize Index (BHSI) dropped by 3 points to 755 points.</p>
`;

const BDI_HTML_UNCHANGED = `
<p>BDI was unchanged at 1,926 points.</p>
`;

const BDI_HTML_PARTIAL = `
<p>The Baltic Dry Index (BDI) increased by 10 points to reach 2,000 points.</p>
`;

describe('BDI parser (functional)', () => {
  it('parses all 5 indices with correct values from "increased" article', () => {
    const indices = parseBDIFromHtml(BDI_HTML_INCREASED);
    assert.equal(indices.length, 5);

    const bdi = indices.find(i => i.indexId === 'BDI');
    assert.equal(bdi.currentValue, 1972);
    assert.equal(bdi.previousValue, 1972 - 46);
    assert.ok(bdi.changePct > 0, 'BDI should show positive change');

    const bci = indices.find(i => i.indexId === 'BCI');
    assert.equal(bci.currentValue, 2709);
    assert.equal(bci.previousValue, 2709 - 120);

    const bpi = indices.find(i => i.indexId === 'BPI');
    assert.equal(bpi.currentValue, 1558);
    assert.equal(bpi.previousValue, 1558 + 15);
    assert.ok(bpi.changePct < 0, 'BPI decreased should show negative change');

    const bsi = indices.find(i => i.indexId === 'BSI');
    assert.equal(bsi.currentValue, 1245);
    assert.ok(bsi.changePct > 0, 'BSI rose should show positive change');

    const bhsi = indices.find(i => i.indexId === 'BHSI');
    assert.equal(bhsi.currentValue, 755);
    assert.ok(bhsi.changePct < 0, 'BHSI dropped should show negative change');
  });

  it('parses "unchanged" phrasing with fallback (no delta)', () => {
    const indices = parseBDIFromHtml(BDI_HTML_UNCHANGED);
    assert.equal(indices.length, 1);
    assert.equal(indices[0].indexId, 'BDI');
    assert.equal(indices[0].currentValue, 1926);
    assert.equal(indices[0].changePct, 0, 'Unchanged should have 0% change');
    assert.equal(indices[0].previousValue, 1926, 'Unchanged: previous = current');
  });

  it('degrades gracefully with partial HTML (only BDI composite)', () => {
    const indices = parseBDIFromHtml(BDI_HTML_PARTIAL);
    assert.equal(indices.length, 1, 'Should parse only BDI when sub-indices are missing');
    assert.equal(indices[0].indexId, 'BDI');
    assert.equal(indices[0].currentValue, 2000);
  });

  it('returns empty for garbage HTML', () => {
    const indices = parseBDIFromHtml('<p>No shipping data here.</p>');
    assert.equal(indices.length, 0);
  });
});

// ─── History accumulation tests (functional) ───

describe('History accumulation (functional)', () => {
  it('appends new date and trims to 24 entries', () => {
    const history = Array.from({ length: 24 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: 100 + i,
    }));
    const prevPayload = { indices: [{ indexId: 'BDI', history }] };
    const newIndices = [{ indexId: 'BDI', currentValue: 200, history: [] }];

    const result = accumulateHistory(newIndices, prevPayload);
    assert.equal(result[0].history.length, 24, 'Should stay at 24 after trim');
    assert.equal(result[0].history[23].value, 200, 'Last entry should be new value');
    assert.notEqual(result[0].history[0].date, '2026-01-01', 'Oldest entry should be trimmed');
  });

  it('deduplicates same-date entries using _observationDate', () => {
    const prevPayload = {
      indices: [{ indexId: 'SCFI', history: [{ date: '2026-03-13', value: 1500 }] }],
    };
    const newIndices = [{ indexId: 'SCFI', currentValue: 1600, history: [], _observationDate: '2026-03-13' }];

    const result = accumulateHistory(newIndices, prevPayload);
    assert.equal(result[0].history.length, 1, 'Should not duplicate same-date entry');
    assert.equal(result[0].history[0].value, 1500, 'Should keep existing value for same date');
  });

  it('uses _observationDate instead of today for history entries', () => {
    const prevPayload = {
      indices: [{ indexId: 'SCFI', history: [{ date: '2026-03-06', value: 1400 }] }],
    };
    const newIndices = [{ indexId: 'SCFI', currentValue: 1710, history: [], _observationDate: '2026-03-13' }];

    const result = accumulateHistory(newIndices, prevPayload);
    assert.equal(result[0].history.length, 2);
    assert.equal(result[0].history[1].date, '2026-03-13', 'Should use SSE observation date, not today');
    assert.equal(result[0].history[1].value, 1710);
  });

  it('strips _observationDate from output', () => {
    const prevPayload = { indices: [{ indexId: 'BDI', history: [] }] };
    const newIndices = [{ indexId: 'BDI', currentValue: 2000, history: [], _observationDate: '2026-03-14' }];

    const result = accumulateHistory(newIndices, prevPayload);
    assert.equal(result[0]._observationDate, undefined, '_observationDate should be stripped');
  });

  it('preserves existing history for indices with their own history (FRED)', () => {
    const fredHistory = [{ date: '2026-01-01', value: 100 }, { date: '2026-02-01', value: 105 }];
    const newIndices = [{ indexId: 'PCU483111483111', currentValue: 110, history: fredHistory }];
    const prevPayload = { indices: [{ indexId: 'PCU483111483111', history: [{ date: '2025-12-01', value: 95 }] }] };

    const result = accumulateHistory(newIndices, prevPayload);
    assert.deepEqual(result[0].history, fredHistory, 'Should not overwrite FRED indices that already have history');
  });

  it('handles null/empty previous payload and strips _observationDate', () => {
    const newIndices = [{ indexId: 'BDI', currentValue: 1900, history: [], _observationDate: '2026-03-14' }];
    const result1 = accumulateHistory(newIndices, null);
    assert.equal(result1[0].history.length, 0, 'Null payload: history stays empty');
    assert.equal(result1[0]._observationDate, undefined, '_observationDate stripped on null payload');

    const result2 = accumulateHistory([{ indexId: 'BDI', currentValue: 1900, history: [], _observationDate: '2026-03-14' }], { indices: [] });
    assert.equal(result2[0].history.length, 0, 'Empty indices: history stays empty');
  });

  it('merges history for new index not in previous payload', () => {
    const prevPayload = { indices: [{ indexId: 'SCFI', history: [{ date: '2026-03-01', value: 1500 }] }] };
    const newIndices = [{ indexId: 'BDI', currentValue: 2000, history: [] }];

    const result = accumulateHistory(newIndices, prevPayload);
    // BDI has no previous history, should get today's date appended
    assert.equal(result[0].history.length, 1);
    assert.equal(result[0].history[0].value, 2000);
  });
});

// ─── Source code structural tests ───

describe('Seed script structure', () => {
  it('uses dataItemTypeName for SSE matching (not English label)', () => {
    assert.ok(seedSrc.includes('dataItemTypeName'), 'Should match by dataItemTypeName');
    assert.ok(seedSrc.includes("'SCFI_T'"), 'SCFI_T type');
    assert.ok(seedSrc.includes("'CCFI_T'"), 'CCFI_T type');
  });

  it('fetchAll runs all fetchers in parallel', () => {
    assert.ok(seedSrc.includes('fetchSCFI()'), 'Missing fetchSCFI in fetchAll');
    assert.ok(seedSrc.includes('fetchCCFI()'), 'Missing fetchCCFI in fetchAll');
    assert.ok(seedSrc.includes('fetchBDI()'), 'Missing fetchBDI in fetchAll');
  });

  it('merges all indices into single array', () => {
    assert.ok(seedSrc.includes("...(sh?.indices || [])"), 'Should spread FRED indices');
    assert.ok(seedSrc.includes('...scfiResult'), 'Should spread SCFI');
    assert.ok(seedSrc.includes('...bdiResult'), 'Should spread BDI');
  });

  it('updated sourceVersion reflects new sources', () => {
    assert.ok(seedSrc.includes("'fred-wto-sse-bdi-budgetlab'"));
  });
});

describe('Handler cache-only (get-shipping-rates.ts)', () => {
  const handlerSrc = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/get-shipping-rates.ts'), 'utf-8');

  it('does not import FRED constants or fetch functions', () => {
    assert.ok(!handlerSrc.includes('FRED_API_BASE'));
    assert.ok(!handlerSrc.includes('fetchFredSeries'));
    assert.ok(!handlerSrc.includes('SHIPPING_SERIES'));
  });

  it('reads seed key raw (bypasses env prefix)', () => {
    assert.ok(handlerSrc.includes('getCachedJson'));
    assert.ok(handlerSrc.includes('true'), 'Should pass raw=true');
  });

  it('returns upstreamUnavailable on cache miss', () => {
    assert.ok(handlerSrc.includes('upstreamUnavailable: true'));
  });

  it('still reads from correct Redis key', () => {
    assert.ok(handlerSrc.includes('supply_chain:shipping:v2'));
  });
});

describe('Panel section grouping (SupplyChainPanel.ts)', () => {
  const panelSrc = readFileSync(resolve(root, 'src/components/SupplyChainPanel.ts'), 'utf-8');

  it('groups indices by type', () => {
    for (const id of ['SCFI', 'CCFI', 'BDI', 'BCI', 'BPI', 'BSI', 'BHSI']) {
      assert.ok(panelSrc.includes(`'${id}'`), `Missing grouping for ${id}`);
    }
  });

  it('renders section headers for each group', () => {
    assert.ok(panelSrc.includes('containerRates'));
    assert.ok(panelSrc.includes('bulkShipping'));
    assert.ok(panelSrc.includes('economicIndicators'));
  });
});
