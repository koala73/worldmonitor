#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from '@e965/xlsx';
import { CHROME_UA, getRedisCredentials, loadEnvFile, withRetry, writeExtraKeyWithMetaAtomically } from './_seed-utils.mjs';
import { readBoundedResponseBytes } from './_china-exchange-transport.mjs';
import { upstashCommand } from './_upstash-rest.mjs';

export const PRIOR_YEAR = 2025;
export const PRIOR_INDICATOR = 'GOV_WGI_PV.EST';
export const PRIOR_KEY = 'intelligence:cii-structural-prior:v1';
export const PRIOR_META_KEY = 'seed-meta:intelligence:cii-structural-prior';
export const PRIOR_ACTIVATION_KEY = 'seed-activated:intelligence:cii-structural-prior';
export const PRIOR_TTL_SECONDS = 400 * 86400;
export const PRIOR_API_URL = `https://api.worldbank.org/v2/country/all/indicator/${PRIOR_INDICATOR}?format=json&per_page=20000&date=${PRIOR_YEAR}`;
export const PRIOR_BULK_URL = 'https://datacatalogfiles.worldbank.org/ddh-published/0038026/DR0095947/WGI%202026%20Governance%20Estimates%20and%20Scores%20%281996-2025%29.xlsx';
// Railway's scripts-only root cannot import shared/cii-weights.ts. A parity
// test guards this list; adding a scored country requires updating both.
export const PRIOR_SCORED_COUNTRIES = Object.freeze([
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR', 'PL',
  'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE', 'CU', 'MX',
  'BR', 'AE', 'KR', 'IQ', 'AF', 'LB', 'EG', 'JP', 'QA',
]);

export function readTaiwanPrior(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', sheets: ['pv'] });
  const sheet = workbook.Sheets.pv;
  if (!sheet) throw new Error('WGI bulk release lacks the pv worksheet');
  const [header, ...rows] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const columns = ['Economy (code)', 'Year', 'Governance dimension', 'Governance estimate (approx. -2.5 to +2.5)']
    .map((name) => header?.indexOf(name) ?? -1);
  if (columns.some((index) => index < 0)) throw new Error('WGI bulk columns changed');
  const [code, year, dimension, estimate] = columns;
  const matches = rows.filter((row) => row[code] === 'TWN' && row[year] === PRIOR_YEAR && row[dimension] === 'pv');
  if (matches.length !== 1 || !Number.isFinite(matches[0][estimate])) {
    throw new Error(`WGI bulk release lacks one finite TWN PV estimate for ${PRIOR_YEAR}`);
  }
  return { pv: matches[0][estimate], year: PRIOR_YEAR, source: PRIOR_BULK_URL };
}

export function buildStructuralPrior(apiResponse, bulkBuffer, nowMs = Date.now()) {
  const [meta, rows] = apiResponse ?? [];
  if (Number(meta?.pages) !== 1 || !Array.isArray(rows) || Number(meta?.total) !== rows.length) {
    throw new Error('Incomplete World Bank prior response');
  }
  const countries = {};
  for (const row of rows) {
    if (String(row.date) !== String(PRIOR_YEAR)) continue;
    if (row.indicator?.id !== PRIOR_INDICATOR) throw new Error('Unexpected WGI indicator');
    const code = row.country?.id;
    if (!/^[A-Z]{2}$/.test(code ?? '') || !Number.isFinite(row.value)) continue;
    if (countries[code] && countries[code].pv !== row.value) throw new Error(`Conflicting prior for ${code}`);
    countries[code] = { pv: row.value, year: PRIOR_YEAR, source: PRIOR_API_URL };
  }
  countries.TW = readTaiwanPrior(bulkBuffer);
  const missing = PRIOR_SCORED_COUNTRIES.filter((code) => !countries[code]);
  if (missing.length) throw new Error(`Missing ${PRIOR_YEAR} WGI prior: ${missing.join(', ')}`);
  return { indicator: PRIOR_INDICATOR, year: PRIOR_YEAR, license: 'CC BY 4.0', fetchedAt: nowMs, countries };
}

async function activatePrior() {
  const { url, token } = getRedisCredentials();
  await withRetry(() => upstashCommand({ restUrl: url, token }, ['SET', PRIOR_ACTIVATION_KEY, '1']), 2, 750);
}

export async function seedStructuralPrior({ fetchImpl = globalThis.fetch, publish = writeExtraKeyWithMetaAtomically, activate = activatePrior, dryRun = false, nowMs = Date.now() } = {}) {
  async function download(url, maxBytes) {
    return withRetry(async () => {
      const response = await fetchImpl(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`WGI fetch failed: HTTP ${response.status}`);
      return readBoundedResponseBytes(response, maxBytes);
    }, 2, 750);
  }
  const [apiBytes, bulkBytes] = await Promise.all([
    download(PRIOR_API_URL, 2 * 1024 * 1024),
    download(PRIOR_BULK_URL, 20 * 1024 * 1024),
  ]);
  // Validate the complete snapshot before the first write. A failed source or
  // missing country leaves both last-good data and its original age intact.
  const payload = buildStructuralPrior(JSON.parse(new TextDecoder().decode(apiBytes)), bulkBytes, nowMs);
  if (!dryRun) {
    const published = await publish({ key: PRIOR_KEY, data: payload, ttlSeconds: PRIOR_TTL_SECONDS,
      recordCount: Object.keys(payload.countries).length, metaKey: PRIOR_META_KEY,
      metaTtlSeconds: PRIOR_TTL_SECONDS, fetchedAt: nowMs });
    if (published !== true) throw new Error('Structural prior publish failed');
    await activate();
  }
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const startedAt = Date.now();
  loadEnvFile(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');
  seedStructuralPrior({ dryRun }).then((payload) => {
    console.log(JSON.stringify({ dryRun, year: payload.year, recordCount: Object.keys(payload.countries).length, countries: payload.countries }));
    console.log(`=== Done (${Date.now() - startedAt}ms) ===`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
