import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  CPI_MAX_CONTENT_AGE_MIN,
  latestCpiWindow,
  normalizeCpiPeriod,
  normalizeCountrySeries,
  periodMonthOrdinal,
  shiftMonth,
  shiftQuarter,
  splitCsvLine,
  parseSdmxCsv,
  buildNational,
  buildHarmonised,
  cpiContentMeta,
  countCpiPoints,
} from '../scripts/_world-cpi-shared.mjs';
import {
  splitImfCpiRows,
  buildImfCpiPayload,
  validate as validateImf,
  IMF_CPI_KEY,
  IMF_CPI_LATEST_KEY,
} from '../scripts/seed-world-cpi-imf.mjs';
import {
  parseEurostatHicp,
  eurostatGeoMap,
  eurostatHicpUrl,
  EUROSTAT_HICP_KEY,
} from '../scripts/seed-world-cpi-eurostat.mjs';
import { parseOecdCpiRows, OECD_CPI_KEY } from '../scripts/seed-world-cpi-oecd.mjs';
import { estatCpiPeriod, parseEstatCpi, ESTAT_CPI_KEY } from '../scripts/seed-world-cpi-estat.mjs';
import { parseAbsCpiRows, ABS_CPI_KEY, ABS_CPI_ACTIVATION_KEY } from '../scripts/seed-world-cpi-abs.mjs';
import {
  PREFERRED_SOURCE_MAX_LAG_MONTHS,
  WORLD_CPI_CANONICAL_KEYS,
  WORLD_CPI_LATEST_KEYS,
  buildCandidateIndex,
  buildWorldCpiCountries,
  periodStartMs,
  rankCountrySources,
  readingAt,
  selectCountrySeries,
  shiftPeriod,
} from '../server/worldmonitor/economic/v1/world-cpi-monthly';

const ISO3_TO_ISO2 = new Map(
  Object.entries(JSON.parse(readFileSync(new URL('../shared/iso3-to-iso2.json', import.meta.url), 'utf8'))),
);

function points(entries) {
  return entries.map(([date, value]) => ({ date, value }));
}

/** A minimal synthetic source payload: one series per country. */
function sourcePayload(seriesByCountry) {
  return { countries: seriesByCountry };
}

describe('world CPI period math', () => {
  it('normalizes SDMX months, ISO months and quarters', () => {
    assert.equal(normalizeCpiPeriod('2026-M08'), '2026-08');
    assert.equal(normalizeCpiPeriod('2026-08'), '2026-08');
    assert.equal(normalizeCpiPeriod('2026-Q2'), '2026-Q2');
    assert.equal(normalizeCpiPeriod('2026-13'), '2026-13');
    assert.equal(normalizeCpiPeriod('2026'), undefined);
    assert.equal(normalizeCpiPeriod('garbage'), undefined);
  });

  it('shifts months and quarters across year boundaries', () => {
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftQuarter('2026-Q1', -1), '2025-Q4');
    assert.equal(shiftQuarter('2025-Q4', 1), '2026-Q1');
  });

  it('maps a quarter to its first month on the freshness axis', () => {
    assert.equal(periodMonthOrdinal('2026-01'), 2026 * 12 + 1);
    assert.equal(periodMonthOrdinal('2026-Q1'), 2026 * 12 + 1);
    assert.equal(periodMonthOrdinal('2026-Q3'), 2026 * 12 + 7);
  });

  it('shifts period tokens without changing their shape', () => {
    assert.equal(shiftPeriod('2026-08', 6), '2026-02');
    assert.equal(shiftPeriod('2026-Q2', 6), '2025-Q4');
    assert.equal(shiftPeriod('2026-02', 1), '2026-01');
  });
});

describe('country series normalization', () => {
  it('prefers monthly when both frequencies exist and trims to the window', () => {
    const raw = points([
      ['2026-Q2', 200], ['2026-M03', 100], ['2026-M04', 101], ['2026-M05', 102],
    ]);
    const series = normalizeCountrySeries(raw, { indexBase: '2020=100' });
    assert.equal(series.frequency, 'M');
    assert.equal(series.indexBase, '2020=100');
    assert.deepEqual(series.points.map((p) => p.date), ['2026-03', '2026-04', '2026-05']);
  });

  it('falls back to quarterly and keeps only 40 quarters', () => {
    const raw = [];
    for (let i = 0; i < 44; i += 1) {
      raw.push([`${2000 + Math.floor(i / 4)}-Q${(i % 4) + 1}`, 100 + i]);
    }
    const series = normalizeCountrySeries(points(raw));
    assert.equal(series.frequency, 'Q');
    assert.equal(series.points.length, 40);
    assert.equal(series.points[0].date, '2001-Q1');
  });

  it('pins Australia to quarterly even when a monthly series exists', () => {
    const raw = points([['2026-M06', 100], ['2026-M07', 101], ['2026-Q2', 200]]);
    const series = normalizeCountrySeries(raw, { iso2: 'AU' });
    assert.equal(series.frequency, 'Q');
    assert.deepEqual(series.points.map((p) => p.date), ['2026-Q2']);
  });

  it('drops non-positive and non-finite values and deduplicates by period', () => {
    const raw = points([['2026-01', 100], ['2026-01', 111], ['2026-02', 0], ['2026-03', NaN], ['2026-04', 'x']]);
    const series = normalizeCountrySeries(raw);
    assert.deepEqual(series.points, [{ date: '2026-01', value: 111 }]);
  });

  it('returns null when nothing survives', () => {
    assert.equal(normalizeCountrySeries([['2026-01', 0]]), null);
    assert.equal(normalizeCountrySeries([]), null);
  });
});

describe('CSV parsing', () => {
  it('splits quoted fields and embedded commas', () => {
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
    assert.deepEqual(splitCsvLine('a,"b""c",d'), ['a', 'b"c', 'd']);
    assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
  });

  it('parses an SDMX document, tolerating a BOM and blank lines', () => {
    const rows = parseSdmxCsv('\uFEFFCOUNTRY,FREQ,OBS_VALUE\n\nJPN,M,113.6\nUSA,M,153.1\n');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { COUNTRY: 'JPN', FREQ: 'M', OBS_VALUE: '113.6' });
    assert.equal(rows[1].OBS_VALUE, '153.1');
  });

  it('pads short rows instead of dropping trailing columns', () => {
    const rows = parseSdmxCsv('A,B,C\n1,2\n');
    assert.deepEqual(rows[0], { A: '1', B: '2', C: '' });
  });
});

describe('IMF source', () => {
  it('splits national and harmonised rows, mapping ISO-3 to ISO-2 and dropping aggregates', () => {
    const rows = [
      { COUNTRY: 'JPN', INDEX_TYPE: 'CPI', FREQUENCY: 'M', TIME_PERIOD: '2026-M06', OBS_VALUE: '113.6' },
      { COUNTRY: 'DEU', INDEX_TYPE: 'CPI', FREQUENCY: 'M', TIME_PERIOD: '2026-M08', OBS_VALUE: '125.8' },
      { COUNTRY: 'DEU', INDEX_TYPE: 'HICP', FREQUENCY: 'M', TIME_PERIOD: '2026-M08', OBS_VALUE: '136.34' },
      { COUNTRY: 'WLD', INDEX_TYPE: 'CPI', FREQUENCY: 'M', TIME_PERIOD: '2026-M08', OBS_VALUE: '120' },
      { COUNTRY: 'JPN', INDEX_TYPE: 'CPI', FREQUENCY: 'M', TIME_PERIOD: '2026-M07', OBS_VALUE: '' },
      { COUNTRY: 'JPN', INDEX_TYPE: 'CPI', FREQUENCY: 'A', TIME_PERIOD: '2026', OBS_VALUE: '110' },
    ];
    const split = splitImfCpiRows(rows, ISO3_TO_ISO2);
    assert.deepEqual(Object.keys(split.national).sort(), ['DE', 'JP']);
    assert.deepEqual(Object.keys(split.harmonised), ['DE']);
    assert.equal(split.national.JP[0].value, 113.6);
    assert.equal(split.harmonised.DE[0].value, 136.34);
  });

  it('reads the index base from the common reference period', () => {
    const split = splitImfCpiRows([
      { COUNTRY: 'JPN', INDEX_TYPE: 'CPI', FREQUENCY: 'M', TIME_PERIOD: '2026-M06', OBS_VALUE: '113.6', COMMON_REFERENCE_PERIOD: '2020A' },
    ], ISO3_TO_ISO2);
    assert.equal(split.indexBases.CPI.M.JP, '2020=100');
  });

  it('keeps base labels specific to index type and selected frequency', () => {
    const row = (country, indexType, frequency, base) => ({ COUNTRY: country, INDEX_TYPE: indexType, FREQUENCY: frequency, TIME_PERIOD: frequency === 'M' ? '2026-M06' : '2026-Q2', OBS_VALUE: '110', COMMON_REFERENCE_PERIOD: base });
    const monthly = splitImfCpiRows([
      row('DEU', 'CPI', 'M', '2020A'), row('DEU', 'HICP', 'M', '2015A'), row('AUS', 'CPI', 'M', '2020A'),
    ], ISO3_TO_ISO2);
    const quarterly = splitImfCpiRows([row('AUS', 'CPI', 'Q', '2025A')], ISO3_TO_ISO2);
    const data = buildImfCpiPayload(monthly, quarterly);
    assert.equal(data.countries.DE.indexBase, '2020=100');
    assert.equal(data.harmonised.DE.indexBase, '2015=100');
    assert.equal(data.countries.AU.frequency, 'Q');
    assert.equal(data.countries.AU.indexBase, '2025=100');
  });

  it('fails validation below the coverage floor', () => {
    const countries = {};
    for (let i = 0; i < 149; i += 1) countries[`C${i}`] = { frequency: 'M', points: points([['2026-01', 100]]) };
    assert.equal(validateImf({ countries }), false);
    assert.equal(validateImf({}), false);
  });
});

describe('Eurostat source', () => {
  /** Two geos, two months, one dimension each — the JSON-stat stride shape. */
  const jsonstat = {
    id: ['freq', 'unit', 'coicop', 'geo', 'time'],
    size: [1, 1, 1, 2, 2],
    dimension: {
      geo: { category: { index: { DE: 0, EL: 1 } } },
      time: { category: { index: { '2025-11': 0, '2025-12': 1 } } },
    },
    value: { 0: 132.6, 1: 132.8, 2: 129.6, 3: 129.9 },
  };

  it('decodes the flat cube by stride and maps Eurostat geo codes', () => {
    const parsed = parseEurostatHicp(jsonstat, eurostatGeoMap());
    assert.deepEqual(parsed.DE, points([['2025-11', 132.6], ['2025-12', 132.8]]));
    assert.deepEqual(parsed.GR, points([['2025-11', 129.6], ['2025-12', 129.9]]));
    assert.equal(parsed.EL, undefined);
  });

  it('excludes euro area and EU aggregates from country rows', () => {
    const map = eurostatGeoMap();
    assert.equal(map.has('EA20'), false);
    assert.equal(map.has('EU27_2020'), false);
    assert.equal(map.get('EL'), 'GR');
  });

  it('returns nothing for a payload without dimensions', () => {
    assert.deepEqual(parseEurostatHicp({}, eurostatGeoMap()), {});
    assert.deepEqual(parseEurostatHicp(null, eurostatGeoMap()), {});
  });

  // prc_hicp_midx was frozen at 2025-12 when Eurostat moved HICP to ECOICOP
  // ver. 2; its successor prc_hicp_minr keys the basket as coicop18.
  it('queries the live ECOICOP ver. 2 index dataset, not the frozen 1996-2025 one', () => {
    const url = new URL(eurostatHicpUrl());
    assert.match(url.pathname, /\/prc_hicp_minr$/);
    assert.equal(url.searchParams.get('coicop18'), 'TOTAL');
    assert.equal(url.searchParams.get('coicop'), null);
    assert.equal(url.searchParams.get('unit'), 'I15');
    assert.equal(url.searchParams.getAll('geo').length, 29);
  });

  it('decodes the ECOICOP ver. 2 cube, whose basket dimension is coicop18', () => {
    const parsed = parseEurostatHicp({ ...jsonstat, id: ['freq', 'unit', 'coicop18', 'geo', 'time'] }, eurostatGeoMap());
    assert.deepEqual(parsed.DE, points([['2025-11', 132.6], ['2025-12', 132.8]]));
  });
});

describe('OECD source', () => {
  it('keeps only CPI index-level rows and reads the base year', () => {
    const rows = [
      { REF_AREA: 'USA', FREQ: 'M', MEASURE: 'CPI', UNIT_MEASURE: 'IX', TIME_PERIOD: '2026-08', OBS_VALUE: '141.3', BASE_PER: '2015' },
      { REF_AREA: 'USA', FREQ: 'M', MEASURE: 'CPI', UNIT_MEASURE: 'PA', TIME_PERIOD: '2026-08', OBS_VALUE: '3.1', BASE_PER: '2015' },
      { REF_AREA: 'WLD', FREQ: 'M', MEASURE: 'CPI', UNIT_MEASURE: 'IX', TIME_PERIOD: '2026-08', OBS_VALUE: '120', BASE_PER: '2015' },
    ];
    const parsed = parseOecdCpiRows(rows, ISO3_TO_ISO2);
    assert.deepEqual(Object.keys(parsed.byCountry), ['US']);
    assert.equal(parsed.indexBases.US, '2015=100');
  });
});

describe('e-Stat source', () => {
  it('decodes the e-Stat time code and rejects fiscal-year entries', () => {
    assert.equal(estatCpiPeriod('2026000808'), '2026-08');
    assert.equal(estatCpiPeriod('2025001212'), '2025-12');
    assert.equal(estatCpiPeriod('2025100000'), undefined);
    assert.equal(estatCpiPeriod('nonsense'), undefined);
  });

  it('extracts the national all-items series from a getStatsData payload', () => {
    const payload = {
      GET_STATS_DATA: {
        STATISTICAL_DATA: {
          DATA_INF: {
            VALUE: [
              { '@tab': '1', '@time': '2026000808', $: '114.3' },
              { '@tab': '1', '@time': '2026000707', $: '114.2' },
              { '@tab': '1', '@time': '2025100000', $: '999' },
              { '@tab': '1', '@time': '2026000606', $: '' },
            ],
          },
        },
      },
    };
    // The parser preserves document order (e-Stat returns newest first);
    // runSeed's normalization sorts ascending.
    const normalized = buildNational(parseEstatCpi(payload));
    assert.deepEqual(normalized.countries.JP.points, points([['2026-07', 114.2], ['2026-08', 114.3]]));
    assert.deepEqual(parseEstatCpi({}), {});
  });
});

describe('ABS source', () => {
  it('keeps quarterly rows only, in document order until normalized', () => {
    const rows = [
      { FREQ: 'Q', TIME_PERIOD: '2026-Q2', OBS_VALUE: '102.31' },
      { FREQ: 'Q', TIME_PERIOD: '2026-Q1', OBS_VALUE: '101.7' },
      { FREQ: 'M', TIME_PERIOD: '2026-M06', OBS_VALUE: '999' },
      { FREQ: 'Q', TIME_PERIOD: '2025-Q4', OBS_VALUE: '' },
    ];
    // The parser preserves document order; runSeed's normalization sorts.
    const normalized = buildNational(parseAbsCpiRows(rows));
    assert.deepEqual(normalized.countries.AU.points, points([['2026-Q1', 101.7], ['2026-Q2', 102.31]]));
  });
});

describe('source key parity', () => {
  it('pins the seeder keys to the handler keys', () => {
    assert.equal(IMF_CPI_KEY, WORLD_CPI_CANONICAL_KEYS['imf-cpi']);
    assert.equal(IMF_CPI_LATEST_KEY, WORLD_CPI_LATEST_KEYS['imf-cpi']);
    assert.equal(EUROSTAT_HICP_KEY, WORLD_CPI_CANONICAL_KEYS['eurostat-hicp']);
    assert.equal(OECD_CPI_KEY, WORLD_CPI_CANONICAL_KEYS['oecd-cpi']);
    assert.equal(ESTAT_CPI_KEY, WORLD_CPI_CANONICAL_KEYS['estat-cpi']);
    assert.equal(ABS_CPI_KEY, WORLD_CPI_CANONICAL_KEYS['abs-cpi']);
  });

  it('gives every source a distinct canonical and latest key', () => {
    const all = [...Object.values(WORLD_CPI_CANONICAL_KEYS), ...Object.values(WORLD_CPI_LATEST_KEYS)];
    assert.equal(new Set(all).size, all.length);
  });
});

describe('country source selection', () => {
  const imfUs = sourcePayload({ US: { frequency: 'M', points: points([['2026-06', 100], ['2026-07', 101], ['2026-08', 102]]) } });

  it('prefers the IMF feed over OECD for a shared country', () => {
    const oecdUs = sourcePayload({ US: { frequency: 'M', points: points([['2026-08', 500]]) } });
    const selected = selectCountrySeries({ 'imf-cpi': imfUs, 'oecd-cpi': oecdUs });
    assert.equal(selected.US.source, 'imf-cpi');
    assert.equal(selected.US.points.length, 3);
  });

  it('prefers Eurostat HICP for EU countries and keeps the IMF national series for others', () => {
    const sources = {
      'imf-cpi': sourcePayload({
        DE: { frequency: 'M', points: points([['2026-07', 125], ['2026-08', 126]]) },
        US: { frequency: 'M', points: points([['2026-07', 153], ['2026-08', 154]]) },
      }),
      'eurostat-hicp': sourcePayload({
        DE: { frequency: 'M', indexBase: '2015=100', points: points([['2026-07', 136.1], ['2026-08', 136.3]]) },
      }),
    };
    const selected = selectCountrySeries(sources);
    assert.equal(selected.DE.source, 'eurostat-hicp');
    assert.equal(selected.DE.indexBase, '2015=100');
    assert.equal(selected.US.source, 'imf-cpi');
  });

  it('prefers the IMF harmonised series over the IMF national series for Europe', () => {
    const sources = {
      'imf-cpi': {
        countries: { DE: { frequency: 'M', points: points([['2026-08', 125.8]]) } },
        harmonised: { DE: { frequency: 'M', points: points([['2026-08', 136.34]]) } },
      },
    };
    const selected = selectCountrySeries(sources);
    assert.equal(selected.DE.source, 'imf-hicp');
    assert.equal(selected.DE.points[0].value, 136.34);
  });

  it('prefers the Japan e-Stat overlay over the IMF national series', () => {
    const sources = {
      'imf-cpi': sourcePayload({
        JP: { frequency: 'M', points: points([['2026-08', 113.6]]) },
      }),
      'estat-cpi': sourcePayload({ JP: { frequency: 'M', points: points([['2026-07', 114.2], ['2026-08', 114.3]]) } }),
    };
    const selected = selectCountrySeries(sources);
    assert.equal(selected.JP.source, 'estat-cpi');
  });

  it('keeps the IMF quarterly series for AU while it is fresh, and falls back to ABS when it lags', () => {
    const imf = sourcePayload({
      AU: { frequency: 'Q', points: points([['2026-Q1', 101.7], ['2026-Q2', 102.31]]) },
    });
    const abs = sourcePayload({ AU: { frequency: 'Q', points: points([['2026-Q2', 102.31]]) } });
    assert.equal(selectCountrySeries({ 'imf-cpi': imf, 'abs-cpi': abs }).AU.source, 'imf-cpi');

    const stalledImf = sourcePayload({ AU: { frequency: 'Q', points: points([['2024-Q2', 96.41]]) } });
    assert.equal(selectCountrySeries({ 'imf-cpi': stalledImf, 'abs-cpi': abs }).AU.source, 'abs-cpi');
  });

  it('falls through to the next source when the preferred one has stalled', () => {
    const stalledEurostat = sourcePayload({ DE: { frequency: 'M', points: points([['2024-01', 120]]) } });
    const currentOecd = sourcePayload({ DE: { frequency: 'M', points: points([['2026-08', 126]]) } });
    const sources = { 'eurostat-hicp': stalledEurostat, 'oecd-cpi': currentOecd };
    const selected = selectCountrySeries(sources);
    assert.equal(selected.DE.source, 'oecd-cpi');
  });

  it('does NOT fall through while the preferred source is within the lag budget', () => {
    const lagging = sourcePayload({ DE: { frequency: 'M', points: points([['2026-05', 125]]) } });
    const fresher = sourcePayload({ DE: { frequency: 'M', points: points([['2026-08', 126]]) } });
    const sources = { 'eurostat-hicp': lagging, 'oecd-cpi': fresher };
    const selected = selectCountrySeries(sources);
    assert.equal(selected.DE.source, 'eurostat-hicp');
  });

  it('still serves a country whose only source is stale', () => {
    const staleOnly = sourcePayload({ DE: { frequency: 'M', points: points([['2020-01', 100]]) } });
    const selected = selectCountrySeries({ 'eurostat-hicp': staleOnly });
    assert.equal(selected.DE.source, 'eurostat-hicp');
  });

  it('returns an empty selection for empty sources', () => {
    assert.deepEqual(selectCountrySeries({}), {});
    assert.deepEqual(selectCountrySeries(undefined), {});
  });

  it('exposes the lag budget as a constant', () => {
    assert.equal(PREFERRED_SOURCE_MAX_LAG_MONTHS, 6);
  });

  it('ranks a stale candidate below a non-stale one whatever the precedence', () => {
    const index = buildCandidateIndex({
      'eurostat-hicp': sourcePayload({ DE: { frequency: 'M', points: points([['2024-01', 120]]) } }),
      'oecd-cpi': sourcePayload({ DE: { frequency: 'M', points: points([['2026-08', 126]]) } }),
    });
    const ranked = rankCountrySources('DE', index, '2026-08');
    assert.equal(ranked[0].sourceId, 'oecd-cpi');
    assert.equal(ranked[0].stale, false);
    assert.equal(ranked[1].sourceId, 'eurostat-hicp');
    assert.equal(ranked[1].stale, true);
  });
});

describe('wire reading math', () => {
  it('computes monthly changes from the same series and omits missing comparisons', () => {
    const series = points([
      ['2025-07', 100], ['2025-08', 101], ['2026-07', 110], ['2026-08', 111.1],
    ]);
    const map = new Map(series.map((point) => [point.date, point.value]));
    const reading = readingAt(series, map, 3, 'M');
    assert.equal(reading.index, 111.1);
    assert.equal(reading.periodOverPeriod.percent, 1);
    assert.equal(reading.yearOverYear.percent, 10);
  });

  it('uses a quarter offset for quarterly series', () => {
    const series = points([
      ['2025-Q2', 100], ['2025-Q3', 101], ['2026-Q1', 102], ['2026-Q2', 105],
    ]);
    const map = new Map(series.map((point) => [point.date, point.value]));
    const reading = readingAt(series, map, 3, 'Q');
    assert.equal(reading.periodOverPeriod.percent, 2.9412);
    assert.equal(reading.yearOverYear.percent, 5);
  });

  it('omits a change when the comparison period is absent', () => {
    const series = points([['2026-08', 100]]);
    const map = new Map(series.map((point) => [point.date, point.value]));
    const reading = readingAt(series, map, 0, 'M');
    assert.equal(reading.index, 100);
    assert.equal(reading.periodOverPeriod, undefined);
    assert.equal(reading.yearOverYear, undefined);
  });

  it('does not divide by zero', () => {
    const series = points([['2025-08', 0], ['2026-08', 100]]);
    const map = new Map(series.map((point) => [point.date, point.value]));
    const reading = readingAt(series, map, 1, 'M');
    assert.equal(reading.yearOverYear, undefined);
  });

  it('maps a period to its UTC start', () => {
    assert.equal(periodStartMs('2026-08'), Date.UTC(2026, 7, 1));
    assert.equal(periodStartMs('2026-Q2'), Date.UTC(2026, 3, 1));
  });
});

describe('wire country shaping', () => {
  const selected = {
    DE: { source: 'eurostat-hicp', frequency: 'M', indexBase: '2015=100', points: points([['2026-07', 136.1], ['2026-08', 136.3]]) },
    AU: { source: 'abs-cpi', frequency: 'Q', indexBase: '2025=100', points: points([['2026-Q1', 101.7], ['2026-Q2', 102.31]]) },
  };

  it('returns one period per country when history is false', () => {
    const countries = buildWorldCpiCountries(selected, false);
    assert.deepEqual(countries.map((c) => c.country), ['AU', 'DE']);
    for (const country of countries) assert.equal(country.periods.length, 1);
    assert.equal(countries.find((c) => c.country === 'AU').periods[0].period, Date.UTC(2026, 3, 1));
  });

  it('returns every stored period and carries source metadata when history is true', () => {
    const countries = buildWorldCpiCountries(selected, true);
    const de = countries.find((c) => c.country === 'DE');
    assert.equal(de.periods.length, 2);
    assert.equal(de.source, 'eurostat-hicp');
    assert.equal(de.indexBase, '2015=100');
  });

  it('applies an upper-cased country filter', () => {
    const countries = buildWorldCpiCountries(selected, false, 'de');
    assert.deepEqual(countries.map((c) => c.country), ['DE']);
  });

  it('returns nothing for a filter with no match', () => {
    assert.deepEqual(buildWorldCpiCountries(selected, false, 'ZZ'), []);
  });
});

describe('latest window and content age', () => {
  it('keeps the trailing change lag plus the current point', () => {
    const raw = [];
    for (let i = 0; i < 30; i += 1) {
      const month = String((i % 12) + 1).padStart(2, '0');
      raw.push([`${2024 + Math.floor(i / 12)}-${month}`, 100 + i]);
    }
    const windowed = latestCpiWindow(buildNational({ US: points(raw) }), 13);
    assert.equal(windowed.countries.US.points.length, 14);
  });

  it('uses the quarterly lag for a quarterly series', () => {
    const raw = [];
    for (let i = 0; i < 30; i += 1) raw.push([`${2020 + Math.floor(i / 4)}-Q${(i % 4) + 1}`, 100 + i]);
    const windowed = latestCpiWindow(buildNational({ AU: points(raw) }), 13);
    assert.equal(windowed.countries.AU.points.length, 6);
  });

  it('counts points across national and harmonised maps', () => {
    const payload = {
      ...buildNational({ US: points([['2026-08', 1]]) }),
      ...buildHarmonised({ DE: points([['2026-08', 1], ['2026-07', 1]]) }),
    };
    assert.equal(countCpiPoints(payload), 3);
  });

  it('takes the content clock from the newest observation across maps', () => {
    const payload = {
      ...buildNational({ US: points([['2026-06', 1]]) }),
      ...buildHarmonised({ DE: points([['2026-08', 1]]) }),
    };
    const meta = cpiContentMeta(payload);
    assert.equal(new Date(meta.newestItemAt).toISOString().slice(0, 7), '2026-08');
    assert.equal(new Date(meta.oldestItemAt).toISOString().slice(0, 7), '2026-06');
  });

  it('compares mixed monthly and quarterly content clocks chronologically', () => {
    const payload = buildNational({
      US: points([['2026-08', 100]]),
      AU: points([['2026-Q2', 100]]),
      JP: points([['2020-01', 100]]),
    });
    const meta = cpiContentMeta(payload);
    assert.equal(meta.newestItemAt, Date.UTC(2026, 7, 1));
    assert.equal(meta.oldestItemAt, Date.UTC(2020, 0, 1));
  });

  it('declares the Japan source credential before bundle execution', () => {
    const bundle = readFileSync(new URL('../scripts/seed-bundle-macro.mjs', import.meta.url), 'utf8');
    const section = bundle.split('\n').find((line) => line.includes("label: 'World-CPI-JP'"));
    assert.ok(section);
    assert.match(section, /requiredEnv: \['ESTAT_APPID'\]/);
  });

  it('writes the ABS activation marker monitored by health', () => {
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    const block = health.match(/worldCpiAbs: \{([\s\S]*?)\n  \},/);
    assert.ok(block);
    const activationKey = block[1].match(/activationKey: '([^']+)'/);
    assert.equal(ABS_CPI_ACTIVATION_KEY, activationKey?.[1]);
  });

  it('returns null when there is nothing to clock', () => {
    assert.equal(cpiContentMeta({}), null);
  });

  it('budgets each source for its own structural publication lag', () => {
    assert.ok(CPI_MAX_CONTENT_AGE_MIN['abs-cpi'] > CPI_MAX_CONTENT_AGE_MIN['oecd-cpi']);
  });

  // Eurostat publishes month M in the middle of M+1, so a monthly series frozen
  // for most of a year is a dead feed, not publication lag. The 2025-12 freeze
  // of prc_hicp_midx sat inside the old 365-day budget until December 2026.
  it('flags a Eurostat HICP series frozen at 2025-12 by late September 2026', () => {
    const frozen = buildNational({ DE: points([['2025-11', 132.6], ['2025-12', 132.8]]) }, {});
    const meta = cpiContentMeta(frozen);
    assert.ok(meta);
    const ageMin = (Date.UTC(2026, 8, 23) - meta.newestItemAt) / 60_000;
    assert.ok(ageMin > CPI_MAX_CONTENT_AGE_MIN['eurostat-hicp']);
  });

  it('keeps a normally lagged Eurostat HICP print inside its budget', () => {
    const current = buildNational({ DE: points([['2026-07', 136.1], ['2026-08', 136.3]]) }, {});
    const meta = cpiContentMeta(current);
    assert.ok(meta);
    // August's print lands mid-September; one missed month still passes.
    const ageMin = (Date.UTC(2026, 10, 20) - meta.newestItemAt) / 60_000;
    assert.ok(ageMin <= CPI_MAX_CONTENT_AGE_MIN['eurostat-hicp']);
  });
});
