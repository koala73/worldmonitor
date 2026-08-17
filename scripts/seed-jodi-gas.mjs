#!/usr/bin/env node
// @ts-check

import { inflateRaw } from 'node:zlib';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKey,
  readExistingSeedMeta,
} from './_seed-utils.mjs';
import {
  MAX_JODI_GAS_CONTENT_AGE_MIN,
  assessChinaJodiCoverage,
  buildChinaRowDiagnostic,
  hasFiniteMeasurementAtPaths,
  jodiDatasetContentMeta,
} from './shared/jodi-content-age.mjs';

loadEnvFile(import.meta.url);
const require = createRequire(import.meta.url);
const JODI_MEASUREMENT_FIELDS = require('./shared/jodi-measurement-fields.json');

const inflateRawAsync = promisify(inflateRaw);

export const CANONICAL_KEY = 'energy:jodi-gas:v1:_countries';
export const KEY_PREFIX = 'energy:jodi-gas:v1:';
export const LNG_VULNERABILITY_KEY = 'energy:lng-vulnerability:v1';
export const GAS_TTL = 3_024_000;

const ZIP_URL = 'https://www.jodidata.org/jodi-publisher/gas/17/GAS_world_NewFormat.zip';
const CSV_FILENAME = 'STAGING_world_NewFormat.csv';
const UNIT_FILTER = 'TJ';
export const MIN_COUNTRIES = 50;

export const FLOW_MAP = {
  IMPLNG:   'lngImportsTj',
  IMPPIP:   'pipeImportsTj',
  EXPLNG:   'lngExportsTj',
  EXPPIP:   'pipeExportsTj',
  INDPROD:  'productionTj',
  TOTIMPSB: 'totalImportsTj',
  TOTDEMO:  'totalDemandTj',
  CLOSTLV:  'closingStockTj',
};

export function parseObsValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === 'x') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseCsvRows(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const idxArea   = header.indexOf('REF_AREA');
  const idxPeriod = header.indexOf('TIME_PERIOD');
  const idxFlow   = header.indexOf('FLOW_BREAKDOWN');
  const idxUnit   = header.indexOf('UNIT_MEASURE');
  const idxObs    = header.indexOf('OBS_VALUE');
  const idxAssess = header.indexOf('ASSESSMENT_CODE');

  if (idxArea < 0 || idxPeriod < 0 || idxFlow < 0 || idxUnit < 0 || idxObs < 0) {
    throw new Error('CSV missing required columns');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    const unit = cells[idxUnit]?.trim().replace(/^"|"$/g, '');
    if (unit !== UNIT_FILTER) continue;
    const flow = cells[idxFlow]?.trim().replace(/^"|"$/g, '');
    if (!FLOW_MAP[flow]) continue;
    const assessRaw = idxAssess >= 0 ? cells[idxAssess]?.trim().replace(/^"|"$/g, '') : '';
    const assessNum = Number(assessRaw);
    if (assessNum !== 1 && assessNum !== 2) continue;
    const obs = parseObsValue(cells[idxObs]);
    rows.push({
      area:   cells[idxArea]?.trim().replace(/^"|"$/g, ''),
      period: cells[idxPeriod]?.trim().replace(/^"|"$/g, ''),
      flow,
      obs,
    });
  }
  return rows;
}

export function buildCountryRecords(rows) {
  const byArea = new Map();
  for (const row of rows) {
    if (!byArea.has(row.area)) byArea.set(row.area, []);
    byArea.get(row.area).push(row);
  }

  const records = [];
  for (const [iso2, areaRows] of byArea) {
    const periods = [...new Set(areaRows.map(r => r.period))].sort().reverse();
    let chosen = null;
    for (const p of periods) {
      if (areaRows.some(r => r.period === p)) {
        chosen = p;
        break;
      }
    }
    if (!chosen) continue;

    const chosenRows = areaRows.filter(r => r.period === chosen);
    const fields = {};
    for (const row of chosenRows) {
      const fieldName = FLOW_MAP[row.flow];
      if (fieldName) fields[fieldName] = row.obs;
    }

    const lngImports   = fields.lngImportsTj  ?? null;
    const totalImports = fields.totalImportsTj ?? null;
    let lngShare = null;
    if (lngImports !== null && totalImports !== null && totalImports > 0) {
      lngShare = +(lngImports / totalImports).toFixed(4);
    }

    records.push({
      iso2,
      dataMonth:         chosen,
      productionTj:      fields.productionTj    ?? null,
      lngImportsTj:      fields.lngImportsTj    ?? null,
      pipeImportsTj:     fields.pipeImportsTj   ?? null,
      lngExportsTj:      fields.lngExportsTj    ?? null,
      pipeExportsTj:     fields.pipeExportsTj   ?? null,
      totalImportsTj:    fields.totalImportsTj  ?? null,
      totalDemandTj:     fields.totalDemandTj   ?? null,
      closingStockTj:    fields.closingStockTj  ?? null,
      lngShareOfImports: lngShare,
      seededAt:          new Date().toISOString(),
    });
  }

  return records;
}

export function validateGasCountries(iso2Array) {
  return Array.isArray(iso2Array) && iso2Array.length >= MIN_COUNTRIES;
}

function hasGasMeasurements(record) {
  return hasFiniteMeasurementAtPaths(record, JODI_MEASUREMENT_FIELDS.gas);
}

export function assessChinaGasCoverage(records, now = new Date()) {
  return assessChinaJodiCoverage(records, now, hasGasMeasurements);
}

/**
 * Content age of the published gas snapshot, for runSeed's content-age
 * contract. This is the staleness guard that used to ride on China's data
 * month: when the world file stops advancing, health says STALE_CONTENT
 * instead of serving a frozen vintage as if it were current.
 *
 * @param {Parameters<typeof assessChinaGasCoverage>[0]} records
 * @param {Date} now
 */
export function gasContentMeta(records, now = new Date()) {
  return jodiDatasetContentMeta(records, hasGasMeasurements, now);
}

/**
 * Record — never enforce — China's state for seed-meta.
 *
 * Until #6395 an unusable China row threw here and discarded all 63 parsed
 * countries, so the whole dataset froze for 40 days behind one absent record.
 * The publish now proceeds on the country floor alone (runSeed `validateFn`),
 * and this diagnostic is what keeps the gap visible on /api/health.
 *
 * @param {Parameters<typeof assessChinaGasCoverage>[0]} records
 * @param {Date} now
 * @param {{ readPreviousMeta?: () => Promise<any> }} deps
 */
export async function buildGasChinaRowDiagnostic(records, now = new Date(), deps = {}) {
  const readPreviousMeta = deps.readPreviousMeta ?? (() => readExistingSeedMeta('energy', 'jodi-gas'));
  const previousMeta = await readPreviousMeta();
  if (previousMeta?.chinaRow == null) {
    // readExistingSeedMeta collapses "no prior record" and "read failed" into
    // one null, so an ongoing gap re-dates to this run. Say so, or the reset is
    // indistinguishable from a genuine new outage in the log.
    console.warn('  China gas row: no previous record readable — dating any gap from this run');
  }
  return buildChinaRowDiagnostic(
    assessChinaGasCoverage(records, now),
    previousMeta?.chinaRow ?? null,
    now.getTime(),
  );
}

/**
 * Parse a downloaded world file into country records and say, once, what
 * happened to China. Separated from the download so the no-China path is
 * exercisable without a network round trip.
 *
 * @param {string} csvText
 * @param {Date} now
 */
export function buildGasRecordsFromCsv(csvText, now = new Date()) {
  const rows = parseCsvRows(csvText);
  console.log(`  Rows after TJ/flow/assessment filter: ${rows.length}`);
  const parsed = buildCountryRecords(rows);

  const chinaCoverage = assessChinaGasCoverage(parsed, now);

  // A country whose every field parsed to null is not coverage: it would count
  // toward MIN_COUNTRIES while serving no measurement to anyone. With no
  // single-country gate standing behind that floor any more (#6395), the floor
  // has to mean what it says, so only measurement-bearing countries are
  // published. It also stops a null-only month from overwriting a country's
  // last-good record — the key simply is not rewritten and ages out instead.
  const records = parsed.filter(hasGasMeasurements);
  console.log(`  Countries with gas data: ${records.length} of ${parsed.length} parsed`);
  console.log(chinaCoverage.ok
    ? `  China gas coverage: ok (dataMonth=${chinaCoverage.dataMonth})`
    : `  China gas coverage: ${chinaCoverage.reason} (dataMonth=${chinaCoverage.dataMonth ?? 'missing'})`
      + ` — publishing the other ${records.length} countries anyway`);

  return records;
}

function findZipEntry(buf, filename) {
  const LOCAL_SIG = 0x04034b50;
  let offset = 0;
  while (offset < buf.length - 30) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== LOCAL_SIG) {
      offset++;
      continue;
    }
    const flags        = buf.readUInt16LE(offset + 6);
    const compression  = buf.readUInt16LE(offset + 8);
    const compSize     = buf.readUInt32LE(offset + 18);
    const fnameLen     = buf.readUInt16LE(offset + 26);
    const extraLen     = buf.readUInt16LE(offset + 28);
    const entryName    = buf.slice(offset + 30, offset + 30 + fnameLen).toString('utf8');
    const dataOffset   = offset + 30 + fnameLen + extraLen;
    if (!filename || entryName === filename || entryName.endsWith('/' + filename)) {
      if ((flags & 0x08) && compSize === 0) {
        throw new Error(`JODI Gas ZIP: entry uses data-descriptor (bit 3) — compSize unknown in local header`);
      }
      return { dataOffset, compSize, compression, entryName };
    }
    // If bit 3 is set, compSize in local header is 0 — fall back to byte scan
    if ((flags & 0x08) && compSize === 0) { offset++; continue; }
    offset = dataOffset + compSize;
  }
  return null;
}

async function fetchAndParseCsv() {
  console.log(`  Fetching JODI Gas ZIP from ${ZIP_URL}`);
  const resp = await fetch(ZIP_URL, {
    headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`JODI Gas ZIP fetch failed: HTTP ${resp.status}`);

  const arrayBuf = await resp.arrayBuffer();
  const zipBuf = Buffer.from(arrayBuf);
  console.log(`  ZIP downloaded: ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB`);

  const entry = findZipEntry(zipBuf, CSV_FILENAME);
  if (!entry) throw new Error(`Could not find ${CSV_FILENAME} in ZIP`);
  console.log(`  Found entry: ${entry.entryName} (compression=${entry.compression})`);

  const compressed = zipBuf.slice(entry.dataOffset, entry.dataOffset + entry.compSize);
  let csvBuf;
  if (entry.compression === 0) {
    csvBuf = compressed;
  } else if (entry.compression === 8) {
    csvBuf = await inflateRawAsync(compressed);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compression}`);
  }

  const csvText = csvBuf.toString('utf8');
  console.log(`  CSV size: ${(csvText.length / 1024 / 1024).toFixed(1)} MB`);
  return csvText;
}

async function fetchJodiGas() {
  const csvText = await fetchAndParseCsv();
  console.log('  Parsing CSV rows...');
  return buildGasRecordsFromCsv(csvText);
}

/**
 * @typedef {{ iso2: string, lngShareOfImports: number|null, lngImportsTj: number|null, pipeImportsTj: number|null, dataMonth: string }} GasRecord
 */

/**
 * Build the LNG vulnerability index from country records.
 * @param {GasRecord[]} members
 * @param {string} dataMonth
 * @param {string} updatedAt
 */
export function buildLngVulnerabilityIndex(members, dataMonth, updatedAt) {
  const withLng = members.filter(
    r => r.lngShareOfImports !== null && typeof r.lngShareOfImports === 'number' && (r.lngImportsTj ?? 0) > 0,
  );
  const withPipe = members.filter(
    r => r.lngShareOfImports !== null && typeof r.lngShareOfImports === 'number' && (r.pipeImportsTj ?? 0) > 0,
  );

  const top20LngDependent = withLng
    .sort((a, b) => /** @type {number} */ (b.lngShareOfImports) - /** @type {number} */ (a.lngShareOfImports))
    .slice(0, 20)
    .map(r => ({
      iso2: r.iso2,
      lngShareOfImports: /** @type {number} */ (r.lngShareOfImports),
      lngImportsTj: /** @type {number} */ (r.lngImportsTj),
    }));

  const top20PipelineDependent = withPipe
    .sort((a, b) => /** @type {number} */ (a.lngShareOfImports) - /** @type {number} */ (b.lngShareOfImports))
    .slice(0, 20)
    .map(r => ({
      iso2: r.iso2,
      lngShareOfImports: /** @type {number} */ (r.lngShareOfImports),
      pipeImportsTj: /** @type {number} */ (r.pipeImportsTj),
    }));

  return { updatedAt, dataMonth, top20LngDependent, top20PipelineDependent };
}

const isMain = process.argv[1]?.endsWith('seed-jodi-gas.mjs');

export function declareRecords(data) {
  return Array.isArray(data) ? data.length : 0;
}

if (isMain) {
  await runSeed('energy', 'jodi-gas', CANONICAL_KEY, fetchJodiGas, {
    ttlSeconds: GAS_TTL,
    metaTtlSeconds: GAS_TTL,
    validateFn: validateGasCountries,
    publishTransform: (records) => records.map(r => r.iso2),
    recordCount: (records) => (Array.isArray(records) ? records.length : 0),
    extraKeys: [
      {
        key: LNG_VULNERABILITY_KEY,
        ttl: GAS_TTL,
        transform: (records) => {
          const updatedAt = new Date().toISOString();
          const dataMonths = records.map(r => r.dataMonth).filter(Boolean).sort();
          const dataMonth = dataMonths[dataMonths.length - 1] ?? '';
          return buildLngVulnerabilityIndex(records, dataMonth, updatedAt);
        },
      },
    ],
    afterPublish: async (records) => {
      for (const record of records) {
        await writeExtraKey(`${KEY_PREFIX}${record.iso2}`, record, GAS_TTL);
      }
      // LNG vulnerability index is now written via extraKeys (gets TTL-preserved on failure)
      return { freshnessMetaPatch: { chinaRow: await buildGasChinaRowDiagnostic(records) } };
    },
    contentMeta: gasContentMeta,
    maxContentAgeMin: MAX_JODI_GAS_CONTENT_AGE_MIN,

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 57600,
    sourceVersion: 'jodi-gas-v1',
  });
}
