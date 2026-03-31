#!/usr/bin/env node --dns-result-order=ipv4first
/**
 * One-off backfill: writes economic:fuel-prices:v1:prev with last week's prices.
 *
 * Run ONCE from local machine before the March 26 EU Oil Bulletin update.
 * After this, the next cron run gets genuine WoW for EU (March 26 vs March 19),
 * US (new vs March 10-16), and Malaysia (new vs previous week).
 *
 * Strategy by source:
 *   - US EIA:   fetch with length=8, skip most-recent period → second period = last week
 *   - Malaysia: fetch with limit=5&sort=-date, take index [1] → previous week
 *   - EU (XLSX March 19): fetch current → IS last week relative to March 26 update ✓
 *   - Spain/Mexico/Brazil/NZ/UK: fetch current → used as baseline (no history API)
 *
 * fetchedAt in the written payload is set to 7 days ago so the seeder's
 * 6-day minimum WoW gap check passes on the next cron run.
 */

import ExcelJS from 'exceljs';
import { loadEnvFile, CHROME_UA, writeExtraKey, getSharedFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fuel-prices:v1';
const PREV_KEY = `${CANONICAL_KEY}:prev`;
const PREV_TTL = 864000 * 2; // 20 days

const USD_L_MIN = 0.02;
const USD_L_MAX = 3.50;
const GALLONS_TO_LITERS = 3.785411784;

const EU_COUNTRY_MAP = {
  'Austria': 'AT', 'Belgium': 'BE', 'Bulgaria': 'BG', 'Croatia': 'HR',
  'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Denmark': 'DK', 'Estonia': 'EE',
  'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Greece': 'GR',
  'Hungary': 'HU', 'Ireland': 'IE', 'Italy': 'IT', 'Latvia': 'LV',
  'Lithuania': 'LT', 'Luxembourg': 'LU', 'Malta': 'MT', 'Netherlands': 'NL',
  'Poland': 'PL', 'Portugal': 'PT', 'Romania': 'RO', 'Slovakia': 'SK',
  'Slovenia': 'SI', 'Spain': 'ES', 'Sweden': 'SE',
};

const EU_COUNTRY_INFO = {
  AT: { name: 'Austria',        currency: 'EUR', flag: '🇦🇹' },
  BE: { name: 'Belgium',        currency: 'EUR', flag: '🇧🇪' },
  BG: { name: 'Bulgaria',       currency: 'BGN', flag: '🇧🇬' },
  HR: { name: 'Croatia',        currency: 'EUR', flag: '🇭🇷' },
  CY: { name: 'Cyprus',         currency: 'EUR', flag: '🇨🇾' },
  CZ: { name: 'Czech Republic', currency: 'CZK', flag: '🇨🇿' },
  DK: { name: 'Denmark',        currency: 'DKK', flag: '🇩🇰' },
  EE: { name: 'Estonia',        currency: 'EUR', flag: '🇪🇪' },
  FI: { name: 'Finland',        currency: 'EUR', flag: '🇫🇮' },
  FR: { name: 'France',         currency: 'EUR', flag: '🇫🇷' },
  DE: { name: 'Germany',        currency: 'EUR', flag: '🇩🇪' },
  GR: { name: 'Greece',         currency: 'EUR', flag: '🇬🇷' },
  HU: { name: 'Hungary',        currency: 'HUF', flag: '🇭🇺' },
  IE: { name: 'Ireland',        currency: 'EUR', flag: '🇮🇪' },
  IT: { name: 'Italy',          currency: 'EUR', flag: '🇮🇹' },
  LV: { name: 'Latvia',         currency: 'EUR', flag: '🇱🇻' },
  LT: { name: 'Lithuania',      currency: 'EUR', flag: '🇱🇹' },
  LU: { name: 'Luxembourg',     currency: 'EUR', flag: '🇱🇺' },
  MT: { name: 'Malta',          currency: 'EUR', flag: '🇲🇹' },
  NL: { name: 'Netherlands',    currency: 'EUR', flag: '🇳🇱' },
  PL: { name: 'Poland',         currency: 'PLN', flag: '🇵🇱' },
  PT: { name: 'Portugal',       currency: 'EUR', flag: '🇵🇹' },
  RO: { name: 'Romania',        currency: 'RON', flag: '🇷🇴' },
  SK: { name: 'Slovakia',       currency: 'EUR', flag: '🇸🇰' },
  SI: { name: 'Slovenia',       currency: 'EUR', flag: '🇸🇮' },
  ES: { name: 'Spain',          currency: 'EUR', flag: '🇪🇸' },
  SE: { name: 'Sweden',         currency: 'SEK', flag: '🇸🇪' },
};

function toUsdPerLiter(localPrice, currency, fxRates) {
  if (currency === 'USD') return localPrice;
  const rate = fxRates[currency] ?? SHARED_FX_FALLBACKS[currency] ?? null;
  if (!rate) return null;
  return +(localPrice * rate).toFixed(4);
}

function isSaneUsd(usdPrice) {
  return usdPrice != null && usdPrice >= USD_L_MIN && usdPrice <= USD_L_MAX;
}

// --- Malaysia: take index [1] for previous week ---
async function fetchMalaysiaPrev() {
  try {
    const url = 'https://api.data.gov.my/data-catalogue?id=fuelprice&limit=5&sort=-date';
    const resp = await globalThis.fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 2) {
      console.warn('  [MY-prev] Not enough rows for previous week');
      return [];
    }
    const row = data[1]; // index 1 = one week prior
    const observedAt = row.date ?? '';
    const ron95 = typeof row.ron95 === 'number' ? row.ron95 : null;
    const diesel = typeof row.diesel === 'number' ? row.diesel : null;
    console.log(`  [MY-prev] RON95=${ron95}, Diesel=${diesel}, date=${observedAt}`);
    return [{
      code: 'MY', name: 'Malaysia', currency: 'MYR', flag: '🇲🇾',
      gasoline: ron95 != null ? { localPrice: ron95, grade: 'RON95', source: 'data.gov.my', observedAt } : null,
      diesel: diesel != null ? { localPrice: diesel, grade: 'Euro5', source: 'data.gov.my', observedAt } : null,
    }];
  } catch (err) {
    console.warn(`  [MY-prev] error: ${err.message}`);
    return [];
  }
}

// --- US EIA: fetch length=8 to get 2 weeks per series, take second period ---
async function fetchUS_EIA_prev() {
  try {
    const apiKey = process.env.EIA_API_KEY || '';
    if (!apiKey) { console.warn('  [US-prev] EIA_API_KEY not set, skipping'); return []; }
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${apiKey}&data[]=value&facets[series][]=EMM_EPMR_PTE_NUS_DPG&facets[series][]=EMD_EPD2DXL0_PTE_NUS_DPG&sort[0][column]=period&sort[0][direction]=desc&length=8`;
    console.log(`  [US-prev] Fetching EIA: ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
    const resp = await globalThis.fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = data?.response?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // Find the two most recent distinct periods (sorted desc)
    const periods = [...new Set(rows.map(r => r.period))].sort().reverse();
    if (periods.length < 2) {
      console.warn('  [US-prev] Only one period in EIA response — cannot get previous week');
      return [];
    }
    const prevPeriod = periods[1]; // second most recent = last week
    const prevRows = rows.filter(r => r.period === prevPeriod);

    let gasolineUSDPerGal = null;
    let dieselUSDPerGal = null;
    for (const row of prevRows) {
      if (row.series === 'EMM_EPMR_PTE_NUS_DPG' && gasolineUSDPerGal == null)
        gasolineUSDPerGal = typeof row.value === 'number' ? row.value : parseFloat(row.value);
      if (row.series === 'EMD_EPD2DXL0_PTE_NUS_DPG' && dieselUSDPerGal == null)
        dieselUSDPerGal = typeof row.value === 'number' ? row.value : parseFloat(row.value);
    }

    const gasolineUSDPerL = gasolineUSDPerGal != null ? +(gasolineUSDPerGal / GALLONS_TO_LITERS).toFixed(4) : null;
    const dieselUSDPerL = dieselUSDPerGal != null ? +(dieselUSDPerGal / GALLONS_TO_LITERS).toFixed(4) : null;
    console.log(`  [US-prev] period=${prevPeriod} Gasoline=${gasolineUSDPerL} USD/L, Diesel=${dieselUSDPerL} USD/L`);
    return [{
      code: 'US', name: 'United States', currency: 'USD', flag: '🇺🇸',
      gasoline: gasolineUSDPerL != null ? { localPrice: gasolineUSDPerL, usdPrice: gasolineUSDPerL, grade: 'Regular', source: 'eia.gov', observedAt: prevPeriod } : null,
      diesel: dieselUSDPerL != null ? { localPrice: dieselUSDPerL, usdPrice: dieselUSDPerL, grade: 'Diesel', source: 'eia.gov', observedAt: prevPeriod } : null,
    }];
  } catch (err) {
    console.warn(`  [US-prev] error: ${err.message}`);
    return [];
  }
}

// --- EU: fetch current XLSX (March 19 = last week relative to March 26) ---
function parseEUPrice(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  let normalized = s;
  const dotIdx = s.lastIndexOf('.');
  const commaIdx = s.lastIndexOf(',');
  if (dotIdx > -1 && commaIdx > -1) {
    normalized = dotIdx > commaIdx ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (commaIdx > -1) {
    normalized = s.replace(',', '.');
  }
  const v = parseFloat(normalized);
  return v > 0 ? +(v / 1000).toFixed(4) : null;
}

async function fetchEU_CSV() {
  const EU_XLSX_URL = 'https://energy.ec.europa.eu/document/download/264c2d0f-f161-4ea3-a777-78faae59bea0_en';
  try {
    console.log('  [EU] Fetching XLSX (March 19 = last week baseline)');
    const resp = await globalThis.fetch(EU_XLSX_URL, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
    const sheetNames = workbook.worksheets.map(ws => ws.name);
    const sheetName = sheetNames.find(n => /with.tax/i.test(n)) ?? sheetNames.find(n => /price/i.test(n)) ?? sheetNames[0];
    const sheet = workbook.getWorksheet(sheetName);
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      rows.push(row.values.slice(1).map(v => {
        if (v == null) return '';
        if (v instanceof Date) {
          const d = v.getUTCDate().toString().padStart(2, '0');
          const m = (v.getUTCMonth() + 1).toString().padStart(2, '0');
          return `${d}/${m}/${v.getUTCFullYear()}`;
        }
        if (typeof v === 'object' && Array.isArray(v.richText)) {
          return v.richText.map(rt => rt.text ?? '').join('');
        }
        return String(v);
      }));
    });

    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].some(c => String(c).includes('Euro-super'))) { headerRowIdx = i; break; }
    }
    if (headerRowIdx === -1) { console.warn('  [EU] Could not find header row'); return []; }

    const headerRow = rows[headerRowIdx];
    const dateRow = rows[headerRowIdx + 1] ?? [];
    const dataStartIdx = headerRowIdx + 2;

    const dateStr = String(dateRow[0] ?? '').trim();
    let observedAt = '';
    const dmatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmatch) observedAt = `${dmatch[3]}-${dmatch[2].padStart(2, '0')}-${dmatch[1].padStart(2, '0')}`;

    const e95ColIdx = headerRow.findIndex(c => String(c).includes('Euro-super'));
    const dieselColIdx = headerRow.findIndex((c, i) => i > e95ColIdx && /gas.oil|diesel/i.test(String(c)));

    const results = [];
    for (let r = dataStartIdx; r < rows.length; r++) {
      const row = rows[r];
      const rawName = String(row[0] ?? '').trim();
      if (!rawName) continue;
      const iso2 = EU_COUNTRY_MAP[rawName];
      if (!iso2) continue;
      const info = EU_COUNTRY_INFO[iso2];
      if (!info) continue;
      const gasPrice = e95ColIdx >= 0 ? parseEUPrice(row[e95ColIdx]) : null;
      const dslPrice = dieselColIdx >= 0 ? parseEUPrice(row[dieselColIdx]) : null;
      results.push({
        code: iso2, name: info.name, currency: 'EUR', flag: info.flag,
        gasoline: gasPrice != null ? { localPrice: gasPrice, grade: 'Euro95', source: 'energy.ec.europa.eu', observedAt } : null,
        diesel: dslPrice != null ? { localPrice: dslPrice, grade: 'Diesel', source: 'energy.ec.europa.eu', observedAt } : null,
      });
    }
    console.log(`  [EU] ${results.length} countries, date=${observedAt}`);
    return results;
  } catch (err) {
    console.warn(`  [EU] error: ${err.message}`);
    return [];
  }
}

// --- Spain: current as baseline ---
async function fetchSpain() {
  try {
    const resp = await globalThis.fetch(
      'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/',
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(60000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const stations = data?.ListaEESSPrecio;
    if (!Array.isArray(stations)) return [];
    function parseP(s) { if (!s?.trim()) return null; const v = parseFloat(s.replace(',', '.')); return v > 0 ? v : null; }
    const g = [], d = [];
    for (const s of stations) {
      const gv = parseP(s['Precio Gasolina 95 E5']); if (gv) g.push(gv);
      const dv = parseP(s['Precio Gasoleo A']); if (dv) d.push(dv);
    }
    const avgG = g.length ? +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(4) : null;
    const avgD = d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(4) : null;
    const today = new Date().toISOString().slice(0, 10);
    console.log(`  [ES] Gasoline=${avgG} EUR/L, Diesel=${avgD} EUR/L (baseline)`);
    return [{ code: 'ES', name: 'Spain', currency: 'EUR', flag: '🇪🇸',
      gasoline: avgG != null ? { localPrice: avgG, grade: 'E5', source: 'minetur.gob.es', observedAt: today } : null,
      diesel: avgD != null ? { localPrice: avgD, grade: 'Diesel A', source: 'minetur.gob.es', observedAt: today } : null }];
  } catch (err) { console.warn(`  [ES] error: ${err.message}`); return []; }
}

// --- Mexico: current as baseline ---
async function fetchMexico() {
  try {
    const resp = await globalThis.fetch(
      'https://api.datos.gob.mx/v2/precio.gasolina.publico?pageSize=1000',
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data?.results;
    if (!Array.isArray(results)) return [];
    const dates = results.map(r => r.fecha_aplicacion).filter(Boolean);
    if (!dates.length) return [];
    const maxDate = dates.sort().reverse()[0];
    const latest = results.filter(r => r.fecha_aplicacion === maxDate);
    const reg = latest.map(r => parseFloat(r.precio_gasolina_regular)).filter(v => !isNaN(v) && v > 0);
    const dsl = latest.map(r => parseFloat(r.precio_diesel)).filter(v => !isNaN(v) && v > 0);
    const avgR = reg.length ? +(reg.reduce((a, b) => a + b, 0) / reg.length).toFixed(4) : null;
    const avgD = dsl.length ? +(dsl.reduce((a, b) => a + b, 0) / dsl.length).toFixed(4) : null;
    console.log(`  [MX] Regular=${avgR} MXN/L, Diesel=${avgD} MXN/L (baseline, date=${maxDate})`);
    return [{ code: 'MX', name: 'Mexico', currency: 'MXN', flag: '🇲🇽',
      gasoline: avgR != null ? { localPrice: avgR, grade: 'Regular', source: 'datos.gob.mx', observedAt: maxDate } : null,
      diesel: avgD != null ? { localPrice: avgD, grade: 'Diesel', source: 'datos.gob.mx', observedAt: maxDate } : null }];
  } catch (err) { console.warn(`  [MX] error: ${err.message}`); return []; }
}

// --- Main ---
console.log('=== Fuel prices prev-snapshot backfill ===');
console.log('US + Malaysia: fetching actual last-week prices');
console.log('EU (March 19): fetching current = IS last week baseline');
console.log('Spain/Mexico: fetching current = generic baseline\n');

const fxSymbols = {};
for (const ccy of ['MYR', 'EUR', 'MXN', 'PLN', 'CZK', 'DKK', 'HUF', 'RON', 'SEK', 'BGN', 'BRL', 'NZD', 'GBP']) {
  fxSymbols[ccy] = `${ccy}USD=X`;
}
const fxRates = await getSharedFxRates(fxSymbols, SHARED_FX_FALLBACKS);
console.log('  [FX] Rates:', Object.keys(fxRates).join(', '), '\n');

const fetchResults = await Promise.allSettled([
  fetchMalaysiaPrev(),
  fetchUS_EIA_prev(),
  fetchEU_CSV(),
  fetchSpain(),
  fetchMexico(),
]);

const sourceNames = ['Malaysia-prev', 'US-EIA-prev', 'EU-current(=last week)', 'Spain-baseline', 'Mexico-baseline'];
const countryMap = new Map();

for (let i = 0; i < fetchResults.length; i++) {
  const result = fetchResults[i];
  if (result.status === 'fulfilled' && result.value.length > 0) {
    for (const entry of result.value) {
      const { code, name, currency, flag, gasoline: gas, diesel: dsl } = entry;
      if (!countryMap.has(code)) countryMap.set(code, { code, name, currency, flag, gasoline: null, diesel: null, fxRate: 0 });
      const existing = countryMap.get(code);
      const fxRate = currency === 'USD' ? 1 : (fxRates[currency] ?? SHARED_FX_FALLBACKS[currency] ?? 0);
      existing.fxRate = fxRate;
      if (gas != null && existing.gasoline == null) {
        const usdPrice = gas.usdPrice ?? toUsdPerLiter(gas.localPrice, currency, fxRates);
        if (isSaneUsd(usdPrice)) existing.gasoline = { ...gas, usdPrice };
      }
      if (dsl != null && existing.diesel == null) {
        const usdPrice = dsl.usdPrice ?? toUsdPerLiter(dsl.localPrice, currency, fxRates);
        if (isSaneUsd(usdPrice)) existing.diesel = { ...dsl, usdPrice };
      }
    }
    console.log(`  [SOURCE] ${sourceNames[i]}: ${result.value.length} countries`);
  } else {
    const reason = result.status === 'rejected' ? result.reason : '0 countries';
    console.warn(`  [SOURCE] ${sourceNames[i]}: ${reason}`);
  }
}

const countries = Array.from(countryMap.values());
console.log(`\n  Total: ${countries.length} countries`);

if (countries.length < 5) {
  console.error('  [ERROR] Fewer than 5 countries — aborting, not writing prev key');
  process.exit(1);
}

// fetchedAt = 7 days ago so the seeder's 6-day min WoW gap check passes
const fetchedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const payload = {
  countries,
  fetchedAt,
  cheapestGasoline: '',
  cheapestDiesel: '',
  mostExpensiveGasoline: '',
  mostExpensiveDiesel: '',
  wowAvailable: false,
  prevFetchedAt: '',
  sourceCount: fetchResults.filter(r => r.status === 'fulfilled' && r.value.length > 0).length,
  countryCount: countries.length,
};

console.log(`\nWriting ${PREV_KEY} (fetchedAt=${fetchedAt}, TTL=${PREV_TTL}s)`);
await writeExtraKey(PREV_KEY, payload, PREV_TTL);
console.log('Done. Next cron run will compute WoW against this snapshot.');
