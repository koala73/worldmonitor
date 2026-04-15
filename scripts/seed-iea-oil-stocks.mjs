#!/usr/bin/env node
// @ts-check

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:iea-oil-stocks:v1:index';
export const ANALYSIS_KEY = 'energy:oil-stocks-analysis:v1';
export const IEA_90_DAY_OBLIGATION = 90;
const TTL_SECONDS = 40 * 24 * 3600;

export const COUNTRY_MAP = {
  'Australia': 'AU', 'Japan': 'JP', 'Korea': 'KR', 'New Zealand': 'NZ',
  'Austria': 'AT', 'Belgium': 'BE', 'Czech Republic': 'CZ', 'Denmark': 'DK',
  'Estonia': 'EE', 'Finland': 'FI', 'France': 'FR', 'Germany': 'DE',
  'Greece': 'GR', 'Hungary': 'HU', 'Ireland': 'IE', 'Italy': 'IT',
  'Latvia': 'LV', 'Lithuania': 'LT', 'Luxembourg': 'LU', 'Netherlands': 'NL',
  'Poland': 'PL', 'Portugal': 'PT', 'Slovak Republic': 'SK', 'Spain': 'ES',
  'Sweden': 'SE', 'Switzerland': 'CH', 'Turkiye': 'TR', 'United Kingdom': 'GB',
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

const REGION_EUROPE = new Set(['AT','BE','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','NL','PL','PT','SK','ES','SE','CH','TR','GB','NO']);
const REGION_ASIA_PACIFIC = new Set(['AU','JP','KR','NZ']);
const REGION_NORTH_AMERICA = new Set(['CA','MX','US']);

/**
 * @typedef {{
 *   iso2: string,
 *   daysOfCover: number | null,
 *   netExporter: boolean,
 *   belowObligation: boolean,
 *   anomaly?: boolean
 * }} IeaMemberInput
 */

/**
 * @param {IeaMemberInput[]} members
 * @param {string} dataMonth
 * @param {string} updatedAt
 */
export function buildOilStocksAnalysis(members, dataMonth, updatedAt) {
  const eligible = members.filter(m => !m.anomaly);

  const ranked = eligible
    .slice()
    .sort((a, b) => {
      if (a.netExporter && b.netExporter) return 0;
      if (a.netExporter) return 1;
      if (b.netExporter) return -1;
      const da = a.daysOfCover ?? -Infinity;
      const db = b.daysOfCover ?? -Infinity;
      return db - da;
    });

  let rank = 1;
  const ieaMembers = ranked.map(m => {
    /** @type {number | null} */
    const vsObligation = m.netExporter ? null : (m.daysOfCover !== null ? m.daysOfCover - IEA_90_DAY_OBLIGATION : null);
    const obligationMet = m.netExporter || (m.daysOfCover !== null && m.daysOfCover >= IEA_90_DAY_OBLIGATION);
    const entry = {
      iso2: m.iso2,
      daysOfCover: m.daysOfCover,
      netExporter: m.netExporter,
      belowObligation: m.belowObligation,
      obligationMet,
      rank,
      vsObligation,
    };
    rank++;
    return entry;
  });

  const belowObligation = ieaMembers.filter(m => m.belowObligation).map(m => m.iso2);

  /**
   * @param {Set<string>} regionSet
   */
  function regionStats(regionSet) {
    const regionMembers = eligible.filter(m => regionSet.has(m.iso2) && !m.netExporter && m.daysOfCover !== null);
    const days = regionMembers.map(m => /** @type {number} */ (m.daysOfCover));
    const avgDays = days.length > 0 ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null;
    const minDays = days.length > 0 ? Math.min(...days) : null;
    const countBelowObligation = regionMembers.filter(m => m.belowObligation).length;
    return { avgDays, minDays, countBelowObligation };
  }

  const euStats = regionStats(REGION_EUROPE);
  const apStats = regionStats(REGION_ASIA_PACIFIC);

  const naMembers = eligible.filter(m => REGION_NORTH_AMERICA.has(m.iso2));
  const naNetExporters = naMembers.filter(m => m.netExporter).length;
  const naImporters = naMembers.filter(m => !m.netExporter && m.daysOfCover !== null);
  const naAvgDays = naImporters.length > 0
    ? Math.round(naImporters.reduce((s, m) => s + /** @type {number} */ (m.daysOfCover), 0) / naImporters.length)
    : null;

  return {
    updatedAt,
    dataMonth,
    ieaMembers,
    belowObligation,
    regionalSummary: {
      europe: { avgDays: euStats.avgDays, minDays: euStats.minDays, countBelowObligation: euStats.countBelowObligation },
      asiaPacific: { avgDays: apStats.avgDays, minDays: apStats.minDays, countBelowObligation: apStats.countBelowObligation },
      northAmerica: { netExporters: naNetExporters, ...(naAvgDays !== null ? { avgDays: naAvgDays } : {}) },
    },
    shockScenario: null,
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

// Declared up front so runSeed can extend their TTL on fetch failure or
// validation skip — keeps country keys alive as long as the index lives.
const COUNTRY_EXTRA_KEYS = Object.values(COUNTRY_MAP).map(iso2 => ({
  key: `energy:iea-oil-stocks:v1:${iso2}`,
  ttl: TTL_SECONDS,
  transform: (data) => data.members?.find(m => m.iso2 === iso2) ?? null,
}));

// Analysis key included in extraKeys so runSeed extends its TTL on fetch
// failure or validation skip — preventing expiry while the index is healthy.
const ANALYSIS_EXTRA_KEY = {
  key: ANALYSIS_KEY,
  ttl: TTL_SECONDS,
  transform: (data) => buildOilStocksAnalysis(data.members, data.dataMonth, data.seededAt),
};

// Seed-meta for the analysis key, also handled via extraKeys so it stays alive
// on fetch failure or validation skip (health.js oilStocksAnalysis check).
const ANALYSIS_META_EXTRA_KEY = {
  key: 'seed-meta:energy:oil-stocks-analysis',
  ttl: Math.max(86400 * 50, TTL_SECONDS),
  transform: (data) => {
    const analysis = buildOilStocksAnalysis(data.members, data.dataMonth, data.seededAt);
    return { fetchedAt: Date.now(), recordCount: analysis.ieaMembers.length };
  },
};

const isMain = process.argv[1]?.endsWith('seed-iea-oil-stocks.mjs');
export function declareRecords(data) {
  return Array.isArray(data?.members) ? data.members.length : 0;
}

if (isMain) {
  runSeed('energy', 'iea-oil-stocks', CANONICAL_KEY, fetchIeaOilStocks, {
    validateFn: (data) => Array.isArray(data?.members) && data.members.length > 0,
    ttlSeconds: TTL_SECONDS,
    sourceVersion: 'iea-oil-stocks-v1',
    recordCount: (data) => data?.members?.length || 0,
    publishTransform: (data) => buildIndex(data.members, data.dataMonth, data.seededAt),
    extraKeys: [...COUNTRY_EXTRA_KEYS, ANALYSIS_EXTRA_KEY, ANALYSIS_META_EXTRA_KEY],
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 57600,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
