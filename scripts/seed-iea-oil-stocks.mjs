#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:iea-oil-stocks:v1:index';
export const IEA_90_DAY_OBLIGATION = 90;
const TTL_SECONDS = 40 * 24 * 3600;

export const COUNTRY_MAP = {
  'Australia': 'AU', 'Japan': 'JP', 'Korea': 'KR', 'New Zealand': 'NZ',
  'Austria': 'AT', 'Belgium': 'BE', 'Czech Republic': 'CZ', 'Denmark': 'DK',
  'Estonia': 'EE', 'Finland': 'FI', 'France': 'FR', 'Germany': 'DE',
  'Greece': 'GR', 'Hungary': 'HU', 'Ireland': 'IE', 'Italy': 'IT',
  'Latvia': 'LV', 'Lithuania': 'LT', 'Luxembourg': 'LU', 'Netherlands': 'NL',
  'Poland': 'PL', 'Portugal': 'PT', 'Slovak Republic': 'SK', 'Spain': 'ES',
  'Sweden': 'SE', 'Switzerland': 'CH', 'Türkiye': 'TR', 'United Kingdom': 'GB',
  'Canada': 'CA', 'Mexico': 'MX', 'United States': 'US', 'Norway': 'NO',
};

const parseIntOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

export function parseRecord(record, seededAt) {
  const iso2 = COUNTRY_MAP[record.countryName];
  if (!iso2) return null;

  const ym = String(record.yearMonth);
  const dataMonth = `${ym.slice(0, 4)}-${ym.slice(4)}`;
  const ts = seededAt || new Date().toISOString();

  if (record.total === 'Net Exporter') {
    return {
      iso2,
      dataMonth,
      daysOfCover: null,
      netExporter: true,
      industryDays: null,
      publicDays: null,
      abroadDays: null,
      belowObligation: false,
      obligationThreshold: IEA_90_DAY_OBLIGATION,
      seededAt: ts,
    };
  }

  const raw = parseInt(record.total, 10);
  if (!Number.isFinite(raw)) return null;

  if (raw > 500) {
    return {
      iso2,
      dataMonth,
      daysOfCover: null,
      netExporter: false,
      industryDays: parseIntOrNull(record.industry),
      publicDays: parseIntOrNull(record.publicData),
      abroadDays: (parseIntOrNull(record.abroadIndustry) ?? 0) + (parseIntOrNull(record.abroadPublic) ?? 0),
      belowObligation: false,
      obligationThreshold: IEA_90_DAY_OBLIGATION,
      anomaly: true,
      seededAt: ts,
    };
  }

  const daysOfCover = raw;
  return {
    iso2,
    dataMonth,
    daysOfCover,
    netExporter: false,
    industryDays: parseIntOrNull(record.industry),
    publicDays: parseIntOrNull(record.publicData),
    abroadDays: (parseIntOrNull(record.abroadIndustry) ?? 0) + (parseIntOrNull(record.abroadPublic) ?? 0),
    belowObligation: daysOfCover !== null && daysOfCover < IEA_90_DAY_OBLIGATION,
    obligationThreshold: IEA_90_DAY_OBLIGATION,
    seededAt: ts,
  };
}

export function buildIndex(members, dataMonth, updatedAt) {
  return {
    dataMonth,
    updatedAt,
    members: members.map(m => ({
      iso2: m.iso2,
      daysOfCover: m.daysOfCover,
      netExporter: m.netExporter,
      belowObligation: m.belowObligation,
    })),
  };
}

async function fetchIeaOilStocks() {
  const latestResp = await fetch('https://api.iea.org/netimports/latest', {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!latestResp.ok) throw new Error(`IEA latest HTTP ${latestResp.status}`);
  const { year, month } = await latestResp.json();

  const monthlyUrl = `https://api.iea.org/netimports/monthly/?year=${year}&month=${month}`;
  const monthlyResp = await fetch(monthlyUrl, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!monthlyResp.ok) throw new Error(`IEA monthly HTTP ${monthlyResp.status}`);
  const records = await monthlyResp.json();

  const seededAt = new Date().toISOString();
  const members = [];

  for (const record of records) {
    if (record.countryName?.startsWith('Total')) continue;
    const parsed = parseRecord(record, seededAt);
    if (parsed) members.push(parsed);
  }

  if (members.length === 0) throw new Error('No IEA oil stock records parsed');

  const firstRecord = records.find(r => !r.countryName?.startsWith('Total'));
  const ym = String(firstRecord?.yearMonth || '');
  const dataMonth = ym.length >= 6
    ? `${ym.slice(0, 4)}-${ym.slice(4)}`
    : `${year}-${String(month).padStart(2, '0')}`;

  return { members, dataMonth, seededAt };
}

async function writeCountryKeys(data) {
  const { url, token } = getRedisCredentials();
  const commands = data.members.map(m => [
    'SET', `energy:iea-oil-stocks:v1:${m.iso2}`, JSON.stringify(m), 'EX', TTL_SECONDS,
  ]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`IEA country key pipeline failed HTTP ${resp.status}`);
  const results = await resp.json();
  const failures = results.filter(r => r?.error || r?.result === 'ERR');
  if (failures.length > 0) throw new Error(`IEA country keys: ${failures.length}/${commands.length} writes failed`);
  console.log(`  Written: ${data.members.length} per-country keys`);
}

const isMain = process.argv[1]?.endsWith('seed-iea-oil-stocks.mjs');
if (isMain) {
  runSeed('energy', 'iea-oil-stocks', CANONICAL_KEY, fetchIeaOilStocks, {
    validateFn: (data) => Array.isArray(data?.members) && data.members.length > 0,
    ttlSeconds: TTL_SECONDS,
    sourceVersion: 'iea-oil-stocks-v1',
    recordCount: (data) => data?.members?.length || 0,
    publishTransform: (data) => buildIndex(data.members, data.dataMonth, data.seededAt),
    afterPublish: writeCountryKeys,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
