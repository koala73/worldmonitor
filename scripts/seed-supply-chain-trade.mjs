#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ─── Keys (must match handler cache keys exactly) ───
const KEYS = {
  shipping: 'supply_chain:shipping:v2',
  barriers: 'trade:barriers:v1:tariff-gap:50',
  restrictions: 'trade:restrictions:v1:tariff-overview:50',
};

const SHIPPING_TTL = 3600;
const TRADE_TTL = 21600;

const MAJOR_REPORTERS = ['840', '156', '276', '392', '826', '356', '076', '643', '410', '036', '124', '484', '250', '380', '528'];

const WTO_MEMBER_CODES = {
  '840': 'United States', '156': 'China', '276': 'Germany', '392': 'Japan',
  '826': 'United Kingdom', '250': 'France', '356': 'India', '643': 'Russia',
  '076': 'Brazil', '410': 'South Korea', '036': 'Australia', '124': 'Canada',
  '484': 'Mexico', '380': 'Italy', '528': 'Netherlands', '000': 'World',
};

// ─── Shipping Rates (FRED) ───

const SHIPPING_SERIES = [
  { seriesId: 'PCU483111483111', name: 'Deep Sea Freight Producer Price Index', unit: 'index', frequency: 'm' },
  { seriesId: 'TSIFRGHT', name: 'Freight Transportation Services Index', unit: 'index', frequency: 'm' },
];

function detectSpike(history) {
  if (!history || history.length < 3) return false;
  const values = history.map(h => typeof h === 'number' ? h : h.value).filter(v => Number.isFinite(v));
  if (values.length < 3) return false;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return false;
  return values[values.length - 1] > mean + 2 * stdDev;
}

async function fetchShippingRates() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const indices = [];
  for (const cfg of SHIPPING_SERIES) {
    const params = new URLSearchParams({
      series_id: cfg.seriesId, api_key: apiKey, file_type: 'json',
      frequency: cfg.frequency, sort_order: 'desc', limit: '24',
    });
    const resp = await fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  FRED ${cfg.seriesId}: HTTP ${resp.status}`); continue; }
    const data = await resp.json();
    const observations = (data.observations || [])
      .map(o => { const v = parseFloat(o.value); return isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
      .filter(Boolean).reverse();
    if (observations.length === 0) continue;
    const current = observations[observations.length - 1].value;
    const previous = observations.length > 1 ? observations[observations.length - 2].value : current;
    const changePct = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
    indices.push({
      indexId: cfg.seriesId, name: cfg.name, currentValue: current, previousValue: previous,
      changePct, unit: cfg.unit, history: observations, spikeAlert: detectSpike(observations),
    });
    await sleep(200);
  }
  console.log(`  Shipping rates: ${indices.length} indices`);
  return { indices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── WTO helpers ───

async function wtoFetch(path, params) {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) { console.warn('[WTO] WTO_API_KEY not set'); return null; }
  const url = new URL(`https://api.wto.org/timeseries/v1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 204) return { Dataset: [] };
  if (!resp.ok) { console.warn(`[WTO] HTTP ${resp.status} for ${path}`); return null; }
  return resp.json();
}

// ─── Trade Flows (WTO) — pre-seed major reporters vs World ───

async function fetchTradeFlows() {
  const currentYear = new Date().getFullYear();
  const flows = {};

  for (const reporter of MAJOR_REPORTERS) {
    const partner = '000';
    const years = 10;
    const startYear = currentYear - years;
    const base = { r: reporter, p: partner, ps: `${startYear}-${currentYear}`, pc: 'TO', fmt: 'json', mode: 'full', max: '500' };

    const [exportsResult, importsResult] = await Promise.allSettled([
      wtoFetch('/data', { ...base, i: 'ITS_MTV_AX' }),
      wtoFetch('/data', { ...base, i: 'ITS_MTV_AM' }),
    ]);
    const exportsData = exportsResult.status === 'fulfilled' ? exportsResult.value : null;
    const importsData = importsResult.status === 'fulfilled' ? importsResult.value : null;

    const parseRows = (data, indicator) => {
      const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
      return dataset.map(row => {
        const year = parseInt(row.Year ?? row.year ?? '', 10);
        const value = parseFloat(row.Value ?? row.value ?? '');
        return !isNaN(year) && !isNaN(value) ? { year, indicator, value } : null;
      }).filter(Boolean);
    };

    const rows = [...(exportsData ? parseRows(exportsData, 'ITS_MTV_AX') : []), ...(importsData ? parseRows(importsData, 'ITS_MTV_AM') : [])];
    const byYear = new Map();
    for (const row of rows) {
      if (!byYear.has(row.year)) byYear.set(row.year, { exports: 0, imports: 0 });
      const e = byYear.get(row.year);
      if (row.indicator === 'ITS_MTV_AX') e.exports = row.value; else e.imports = row.value;
    }

    const sortedYears = [...byYear.keys()].sort((a, b) => a - b);
    const records = sortedYears.map((year, i) => {
      const cur = byYear.get(year);
      const prev = i > 0 ? byYear.get(sortedYears[i - 1]) : null;
      return {
        reportingCountry: WTO_MEMBER_CODES[reporter] ?? reporter, partnerCountry: 'World',
        year, exportValueUsd: cur.exports, importValueUsd: cur.imports,
        yoyExportChange: prev?.exports > 0 ? Math.round(((cur.exports - prev.exports) / prev.exports) * 10000) / 100 : 0,
        yoyImportChange: prev?.imports > 0 ? Math.round(((cur.imports - prev.imports) / prev.imports) * 10000) / 100 : 0,
        productSector: 'Total merchandise',
      };
    });

    const cacheKey = `trade:flows:v1:${reporter}:${partner}:${years}`;
    if (records.length > 0) {
      flows[cacheKey] = { flows: records, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
    }
    await sleep(500); // WTO rate limit
  }
  console.log(`  Trade flows: ${Object.keys(flows).length} country pairs`);
  return flows;
}

// ─── Trade Barriers (WTO) ───

async function fetchTradeBarriers() {
  const currentYear = new Date().getFullYear();
  const reporters = MAJOR_REPORTERS.join(',');

  const [agriResult, nonAgriResult] = await Promise.allSettled([
    wtoFetch('/data', { i: 'TP_A_0160', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }),
    wtoFetch('/data', { i: 'TP_A_0430', r: reporters, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500' }),
  ]);
  const agriData = agriResult.status === 'fulfilled' ? agriResult.value : null;
  const nonAgriData = nonAgriResult.status === 'fulfilled' ? nonAgriResult.value : null;
  if (!agriData && !nonAgriData) return null;

  const parseRows = (data) => {
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
    return dataset.map(row => {
      const year = parseInt(row.Year ?? row.year ?? '0', 10);
      const value = parseFloat(row.Value ?? row.value ?? '');
      const cc = String(row.ReportingEconomyCode ?? '');
      return !isNaN(year) && !isNaN(value) && cc ? { country: WTO_MEMBER_CODES[cc] ?? '', countryCode: cc, year, value } : null;
    }).filter(Boolean);
  };

  const latestByCountry = (rows) => {
    const m = new Map();
    for (const r of rows) { const e = m.get(r.countryCode); if (!e || r.year > e.year) m.set(r.countryCode, r); }
    return m;
  };

  const latestAgri = latestByCountry(agriData ? parseRows(agriData) : []);
  const latestNonAgri = latestByCountry(nonAgriData ? parseRows(nonAgriData) : []);
  const allCodes = new Set([...latestAgri.keys(), ...latestNonAgri.keys()]);

  const barriers = [];
  for (const code of allCodes) {
    const agri = latestAgri.get(code);
    const nonAgri = latestNonAgri.get(code);
    if (!agri && !nonAgri) continue;
    const agriRate = agri?.value ?? 0;
    const nonAgriRate = nonAgri?.value ?? 0;
    const gap = agriRate - nonAgriRate;
    const country = agri?.country ?? nonAgri?.country ?? code;
    const year = String(agri?.year ?? nonAgri?.year ?? '');
    barriers.push({
      id: `${code}-tariff-gap-${year}`, notifyingCountry: country,
      title: `Agricultural tariff: ${agriRate.toFixed(1)}% vs Non-agricultural: ${nonAgriRate.toFixed(1)}% (gap: ${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp)`,
      measureType: gap > 10 ? 'High agricultural protection' : gap > 5 ? 'Moderate agricultural protection' : 'Low tariff gap',
      productDescription: 'Agricultural vs Non-agricultural products',
      objective: gap > 0 ? 'Agricultural sector protection' : 'Uniform tariff structure',
      status: gap > 10 ? 'high' : gap > 5 ? 'moderate' : 'low',
      dateDistributed: year, sourceUrl: 'https://stats.wto.org',
    });
  }
  barriers.sort((a, b) => {
    const gapA = parseFloat(a.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    const gapB = parseFloat(b.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    return gapB - gapA;
  });
  console.log(`  Trade barriers: ${barriers.length} countries`);
  return { barriers: barriers.slice(0, 50), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Trade Restrictions (WTO) ───

async function fetchTradeRestrictions() {
  const currentYear = new Date().getFullYear();
  const data = await wtoFetch('/data', {
    i: 'TP_A_0010', r: MAJOR_REPORTERS.join(','),
    ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '500',
  });
  if (!data) return null;

  const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const latestByCountry = new Map();
  for (const row of dataset) {
    const code = String(row.ReportingEconomyCode ?? '');
    const year = parseInt(row.Year ?? row.year ?? '0', 10);
    const existing = latestByCountry.get(code);
    if (!existing || year > parseInt(existing.Year ?? existing.year ?? '0', 10)) latestByCountry.set(code, row);
  }

  const restrictions = [...latestByCountry.values()].map(row => {
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (isNaN(value)) return null;
    const cc = String(row.ReportingEconomyCode ?? '');
    const year = String(row.Year ?? row.year ?? '');
    return {
      id: `${cc}-${year}-${row.IndicatorCode ?? ''}`,
      reportingCountry: WTO_MEMBER_CODES[cc] ?? String(row.ReportingEconomy ?? ''),
      affectedCountry: 'All trading partners', productSector: 'All products',
      measureType: 'MFN Applied Tariff', description: `Average tariff rate: ${value.toFixed(1)}%`,
      status: value > 10 ? 'high' : value > 5 ? 'moderate' : 'low',
      notifiedAt: year, sourceUrl: 'https://stats.wto.org',
    };
  }).filter(Boolean).sort((a, b) => {
    const rateA = parseFloat(a.description.match(/[\d.]+/)?.[0] ?? '0');
    const rateB = parseFloat(b.description.match(/[\d.]+/)?.[0] ?? '0');
    return rateB - rateA;
  }).slice(0, 50);

  console.log(`  Trade restrictions: ${restrictions.length} countries`);
  return { restrictions, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Tariff Trends (WTO) — pre-seed major reporters ───

async function fetchTariffTrends() {
  const currentYear = new Date().getFullYear();
  const trends = {};

  for (const reporter of MAJOR_REPORTERS) {
    const years = 10;
    const data = await wtoFetch('/data', {
      i: 'TP_A_0010', r: reporter,
      ps: `${currentYear - years}-${currentYear}`, fmt: 'json', mode: 'full', max: '500',
    });
    if (!data) { await sleep(500); continue; }
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
    const datapoints = dataset.map(row => {
      const year = parseInt(row.Year ?? row.year ?? '', 10);
      const tariffRate = parseFloat(row.Value ?? row.value ?? '');
      if (isNaN(year) || isNaN(tariffRate)) return null;
      return {
        reportingCountry: WTO_MEMBER_CODES[reporter] ?? reporter,
        partnerCountry: 'World', productSector: 'All products',
        year, tariffRate: Math.round(tariffRate * 100) / 100,
        boundRate: 0, indicatorCode: 'TP_A_0010',
      };
    }).filter(Boolean).sort((a, b) => a.year - b.year);

    if (datapoints.length > 0) {
      const cacheKey = `trade:tariffs:v1:${reporter}:all:${years}`;
      trends[cacheKey] = { datapoints, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
    }
    await sleep(500);
  }
  console.log(`  Tariff trends: ${Object.keys(trends).length} countries`);
  return trends;
}

// ─── Main ───

async function fetchAll() {
  const [shipping, barriers, restrictions, flows, tariffs] = await Promise.allSettled([
    fetchShippingRates(),
    fetchTradeBarriers(),
    fetchTradeRestrictions(),
    fetchTradeFlows(),
    fetchTariffTrends(),
  ]);

  const sh = shipping.status === 'fulfilled' ? shipping.value : null;
  const ba = barriers.status === 'fulfilled' ? barriers.value : null;
  const re = restrictions.status === 'fulfilled' ? restrictions.value : null;
  const fl = flows.status === 'fulfilled' ? flows.value : null;
  const ta = tariffs.status === 'fulfilled' ? tariffs.value : null;

  if (!sh && !ba && !re) throw new Error('All supply-chain/trade fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ba) await writeExtraKeyWithMeta(KEYS.barriers, ba, TRADE_TTL, ba.barriers?.length ?? 0);
  if (re) await writeExtraKeyWithMeta(KEYS.restrictions, re, TRADE_TTL, re.restrictions?.length ?? 0);
  if (fl) { for (const [key, data] of Object.entries(fl)) await writeExtraKeyWithMeta(key, data, TRADE_TTL, data.flows?.length ?? 0); }
  if (ta) { for (const [key, data] of Object.entries(ta)) await writeExtraKeyWithMeta(key, data, TRADE_TTL, data.datapoints?.length ?? 0); }

  return sh || { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
}

function validate(data) {
  return data?.indices?.length > 0;
}

runSeed('supply_chain', 'shipping', KEYS.shipping, fetchAll, {
  validateFn: validate,
  ttlSeconds: SHIPPING_TTL,
  sourceVersion: 'fred-wto',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
