#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep, verifySeedKey, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
import { BUDGET_LAB_TARIFFS_URL, htmlToPlainText, toIsoDate, parseBudgetLabEffectiveTariffHtml } from './_trade-parse-utils.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

// ─── Keys (must match handler cache keys exactly) ───
const KEYS = {
  shipping: 'supply_chain:shipping:v2',
  barriers: 'trade:barriers:v1:tariff-gap:50',
  restrictions: 'trade:restrictions:v1:tariff-overview:50',
  customsRevenue: 'trade:customs-revenue:v1',
};

const SHIPPING_TTL = 3600;
const TRADE_TTL = 21600;
const TARIFF_TTL = 28800; // 8h — 2h buffer over 6h cron cadence (was TRADE_TTL=6h = 0 buffer)
const CUSTOMS_TTL = 86400; // 24h — monthly Treasury data, matches maxStaleMin:1440 (was TRADE_TTL=6h = 0 buffer)

// Reporter list fetched dynamically from WTO API at startup.
// WorldMonitor = WORLD coverage — use whatever the WTO API supports.
import { readFileSync as _readFileSync } from 'node:fs';
import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const __dirname = _dirname(_fileURLToPath(import.meta.url));
const _un2iso2 = JSON.parse(_readFileSync(_join(__dirname, '..', 'shared', 'un-to-iso2.json'), 'utf8'));

// Populated by fetchWtoReporters() before any data fetches
let ALL_REPORTERS = [];

async function fetchWtoReporters() {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) { console.warn('[WTO] WTO_API_KEY not set'); return; }
  try {
    const resp = await fetch('https://api.wto.org/timeseries/v1/reporters', {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    ALL_REPORTERS = data.map(r => String(r.code)).filter(c => /^\d+$/.test(c) && c !== '000');
    console.log(`  WTO reporters: ${ALL_REPORTERS.length} economies`);
  } catch (err) {
    console.warn(`[WTO] Failed to fetch reporter list: ${err.message}, using un-to-iso2.json fallback`);
    ALL_REPORTERS = Object.keys(_un2iso2);
  }
}

// ISO2 lookup for cache keys — derived from the same un-to-iso2.json
const WTO_CODE_TO_ISO2 = { ..._un2iso2 };

function getReporterIso2() {
  return ALL_REPORTERS.map(c => WTO_CODE_TO_ISO2[c]).filter(Boolean);
}

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
    try {
      const params = new URLSearchParams({
        series_id: cfg.seriesId, api_key: apiKey, file_type: 'json',
        frequency: cfg.frequency, sort_order: 'desc', limit: '24',
      });
      const data = await fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, _proxyAuth).catch((e) => {
        console.warn(`  FRED ${cfg.seriesId}: ${e.message}`);
        return null;
      });
      if (!data) continue;
      const observations = (data.observations || [])
        .map(o => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
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
    } catch (e) {
      console.warn(`  FRED ${cfg.seriesId}: ${e.message}`);
    }
  }
  console.log(`  Shipping rates: ${indices.length} indices`);
  return { indices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Container Indices (Shanghai Shipping Exchange) ───

async function fetchSSEIndex(indexName, indexId, dataItemType, displayName, unit) {
  try {
    const resp = await fetch(`https://en.sse.net.cn/currentIndex?indexName=${indexName}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  SSE ${indexName}: HTTP ${resp.status}`); return []; }
    const json = await resp.json();
    const lines = json?.data?.lineDataList;
    if (!Array.isArray(lines)) { console.warn(`  SSE ${indexName}: no lineDataList`); return []; }
    const composite = lines.find(l => l.dataItemTypeName === dataItemType);
    if (!composite) { console.warn(`  SSE ${indexName}: ${dataItemType} not found`); return []; }
    const currentValue = composite.currentContent;
    const previousValue = composite.lastContent;
    if (typeof currentValue !== 'number') return [];
    const changePct = typeof composite.percentage === 'number' ? composite.percentage
      : (previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0);
    const observationDate = json.data?.currentDate || new Date().toISOString().slice(0, 10);
    return [{
      indexId, name: displayName, currentValue, previousValue: previousValue ?? currentValue,
      changePct, unit, history: [], spikeAlert: false, _observationDate: observationDate,
    }];
  } catch (e) {
    console.warn(`  SSE ${indexName}: ${e.message}`);
    return [];
  }
}

async function fetchSCFI() {
  return fetchSSEIndex('scfi', 'SCFI', 'SCFI_T', 'SCFI - Shanghai Container Freight', 'index');
}

async function fetchCCFI() {
  return fetchSSEIndex('ccfi', 'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index');
}

// ─── Baltic Dry Index (HandyBulk scrape) ───

const BDI_INDEX_MAP = [
  { label: 'Dry', id: 'BDI', name: 'BDI - Baltic Dry Index' },
  { label: 'Capesize', id: 'BCI', name: 'BCI - Baltic Capesize Index' },
  { label: 'Panamax', id: 'BPI', name: 'BPI - Baltic Panamax Index' },
  { label: 'Supramax', id: 'BSI', name: 'BSI - Baltic Supramax Index' },
  { label: 'Handysize', id: 'BHSI', name: 'BHSI - Baltic Handysize Index' },
];

async function fetchBDI() {
  try {
    const resp = await fetch('https://www.handybulk.com/baltic-dry-index/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    if (!resp.ok && resp.status !== 301 && resp.status !== 302) {
      console.warn(`  BDI: HTTP ${resp.status}`);
      return [];
    }
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > 1_000_000) { console.warn('  BDI: response too large'); return []; }
    const html = await resp.text();
    if (html.length > 1_000_000) { console.warn('  BDI: body too large'); return []; }

    // Parse article date from heading (e.g., "13-March-2026" or "13-Mar-2026")
    const dateMatch = html.match(/(\d{1,2})-(\w+)-(\d{4})/);
    let articleDate = new Date().toISOString().slice(0, 10);
    if (dateMatch) {
      const parsed = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]}`);
      if (!Number.isNaN(parsed.getTime())) articleDate = parsed.toISOString().slice(0, 10);
    }

    const indices = [];
    for (const cfg of BDI_INDEX_MAP) {
      const patterns = [
        new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
        new RegExp(`${cfg.id}[^.]*?(?:reach|to|at)\\s+([\\d,]+)\\s*points`, 'i'),
        new RegExp(`Baltic ${cfg.label} Index \\(${cfg.id}\\)[^.]*?([\\d,]+)\\s*points`, 'i'),
      ];
      let currentValue = null;
      for (const re of patterns) {
        const m = html.match(re);
        if (m) { currentValue = parseFloat(m[1].replace(/,/g, '')); break; }
      }
      if (currentValue == null || !Number.isFinite(currentValue)) continue;

      let changePct = 0;
      let previousValue = currentValue;
      const deltaRe = new RegExp(`${cfg.id}\\)?[^.]*?(increased|decreased|gained|lost|dropped|rose)\\s+by\\s+([\\d,]+)\\s+points`, 'i');
      const deltaMatch = html.match(deltaRe);
      if (deltaMatch) {
        const delta = parseFloat(deltaMatch[2].replace(/,/g, ''));
        const isNeg = /decreased|lost|dropped/i.test(deltaMatch[1]);
        const signedDelta = isNeg ? -delta : delta;
        previousValue = currentValue - signedDelta;
        changePct = previousValue !== 0 ? (signedDelta / previousValue) * 100 : 0;
      }

      indices.push({
        indexId: cfg.id, name: cfg.name, currentValue, previousValue,
        changePct, unit: 'index', history: [], spikeAlert: false, _observationDate: articleDate,
      });
    }
    console.log(`  BDI: ${indices.length} indices parsed`);
    return indices;
  } catch (e) {
    console.warn(`  BDI: ${e.message}`);
    return [];
  }
}

// ─── History accumulation (inline in canonical payload) ───

function accumulateHistory(newIndices, previousPayload) {
  if (!previousPayload?.indices?.length) {
    for (const idx of newIndices) delete idx._observationDate;
    return newIndices;
  }
  const prevMap = new Map();
  for (const idx of previousPayload.indices) {
    if (idx.indexId) prevMap.set(idx.indexId, idx);
  }
  const fallbackDate = new Date().toISOString().slice(0, 10);
  for (const idx of newIndices) {
    const prev = prevMap.get(idx.indexId);
    const existingHistory = prev?.history ?? [];
    if (idx.history?.length > 0) { delete idx._observationDate; continue; }
    const obsDate = idx._observationDate || fallbackDate;
    const last = existingHistory[existingHistory.length - 1];
    const newHistory = [...existingHistory];
    if (!last || last.date !== obsDate) {
      newHistory.push({ date: obsDate, value: idx.currentValue });
    }
    idx.history = newHistory.slice(-24);
    delete idx._observationDate;
  }
  return newIndices;
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

async function fetchBudgetLabEffectiveTariffRate() {
  try {
    const resp = await fetch(BUDGET_LAB_TARIFFS_URL, {
      headers: { Accept: 'text/html', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  Budget Lab tariffs: HTTP ${resp.status}`);
      return null;
    }
    const html = await resp.text();
    const parsed = parseBudgetLabEffectiveTariffHtml(html);
    if (!parsed) {
      const hasBody = html.length > 5000 && /<body/i.test(html);
      const reason = hasBody ? 'page structure changed' : 'JS-rendered SPA (no static content)';
      console.log(`  Budget Lab tariffs: skipped (${reason})`);
      return null;
    }
    console.log(`  Budget Lab effective tariff: ${parsed.tariffRate.toFixed(1)}%${parsed.observationPeriod ? ` (${parsed.observationPeriod})` : ''}`);
    return parsed;
  } catch (e) {
    console.warn(`  Budget Lab tariffs: ${e.message}`);
    return null;
  }
}

// ─── Trade Flows (WTO) — pre-seed major reporters vs World + key bilateral pairs ───

const BILATERAL_PAIRS = [
  ['840', '156'], // US ↔ China
  ['840', '276'], // US ↔ Germany
  ['840', '392'], // US ↔ Japan
  ['840', '124'], // US ↔ Canada
  ['840', '484'], // US ↔ Mexico
  ['156', '840'], // China ↔ US
  ['156', '276'], // China ↔ Germany
  ['826', '156'], // UK ↔ China
  ['000', '156'], // World ↔ China
  ['000', '840'], // World ↔ US
];

function parseFlowRows(data, indicator) {
  const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  return dataset.map(row => {
    const year = parseInt(row.Year ?? row.year ?? '', 10);
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (Number.isNaN(year) || Number.isNaN(value)) return null;
    return { year, indicator, value, reporterName: row.ReportingEconomy ?? '', partnerName: row.PartnerEconomy ?? '' };
  }).filter(Boolean);
}

function buildFlowRecords(rows, reporterCode, partnerCode) {
  const byYear = new Map();
  let reporterName = reporterCode;
  let partnerName = partnerCode === '000' ? 'World' : partnerCode;
  for (const row of rows) {
    if (!byYear.has(row.year)) byYear.set(row.year, { exports: 0, imports: 0 });
    const e = byYear.get(row.year);
    if (row.indicator === 'ITS_MTV_AX') e.exports = row.value; else e.imports = row.value;
    if (row.reporterName) reporterName = row.reporterName;
    if (row.partnerName && partnerCode !== '000') partnerName = row.partnerName;
  }
  const sortedYears = [...byYear.keys()].sort((a, b) => a - b);
  return sortedYears.map((year, i) => {
    const cur = byYear.get(year);
    const prev = i > 0 ? byYear.get(sortedYears[i - 1]) : null;
    return {
      reportingCountry: reporterName,
      partnerCountry: partnerName,
      year, exportValueUsd: cur.exports, importValueUsd: cur.imports,
      yoyExportChange: prev?.exports > 0 ? Math.round(((cur.exports - prev.exports) / prev.exports) * 10000) / 100 : 0,
      yoyImportChange: prev?.imports > 0 ? Math.round(((cur.imports - prev.imports) / prev.imports) * 10000) / 100 : 0,
      productSector: 'Total merchandise',
    };
  });
}

async function fetchFlowPair(reporter, partner, years, flows) {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years;
  const base = { r: reporter, p: partner, ps: `${startYear}-${currentYear}`, pc: 'TO', fmt: 'json', mode: 'full', max: '500' };
  const [exportsResult, importsResult] = await Promise.allSettled([
    wtoFetch('/data', { ...base, i: 'ITS_MTV_AX' }),
    wtoFetch('/data', { ...base, i: 'ITS_MTV_AM' }),
  ]);
  const exportsData = exportsResult.status === 'fulfilled' ? exportsResult.value : null;
  const importsData = importsResult.status === 'fulfilled' ? importsResult.value : null;
  const rows = [...(exportsData ? parseFlowRows(exportsData, 'ITS_MTV_AX') : []), ...(importsData ? parseFlowRows(importsData, 'ITS_MTV_AM') : [])];
  const records = buildFlowRecords(rows, reporter, partner);
  const cacheKey = `trade:flows:v1:${reporter}:${partner}:${years}`;
  if (records.length > 0) {
    flows[cacheKey] = { flows: records, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
  }
}

async function fetchTradeFlows() {
  const flows = {};
  const years = 10;

  for (const reporter of ALL_REPORTERS) {
    await fetchFlowPair(reporter, '000', years, flows);
    await sleep(500);
  }

  for (const [reporter, partner] of BILATERAL_PAIRS) {
    await fetchFlowPair(reporter, partner, years, flows);
    await sleep(500);
  }

  console.log(`  Trade flows: ${Object.keys(flows).length} pairs (${ALL_REPORTERS.length} world + ${BILATERAL_PAIRS.length} bilateral)`);
  return flows;
}

// ─── Trade Barriers (WTO) ───

async function fetchTradeBarriers() {
  const currentYear = new Date().getFullYear();
  const BATCH = 30;
  const allAgri = [];
  const allNonAgri = [];
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH).join(',');
    const [agriResult, nonAgriResult] = await Promise.allSettled([
      wtoFetch('/data', { i: 'TP_A_0160', r: batch, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000' }),
      wtoFetch('/data', { i: 'TP_A_0430', r: batch, ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000' }),
    ]);
    if (agriResult.status === 'fulfilled' && agriResult.value) allAgri.push(agriResult.value);
    if (nonAgriResult.status === 'fulfilled' && nonAgriResult.value) allNonAgri.push(nonAgriResult.value);
    await sleep(1000);
  }
  const mergeDatasets = (results) => results.flatMap(d => Array.isArray(d) ? d : d?.Dataset ?? d?.dataset ?? []);
  const agriData = allAgri.length > 0 ? { Dataset: mergeDatasets(allAgri) } : null;
  const nonAgriData = allNonAgri.length > 0 ? { Dataset: mergeDatasets(allNonAgri) } : null;
  if (!agriData && !nonAgriData) return null;

  const parseRows = (data) => {
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
    return dataset.map(row => {
      const year = parseInt(row.Year ?? row.year ?? '0', 10);
      const value = parseFloat(row.Value ?? row.value ?? '');
      const cc = String(row.ReportingEconomyCode ?? '');
      return !Number.isNaN(year) && !Number.isNaN(value) && cc ? { country: String(row.ReportingEconomy ?? ''), countryCode: cc, year, value } : null;
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
  return { barriers, _reporterCountries: getReporterIso2(), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Trade Restrictions (WTO) ───

async function fetchTradeRestrictions() {
  const currentYear = new Date().getFullYear();
  const BATCH = 30;
  const allResults = [];
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH).join(',');
    const data = await wtoFetch('/data', {
      i: 'TP_A_0010', r: batch,
      ps: `${currentYear - 3}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000',
    });
    if (data) allResults.push(data);
    await sleep(1000);
  }
  if (allResults.length === 0) return null;

  const dataset = allResults.flatMap(d => Array.isArray(d) ? d : d?.Dataset ?? d?.dataset ?? []);
  const latestByCountry = new Map();
  for (const row of dataset) {
    const code = String(row.ReportingEconomyCode ?? '');
    const year = parseInt(row.Year ?? row.year ?? '0', 10);
    const existing = latestByCountry.get(code);
    if (!existing || year > parseInt(existing.Year ?? existing.year ?? '0', 10)) latestByCountry.set(code, row);
  }

  const restrictions = [...latestByCountry.values()].map(row => {
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (Number.isNaN(value)) return null;
    const cc = String(row.ReportingEconomyCode ?? '');
    const year = String(row.Year ?? row.year ?? '');
    return {
      id: `${cc}-${year}-${row.IndicatorCode ?? ''}`,
      reportingCountry: String(row.ReportingEconomy ?? cc),
      affectedCountry: 'All trading partners', productSector: 'All products',
      measureType: 'WTO MFN Baseline', description: `WTO MFN baseline: ${value.toFixed(1)}%`,
      status: value > 10 ? 'high' : value > 5 ? 'moderate' : 'low',
      notifiedAt: year, sourceUrl: 'https://stats.wto.org',
    };
  }).filter(Boolean).sort((a, b) => {
    const rateA = parseFloat(a.description.match(/[\d.]+/)?.[0] ?? '0');
    const rateB = parseFloat(b.description.match(/[\d.]+/)?.[0] ?? '0');
    return rateB - rateA;
  });

  console.log(`  Trade restrictions: ${restrictions.length} countries`);
  return { restrictions, _reporterCountries: getReporterIso2(), fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Tariff Trends (WTO) — pre-seed major reporters ───

async function fetchTariffTrends() {
  const currentYear = new Date().getFullYear();
  const trends = {};
  const usEffectiveTariffRate = await fetchBudgetLabEffectiveTariffRate();

  // Batch WTO requests in groups of 30 to avoid URL length limits
  const BATCH_SIZE = 30;
  const years = 10;
  for (let i = 0; i < ALL_REPORTERS.length; i += BATCH_SIZE) {
    const batch = ALL_REPORTERS.slice(i, i + BATCH_SIZE);
    const data = await wtoFetch('/data', {
      i: 'TP_A_0010', r: batch.join(','),
      ps: `${currentYear - years}-${currentYear}`, fmt: 'json', mode: 'full', max: '5000',
    });
    if (!data) { await sleep(1000); continue; }
    const dataset = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];

    // Group by reporter code
    const byReporter = new Map();
    for (const row of dataset) {
      const code = String(row.ReportingEconomyCode ?? '');
      if (!byReporter.has(code)) byReporter.set(code, []);
      byReporter.get(code).push(row);
    }

    for (const [reporter, rows] of byReporter) {
      const datapoints = rows.map(row => {
        const year = parseInt(row.Year ?? row.year ?? '', 10);
        const tariffRate = parseFloat(row.Value ?? row.value ?? '');
        if (Number.isNaN(year) || Number.isNaN(tariffRate)) return null;
        return {
          reportingCountry: row.ReportingEconomy ?? reporter,
          partnerCountry: 'World', productSector: 'All products',
          year, tariffRate: Math.round(tariffRate * 100) / 100,
          boundRate: 0, indicatorCode: 'TP_A_0010',
        };
      }).filter(Boolean).sort((a, b) => a.year - b.year);

      if (datapoints.length > 0) {
        const cacheKey = `trade:tariffs:v1:${reporter}:all:${years}`;
        trends[cacheKey] = {
          datapoints,
          ...(reporter === '840' && usEffectiveTariffRate ? { effectiveTariffRate: usEffectiveTariffRate } : {}),
          fetchedAt: new Date().toISOString(),
          upstreamUnavailable: false,
        };
      }
    }
    await sleep(1000);
  }
  console.log(`  Tariff trends: ${Object.keys(trends).length} countries`);
  return trends;
}

// ─── US Treasury Customs Revenue ───

const TREASURY_MTS_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_9';

async function fetchCustomsRevenue() {
  const threeYearsAgo = `${new Date().getFullYear() - 3}-01-01`;
  const fields = 'record_date,current_month_rcpt_outly_amt,current_fytd_rcpt_outly_amt,record_fiscal_year,record_calendar_year,record_calendar_month';
  const url = `${TREASURY_MTS_URL}?fields=${fields}&filter=classification_desc:eq:Customs%20Duties,record_date:gte:${threeYearsAgo}&sort=-record_date&page[size]=50`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Treasury MTS HTTP ${resp.status}`);
  const json = await resp.json();
  const rows = json.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Treasury MTS returned no data');
  if (rows.length > 100) throw new Error(`Treasury MTS returned unexpected row count: ${rows.length}`);

  const months = rows
    .map(r => {
      const monthly = parseFloat(r.current_month_rcpt_outly_amt);
      const fytd = parseFloat(r.current_fytd_rcpt_outly_amt);
      if (!Number.isFinite(monthly) || !Number.isFinite(fytd)) return null;
      return {
        recordDate: r.record_date,
        fiscalYear: parseInt(r.record_fiscal_year, 10) || 0,
        calendarYear: parseInt(r.record_calendar_year, 10) || 0,
        calendarMonth: parseInt(r.record_calendar_month, 10) || 0,
        monthlyAmountBillions: Math.round((monthly / 1e9) * 100) / 100,
        fytdAmountBillions: Math.round((fytd / 1e9) * 100) / 100,
      };
    })
    .filter(Boolean)
    .reverse();

  console.log(`  Treasury customs revenue: ${months.length} months (${months[0]?.recordDate} to ${months[months.length - 1]?.recordDate})`);
  return { months, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
}

// ─── Main ───

async function fetchAll() {
  await fetchWtoReporters();
  const [shipping, scfi, ccfi, bdi, barriers, restrictions, flows, tariffs, customs] = await Promise.allSettled([
    fetchShippingRates(),
    fetchSCFI(),
    fetchCCFI(),
    fetchBDI(),
    fetchTradeBarriers(),
    fetchTradeRestrictions(),
    fetchTradeFlows(),
    fetchTariffTrends(),
    fetchCustomsRevenue(),
  ]);

  const sh = shipping.status === 'fulfilled' ? shipping.value : null;
  const scfiResult = scfi.status === 'fulfilled' ? scfi.value : [];
  const ccfiResult = ccfi.status === 'fulfilled' ? ccfi.value : [];
  const bdiResult = bdi.status === 'fulfilled' ? bdi.value : [];
  const ba = barriers.status === 'fulfilled' ? barriers.value : null;
  const re = restrictions.status === 'fulfilled' ? restrictions.value : null;
  const fl = flows.status === 'fulfilled' ? flows.value : null;
  const ta = tariffs.status === 'fulfilled' ? tariffs.value : null;
  const cu = customs.status === 'fulfilled' ? customs.value : null;

  if (shipping.status === 'rejected') console.warn(`  Shipping failed: ${shipping.reason?.message || shipping.reason}`);
  if (scfi.status === 'rejected') console.warn(`  SCFI failed: ${scfi.reason?.message || scfi.reason}`);
  if (ccfi.status === 'rejected') console.warn(`  CCFI failed: ${ccfi.reason?.message || ccfi.reason}`);
  if (bdi.status === 'rejected') console.warn(`  BDI failed: ${bdi.reason?.message || bdi.reason}`);
  if (barriers.status === 'rejected') console.warn(`  Barriers failed: ${barriers.reason?.message || barriers.reason}`);
  if (restrictions.status === 'rejected') console.warn(`  Restrictions failed: ${restrictions.reason?.message || restrictions.reason}`);
  if (flows.status === 'rejected') console.warn(`  Flows failed: ${flows.reason?.message || flows.reason}`);
  if (tariffs.status === 'rejected') console.warn(`  Tariffs failed: ${tariffs.reason?.message || tariffs.reason}`);
  if (customs.status === 'rejected') console.warn(`  Treasury customs failed: ${customs.reason?.message || customs.reason}`);

  const allIndices = [
    ...(sh?.indices || []),
    ...scfiResult,
    ...ccfiResult,
    ...bdiResult,
  ];

  if (allIndices.length === 0 && !ba && !re) throw new Error('All supply-chain/trade fetches failed');

  // History accumulation: read previous payload, merge history
  let previousPayload = null;
  try { previousPayload = await verifySeedKey(KEYS.shipping); } catch { /* ignore */ }
  const mergedIndices = accumulateHistory(allIndices, previousPayload);
  console.log(`  Merged shipping indices: ${mergedIndices.length} (FRED: ${sh?.indices?.length ?? 0}, SCFI: ${scfiResult.length}, CCFI: ${ccfiResult.length}, BDI: ${bdiResult.length})`);

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ba) await writeExtraKeyWithMeta(KEYS.barriers, ba, TRADE_TTL, ba.barriers?.length ?? 0);
  if (re) await writeExtraKeyWithMeta(KEYS.restrictions, re, TRADE_TTL, re.restrictions?.length ?? 0);
  if (fl) { for (const [key, data] of Object.entries(fl)) await writeExtraKeyWithMeta(key, data, TRADE_TTL, data.flows?.length ?? 0); }
  if (ta) { for (const [key, data] of Object.entries(ta)) await writeExtraKeyWithMeta(key, data, TARIFF_TTL, data.datapoints?.length ?? 0); }
  if (cu) await writeExtraKeyWithMeta(KEYS.customsRevenue, cu, CUSTOMS_TTL, cu.months?.length ?? 0);

  return mergedIndices.length > 0
    ? { indices: mergedIndices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false }
    : { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
}

function validate(data) {
  return data?.indices?.length > 0;
}

runSeed('supply_chain', 'shipping', KEYS.shipping, fetchAll, {
  validateFn: validate,
  ttlSeconds: SHIPPING_TTL,
  sourceVersion: 'fred-wto-sse-bdi-budgetlab',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
