#!/usr/bin/env node

import xlsx from 'xlsx';
import { loadEnvFile, CHROME_UA, runSeed, readSeedSnapshot, getSharedFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fuel-prices:v1';
const CACHE_TTL = 864000; // 10 days — weekly seed with 3-day cron-drift buffer
const MIN_COUNTRIES = 5;
const MAX_DROP_PCT = 50;

const MIN_WOW_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days minimum between snapshots
const WOW_ANOMALY_THRESHOLD = 15; // % change that signals a data bug

// USD/L sanity range globally
const USD_L_MIN = 0.02;
const USD_L_MAX = 3.50;

// EU country name to ISO2 mapping
const EU_COUNTRY_MAP = {
  'Austria': 'AT', 'Belgium': 'BE', 'Bulgaria': 'BG', 'Croatia': 'HR',
  'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Denmark': 'DK', 'Estonia': 'EE',
  'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Greece': 'GR',
  'Hungary': 'HU', 'Ireland': 'IE', 'Italy': 'IT', 'Latvia': 'LV',
  'Lithuania': 'LT', 'Luxembourg': 'LU', 'Malta': 'MT', 'Netherlands': 'NL',
  'Poland': 'PL', 'Portugal': 'PT', 'Romania': 'RO', 'Slovakia': 'SK',
  'Slovenia': 'SI', 'Spain': 'ES', 'Sweden': 'SE',
};

const EU_COUNTRY_INFO = {
  AT: { name: 'Austria',      currency: 'EUR', flag: '🇦🇹' },
  BE: { name: 'Belgium',      currency: 'EUR', flag: '🇧🇪' },
  BG: { name: 'Bulgaria',     currency: 'BGN', flag: '🇧🇬' },
  HR: { name: 'Croatia',      currency: 'EUR', flag: '🇭🇷' },
  CY: { name: 'Cyprus',       currency: 'EUR', flag: '🇨🇾' },
  CZ: { name: 'Czech Republic', currency: 'CZK', flag: '🇨🇿' },
  DK: { name: 'Denmark',      currency: 'DKK', flag: '🇩🇰' },
  EE: { name: 'Estonia',      currency: 'EUR', flag: '🇪🇪' },
  FI: { name: 'Finland',      currency: 'EUR', flag: '🇫🇮' },
  FR: { name: 'France',       currency: 'EUR', flag: '🇫🇷' },
  DE: { name: 'Germany',      currency: 'EUR', flag: '🇩🇪' },
  GR: { name: 'Greece',       currency: 'EUR', flag: '🇬🇷' },
  HU: { name: 'Hungary',      currency: 'HUF', flag: '🇭🇺' },
  IE: { name: 'Ireland',      currency: 'EUR', flag: '🇮🇪' },
  IT: { name: 'Italy',        currency: 'EUR', flag: '🇮🇹' },
  LV: { name: 'Latvia',       currency: 'EUR', flag: '🇱🇻' },
  LT: { name: 'Lithuania',    currency: 'EUR', flag: '🇱🇹' },
  LU: { name: 'Luxembourg',   currency: 'EUR', flag: '🇱🇺' },
  MT: { name: 'Malta',        currency: 'EUR', flag: '🇲🇹' },
  NL: { name: 'Netherlands',  currency: 'EUR', flag: '🇳🇱' },
  PL: { name: 'Poland',       currency: 'PLN', flag: '🇵🇱' },
  PT: { name: 'Portugal',     currency: 'EUR', flag: '🇵🇹' },
  RO: { name: 'Romania',      currency: 'RON', flag: '🇷🇴' },
  SK: { name: 'Slovakia',     currency: 'EUR', flag: '🇸🇰' },
  SI: { name: 'Slovenia',     currency: 'EUR', flag: '🇸🇮' },
  ES: { name: 'Spain',        currency: 'EUR', flag: '🇪🇸' },
  SE: { name: 'Sweden',       currency: 'SEK', flag: '🇸🇪' },
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

async function fetchMalaysia() {
  try {
    const url = 'https://api.data.gov.my/data-catalogue?id=fuelprice&limit=20&sort=-date';
    const resp = await globalThis.fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return [];
    const row = data[0];
    const observedAt = row.date ?? '';
    const ron95 = typeof row.ron95 === 'number' ? row.ron95 : null;
    const diesel = typeof row.diesel === 'number' ? row.diesel : null;
    console.log(`  [MY] RON95=${ron95}, Diesel=${diesel}, date=${observedAt}`);
    return [{
      code: 'MY', name: 'Malaysia', currency: 'MYR', flag: '🇲🇾',
      gasoline: ron95 != null ? { localPrice: ron95, grade: 'RON95', source: 'data.gov.my', observedAt } : null,
      diesel: diesel != null ? { localPrice: diesel, grade: 'Euro5', source: 'data.gov.my', observedAt } : null,
    }];
  } catch (err) {
    console.warn(`  [MY] fetchMalaysia error: ${err.message}`);
    return [];
  }
}

async function fetchSpain() {
  try {
    const url = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';
    const resp = await globalThis.fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const stations = data?.ListaEESSPrecio;
    if (!Array.isArray(stations) || stations.length === 0) return [];

    function parseSpainPrice(str) {
      if (!str || str.trim() === '') return null;
      const v = parseFloat(str.replace(',', '.'));
      return v > 0 ? v : null;
    }

    const gasolinePrices = [];
    const dieselPrices = [];
    for (const s of stations) {
      const g = parseSpainPrice(s['Precio Gasolina 95 E5']);
      const d = parseSpainPrice(s['Precio Gasoleo A']);
      if (g != null) gasolinePrices.push(g);
      if (d != null) dieselPrices.push(d);
    }

    const avgGasoline = gasolinePrices.length > 0
      ? +(gasolinePrices.reduce((a, b) => a + b, 0) / gasolinePrices.length).toFixed(4)
      : null;
    const avgDiesel = dieselPrices.length > 0
      ? +(dieselPrices.reduce((a, b) => a + b, 0) / dieselPrices.length).toFixed(4)
      : null;

    console.log(`  [ES] Gasoline=${avgGasoline} EUR/L, Diesel=${avgDiesel} EUR/L (${stations.length} stations)`);
    return [{
      code: 'ES', name: 'Spain', currency: 'EUR', flag: '🇪🇸',
      gasoline: avgGasoline != null ? { localPrice: avgGasoline, grade: 'E5', source: 'minetur.gob.es', observedAt: new Date().toISOString().slice(0, 10) } : null,
      diesel: avgDiesel != null ? { localPrice: avgDiesel, grade: 'Diesel A', source: 'minetur.gob.es', observedAt: new Date().toISOString().slice(0, 10) } : null,
    }];
  } catch (err) {
    console.warn(`  [ES] fetchSpain error: ${err.message}`);
    return [];
  }
}

async function fetchMexico() {
  try {
    const url = 'https://api.datos.gob.mx/v2/precio.gasolina.publico?pageSize=1000';
    console.log(`  [MX] API: ${url}`);
    const resp = await globalThis.fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    const dates = results.map(r => r.fecha_aplicacion).filter(Boolean);
    if (dates.length === 0) return [];
    const maxDate = dates.sort().reverse()[0];
    const latest = results.filter(r => r.fecha_aplicacion === maxDate);

    const regularPrices = latest.map(r => parseFloat(r.precio_gasolina_regular)).filter(v => !isNaN(v) && v > 0);
    const dieselPrices = latest.map(r => parseFloat(r.precio_diesel)).filter(v => !isNaN(v) && v > 0);

    const avgRegular = regularPrices.length > 0
      ? +(regularPrices.reduce((a, b) => a + b, 0) / regularPrices.length).toFixed(4)
      : null;
    const avgDiesel = dieselPrices.length > 0
      ? +(dieselPrices.reduce((a, b) => a + b, 0) / dieselPrices.length).toFixed(4)
      : null;

    console.log(`  [MX] Regular=${avgRegular} MXN/L, Diesel=${avgDiesel} MXN/L (${latest.length} entries, date=${maxDate})`);
    return [{
      code: 'MX', name: 'Mexico', currency: 'MXN', flag: '🇲🇽',
      gasoline: avgRegular != null ? { localPrice: avgRegular, grade: 'Regular', source: 'datos.gob.mx', observedAt: maxDate } : null,
      diesel: avgDiesel != null ? { localPrice: avgDiesel, grade: 'Diesel', source: 'datos.gob.mx', observedAt: maxDate } : null,
    }];
  } catch (err) {
    console.warn(`  [MX] fetchMexico error: ${err.message}`);
    return [];
  }
}

async function fetchUS_EIA() {
  try {
    const apiKey = process.env.EIA_API_KEY || '';
    if (!apiKey) {
      console.warn('  [US] EIA_API_KEY not set, skipping');
      return [];
    }
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${apiKey}&data[]=value&facets[series][]=EMM_EPMR_PTE_NUS_DPG&facets[series][]=EMD_EPD2DXL0_PTE_NUS_DPG&sort[0][column]=period&sort[0][direction]=desc&length=4`;
    console.log(`  [US] Fetching EIA: ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
    const resp = await globalThis.fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = data?.response?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const GALLONS_TO_LITERS = 3.785411784;
    let gasolineUSDPerGal = null;
    let dieselUSDPerGal = null;

    for (const row of rows) {
      if (row.series === 'EMM_EPMR_PTE_NUS_DPG' && gasolineUSDPerGal == null) {
        gasolineUSDPerGal = typeof row.value === 'number' ? row.value : parseFloat(row.value);
      }
      if (row.series === 'EMD_EPD2DXL0_PTE_NUS_DPG' && dieselUSDPerGal == null) {
        dieselUSDPerGal = typeof row.value === 'number' ? row.value : parseFloat(row.value);
      }
    }

    const gasolineUSDPerL = gasolineUSDPerGal != null ? +(gasolineUSDPerGal / GALLONS_TO_LITERS).toFixed(4) : null;
    const dieselUSDPerL = dieselUSDPerGal != null ? +(dieselUSDPerGal / GALLONS_TO_LITERS).toFixed(4) : null;
    const observedAt = rows[0]?.period ?? new Date().toISOString().slice(0, 10);

    console.log(`  [US] Gasoline=${gasolineUSDPerL} USD/L, Diesel=${dieselUSDPerL} USD/L (period=${observedAt})`);
    return [{
      code: 'US', name: 'United States', currency: 'USD', flag: '🇺🇸',
      gasoline: gasolineUSDPerL != null ? { localPrice: gasolineUSDPerL, usdPrice: gasolineUSDPerL, grade: 'Regular', source: 'eia.gov', observedAt } : null,
      diesel: dieselUSDPerL != null ? { localPrice: dieselUSDPerL, usdPrice: dieselUSDPerL, grade: 'Diesel', source: 'eia.gov', observedAt } : null,
    }];
  } catch (err) {
    console.warn(`  [US] fetchUS_EIA error: ${err.message}`);
    return [];
  }
}

// EU Oil Bulletin XLSX: EUR per 1000 liters. EC dropped the CSV format; document ID is stable.
// "Prices with taxes latest prices" — updated weekly in-place with the same document UUID.
const EU_XLSX_URL = 'https://energy.ec.europa.eu/document/download/264c2d0f-f161-4ea3-a777-78faae59bea0_en';

function parseEUPrice(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  // Handle both "1234.56" (xlsx default) and "1.234,56" / "1,234.56" with thousand separators
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
  try {
    console.log(`  [EU] Fetching XLSX from EC document store`);
    const resp = await globalThis.fetch(EU_XLSX_URL, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());
    const workbook = xlsx.read(buf, { type: 'buffer' });
    console.log(`  [EU] XLSX sheets: ${workbook.SheetNames.join(', ')}`);

    // Find the "with taxes" sheet, or fall back to first sheet
    const sheetName = workbook.SheetNames.find(n => /with.tax/i.test(n))
      ?? workbook.SheetNames.find(n => /price/i.test(n))
      ?? workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // raw: false → all cells as formatted strings; defval: '' for empty cells
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

    // Find header row: first row (within first 10) containing "country"
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].some(cell => /^country$/i.test(String(cell).trim()))) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx < 0) {
      console.warn(`  [EU] XLSX: no header row found. First 3 rows: ${rows.slice(0, 3).map(r => r.slice(0, 5).join('|')).join(' // ')}`);
      return [];
    }

    const header = rows[headerRowIdx].map(c => String(c).trim());
    const countryIdx = header.findIndex(h => /^country$/i.test(h));
    // Gasoline: "Euro-super 95" column (with taxes)
    const gasolIdx = header.findIndex(h => /euro.super.95|95 e5|e5.95/i.test(h) || (/\b95\b/i.test(h) && !/98|100/i.test(h)));
    // Diesel: "Gas oil automotive" or "Automotive gas oil"
    const dieselIdx = header.findIndex(h => /gas.oil|gasoil|diesel/i.test(h));

    if (gasolIdx < 0 || dieselIdx < 0) {
      console.warn(`  [EU] XLSX: couldn't find price columns. Headers: ${header.join(' | ')}`);
    }

    const euResults = [];
    const observedAt = new Date().toISOString().slice(0, 10);
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const countryName = String(row[countryIdx] ?? '').trim();
      if (!countryName) continue;
      const iso2 = EU_COUNTRY_MAP[countryName];
      if (!iso2) continue;
      const info = EU_COUNTRY_INFO[iso2];
      if (!info) continue;

      const gasPrice = gasolIdx >= 0 ? parseEUPrice(row[gasolIdx]) : null;
      const dslPrice = dieselIdx >= 0 ? parseEUPrice(row[dieselIdx]) : null;

      euResults.push({
        code: iso2,
        name: info.name,
        currency: 'EUR',
        flag: info.flag,
        gasoline: gasPrice != null ? { localPrice: gasPrice, grade: 'E5', source: 'energy.ec.europa.eu', observedAt } : null,
        diesel: dslPrice != null ? { localPrice: dslPrice, grade: 'Diesel', source: 'energy.ec.europa.eu', observedAt } : null,
      });
    }

    console.log(`  [EU] Parsed ${euResults.length} countries from XLSX (sheet=${sheetName})`);
    return euResults;
  } catch (err) {
    console.warn(`  [EU] fetchEU_XLSX error: ${err.message}`);
    return [];
  }
}

async function fetchBrazil() {
  // Two CSVs: gasoline/ethanol and diesel/gnv. Aggregate per-station to national mean.
  // Decimal separator: comma. Date format: DD/MM/YYYY.
  const GAS_URL = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv';
  const DSL_URL = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-diesel-gnv.csv';

  function parseBRPrice(str) {
    if (!str) return null;
    const v = parseFloat(str.replace(',', '.'));
    return v > 0 ? v : null;
  }

  function parseBRDate(str) {
    // DD/MM/YYYY -> YYYY-MM-DD for ISO sort
    if (!str) return '';
    const [d, m, y] = str.split('/');
    return y && m && d ? `${y}-${m}-${d}` : str;
  }

  function nationalMean(csvText, productoFilter, priceField) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const header = lines[0].split(';').map(h => h.replace(/^"|"$/g, '').trim());
    const prodIdx = header.findIndex(h => /produto/i.test(h));
    const priceIdx = header.findIndex(h => h.toLowerCase().includes(priceField.toLowerCase()));
    const dateIdx = header.findIndex(h => /data.*coleta/i.test(h));
    if (prodIdx < 0 || priceIdx < 0 || dateIdx < 0) return null;

    const rows = lines.slice(1).map(l => l.split(';').map(c => c.replace(/^"|"$/g, '').trim()));
    const filtered = rows.filter(r => r[prodIdx] === productoFilter);
    if (!filtered.length) return null;

    // Pre-compute ISO dates once to avoid double-converting per row
    const withDates = filtered.map(r => ({ r, iso: parseBRDate(r[dateIdx]) }));
    const maxDate = withDates.map(x => x.iso).filter(Boolean).sort().at(-1);
    const latest = withDates.filter(x => x.iso === maxDate).map(x => x.r);
    const prices = latest.map(r => parseBRPrice(r[priceIdx])).filter(v => v != null);
    if (!prices.length) return { avg: null, date: maxDate };
    const avg = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(4);
    return { avg, date: maxDate };
  }

  try {
    console.log(`  [BR] gas CSV: ${GAS_URL}`);
    console.log(`  [BR] dsl CSV: ${DSL_URL}`);
    // Use allSettled so a 429 on the diesel CSV doesn't discard gasoline data
    const [gasResult, dslResult] = await Promise.allSettled([
      globalThis.fetch(GAS_URL, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(30000) })
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`Gas HTTP ${r.status}`))),
      globalThis.fetch(DSL_URL, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(30000) })
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`Dsl HTTP ${r.status}`))),
    ]);
    if (gasResult.status === 'rejected') console.warn(`  [BR] gas CSV failed: ${gasResult.reason.message}`);
    if (dslResult.status === 'rejected') console.warn(`  [BR] dsl CSV failed: ${dslResult.reason.message}`);

    const gas = gasResult.status === 'fulfilled' ? nationalMean(gasResult.value, 'GASOLINA', 'valor de venda') : null;
    const dsl = dslResult.status === 'fulfilled' ? nationalMean(dslResult.value, 'DIESEL', 'valor de venda') : null;
    if (!gas && !dsl) return [];

    console.log(`  [BR] Gasoline=${gas?.avg} BRL/L (${gas?.date}), Diesel=${dsl?.avg} BRL/L (${dsl?.date})`);
    return [{
      code: 'BR', name: 'Brazil', currency: 'BRL', flag: '🇧🇷',
      gasoline: gas?.avg != null ? { localPrice: gas.avg, grade: 'Regular', source: 'gov.br/anp', observedAt: gas.date } : null,
      diesel: dsl?.avg != null ? { localPrice: dsl.avg, grade: 'Diesel', source: 'gov.br/anp', observedAt: dsl.date } : null,
    }];
  } catch (err) {
    console.warn(`  [BR] fetchBrazil error: ${err.message}`);
    return [];
  }
}

async function fetchNewZealand() {
  // Direct MBIE CSV. Filter: Variable='Board price', Region='National', latest week.
  // Fuel: 'Regular Petrol' -> gasoline, 'Diesel' -> diesel. Unit: NZD/litre.
  const url = 'https://www.mbie.govt.nz/assets/Data-Files/Energy/Weekly-fuel-price-monitoring/weekly-table.csv';
  try {
    console.log(`  [NZ] CSV: ${url}`);
    const resp = await globalThis.fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    // MBIE data uses simple numeric values — no quoted commas in value fields, bare split is safe.
    // Live header (as of 2026): Week,Date,Fuel,Variable,Value,Unit,Status — no Region column.
    // Values are in NZD c/L (cents per litre) — divide by 100 for NZD/L.
    const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const weekIdx = header.indexOf('week');
    const varIdx = header.indexOf('variable');
    const fuelIdx = header.indexOf('fuel');
    const valIdx = header.indexOf('value');
    if ([weekIdx, varIdx, fuelIdx, valIdx].includes(-1)) {
      console.warn('  [NZ] CSV header missing expected columns:', header.join(','));
      return [];
    }

    const rows = lines.slice(1).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
    // All rows are national averages (no region column); filter to Board price only
    const boardRows = rows.filter(r => r[varIdx] === 'Board price');
    if (!boardRows.length) return [];

    const maxWeek = boardRows.map(r => r[weekIdx]).filter(Boolean).sort().at(-1);
    const latest = boardRows.filter(r => r[weekIdx] === maxWeek);

    const gasRow = latest.find(r => r[fuelIdx] === 'Regular Petrol');
    const dslRow = latest.find(r => r[fuelIdx] === 'Diesel');
    // Values are c/L — divide by 100 to get NZD/L
    const gasPrice = gasRow ? (parseFloat(gasRow[valIdx]) || null) && +(parseFloat(gasRow[valIdx]) / 100).toFixed(4) : null;
    const dslPrice = dslRow ? (parseFloat(dslRow[valIdx]) || null) && +(parseFloat(dslRow[valIdx]) / 100).toFixed(4) : null;

    const dateIdx = header.indexOf('date');
    const obsDate = dateIdx >= 0 ? (latest[0]?.[dateIdx] ?? maxWeek) : maxWeek;

    console.log(`  [NZ] Gasoline=${gasPrice} NZD/L, Diesel=${dslPrice} NZD/L (week=${maxWeek})`);
    return [{
      code: 'NZ', name: 'New Zealand', currency: 'NZD', flag: '🇳🇿',
      gasoline: gasPrice != null ? { localPrice: gasPrice, grade: 'Regular', source: 'mbie.govt.nz', observedAt: obsDate } : null,
      diesel: dslPrice != null ? { localPrice: dslPrice, grade: 'Diesel', source: 'mbie.govt.nz', observedAt: obsDate } : null,
    }];
  } catch (err) {
    console.warn(`  [NZ] fetchNewZealand error: ${err.message}`);
    return [];
  }
}

async function fetchUK_ModeA() {
  // CMA voluntary scheme: each retailer hosts their own JSON feed. No auth required.
  // Prices in pence/litre (integer). Divide by 100 -> GBP/litre.
  // E10 = standard unleaded (gasoline), B7 = standard diesel.
  // Aggregate across all working retailers for a national average.
  const RETAILER_URLS = [
    'https://storelocator.asda.com/fuel_prices_data.json',
    'https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json',
    'https://jetlocal.co.uk/fuel_prices_data.json',
    'https://fuel.motorfuelgroup.com/fuel_prices_data.json',
    'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json',
    'https://www.morrisons.com/fuel-prices/fuel.json',
  ];

  const allE10 = [];
  const allB7 = [];
  let observedAt = new Date().toISOString().slice(0, 10);

  const results = await Promise.allSettled(
    RETAILER_URLS.map(url =>
      globalThis.fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(15000) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} ${url}`)))
    )
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.warn(`  [UK] ${RETAILER_URLS[i]}: ${r.reason?.message ?? r.reason}`);
      continue;
    }
    const body = r.value;
    // CMA format: { last_updated, stations: [{ prices: { E10, B7, ... } }] }
    const stations = body?.stations ?? body?.data ?? [];
    if (!Array.isArray(stations)) continue;
    if (body.last_updated) {
      // CMA feeds use "DD/MM/YYYY HH:mm:ss" — convert to ISO YYYY-MM-DD for comparison
      const raw = String(body.last_updated);
      const ddmmyyyy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      const iso = ddmmyyyy ? `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}` : raw.slice(0, 10);
      if (iso > observedAt) observedAt = iso;
    }
    for (const s of stations) {
      const prices = s?.prices ?? s?.fuel_prices ?? {};
      const e10 = prices?.E10 ?? prices?.['E10_STANDARD'];
      const b7 = prices?.B7 ?? prices?.['B7_STANDARD'];
      if (e10 > 0) allE10.push(e10);
      if (b7 > 0) allB7.push(b7);
    }
  }

  if (!allE10.length && !allB7.length) {
    console.warn('  [UK] No stations with E10/B7 data from any retailer');
    return [];
  }

  // Prices are in pence/litre -> divide by 100 for GBP/litre
  const avgE10 = allE10.length ? +(allE10.reduce((a, b) => a + b, 0) / allE10.length / 100).toFixed(4) : null;
  const avgB7 = allB7.length ? +(allB7.reduce((a, b) => a + b, 0) / allB7.length / 100).toFixed(4) : null;

  console.log(`  [GB] E10=${avgE10} GBP/L (${allE10.length} stations), B7=${avgB7} GBP/L (${allB7.length} stations)`);
  return [{
    code: 'GB', name: 'United Kingdom', currency: 'GBP', flag: '🇬🇧',
    gasoline: avgE10 != null ? { localPrice: avgE10, grade: 'E10', source: 'gov.uk/fuel-finder', observedAt } : null,
    diesel: avgB7 != null ? { localPrice: avgB7, grade: 'B7', source: 'gov.uk/fuel-finder', observedAt } : null,
  }];
}

const prevSnapshot = await readSeedSnapshot(CANONICAL_KEY);

const fxSymbols = {};
for (const ccy of ['MYR', 'EUR', 'MXN', 'PLN', 'CZK', 'DKK', 'HUF', 'RON', 'SEK', 'BGN', 'BRL', 'NZD', 'GBP']) {
  fxSymbols[ccy] = `${ccy}USD=X`;
}

const fxRates = await getSharedFxRates(fxSymbols, SHARED_FX_FALLBACKS);
console.log('  [FX] Rates loaded:', Object.keys(fxRates).join(', '));

const fetchResults = await Promise.allSettled([
  fetchMalaysia(),
  fetchSpain(),
  fetchMexico(),
  fetchUS_EIA(),
  fetchEU_CSV(),
  fetchBrazil(),
  fetchNewZealand(),
  fetchUK_ModeA(),
]);

const sourceNames = ['Malaysia', 'Spain', 'Mexico', 'US-EIA', 'EU-CSV', 'Brazil', 'New Zealand', 'UK-ModeA'];
let successfulSources = 0;

const countryMap = new Map();

function mergeCountry(entry, fxRates) {
  const { code, name, currency, flag, gasoline: gas, diesel: dsl } = entry;
  if (!countryMap.has(code)) {
    countryMap.set(code, { code, name, currency, flag, gasoline: null, diesel: null, fxRate: 0 });
  }
  const existing = countryMap.get(code);
  const fxRate = currency === 'USD' ? 1 : (fxRates[currency] ?? SHARED_FX_FALLBACKS[currency] ?? 0);
  existing.fxRate = fxRate;

  if (gas != null && existing.gasoline == null) {
    const usdPrice = gas.usdPrice ?? toUsdPerLiter(gas.localPrice, currency, fxRates);
    if (isSaneUsd(usdPrice)) {
      existing.gasoline = { ...gas, usdPrice };
    } else if (usdPrice != null) {
      console.warn(`  [SANITY] ${code} gasoline USD/L=${usdPrice} out of range — dropping`);
    }
  }
  if (dsl != null && existing.diesel == null) {
    const usdPrice = dsl.usdPrice ?? toUsdPerLiter(dsl.localPrice, currency, fxRates);
    if (isSaneUsd(usdPrice)) {
      existing.diesel = { ...dsl, usdPrice };
    } else if (usdPrice != null) {
      console.warn(`  [SANITY] ${code} diesel USD/L=${usdPrice} out of range — dropping`);
    }
  }
}

for (let i = 0; i < fetchResults.length; i++) {
  const result = fetchResults[i];
  if (result.status === 'fulfilled' && result.value.length > 0) {
    successfulSources++;
    for (const entry of result.value) {
      mergeCountry(entry, fxRates);
    }
    console.log(`  [SOURCE] ${sourceNames[i]}: ${result.value.length} countries`);
  } else if (result.status === 'rejected') {
    console.warn(`  [SOURCE] ${sourceNames[i]}: rejected — ${result.reason}`);
  } else {
    console.warn(`  [SOURCE] ${sourceNames[i]}: 0 countries`);
  }
}

const countries = Array.from(countryMap.values());

// Coverage gates — must pass before calling runSeed
if (countries.length < MIN_COUNTRIES) {
  throw new Error(`Coverage too low: ${countries.length} countries (min=${MIN_COUNTRIES})`);
}
if (prevSnapshot?.countries?.length) {
  const prevCount = prevSnapshot.countries.length;
  const dropPct = (prevCount - countries.length) / prevCount * 100;
  if (dropPct > MAX_DROP_PCT) {
    throw new Error(`Drop too large: was ${prevCount}, now ${countries.length} (${dropPct.toFixed(1)}% drop > ${MAX_DROP_PCT}% limit)`);
  }
}

// Compute WoW per fuel entry
const prevAge = prevSnapshot?.fetchedAt ? Date.now() - new Date(prevSnapshot.fetchedAt).getTime() : 0;
const hasPrevData = prevSnapshot?.countries?.length > 0;
const prevTooRecent = prevAge > 0 && prevAge < MIN_WOW_AGE_MS;

if (hasPrevData && prevTooRecent) {
  console.warn(`  [WoW] Skipping WoW — previous snapshot is only ${Math.round(prevAge / 3600000)}h old (need 144h+)`);
}

let wowAvailable = hasPrevData && !prevTooRecent;

if (wowAvailable) {
  const prevMap = new Map(prevSnapshot.countries.map(c => [c.code, c]));
  for (const country of countries) {
    const prev = prevMap.get(country.code);
    if (!prev) continue;

    if (country.gasoline && prev.gasoline?.usdPrice > 0 && country.gasoline.usdPrice > 0) {
      const raw = +((country.gasoline.usdPrice - prev.gasoline.usdPrice) / prev.gasoline.usdPrice * 100).toFixed(2);
      if (Math.abs(raw) > WOW_ANOMALY_THRESHOLD) {
        console.warn(`  [WoW] ANOMALY ${country.flag} ${country.name} gasoline: ${raw}% — omitting`);
      } else {
        country.gasoline.wowPct = raw;
      }
    }
    if (country.diesel && prev.diesel?.usdPrice > 0 && country.diesel.usdPrice > 0) {
      const raw = +((country.diesel.usdPrice - prev.diesel.usdPrice) / prev.diesel.usdPrice * 100).toFixed(2);
      if (Math.abs(raw) > WOW_ANOMALY_THRESHOLD) {
        console.warn(`  [WoW] ANOMALY ${country.flag} ${country.name} diesel: ${raw}% — omitting`);
      } else {
        country.diesel.wowPct = raw;
      }
    }
  }
}

// Compute cheapest/most-expensive
const withGasoline = countries.filter(c => c.gasoline?.usdPrice > 0);
const withDiesel = countries.filter(c => c.diesel?.usdPrice > 0);

const cheapestGasoline = withGasoline.length
  ? withGasoline.reduce((a, b) => a.gasoline.usdPrice < b.gasoline.usdPrice ? a : b).code
  : '';
const cheapestDiesel = withDiesel.length
  ? withDiesel.reduce((a, b) => a.diesel.usdPrice < b.diesel.usdPrice ? a : b).code
  : '';
const mostExpensiveGasoline = withGasoline.length
  ? withGasoline.reduce((a, b) => a.gasoline.usdPrice > b.gasoline.usdPrice ? a : b).code
  : '';
const mostExpensiveDiesel = withDiesel.length
  ? withDiesel.reduce((a, b) => a.diesel.usdPrice > b.diesel.usdPrice ? a : b).code
  : '';

console.log(`\n  Summary: ${countries.length} countries, ${successfulSources} sources`);
console.log(`  Cheapest gasoline: ${cheapestGasoline}, Cheapest diesel: ${cheapestDiesel}`);
console.log(`  Most expensive gasoline: ${mostExpensiveGasoline}, Most expensive diesel: ${mostExpensiveDiesel}`);

const data = {
  countries,
  fetchedAt: new Date().toISOString(),
  cheapestGasoline,
  cheapestDiesel,
  mostExpensiveGasoline,
  mostExpensiveDiesel,
  wowAvailable,
  prevFetchedAt: wowAvailable ? (prevSnapshot.fetchedAt ?? '') : '',
  sourceCount: successfulSources,
  countryCount: countries.length,
};

await runSeed('economic', 'fuel-prices', CANONICAL_KEY, async () => data, {
  ttlSeconds: CACHE_TTL,
  validateFn: (d) => d?.countries?.length >= MIN_COUNTRIES,
  recordCount: (d) => d?.countries?.length || 0,
  extraKeys: prevSnapshot ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => prevSnapshot,
    ttl: CACHE_TTL * 2,
  }] : undefined,
});
