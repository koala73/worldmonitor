#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  logSeedResult,
  withRetry,
  readSeedSnapshot,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:jodi-oil:v1:_countries';
export const COUNTRY_KEY_PREFIX = 'energy:jodi-oil:v1:';
export const JODI_TTL = 3_024_000; // 35 days
const META_KEY = 'seed-meta:energy:jodi-oil';
const LOCK_DOMAIN = 'energy:jodi-oil';
const LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_VALID_COUNTRIES = 40;
const ANOMALY_DEMAND_KBD = 10_000;

const JODI_BASE = 'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/';

const SECONDARY_PRODUCTS = {
  GASOLINE: 'gasoline',
  GASDIES: 'diesel',
  JETKERO: 'jet',
  RESFUEL: 'fuelOil',
  LPG: 'lpg',
};

function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

export function parseCsv(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = splitCsvLine(line);
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = parts[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

export function parseObsValue(raw) {
  if (!raw || raw === '-' || raw === 'x' || raw.toLowerCase() === 'na') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function extractCountryData(allRows, iso2) {
  const rows = allRows.filter(r => r.REF_AREA === iso2 && r.UNIT_MEASURE === 'KBD');

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.TIME_PERIOD;
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }

  const sortedMonths = [...byMonth.keys()].sort((a, b) => b.localeCompare(a));

  let dataMonth = null;
  for (const month of sortedMonths) {
    const monthRows = byMonth.get(month);
    const hasValidCode = monthRows.some(r => r.ASSESSMENT_CODE === '1' || r.ASSESSMENT_CODE === '2');
    if (!hasValidCode) continue;
    // Require at least one valid secondary-product row so a failed secondary
    // download (crude-only month) never becomes the chosen dataMonth.
    const hasSecondaryData = monthRows.some(
      r => (r.ASSESSMENT_CODE === '1' || r.ASSESSMENT_CODE === '2') && r.ENERGY_PRODUCT in SECONDARY_PRODUCTS,
    );
    if (hasSecondaryData) {
      dataMonth = month;
      break;
    }
  }

  if (!dataMonth) return null;

  const monthRows = byMonth.get(dataMonth) || [];

  function pickVal(product, flow, isAnomalyCapped) {
    const r = monthRows.find(row => row.ENERGY_PRODUCT === product && row.FLOW_BREAKDOWN === flow);
    if (!r) return null;
    const code = r.ASSESSMENT_CODE;
    if (code === '3') return null;
    const val = parseObsValue(r.OBS_VALUE);
    if (val === null) return null;
    if (isAnomalyCapped && iso2 !== 'US' && flow === 'TOTDEMO' && val > ANOMALY_DEMAND_KBD) return null;
    return val;
  }

  const seededAt = new Date().toISOString();

  const secondaryProducts = {};
  for (const [prodCode, prodName] of Object.entries(SECONDARY_PRODUCTS)) {
    secondaryProducts[prodName] = {
      demandKbd:    pickVal(prodCode, 'TOTDEMO',  true),
      refOutputKbd: pickVal(prodCode, 'REFGROUT', false),
      importsKbd:   pickVal(prodCode, 'TOTIMPSB', false),
      exportsKbd:   pickVal(prodCode, 'TOTEXPSB', false),
    };
  }

  let crudeProductionKbd = null;
  let crudeRefineryIntakeKbd = null;
  let crudeImportsKbd = null;
  let crudeExportsKbd = null;

  for (const prodCode of ['CRUDEOIL', 'TOTCRUDE']) {
    if (crudeProductionKbd === null) {
      crudeProductionKbd = pickVal(prodCode, 'INDPROD', false);
    }
    if (crudeRefineryIntakeKbd === null) {
      crudeRefineryIntakeKbd = pickVal(prodCode, 'REFINOBS', false);
    }
    if (crudeImportsKbd === null) {
      crudeImportsKbd = pickVal(prodCode, 'TOTIMPSB', false);
    }
    if (crudeExportsKbd === null) {
      crudeExportsKbd = pickVal(prodCode, 'TOTEXPSB', false);
    }
  }

  return {
    iso2,
    dataMonth,
    ...secondaryProducts,
    crude: {
      productionKbd:     crudeProductionKbd,
      refineryIntakeKbd: crudeRefineryIntakeKbd,
      importsKbd:        crudeImportsKbd,
      exportsKbd:        crudeExportsKbd,
    },
    seededAt,
  };
}

export function buildAllCountries(allRows) {
  const countries = new Set(allRows.filter(r => r.REF_AREA && r.UNIT_MEASURE === 'KBD').map(r => r.REF_AREA));
  const results = [];
  for (const iso2 of countries) {
    const data = extractCountryData(allRows, iso2);
    if (data) results.push(data);
  }
  return results;
}

export function validateCoverage(countries) {
  return countries.length >= MIN_VALID_COUNTRIES;
}

async function fetchCsv(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`JODI CSV fetch failed: HTTP ${resp.status} for ${url}`);
  return resp.text();
}

export function mergeSourceRows(primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior) {
  if (!secondaryCurrent && !secondaryPrior) {
    throw new Error('Both secondary JODI CSV files failed to download; product-level data unavailable');
  }
  const allRows = [
    ...(primaryCurrent ? parseCsv(primaryCurrent) : []),
    ...(primaryPrior ? parseCsv(primaryPrior) : []),
    ...(secondaryCurrent ? parseCsv(secondaryCurrent) : []),
    ...(secondaryPrior ? parseCsv(secondaryPrior) : []),
  ];
  return allRows.filter(r => r.UNIT_MEASURE === 'KBD');
}

async function fetchAllRows() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const priorYear = currentYear - 1;

  const [primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior] = await Promise.all([
    withRetry(() => fetchCsv(`${JODI_BASE}primary/${currentYear}.csv`), 2, 2000)
      .catch(e => { console.warn(`  primary/${currentYear}.csv failed: ${e.message}`); return ''; }),
    withRetry(() => fetchCsv(`${JODI_BASE}primary/${priorYear}.csv`), 2, 2000)
      .catch(e => { console.warn(`  primary/${priorYear}.csv failed: ${e.message}`); return ''; }),
    withRetry(() => fetchCsv(`${JODI_BASE}secondary/${currentYear}.csv`), 2, 2000)
      .catch(e => { console.warn(`  secondary/${currentYear}.csv failed: ${e.message}`); return ''; }),
    withRetry(() => fetchCsv(`${JODI_BASE}secondary/${priorYear}.csv`), 2, 2000)
      .catch(e => { console.warn(`  secondary/${priorYear}.csv failed: ${e.message}`); return ''; }),
  ]);

  return mergeSourceRows(primaryCurrent, primaryPrior, secondaryCurrent, secondaryPrior);
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function main() {
  const startedAt = Date.now();
  const runId = `jodi-oil:${startedAt}`;

  console.log('=== energy:jodi-oil Seed ===');
  console.log(`  Run ID: ${runId}`);
  console.log(`  Key prefix: ${COUNTRY_KEY_PREFIX}`);

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('  SKIPPED: another seed run in progress');
    return;
  }

  try {
    console.log('  Fetching JODI CSV data (4 files)...');
    const allRows = await withRetry(fetchAllRows, 2, 3000);

    if (!allRows.length) {
      throw new Error('No KBD rows parsed from JODI CSV files');
    }

    console.log(`  Parsed ${allRows.length} KBD rows`);

    const countries = buildAllCountries(allRows);
    console.log(`  Built ${countries.length} country payloads`);

    if (!validateCoverage(countries)) {
      console.error(`  COVERAGE GATE FAILED: only ${countries.length} countries, need >=${MIN_VALID_COUNTRIES}`);
      const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
      const prevCountryKeys = Array.isArray(prevIso2List)
        ? prevIso2List.map(iso2 => `${COUNTRY_KEY_PREFIX}${iso2}`)
        : countries.map(c => `${COUNTRY_KEY_PREFIX}${c.iso2}`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], JODI_TTL);
      return;
    }

    const iso2List = countries.map(c => c.iso2);
    const metaPayload = { fetchedAt: Date.now(), recordCount: countries.length };

    const commands = [];
    for (const payload of countries) {
      commands.push(['SET', `${COUNTRY_KEY_PREFIX}${payload.iso2}`, JSON.stringify(payload), 'EX', JODI_TTL]);
    }
    commands.push(['SET', CANONICAL_KEY, JSON.stringify(iso2List), 'EX', JODI_TTL]);
    commands.push(['SET', META_KEY, JSON.stringify(metaPayload), 'EX', JODI_TTL]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('energy', countries.length, Date.now() - startedAt, { source: 'jodi-oil' });
    console.log(`  Seeded ${countries.length} countries`);
    console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
  } catch (err) {
    console.error(`  SEED FAILED: ${err.message}`);
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
    const prevCountryKeys = Array.isArray(prevIso2List)
      ? prevIso2List.map(iso2 => `${COUNTRY_KEY_PREFIX}${iso2}`)
      : [];
    await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], JODI_TTL).catch(() => {});
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-jodi-oil.mjs');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
