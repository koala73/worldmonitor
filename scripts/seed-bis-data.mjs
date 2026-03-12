#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const BIS_BASE = 'https://stats.bis.org/api/v1/data';

const BIS_COUNTRIES = {
  US: { name: 'United States', centralBank: 'Federal Reserve' },
  GB: { name: 'United Kingdom', centralBank: 'Bank of England' },
  JP: { name: 'Japan', centralBank: 'Bank of Japan' },
  XM: { name: 'Euro Area', centralBank: 'ECB' },
  CH: { name: 'Switzerland', centralBank: 'Swiss National Bank' },
  SG: { name: 'Singapore', centralBank: 'MAS' },
  IN: { name: 'India', centralBank: 'Reserve Bank of India' },
  AU: { name: 'Australia', centralBank: 'RBA' },
  CN: { name: 'China', centralBank: "People's Bank of China" },
  CA: { name: 'Canada', centralBank: 'Bank of Canada' },
  KR: { name: 'South Korea', centralBank: 'Bank of Korea' },
  BR: { name: 'Brazil', centralBank: 'Banco Central do Brasil' },
};

const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

const KEYS = {
  policy:   'economic:bis:policy:v1',
  exchange: 'economic:bis:eer:v1',
  credit:   'economic:bis:credit:v1',
};

const TTL = 43200; // 12 hours

async function fetchBisCSV(dataset, key) {
  const separator = key.includes('?') ? '&' : '?';
  const url = `${BIS_BASE}/${dataset}/${key}${separator}format=csv`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`BIS HTTP ${resp.status} for ${dataset}`);
  return resp.text();
}

function parseBisCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

function parseBisNumber(val) {
  if (!val || val === '.' || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function groupByCountry(rows) {
  const byCountry = new Map();
  for (const row of rows) {
    const cc = row['REF_AREA'] || row['BORROWERS_CTY'] || row['Reference area'] || '';
    const date = row['TIME_PERIOD'] || row['Time period'] || '';
    const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
    if (!cc || !date || val === null) continue;
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    byCountry.get(cc).push({ date, value: val });
  }
  return byCountry;
}

// --- Policy Rates (WS_CBPOL) ---
async function fetchPolicyRates() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

  const csv = await fetchBisCSV('WS_CBPOL', `M.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseBisCSV(csv));

  const rates = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const previous = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (latest) {
      rates.push({
        countryCode: cc, countryName: info.name,
        rate: latest.value, previousRate: previous?.value ?? latest.value,
        date: latest.date, centralBank: info.centralBank,
      });
    }
  }
  console.log(`  Policy rates: ${rates.length} countries`);
  return rates.length > 0 ? { rates } : null;
}

// --- Exchange Rates (WS_EER) ---
async function fetchExchangeRates() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

  const csv = await fetchBisCSV('WS_EER', `M.R.B.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseBisCSV(csv));

  const rates = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const prev = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (latest) {
      const realChange = prev
        ? Math.round(((latest.value - prev.value) / prev.value) * 1000) / 10
        : 0;
      rates.push({
        countryCode: cc, countryName: info.name,
        realEer: Math.round(latest.value * 100) / 100, nominalEer: 0,
        realChange, date: latest.date,
      });
    }
  }
  console.log(`  Exchange rates: ${rates.length} countries`);
  return rates.length > 0 ? { rates } : null;
}

// --- Credit to GDP (WS_TC) ---
async function fetchCreditToGdp() {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const startPeriod = `${twoYearsAgo.getFullYear()}-Q1`;

  const csv = await fetchBisCSV('WS_TC', `Q.${BIS_COUNTRY_KEYS}.C.A.M.770.A?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseBisCSV(csv));

  const entries = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const previous = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (latest) {
      entries.push({
        countryCode: cc, countryName: info.name,
        creditGdpRatio: Math.round(latest.value * 10) / 10,
        previousRatio: previous ? Math.round(previous.value * 10) / 10 : Math.round(latest.value * 10) / 10,
        date: latest.date,
      });
    }
  }
  console.log(`  Credit-to-GDP: ${entries.length} countries`);
  return entries.length > 0 ? { entries } : null;
}

// --- Main seed ---
let seedData = null;

async function fetchAll() {
  const [policy, exchange, credit] = await Promise.all([
    fetchPolicyRates(),
    fetchExchangeRates(),
    fetchCreditToGdp(),
  ]);
  seedData = { policy, exchange, credit };
  const total = (policy?.rates?.length || 0) + (exchange?.rates?.length || 0) + (credit?.entries?.length || 0);
  if (total === 0) throw new Error('All BIS fetches returned empty');
  return seedData;
}

function validate(data) {
  return data?.policy || data?.exchange || data?.credit;
}

runSeed('economic', 'bis', KEYS.policy, fetchAll, {
  validateFn: validate,
  ttlSeconds: TTL,
  sourceVersion: 'bis-sdmx-csv',
}).then(async (result) => {
  if (result?.skipped || !seedData) return;
  if (seedData.exchange) await writeExtraKey(KEYS.exchange, seedData.exchange, TTL);
  if (seedData.credit) await writeExtraKey(KEYS.credit, seedData.credit, TTL);
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
