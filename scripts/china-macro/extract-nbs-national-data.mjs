import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_URL = 'https://data.stats.gov.cn/dg/website/publicrelease/web/external/stream/esData';
const MONEY_CATALOG = '82130c6621a745cda3d64b090e733383';
const TRADE_CATALOG = '7e11b47c828d4e4e925f1c5a98305558';
const DEFINITIONS = new Map([
  ['e03f2232631f41cd9d754a7d7feb4a81', {
    seriesId: 'pboc_m2_yoy', label: '货币和准货币 (M2) 供应量_同比增长 (%)',
    catalog: MONEY_CATALOG, dp: '11', sourceUnit: '%', unit: '%', divisor: 1,
  }],
  ['9e38b39f55a7461ea195508c1bb7dbdc', {
    seriesId: 'gacc_exports', label: '出口总值当期值 (千美元)',
    catalog: TRADE_CATALOG, dp: '1', sourceUnit: '千美元', unit: 'USD million', divisor: 1000,
  }],
  ['86a340fee806409ebdf4d0069bd23f29', {
    seriesId: 'gacc_imports', label: '进口总值当期值 (千美元)',
    catalog: TRADE_CATALOG, dp: '1', sourceUnit: '千美元', unit: 'USD million', divisor: 1000,
  }],
  ['0123bdd4e85348f28efc74685a4a40e5', {
    seriesId: 'gacc_trade_balance', label: '进出口差额当期值 (千美元)',
    catalog: TRADE_CATALOG, dp: '1', sourceUnit: '千美元', unit: 'USD million', divisor: 1000,
  }],
]);
const LABELS = new Set([...DEFINITIONS.values()].map(({ label }) => label));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const labelText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const unknown = (reason) => ({ status: 'unknown', reason });

function fail(reason) {
  throw new Error(`INVALID_NBS_NATIONAL_DATA:${reason}`);
}

// This extracts evidence, not canonical observations. The public table has no
// publication/revision clock. Do not replace either clock with retrievedAt or
// daterange_sdate (the historical start of the series).
export function extractNbsNationalData(raw, { retrievedAt } = {}) {
  const retrievedMs = Date.parse(retrievedAt);
  if (typeof retrievedAt !== 'string' || !Number.isFinite(retrievedMs)
    || new Date(retrievedMs).toISOString() !== retrievedAt) fail('RETRIEVAL_TIME');
  if (typeof raw !== 'string') fail('RAW_RESPONSE_REQUIRED');
  let payload;
  try { payload = JSON.parse(raw); } catch { fail('JSON'); }
  if (!record(payload) || payload.success !== true || payload.state !== 20000
    || !Array.isArray(payload.data)) fail('ENVELOPE');

  const candidates = [];
  const seen = new Set();
  for (const period of payload.data) {
    if (!record(period) || !Array.isArray(period.values)) fail('PERIOD');
    const match = /^(\d{4})(0[1-9]|1[0-2])MM$/.exec(period.code);
    if (!match || Number(match[1]) < 1900
      || period.name !== `${match[1]}年${Number(match[2])}月`) fail('MONTH');
    const observationPeriod = `${match[1]}-${match[2]}`;
    const monthEnd = Date.UTC(Number(match[1]), Number(match[2]), 0, 23, 59, 59, 999);
    const retrievalMonth = retrievedAt.slice(0, 7);
    if (observationPeriod > retrievalMonth) fail('FUTURE_MONTH');
    for (const cell of period.values) {
      if (!record(cell)) fail('CELL');
      const definition = DEFINITIONS.get(cell._id);
      if (!definition) {
        if (LABELS.has(labelText(cell.i_showname))) fail('UNREVIEWED_INDICATOR');
        continue;
      }
      if (cell.catalogid !== definition.catalog || cell.dp !== definition.dp
        || cell.du_name !== definition.sourceUnit || cell.da !== '000000000000'
        || labelText(cell.i_showname) !== definition.label) fail('INDICATOR_BINDING');
      const identity = `${definition.seriesId}:${observationPeriod}`;
      if (seen.has(identity)) fail('DUPLICATE_OBSERVATION');
      seen.add(identity);

      // Empty cells remain unknown, including a newer empty month. Never use
      // Number('') or silently relabel a prior month's value as the newest one.
      const missing = cell.value === '' || cell.value === null;
      if (!missing && monthEnd > retrievedMs) fail('FUTURE_MONTH');
      if (!missing && (typeof cell.value !== 'string'
        || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.value))) fail('NUMERIC_VALUE');
      const value = missing ? null : Number(cell.value) / definition.divisor;
      if (!missing && (!Number.isFinite(value)
        || (definition.divisor === 1000 && !Number.isSafeInteger(Number(cell.value)))
        || (['gacc_exports', 'gacc_imports'].includes(definition.seriesId) && value < 0))) {
        fail('NUMERIC_VALUE');
      }
      candidates.push({
        seriesId: definition.seriesId,
        observationPeriod,
        periodKind: 'month',
        value,
        unit: definition.unit,
        availability: missing ? 'unavailable' : 'extracted',
        unavailableReason: missing ? 'SOURCE_VALUE_MISSING' : null,
        sourceReference: {
          indicatorId: cell._id, catalogId: cell.catalogid,
          sourceValue: cell.value, sourceUnit: cell.du_name,
        },
      });
    }
  }
  return {
    canonicalEligible: false,
    source: 'National Bureau of Statistics of China, National Data',
    sourceUrl: SOURCE_URL,
    attribution: 'Quoted from the website of the National Bureau of Statistics: www.stats.gov.cn',
    retrievedAt,
    contentHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    publication: unknown('NBS_DATABASE_PUBLICATION_TIME_UNAVAILABLE'),
    revision: unknown('NBS_DATABASE_REVISION_TIME_UNAVAILABLE'),
    candidates,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node extract-nbs-national-data.mjs <saved-response.json> <retrievedAt ISO UTC>');
    const result = extractNbsNationalData(readFileSync(process.argv[2], 'utf8'), { retrievedAt: process.argv[3] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
