#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const COT_KEY = 'market:cot:v1';
const COT_TTL = 604800;

// Financial futures: TFF Combined report (Socrata yw9f-hn96)
// Fields: dealer_positions_long_all, asset_mgr_positions_long, lev_money_positions_long
const FINANCIAL_INSTRUMENTS = [
  { name: 'S&P 500 E-Mini',    code: 'ES', pattern: /E-MINI S&P 500 - CHICAGO/i },
  { name: 'Nasdaq 100 E-Mini', code: 'NQ', pattern: /^NASDAQ MINI - CHICAGO/i },
  { name: '10-Year T-Note',    code: 'ZN', pattern: /^UST 10Y NOTE - CHICAGO/i },
  { name: '2-Year T-Note',     code: 'ZT', pattern: /^UST 2Y NOTE - CHICAGO/i },
  { name: 'EUR/USD',           code: 'EC', pattern: /EURO FX - CHICAGO/i },
  { name: 'USD/JPY',           code: 'JY', pattern: /JAPANESE YEN - CHICAGO/i },
];

// Physical commodities: Disaggregated Combined report (Socrata rxbv-e226)
// Fields: swap_positions_long_all, m_money_positions_long_all (no lev_money equivalent)
// cftc_contract_market_code used for precise filtering — avoids fragile name matching
const COMMODITY_INSTRUMENTS = [
  { name: 'Gold',            code: 'GC', contractCode: '088691' },
  { name: 'Crude Oil (WTI)', code: 'CL', contractCode: '067651' }, // WTI-PHYSICAL NYMEX
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

async function fetchCotData() {
  const toNum = v => {
    const n = parseInt(String(v ?? '').replace(/,/g, '').trim(), 10);
    return isNaN(n) ? 0 : n;
  };

  let financialRows, commodityRows;
  try {
    // yw9f-hn96: TFF Combined — financial futures (ES, NQ, ZN, ZT, EC, JY)
    // Fields: dealer_positions_long_all, asset_mgr_positions_long, lev_money_positions_long
    financialRows = await fetchSocrata('yw9f-hn96');
  } catch (e) {
    console.warn(`  CFTC TFF fetch failed: ${e.message}`);
    financialRows = [];
  }
  try {
    // rxbv-e226: Disaggregated All Combined — physical commodities (GC, CL)
    // Fields: swap_positions_long_all, m_money_positions_long_all
    // Filter by contract code — more reliable than name pattern matching
    const codeList = COMMODITY_INSTRUMENTS.map(i => `%27${i.contractCode}%27`).join('%2C');
    commodityRows = await fetchSocrata('rxbv-e226', `%20AND%20cftc_contract_market_code%20IN%28${codeList}%29`);
  } catch (e) {
    console.warn(`  CFTC Disaggregated fetch failed: ${e.message}`);
    commodityRows = [];
  }

  if (!financialRows.length && !commodityRows.length) {
    console.warn('  CFTC: both endpoints returned empty');
    return { instruments: [], reportDate: '' };
  }

  const instruments = [];
  let latestReportDate = '';

  const pushInstrument = (target, row, amLong, amShort, levLong, levShort, dealerLong, dealerShort) => {
    const reportDate = parseDate(row.report_date_as_yyyy_mm_dd ?? '');
    if (reportDate && !latestReportDate) latestReportDate = reportDate;
    const netPct = ((amLong - amShort) / Math.max(amLong + amShort, 1)) * 100;
    instruments.push({
      name: target.name, code: target.code, reportDate,
      assetManagerLong: amLong, assetManagerShort: amShort,
      leveragedFundsLong: levLong, leveragedFundsShort: levShort,
      dealerLong, dealerShort,
      netPct: parseFloat(netPct.toFixed(2)),
    });
    console.log(`  ${target.code}: AM net ${netPct.toFixed(1)}% (${amLong}L / ${amShort}S), date=${reportDate}`);
  };

  for (const target of FINANCIAL_INSTRUMENTS) {
    const row = financialRows.find(r => target.pattern.test(r.market_and_exchange_names ?? ''));
    if (!row) { console.warn(`  CFTC: no row for ${target.name}`); continue; }
    pushInstrument(target, row,
      toNum(row.asset_mgr_positions_long),  toNum(row.asset_mgr_positions_short),
      toNum(row.lev_money_positions_long),   toNum(row.lev_money_positions_short),
      toNum(row.dealer_positions_long_all),  toNum(row.dealer_positions_short_all),
    );
  }

  for (const target of COMMODITY_INSTRUMENTS) {
    const row = commodityRows.find(r => r.cftc_contract_market_code === target.contractCode);
    if (!row) { console.warn(`  CFTC: no row for ${target.name}`); continue; }
    // Physical commodity disaggregated: managed money → assetManager, swap dealers → dealer
    pushInstrument(target, row,
      toNum(row.m_money_positions_long_all),  toNum(row.m_money_positions_short_all),
      0, 0,
      toNum(row.swap_positions_long_all),     toNum(row.swap__positions_short_all),
    );
  }

  return { instruments, reportDate: latestReportDate };
}

if (process.argv[1] && process.argv[1].endsWith('seed-cot.mjs')) {
  runSeed('market', 'cot', COT_KEY, fetchCotData, {
    ttlSeconds: COT_TTL,
    validateFn: data => Array.isArray(data?.instruments) && data.instruments.length > 0,
    recordCount: data => data?.instruments?.length ?? 0,
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
