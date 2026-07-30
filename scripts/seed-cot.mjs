#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const COT_KEY = 'market:cot:v1';
const COT_TTL = 604800;

const FINANCIAL_INSTRUMENTS = [
  { name: 'S&P 500 E-Mini',    code: 'ES', pattern: /E-MINI S&P 500 - CHICAGO/i },
  { name: 'Nasdaq 100 E-Mini', code: 'NQ', pattern: /^NASDAQ MINI - CHICAGO/i },
  { name: '10-Year T-Note',    code: 'ZN', pattern: /^UST 10Y NOTE - CHICAGO/i },
  { name: '2-Year T-Note',     code: 'ZT', pattern: /^UST 2Y NOTE - CHICAGO/i },
  { name: 'EUR/USD',           code: 'EC', pattern: /EURO FX - CHICAGO/i },
  { name: 'USD/JPY',           code: 'JY', pattern: /JAPANESE YEN - CHICAGO/i },
];

const COMMODITY_INSTRUMENTS = [
  { name: 'Gold',            code: 'GC', contractCode: '088691' },
  { name: 'Silver',          code: 'SI', contractCode: '084691' },
  { name: 'Crude Oil (WTI)', code: 'CL', contractCode: '067651' },
];

function parseDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    const yy = s.slice(0, 2);
    const mm = s.slice(2, 4);
    const dd = s.slice(4, 6);
    const year = parseInt(yy, 10) >= 50 ? `19${yy}` : `20${yy}`;
    return `${year}-${mm}-${dd}`;
  }
  return s.slice(0, 10);
}

// CFTC releases COT every Friday ~3:30pm ET for Tuesday data. Given a reportDate
// (Tuesday), the NEXT release is the Friday of the same week (reportDate + 3 days).
// If today is already past that Friday, the next Tuesday's data releases the
// following Friday — but we only call this with the *latest* stored row, so the
// next release is always reportDate + 3 days.
export function computeNextCotRelease(reportDate) {
  if (!reportDate) return '';
  const d = new Date(`${reportDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10);
}

async function fetchSocrata(datasetId, extraParams = '') {
  const url =
    `https://publicreporting.cftc.gov/resource/${datasetId}.json` +
    `?$limit=200&$order=report_date_as_yyyy_mm_dd%20DESC&$where=futonly_or_combined%3D%27Combined%27${extraParams}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export function buildInstrument(target, currentRow, priorRow, kind) {
  const toNum = v => {
    const n = parseInt(String(v ?? '').replace(/,/g, '').trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  };

  const reportDate = parseDate(currentRow.report_date_as_yyyy_mm_dd ?? '');
  const openInterest = toNum(currentRow.open_interest_all);

  let mmLong, mmShort, psLong, psShort, priorMmNet, priorPsNet;
  let leveragedFundsLong = 0;
  let leveragedFundsShort = 0;

  if (kind === 'financial') {
    mmLong = toNum(currentRow.asset_mgr_positions_long);
    mmShort = toNum(currentRow.asset_mgr_positions_short);
    psLong = toNum(currentRow.dealer_positions_long_all);
    psShort = toNum(currentRow.dealer_positions_short_all);
    // TFF report also exposes leveraged-funds positions — consumed by CotPositioningPanel.
    leveragedFundsLong = toNum(currentRow.lev_money_positions_long);
    leveragedFundsShort = toNum(currentRow.lev_money_positions_short);
    if (priorRow) {
      priorMmNet = toNum(priorRow.asset_mgr_positions_long) - toNum(priorRow.asset_mgr_positions_short);
      priorPsNet = toNum(priorRow.dealer_positions_long_all) - toNum(priorRow.dealer_positions_short_all);
    }
  } else {
    mmLong = toNum(currentRow.m_money_positions_long_all);
    mmShort = toNum(currentRow.m_money_positions_short_all);
    psLong = toNum(currentRow.swap_positions_long_all);
    psShort = toNum(currentRow.swap__positions_short_all);
    if (priorRow) {
      priorMmNet = toNum(priorRow.m_money_positions_long_all) - toNum(priorRow.m_money_positions_short_all);
      priorPsNet = toNum(priorRow.swap_positions_long_all) - toNum(priorRow.swap__positions_short_all);
    }
  }

  const mkCategory = (long, short, priorNet) => {
    const gross = Math.max(long + short, 1);
    const netPct = ((long - short) / gross) * 100;
    const oiSharePct = openInterest > 0 ? ((long + short) / openInterest) * 100 : 0;
    const wowNetDelta = priorNet != null ? (long - short) - priorNet : 0;
    return {
      longPositions: long,
      shortPositions: short,
      netPct: parseFloat(netPct.toFixed(2)),
      oiSharePct: parseFloat(oiSharePct.toFixed(2)),
      wowNetDelta,
    };
  };

  const managedMoney = mkCategory(mmLong, mmShort, priorMmNet);
  const producerSwap = mkCategory(psLong, psShort, priorPsNet);

  return {
    name: target.name,
    code: target.code,
    reportDate,
    nextReleaseDate: computeNextCotRelease(reportDate),
    openInterest,
    managedMoney,
    producerSwap,
    // legacy flat fields consumed by get-cot-positioning.ts / CotPositioningPanel
    assetManagerLong: mmLong,
    assetManagerShort: mmShort,
    leveragedFundsLong,
    leveragedFundsShort,
    dealerLong: psLong,
    dealerShort: psShort,
    netPct: managedMoney.netPct,
  };
}

async function fetchCotData() {
  let financialRows = [];
  let commodityRows = [];

  try {
    financialRows = await fetchSocrata('yw9f-hn96');
  } catch (e) {
    console.warn(`  CFTC TFF fetch failed: ${e.message}`);
  }

  try {
    const codeList = COMMODITY_INSTRUMENTS.map(i => `%27${i.contractCode}%27`).join('%2C');
    commodityRows = await fetchSocrata('rxbv-e226', `%20AND%20cftc_contract_market_code%20IN%28${codeList}%29`);
  } catch (e) {
    console.warn(`  CFTC Disaggregated fetch failed: ${e.message}`);
  }

  if (!financialRows.length && !commodityRows.length) {
    console.warn('  CFTC: both endpoints returned empty');
    return { instruments: [], reportDate: '' };
  }

  const instruments = [];
  let latestReportDate = '';

  const findPair = (rows, predicate) => {
    const matches = rows.filter(predicate);
    // Sorted DESC already; index 0 = current, index 1 = prior week
    return [matches[0], matches[1]];
  };

  for (const target of FINANCIAL_INSTRUMENTS) {
    const [current, prior] = findPair(financialRows, r => target.pattern.test(r.market_and_exchange_names ?? ''));
    if (!current) { console.warn(`  CFTC: no row for ${target.name}`); continue; }
    const inst = buildInstrument(target, current, prior, 'financial');
    if (inst.reportDate && !latestReportDate) latestReportDate = inst.reportDate;
    instruments.push(inst);
    console.log(`  ${inst.code}: MM net ${inst.managedMoney.netPct}% Δ${inst.managedMoney.wowNetDelta}, OI ${inst.openInterest}, date=${inst.reportDate}`);
  }

  for (const target of COMMODITY_INSTRUMENTS) {
    const [current, prior] = findPair(commodityRows, r => r.cftc_contract_market_code === target.contractCode);
    if (!current) { console.warn(`  CFTC: no row for ${target.name}`); continue; }
    const inst = buildInstrument(target, current, prior, 'commodity');
    if (inst.reportDate && !latestReportDate) latestReportDate = inst.reportDate;
    instruments.push(inst);
    console.log(`  ${inst.code}: MM net ${inst.managedMoney.netPct}% Δ${inst.managedMoney.wowNetDelta}, OI ${inst.openInterest}, date=${inst.reportDate}`);
  }

  return { instruments, reportDate: latestReportDate };
}

export function declareRecords(data) {
  return Array.isArray(data?.instruments) ? data.instruments.length : 0;
}

if (process.argv[1]?.endsWith('seed-cot.mjs')) {
  runSeed('market', 'cot', COT_KEY, fetchCotData, {
    ttlSeconds: COT_TTL,
    validateFn: data => Array.isArray(data?.instruments) && data.instruments.length > 0,
    recordCount: data => data?.instruments?.length ?? 0,
    declareRecords,
    sourceVersion: 'cftc-cot-v1',
    schemaVersion: 1,
    maxStaleMin: 14400,
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
