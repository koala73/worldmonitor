import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every parser under test is the REAL exported seeder function, never a
// re-implementation or a `new Function`-eval'd copy of the source: a mirror
// drifts silently from production (#6066), and the #6078 contract gate below is
// only worth anything if it diffs what the seeder actually publishes.
import {
  parseSseIndexResponse,
  parseBdiIndices,
  parseFredShippingIndex,
  accumulateHistory,
  SHIPPING_SERIES,
} from '../scripts/seed-supply-chain-trade.mjs';
// Shared with the sebuf query-param contract gate so both read proto field names
// by the same rule.
import { snakeToCamel } from '../scripts/lib/sebuf-query-param-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const seedSrc = readFileSync(resolve(root, 'scripts/seed-supply-chain-trade.mjs'), 'utf-8');

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
  // currentDate defaults to a real date because an undated observation fails the
  // decision-grade field closed on its own (covered by its own test below).
  const parse = (line, data = {}) => parseSseIndexResponse(
    {
      data: {
        currentDate: '2026-07-18',
        lineDataList: [{ dataItemTypeName: 'CCFI_T', ...line }],
        ...data,
      },
    },
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

  it('keeps the derived direction correct against a negative prior level', () => {
    // The denominator is |prior| (matching the evaluator's own percentage_change
    // convention in shared/china-activity-nowcast.ts), so a rise off a negative
    // prior stays a rise. Without the guard the sign inverts and a strengthening
    // week would be reported as weakening.
    const rising = parse({ currentContent: -50, lastContent: -100 });
    assert.ok(rising.periodChangePct > 0, `rise off a negative prior: ${rising.periodChangePct}`);
    assert.ok(Math.abs(rising.periodChangePct - 50) < 1e-9, `got ${rising.periodChangePct}`);

    const falling = parse({ currentContent: -150, lastContent: -100 });
    assert.ok(falling.periodChangePct < 0, `fall off a negative prior: ${falling.periodChangePct}`);
    assert.ok(Math.abs(falling.periodChangePct + 50) < 1e-9, `got ${falling.periodChangePct}`);
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

  it('publishes no change when SSE does not date the observation', () => {
    // An undated or malformed observation must not receive a synthetic date
    // downstream, where a frozen index could clear the 28-day freshness budget.
    for (const data of [
      {},
      { currentDate: '' },
      { currentDate: 42 },
      { currentDate: 'N/A' },
      { currentDate: '2026-02-30' },
      { currentDate: ' 2026-07-18' },
    ]) {
      const index = parseSseIndexResponse(
        {
          data: {
            lineDataList: [{
              dataItemTypeName: 'CCFI_T',
              currentContent: 1072.16,
              lastContent: 1054.38,
              percentage: 1.69,
            }],
            ...data,
          },
        },
        'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index',
      )[0];
      const label = JSON.stringify(data);
      assert.equal(index.periodChangePct, null, label);
      assert.equal(index.periodChangeBasis, null, label);
      assert.equal(index._observationDate, null, label);
      // The display record still renders — only the decision-grade field fails closed.
      assert.equal(index.currentValue, 1072.16, label);
      assert.equal(index.changePct, 1.69, label);
    }
  });

  it('withholds both prior-period facts when no change was proven', () => {
    // A prior level or date with no change to attach it to describes a comparison
    // that was never made. Each case below supplies a FINITE prior that would
    // otherwise be published next to a null change.
    const zeroPrior = parse({ currentContent: 900, lastContent: 0 }, { lastDate: '2026-07-11' });
    assert.equal(zeroPrior.periodChangePct, null, 'zero prior proves no change');
    assert.equal(zeroPrior.priorPeriodValue, null, 'zero prior is not a comparison');
    assert.equal(zeroPrior.priorPeriodDate, null);

    const undated = parseSseIndexResponse(
      {
        data: {
          lastDate: '2026-07-11',
          lineDataList: [{
            dataItemTypeName: 'CCFI_T',
            currentContent: 1072.16,
            lastContent: 1054.38,
            percentage: 1.69,
          }],
        },
      },
      'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index',
    )[0];
    assert.equal(undated.periodChangePct, null, 'undated observation proves no change');
    assert.equal(undated.priorPeriodValue, null, 'no change means no comparison to report');
    assert.equal(undated.priorPeriodDate, null);

    const noPrior = parse({ currentContent: 900 }, { lastDate: '2026-07-11' });
    assert.equal(noPrior.periodChangePct, null);
    assert.equal(noPrior.priorPeriodValue, null);
    assert.equal(noPrior.priorPeriodDate, null);

    const proven = parse(
      { currentContent: 1072.16, lastContent: 1054.38, percentage: 1.69 },
      { currentDate: '2026-07-18', lastDate: '2026-07-11' },
    );
    assert.equal(proven.priorPeriodValue, 1054.38);
    assert.equal(proven.priorPeriodDate, '2026-07-11');
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
    const indices = parseBdiIndices(BDI_HTML_INCREASED);
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
    const indices = parseBdiIndices(BDI_HTML_UNCHANGED);
    assert.equal(indices.length, 1);
    assert.equal(indices[0].indexId, 'BDI');
    assert.equal(indices[0].currentValue, 1926);
    assert.equal(indices[0].changePct, 0, 'Unchanged should have 0% change');
    assert.equal(indices[0].previousValue, 1926, 'Unchanged: previous = current');
  });

  it('degrades gracefully with partial HTML (only BDI composite)', () => {
    const indices = parseBdiIndices(BDI_HTML_PARTIAL);
    assert.equal(indices.length, 1, 'Should parse only BDI when sub-indices are missing');
    assert.equal(indices[0].indexId, 'BDI');
    assert.equal(indices[0].currentValue, 2000);
  });

  it('returns empty for garbage HTML', () => {
    const indices = parseBdiIndices('<p>No shipping data here.</p>');
    assert.equal(indices.length, 0);
  });

  it('stamps the article date from the heading, falling back to today', () => {
    // _observationDate is what accumulateHistory dedupes history points on, so a
    // silent fallback to today would append a fresh point every cycle and make a
    // frozen index look like it is still moving.
    const dated = parseBdiIndices(`<h1>Baltic Dry Index 13-March-2026</h1>${BDI_HTML_PARTIAL}`);
    assert.equal(dated[0]._observationDate, '2026-03-13');

    const abbreviated = parseBdiIndices(`<h1>Baltic Dry Index 13-Mar-2026</h1>${BDI_HTML_PARTIAL}`);
    assert.equal(abbreviated[0]._observationDate, '2026-03-13', 'abbreviated month names must parse too');

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(parseBdiIndices(BDI_HTML_PARTIAL)[0]._observationDate, today,
      'an undated article falls back to today');

    const unparseable = parseBdiIndices(`<h1>Baltic Dry Index 13-Smarch-2026</h1>${BDI_HTML_PARTIAL}`);
    assert.equal(unparseable[0]._observationDate, today,
      'an unparseable heading date falls back to today rather than yielding Invalid Date');
  });

  it('keeps heading dates stable across positive-offset and UTC timezones', () => {
    const probe = [
      `import { parseBdiIndices } from ${JSON.stringify(resolve(root, 'scripts/seed-supply-chain-trade.mjs'))};`,
      `const html = ${JSON.stringify('<h1>Baltic Dry Index 13-March-2026</h1>Baltic Dry Index (BDI) reached 2,000 points.')};`,
      `console.log(parseBdiIndices(html)[0]?._observationDate ?? '');`,
    ].join('\n');
    const run = (timezone) => execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root,
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
    }).trim();

    assert.equal(run('Pacific/Auckland'), '2026-03-13');
    assert.equal(run('UTC'), '2026-03-13');
  });
});

// ─── FRED parser tests (functional) ───

describe('FRED parser (functional)', () => {
  const cfg = { seriesId: 'PCU483111483111', name: 'Deep Sea Freight Producer Price Index', unit: 'index' };
  const obs = (...values) => ({ observations: values.map(([date, value]) => ({ date, value })) });

  it('builds an index from the newest two observations, oldest-first', () => {
    // FRED is queried sort_order=desc, so the parser reverses into chronological
    // order; current/previous are the LAST two entries after that reversal.
    const index = parseFredShippingIndex(cfg, obs(['2026-03-01', '110'], ['2026-02-01', '100']));
    assert.equal(index.indexId, 'PCU483111483111');
    assert.equal(index.currentValue, 110);
    assert.equal(index.previousValue, 100);
    assert.ok(Math.abs(index.changePct - 10) < 1e-9, `got ${index.changePct}`);
    assert.deepEqual(index.history.map(h => h.date), ['2026-02-01', '2026-03-01']);
  });

  it('drops the "." missing-value sentinel FRED uses for gaps', () => {
    const index = parseFredShippingIndex(cfg, obs(['2026-03-01', '110'], ['2026-02-01', '.'], ['2026-01-01', '100']));
    assert.deepEqual(index.history.map(h => h.value), [100, 110]);
    assert.equal(index.previousValue, 100, 'the sentinel row must not become the prior level');
  });

  it('falls back to current for previousValue on a single-observation series', () => {
    const index = parseFredShippingIndex(cfg, obs(['2026-03-01', '110']));
    assert.equal(index.currentValue, 110);
    assert.equal(index.previousValue, 110);
    assert.equal(index.changePct, 0, 'no prior means no move, not a divide-by-zero');
  });

  it('returns null when no observation is usable', () => {
    assert.equal(parseFredShippingIndex(cfg, obs(['2026-03-01', '.'])), null);
    assert.equal(parseFredShippingIndex(cfg, { observations: [] }), null);
    assert.equal(parseFredShippingIndex(cfg, {}), null);
    assert.equal(parseFredShippingIndex(cfg, null), null);
  });

  it('reports no move when the prior level is zero rather than dividing by it', () => {
    const index = parseFredShippingIndex(cfg, obs(['2026-03-01', '110'], ['2026-02-01', '0']));
    assert.equal(index.changePct, 0);
    assert.ok(Number.isFinite(index.changePct));
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

  it('seeds a first history point only when the observation is dated', () => {
    const dated = accumulateHistory([{
      indexId: 'CCFI', currentValue: 1710, history: [], _observationDate: '2026-03-13',
    }], null);
    assert.deepEqual(dated[0].history, [{ date: '2026-03-13', value: 1710 }]);

    const undated = accumulateHistory([{
      indexId: 'CCFI', currentValue: 1710, history: [], _observationDate: null,
    }], null);
    assert.deepEqual(undated[0].history, []);
  });

  it('preserves existing history without appending an undated observation', () => {
    const existingHistory = [{ date: '2026-03-06', value: 1690 }];
    const result = accumulateHistory([{
      indexId: 'CCFI', currentValue: 1710, history: [], _observationDate: null,
    }], { indices: [{ indexId: 'CCFI', history: existingHistory }] });

    assert.deepEqual(result[0].history, existingHistory);
    assert.equal(result[0]._observationDate, undefined);
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
    assert.deepEqual(result1[0].history, [{ date: '2026-03-14', value: 1900 }],
      'Null payload: the first dated observation seeds history');
    assert.equal(result1[0]._observationDate, undefined, '_observationDate stripped on null payload');

    const result2 = accumulateHistory([{ indexId: 'BDI', currentValue: 1900, history: [], _observationDate: '2026-03-14' }], { indices: [] });
    assert.deepEqual(result2[0].history, [{ date: '2026-03-14', value: 1900 }],
      'Empty indices: the first dated observation seeds history');
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

// ─── Public contract gate: published payload vs `message ShippingIndex` (#6078) ───
//
// #6074 grew every `supply_chain:shipping:v2` entry by four fields while
// `message ShippingIndex` still declared eight. `get-shipping-rates` casts that
// Redis blob straight to `GetShippingRatesResponse` and returns it with no field
// stripping, so `/api/supply-chain/v1/get-shipping-rates` served four properties
// the public contract never declared — and nothing failed, because the schema
// sets no `additionalProperties: false`.
//
// This gate closes that loop from BOTH ends: the declared set is read from the
// proto (the contract source of truth) and the emitted set is produced by the
// real seeder functions, run through the real publish-time history merge. Grow
// the payload without growing the proto and this reds.

const PROTO_PATH = 'proto/worldmonitor/supply_chain/v1/supply_chain_data.proto';
const SHIPPING_PROTO_PATHS = {
  response: 'proto/worldmonitor/supply_chain/v1/get_shipping_rates.proto',
};
const GENERATED_SERVER_PATH = 'src/generated/server/worldmonitor/supply_chain/v1/service_server.ts';

// Keys the seeder uses for its own bookkeeping and MUST delete before publish.
// Anything listed here is asserted below to be (a) genuinely emitted by some
// producer and (b) genuinely gone from the published entry — an allowlist that
// silently covered a leaking field would make this whole gate vacuous.
// Both strips-internal-keys tests iterate this list, so an empty list would make
// them pass with zero assertions executed — a vacuous guard for the exact leak
// they exist to catch. Pin it non-empty at module load.
const INTERNAL_SEEDER_KEYS = ['_observationDate'];
assert.ok(INTERNAL_SEEDER_KEYS.length > 0,
  'INTERNAL_SEEDER_KEYS is empty — the strips-internal-keys tests would pass vacuously');

// Field declarations, tolerating an options bracket (`[deprecated = true]`) —
// the same message already carries `repeated DirectionalDwt directional_dwt = 13
// [deprecated = true];`, so options are a live form here, not a hypothetical.
const PROTO_FIELD_RE = /^\s*(?:optional\s+|repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+\s*(?:\[[^\]]*\])?\s*;/gm;
// Deliberately LOOSER than PROTO_FIELD_RE: it must match every form the field
// regex matches AND the forms it misses, or it cannot detect a parse failure.
// Counting with the same `=\s*\d+\s*;` shape the field regex requires made this
// pin blind to exactly the case it existed for — an options-carrying field drops
// out of both counts and they agree at the wrong number.
const PROTO_FIELD_NUMBER_RE = /=\s*\d+\s*(?:\[[^\]]*\])?\s*[;[]/g;

function declaredFields(messageName, protoPath = PROTO_PATH) {
  const raw = readFileSync(resolve(root, protoPath), 'utf-8');
  // Strip BOTH comment forms from the WHOLE SOURCE before locating the message.
  // Stripping only `//`, or stripping after extraction, both let commented-out
  // proto text keep counting as declared: a block-commented field survived, and
  // a block-commented `message ShippingIndex { ... }` preceding a live one got
  // selected instead of the real message — the gate would then certify fields
  // the proto does not declare.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const block = src.match(new RegExp(`message ${messageName} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(block, `message ${messageName} not found in ${protoPath}`);
  const withoutComments = block;
  const fields = [...withoutComments.matchAll(PROTO_FIELD_RE)].map(m => snakeToCamel(m[1]));
  // Every field-number occurrence in the block must have been understood. A
  // field written in a form the field regex misses would silently shrink the
  // declared set, and the gate would then red on a field that IS declared —
  // loud, but for the wrong reason. Pin the count so the parse failure is
  // reported as itself.
  const fieldNumbers = (withoutComments.match(PROTO_FIELD_NUMBER_RE) ?? []).length;
  assert.equal(fields.length, fieldNumbers,
    `Parsed ${fields.length} of ${fieldNumbers} ${messageName} fields — update PROTO_FIELD_RE`);
  return new Set(fields);
}

// The pure predicate the gate turns on, extracted so it can be attacked
// directly: a check that only ever runs against conforming input proves nothing
// about what it does with a violation.
function undeclaredKeys(entry, declared) {
  return Object.keys(entry).filter(key => !declared.has(key));
}

// Same CCFI envelope as CCFI_FIXTURE but with the publisher's own `percentage`
// omitted, so parseSseIndexResponse takes the `derived_from_prior_period_level`
// branch instead of `publisher_reported`.
const CCFI_DERIVED_FIXTURE = {
  data: {
    currentDate: '2026-03-13',
    lastDate: '2026-03-06',
    lineDataList: [
      {
        properties: { lineName_EN: 'Composite Index' },
        currentContent: 1072.16,
        lastContent: 1054.38,
        dataItemTypeName: 'CCFI_T',
      },
    ],
  },
};

// A bare level with no comparable prior — parseSseIndexResponse's fail-closed
// path, where all four decision fields go null.
const CCFI_NO_PRIOR_FIXTURE = {
  data: {
    currentDate: '2026-03-13',
    lineDataList: [
      { properties: { lineName_EN: 'Composite Index' }, currentContent: 900, dataItemTypeName: 'CCFI_T' },
    ],
  },
};

const FRED_FIXTURE = {
  observations: [
    { date: '2026-03-01', value: '118.4' },
    { date: '2026-02-01', value: '115.2' },
    { date: '2026-01-01', value: '.' },
    { date: '2025-12-01', value: '112.0' },
  ],
};

// The spread sources `fetchAll()` merges into `allIndices` — i.e. every producer
// whose entries reach the published payload. `producedIndices()` below mirrors
// this list by hand, so pin it: a 5th producer added to fetchAll() without a
// matching fixture here would contribute entries the gate never inspects, and
// the gate would stay green while that producer drifted. That is the same
// hand-mirrored-copy failure this whole file exists to avoid, one level up.
// Pinned as the EXACT element lines, not just the spread expressions: matching
// only `...x` made the guard blind to a non-spread element (a bare
// `{ indexId: 'X', ... }` literal pushed straight into the array), which reaches
// the published payload the same way a spread does.
const FETCH_ALL_INDEX_ELEMENTS = [
  '...(sh?.indices || []),',
  '...scfiResult,',
  '...ccfiResult,',
  '...bdiResult,',
];

// Every producer that contributes entries to `allIndices` in fetchAll().
function producedIndices() {
  const fred = SHIPPING_SERIES
    .map(cfg => parseFredShippingIndex(cfg, FRED_FIXTURE))
    .filter(Boolean);
  const sse = [
    // All three SSE branches: SCFI/CCFI carry the publisher's own `percentage`
    // (publisher_reported), CCFI_DERIVED_FIXTURE omits it so the change is
    // derived from the prior level, and CCFI_NO_PRIOR_FIXTURE ships a bare
    // level so the decision fields fail closed. The gate can only see fields a
    // fixture materializes, so a field emitted on one branch alone must still
    // meet a fixture that takes it.
    ...parseSseIndexResponse(SCFI_FIXTURE, 'SCFI', 'SCFI_T', 'SCFI - Shanghai Container Freight', 'index'),
    ...parseSseIndexResponse(CCFI_FIXTURE, 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index'),
    ...parseSseIndexResponse(CCFI_DERIVED_FIXTURE, 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index'),
    ...parseSseIndexResponse(CCFI_NO_PRIOR_FIXTURE, 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index'),
  ];
  // Every BDI article shape: full (delta-bearing), unchanged (no delta match),
  // and partial (only the composite parses).
  const bdi = [
    ...parseBdiIndices(BDI_HTML_INCREASED),
    ...parseBdiIndices(BDI_HTML_UNCHANGED),
    ...parseBdiIndices(BDI_HTML_PARTIAL),
  ];
  // Per-producer counts, not just "non-empty": a fixture that silently stops
  // yielding 4 of its 5 BDI indices would still clear a >0 check while shrinking
  // what the gate actually inspects.
  assert.deepEqual(
    { fred: fred.length, sse: sse.length, bdi: bdi.length },
    { fred: 2, sse: 4, bdi: 7 },
    'Fixture yield changed — the gate now inspects a different set than it was calibrated against; update these counts deliberately',
  );
  return [...fred, ...sse, ...bdi];
}

describe('ShippingIndex public contract gate (#6078)', () => {
  const declared = declaredFields('ShippingIndex');
  const declaredPoint = declaredFields('ShippingRatePoint');

  it('declares the four CCFI period-change fields #6074 introduced', () => {
    for (const field of ['periodChangePct', 'periodChangeBasis', 'priorPeriodValue', 'priorPeriodDate']) {
      assert.ok(declared.has(field), `${field} is served by get-shipping-rates but not declared in ${PROTO_PATH}`);
    }
  });

  it('publishes the period-change basis as a closed, wire-compatible enum', () => {
    const genSrc = readFileSync(resolve(root, GENERATED_SERVER_PATH), 'utf-8');
    assert.match(genSrc, /periodChangeBasis\?: PeriodChangeBasis;/);
    assert.match(genSrc, /export type PeriodChangeBasis = [^;]*"publisher_reported"/);
    assert.match(genSrc, /export type PeriodChangeBasis = [^;]*"derived_from_prior_period_level"/);
    const openapi = JSON.parse(readFileSync(resolve(root, 'docs/api/SupplyChainService.openapi.json'), 'utf-8'));
    const schema = openapi.components?.schemas?.ShippingIndex?.properties?.periodChangeBasis;
    assert.deepEqual(
      schema?.enum?.filter((value) => value !== 'PERIOD_CHANGE_BASIS_UNSPECIFIED').sort(),
      ['derived_from_prior_period_level', 'publisher_reported'],
    );
  });

  it('keeps the generated server interface in step with the proto', () => {
    const genSrc = readFileSync(resolve(root, GENERATED_SERVER_PATH), 'utf-8');
    const block = genSrc.match(/export interface ShippingIndex \{\n([\s\S]*?)\n\}/)?.[1];
    assert.ok(block, `export interface ShippingIndex not found in ${GENERATED_SERVER_PATH}`);
    const generated = [...block.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1]);
    assert.deepEqual(generated.sort(), [...declared].sort(),
      'src/generated is stale — run `make generate` after editing the proto');
  });

  // The real assertion: what the seeder publishes, keyed against what the proto
  // declares. `accumulateHistory` is the last transform before atomicPublish, so
  // its output IS the blob get-shipping-rates hands to clients verbatim.
  for (const [label, previousPayload] of [
    ['first run (no previous payload)', null],
    ['steady state (merging prior history)', { indices: [{ indexId: 'BDI', history: [{ date: '2026-03-12', value: 1900 }] }] }],
  ]) {
    it(`publishes no field ShippingIndex does not declare — ${label}`, () => {
      const published = accumulateHistory(producedIndices(), previousPayload);
      for (const entry of published) {
        assert.deepEqual(undeclaredKeys(entry, declared), [],
          `${entry.indexId} publishes undeclared field(s); declare them in ${PROTO_PATH} and run \`make generate\`, or strip them before publish`);
        // `history` entries are the other message this endpoint serves, one
        // array deep. They reach the published blob without passing through any
        // producer — accumulateHistory both builds new points and copies old
        // ones forward from the previous payload — so the top-level check alone
        // leaves ShippingRatePoint with no drift guard at all.
        for (const point of entry.history ?? []) {
          assert.deepEqual(undeclaredKeys(point, declaredPoint), [],
            `${entry.indexId} publishes a history point with undeclared field(s); declare them on ShippingRatePoint in ${PROTO_PATH}`);
        }
      }
    });
  }

  it('inspects every producer fetchAll() merges into the published payload', () => {
    // Fails CLOSED: if the `allIndices` block cannot be located, the spread list
    // cannot be compared and the gate's coverage claim is unverifiable.
    const block = seedSrc.match(/const allIndices = \[\n([\s\S]*?)\n\s*\];/)?.[1];
    assert.ok(block, 'Could not locate the `const allIndices = [...]` block in the seeder — update this guard');
    // Compare EVERY element line, so an added element of any form (spread or
    // bare object literal) trips the guard.
    const elements = block.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    assert.deepEqual(elements, FETCH_ALL_INDEX_ELEMENTS,
      'fetchAll() changed what feeds `allIndices`. Add a fixture for the new producer to producedIndices() above, then update FETCH_ALL_INDEX_ELEMENTS — otherwise its entries reach the public payload without this gate ever inspecting them.');

    // Composing the array is not the only way to add an entry: appending or
    // reassigning after composition reaches the payload identically, and the
    // element pin above cannot see it. Reproduced as a live evasion, so pin it.
    for (const mutation of [/allIndices\s*\.\s*push\s*\(/, /mergedIndices\s*\.\s*push\s*\(/, /mergedIndices\s*\[[^\]]*\]\s*=/]) {
      assert.ok(!mutation.test(seedSrc),
        `The seeder mutates the composed index list (${mutation}) after fetchAll() builds it. Entries added that way bypass this gate — route them through a producer, or extend the gate to cover the mutation.`);
    }
  });

  it('publishes no envelope field GetShippingRatesResponse does not declare', () => {
    // The gate above guards entries of `indices`; this guards the object that
    // carries them. `get-shipping-rates` casts the whole cached blob to
    // GetShippingRatesResponse with no field stripping — the identical
    // mechanism that produced #6078, one level up. A diagnostic added to
    // fetchAll's return (`degraded`, `sourcesOk`, …) would ship undeclared.
    const declaredEnvelope = declaredFields('GetShippingRatesResponse', SHIPPING_PROTO_PATHS.response);
    const returns = [...seedSrc.matchAll(/\{ indices: [^,]+, fetchedAt: [^,]+, upstreamUnavailable: \w+ \}/g)];
    assert.ok(returns.length >= 2,
      'Could not locate fetchAll()\'s payload return literals — update this guard');
    for (const literal of returns.map(m => m[0])) {
      const keys = [...literal.matchAll(/(\w+):/g)].map(m => m[1]);
      assert.deepEqual([...keys].sort(), [...declaredEnvelope].sort(),
        `fetchAll() returns envelope keys that GetShippingRatesResponse does not declare (or omits declared ones): ${literal}`);
    }
  });

  it('covers both period-change bases, not just the publisher-reported one', () => {
    // A field added on only one branch of parseSseIndexResponse would otherwise
    // slip past a gate whose fixtures all take the other branch.
    const bases = new Set(producedIndices().map(e => e.periodChangeBasis));
    assert.ok(bases.has('publisher_reported'), `missing publisher_reported branch; saw ${[...bases]}`);
    assert.ok(bases.has('derived_from_prior_period_level'), `missing derived branch; saw ${[...bases]}`);
  });

  it('treats FRED entries carrying no period-change fields as a deliberate boundary', () => {
    // FRED publishes an index level with no publisher-reported period change, so
    // parseFredShippingIndex emits none of the four. Pin that as intentional —
    // otherwise a future regression that drops the fields from the SSE producer
    // reads as "matches FRED" rather than as a defect.
    const fred = SHIPPING_SERIES.map(cfg => parseFredShippingIndex(cfg, FRED_FIXTURE)).filter(Boolean);
    assert.ok(fred.length > 0);
    for (const entry of fred) {
      for (const field of ['periodChangePct', 'periodChangeBasis', 'priorPeriodValue', 'priorPeriodDate']) {
        assert.ok(!(field in entry), `FRED entry ${entry.indexId} unexpectedly carries ${field}`);
      }
      assert.deepEqual(undeclaredKeys(entry, declared), []);
    }
  });

  it('actually exercises the period-change fields it is guarding', () => {
    // Without this, a fixture change that stopped emitting the four fields would
    // leave the gate green while guarding nothing.
    const published = accumulateHistory(producedIndices(), null);
    const carriers = published.filter(e => 'periodChangePct' in e);
    assert.ok(carriers.length > 0, 'No produced entry carries periodChangePct — the gate is guarding an empty shape');
    for (const field of ['periodChangeBasis', 'priorPeriodValue', 'priorPeriodDate']) {
      assert.ok(carriers.every(e => field in e), `Produced SSE entries no longer carry ${field}`);
    }
  });

  it('strips every internal bookkeeping key before publish', () => {
    const produced = producedIndices();
    for (const key of INTERNAL_SEEDER_KEYS) {
      assert.ok(produced.some(e => key in e),
        `${key} is allowlisted as internal but no producer emits it — drop it from INTERNAL_SEEDER_KEYS`);
      assert.ok(!declared.has(key), `${key} is allowlisted as internal but the proto declares it`);
    }
    for (const previousPayload of [null, { indices: [{ indexId: 'BDI', history: [] }] }]) {
      for (const entry of accumulateHistory(producedIndices(), previousPayload)) {
        for (const key of INTERNAL_SEEDER_KEYS) {
          assert.ok(!(key in entry), `${key} survived into the published ${entry.indexId} entry`);
        }
      }
    }
  });

  it('strips internal keys on the already-has-history branch too', () => {
    // accumulateHistory strips in two places: the accumulate path (SSE/BDI ship
    // `history: []`) and the early-continue path for entries that arrive with
    // their own history (FRED). Today no producer emits history AND an internal
    // key at once, so the fixtures above never reach the second strip — drop it
    // and they all still pass. Drive that branch directly: the day a producer
    // gains history, the internal key must still not reach the public payload.
    const probes = INTERNAL_SEEDER_KEYS.map((key, i) => ({
      indexId: `PROBE_${i}`, currentValue: 1,
      history: [{ date: '2026-03-13', value: 1 }],
      [key]: '2026-03-13',
    }));
    const previousPayload = { indices: probes.map(p => ({ indexId: p.indexId, history: [{ date: '2026-03-12', value: 1 }] })) };
    const published = accumulateHistory(probes, previousPayload);
    assert.equal(published.length, INTERNAL_SEEDER_KEYS.length);
    for (const entry of published) {
      assert.ok(entry.history.length > 0, 'probe must take the already-has-history branch');
      for (const key of INTERNAL_SEEDER_KEYS) {
        assert.ok(!(key in entry), `${key} survived the already-has-history branch of accumulateHistory`);
      }
    }
  });

  it('reports an undeclared field rather than shrugging at it', () => {
    const entry = accumulateHistory(producedIndices(), null)[0];
    assert.deepEqual(undeclaredKeys({ ...entry, freightRateOutlook: 'bullish' }, declared), ['freightRateOutlook']);
    assert.deepEqual(undeclaredKeys(entry, declared), []);
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
