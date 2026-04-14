#!/usr/bin/env node

import ExcelJS from 'exceljs';
import { loadEnvFile, CHROME_UA, runSeed, readSeedSnapshot, getSharedFxRates, SHARED_FX_FALLBACKS, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

// Startup diagnostic — makes silent proxy misconfig immediately visible in logs.
if (_proxyAuth) {
  const hostHint = _proxyAuth.split('@').pop().split(':')[0];
  console.log(`  [PROXY] configured via PROXY_URL (host=${hostHint})`);
} else {
  console.warn(`  [PROXY] NOT configured — PROXY_URL empty; datacenter-blocked sources (NZ/BR/MX) will fail`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retry wrapper: 3 attempts, 1.5s/3s/4.5s backoff. Use for all upstream calls.
async function withFuelRetry(label, fn, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) {
        const delay = 1500 * i;
        console.warn(`  [${label}] attempt ${i}/${tries} failed (${err.message}) — retry in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

async function fetchDirect(url, { timeoutMs, accept }) {
  const r = await globalThis.fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

async function fetchViaProxy(url, { timeoutMs, accept }) {
  if (!_proxyAuth) throw new Error('proxy not configured');
  const { buffer, contentType } = await httpsProxyFetchRaw(url, _proxyAuth, { accept, timeoutMs });
  return new Response(buffer, { headers: { 'Content-Type': contentType || 'text/plain' } });
}

// Direct-first: try direct, fall back to proxy. Use for sources that usually work.
async function fetchWithProxyFallback(url, { timeoutMs = 20_000, accept = 'text/csv,text/plain,*/*' } = {}) {
  try {
    return await fetchDirect(url, { timeoutMs, accept });
  } catch (directErr) {
    if (!_proxyAuth) throw directErr;
    console.warn(`    direct failed (${directErr.message}) — retrying via proxy`);
    return await fetchViaProxy(url, { timeoutMs, accept });
  }
}

// Proxy-first: try proxy, fall back to direct. Use for sources known to block
// datacenter IPs (NZ MBIE via Cloudflare, gov.br TLS failures from Railway,
// MX CRE with intermittent IPv4 routing). Saves a failed direct call every run.
async function fetchWithProxyPreferred(url, { timeoutMs = 20_000, accept = 'text/csv,text/plain,*/*' } = {}) {
  if (_proxyAuth) {
    try {
      return await fetchViaProxy(url, { timeoutMs, accept });
    } catch (proxyErr) {
      console.warn(`    proxy failed (${proxyErr.message}) — falling back to direct`);
    }
  }
  return await fetchDirect(url, { timeoutMs, accept });
}

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
  'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Denmark': 'DK', 'Estonia': 'EE',
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
    const row = data.find(r => r.series_type === 'level') ?? data[0];
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

// MX: datos.gob.mx/v2 went unresponsive in 2026 — IPv4 connect hangs forever
// even from residential IPs. Switched to CRE's publicacionexterna XML feed,
// which publishes daily station-level prices (regular/premium/diesel in MXN/L).
async function fetchMexico() {
  const url = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';
  try {
    console.log(`  [MX] CRE XML: ${url}`);
    const resp = await withFuelRetry('MX', () =>
      fetchWithProxyPreferred(url, { accept: 'application/xml,text/xml,*/*', timeoutMs: 30000 }),
    );
    const xml = await resp.text();
    const re = (type) => new RegExp(`<gas_price\\s+type="${type}">([\\d.]+)</gas_price>`, 'g');
    const collect = (type) => [...xml.matchAll(re(type))].map(m => parseFloat(m[1]))
      .filter(v => Number.isFinite(v) && v > 5 && v < 100); // MXN/L sanity (5 < v < 100)
    const regular = collect('regular');
    const diesel = collect('diesel');
    if (!regular.length && !diesel.length) {
      console.warn(`  [MX] CRE returned ${xml.length} bytes but no usable <gas_price> rows`);
      return [];
    }
    const avg = (a) => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(4) : null;
    const avgRegular = avg(regular);
    const avgDiesel = avg(diesel);
    const observedAt = new Date().toISOString().slice(0, 10);
    console.log(`  [MX] Regular=${avgRegular} MXN/L (${regular.length}), Diesel=${avgDiesel} MXN/L (${diesel.length})`);
    return [{
      code: 'MX', name: 'Mexico', currency: 'MXN', flag: '🇲🇽',
      gasoline: avgRegular != null ? { localPrice: avgRegular, grade: 'Regular', source: 'cre.gob.mx', observedAt } : null,
      diesel: avgDiesel != null ? { localPrice: avgDiesel, grade: 'Diesel', source: 'cre.gob.mx', observedAt } : null,
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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
    const sheetNames = workbook.worksheets.map(ws => ws.name);
    console.log(`  [EU] XLSX sheets: ${sheetNames.join(', ')}`);

    // Find the "with taxes" sheet, or fall back to first sheet
    const sheetName = sheetNames.find(n => /with.tax/i.test(n))
      ?? sheetNames.find(n => /price/i.test(n))
      ?? sheetNames[0];
    const sheet = workbook.getWorksheet(sheetName);

    // Convert to array-of-arrays (like xlsx's header:1 mode)
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

    // EU Oil Bulletin XLSX format (confirmed from live file):
    // Row 0: "in EUR" | "Euro-super 95 (I)" | "Gas oil automobile..." | ...  ← column headers
    // Row 1: "16/03/2026" | "1000 l" | "1000 l" | ...                        ← date + units
    // Row 2+: "Austria" | "1,743.00" | "1,954.00" | ...                      ← data
    // The first column has no "Country" label — it's headed "in EUR".
    // Detect header row by finding "Euro-super" in any cell.
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].some(cell => /euro.super/i.test(String(cell)))) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx < 0) {
      console.warn(`  [EU] XLSX: no Euro-super column found. First 3 rows: ${rows.slice(0, 3).map(r => r.slice(0, 5).join('|')).join(' // ')}`);
      return [];
    }

    const header = rows[headerRowIdx].map(c => String(c).trim());
    // Country is always column 0 (labeled "in EUR", not "Country")
    const countryIdx = 0;
    // Gasoline: "Euro-super 95 (I)" — with taxes column
    const gasolIdx = header.findIndex(h => /euro.super.95/i.test(h));
    // Diesel: "Gas oil automobile" / "Automotive gas oil"
    const dieselIdx = header.findIndex(h => /gas.oil|gasoil/i.test(h));

    if (gasolIdx < 0 || dieselIdx < 0) {
      console.warn(`  [EU] XLSX: couldn't find price columns. Headers: ${header.join(' | ')}`);
    }

    // Row after header is the date/units row — extract the observed date from it
    const dateRow = rows[headerRowIdx + 1] ?? [];
    const rawDate = String(dateRow[0] ?? '').trim();
    const ddmmyyyy = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const observedAt = ddmmyyyy
      ? `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`
      : new Date().toISOString().slice(0, 10);

    const euResults = [];
    // Data starts 2 rows after header (skip the date/units row)
    for (let i = headerRowIdx + 2; i < rows.length; i++) {
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
    // Use allSettled so a 429 on the diesel CSV doesn't discard gasoline data.
    // gov.br returns generic undici "fetch failed" from Railway IPs — proxy-preferred + retry
    // is the only path that consistently works from datacenter networks.
    const [gasResult, dslResult] = await Promise.allSettled([
      withFuelRetry('BR-gas', () => fetchWithProxyPreferred(GAS_URL, { timeoutMs: 30000 }))
        .then(r => r.text()),
      withFuelRetry('BR-dsl', () => fetchWithProxyPreferred(DSL_URL, { timeoutMs: 30000 }))
        .then(r => r.text()),
    ]);
    if (gasResult.status === 'rejected') console.warn(`  [BR] gas CSV failed after retries: ${gasResult.reason?.message || gasResult.reason}`);
    if (dslResult.status === 'rejected') console.warn(`  [BR] dsl CSV failed after retries: ${dslResult.reason?.message || dslResult.reason}`);

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
    // MBIE's CDN 403s Railway datacenter IPs (Cloudflare IP reputation). Proxy-preferred + retry.
    const resp = await withFuelRetry('NZ', () => fetchWithProxyPreferred(url, { timeoutMs: 30000 }));
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

async function fetchUK_DESNZ() {
  // Gov.uk DESNZ weekly road fuel prices CSV. Published weekly, covers 2018-present.
  // ULSP = unleaded petrol (gasoline), ULSD = diesel. Prices in pence/litre.
  // URL changes weekly; discover via Content API.
  try {
    console.log('  [GB] Discovering DESNZ CSV URL...');
    const apiResp = await globalThis.fetch('https://www.gov.uk/api/content/government/statistics/weekly-road-fuel-prices', {
      headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(15000),
    });
    if (!apiResp.ok) throw new Error(`Content API HTTP ${apiResp.status}`);
    const apiData = await apiResp.json();
    const csvAttach = apiData?.details?.attachments?.find(a => a.content_type?.includes('csv') && a.title?.includes('2018'));
    if (!csvAttach?.url) throw new Error('CSV attachment not found in Content API');

    const csvResp = await globalThis.fetch(csvAttach.url, {
      headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(20000),
    });
    if (!csvResp.ok) throw new Error(`CSV HTTP ${csvResp.status}`);
    const lines = (await csvResp.text()).split('\n').filter(l => l.trim());
    // Header: Date,ULSP Pump price pence/litre,ULSD Pump price pence/litre,...
    const dataLines = lines.slice(1).filter(l => l.split(',').length >= 3);
    if (!dataLines.length) throw new Error('No data rows in CSV');

    const lastLine = dataLines.at(-1).split(',');
    const dateStr = lastLine[0]?.trim();
    const ulsp = parseFloat(lastLine[1]);
    const ulsd = parseFloat(lastLine[2]);
    const gasPrice = ulsp > 0 ? +(ulsp / 100).toFixed(4) : null;
    const dslPrice = ulsd > 0 ? +(ulsd / 100).toFixed(4) : null;

    // Parse DD/MM/YYYY -> YYYY-MM-DD
    const dm = dateStr?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const observedAt = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : dateStr;

    console.log(`  [GB] ULSP=${gasPrice} GBP/L, ULSD=${dslPrice} GBP/L (${observedAt})`);
    return [{
      code: 'GB', name: 'United Kingdom', currency: 'GBP', flag: '🇬🇧',
      gasoline: gasPrice != null ? { localPrice: gasPrice, grade: 'E10', source: 'gov.uk/desnz', observedAt } : null,
      diesel: dslPrice != null ? { localPrice: dslPrice, grade: 'B7', source: 'gov.uk/desnz', observedAt } : null,
    }];
  } catch (err) {
    console.warn(`  [GB] fetchUK_DESNZ error: ${err.message}`);
    return [];
  }
}

// Pure helpers exported for unit testing. Must stay above the isMain guard
// so `import` from tests doesn't trigger the imperative seed run below.

// Extract per-station MXN/L prices from the CRE XML feed. Used by fetchMexico.
// Filters to the sane range (5..100 MXN/L) to drop placeholder/test rows.
export function parseCREStationPrices(xml) {
  const re = (type) => new RegExp(`<gas_price\\s+type="${type}">([\\d.]+)</gas_price>`, 'g');
  const collect = (type) => [...xml.matchAll(re(type))].map(m => parseFloat(m[1]))
    .filter(v => Number.isFinite(v) && v > 5 && v < 100);
  return { regular: collect('regular'), diesel: collect('diesel') };
}

// Sources whose failure must not gate publish. Brazil ANP (gov.br) is
// unreachable from Railway IPs both ways: Decodo proxy 403s all .gov.br
// CONNECTs by policy, and direct fetch fails undici TLS handshake. Until a
// working route is found, gating publish on Brazil's freshness means every
// run exits 1 → Railway "Deployment crashed" banner + STALE_SEED flip.
const TOLERATED_FAILURES = new Set(['Brazil']);

// Publish gate. Exported so tests can lock in the contract.
//
// All entries in `countries` are FRESH from this run (no stale-carry-forward —
// that was removed after review: carrying previous-week's data as if current
// created a freshness bug because the proto/UI have no badge for staleness).
// A degraded run that can't meet this gate fails publish; the 10-day cache TTL
// serves the last healthy snapshot and health flips to STALE_SEED after its
// maxStaleMin window.
//
// Contract:
//   - ≥30 countries (EU-CSV alone is 27 + at least 3 of US/GB/MY/BR/MX/NZ).
//   - US + GB + MY present (each uniquely covers a non-EU region).
//   - No untolerated failed sources — partial failures of critical regions
//     must not publish as healthy, but TOLERATED_FAILURES (e.g. structurally
//     unreachable Brazil ANP) don't gate publish.
export function validateFuel(d) {
  const codes = new Set((d?.countries ?? []).map(c => c.code));
  const total = d?.countries?.length ?? 0;
  const criticalPresent = ['US', 'GB', 'MY'].every(code => codes.has(code));
  const untoleratedFailures = Array.isArray(d?.failedSources)
    ? d.failedSources.filter(name => !TOLERATED_FAILURES.has(name))
    : [];
  return total >= 30 && criticalPresent && untoleratedFailures.length === 0;
}

async function main() {
const prevSnapshot = await readSeedSnapshot(`${CANONICAL_KEY}:prev`);

const fxSymbols = {};
for (const ccy of ['MYR', 'EUR', 'MXN', 'PLN', 'CZK', 'DKK', 'HUF', 'RON', 'SEK', 'BGN', 'BRL', 'NZD', 'GBP']) {
  fxSymbols[ccy] = `${ccy}USD=X`;
}

const fxRates = await getSharedFxRates(fxSymbols, SHARED_FX_FALLBACKS);
console.log('  [FX] Rates loaded:', Object.keys(fxRates).join(', '));

const fetchResults = await Promise.allSettled([
  fetchMalaysia(),
  fetchMexico(),
  fetchUS_EIA(),
  fetchEU_CSV(),
  fetchBrazil(),
  fetchNewZealand(),
  fetchUK_DESNZ(),
]);

const sourceNames = ['Malaysia', 'Mexico', 'US-EIA', 'EU-CSV', 'Brazil', 'New Zealand', 'UK-DESNZ'];
let successfulSources = 0;
const failedSources = [];

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
  const name = sourceNames[i];
  if (result.status === 'fulfilled' && result.value.length > 0) {
    successfulSources++;
    for (const entry of result.value) {
      mergeCountry(entry, fxRates);
    }
    console.log(`  [SOURCE] ${name}: ${result.value.length} countries`);
  } else {
    failedSources.push(name);
    if (result.status === 'rejected') {
      console.warn(`  [SOURCE] ${name}: rejected — ${result.reason?.message || result.reason}`);
    } else {
      console.warn(`  [SOURCE] ${name}: 0 countries`);
    }
  }
}

// Stale-carry-forward was removed after review: it inserted week-old data
// into the published payload with a `stale:true` field that no proto schema
// or panel knew how to render, so BR/MX/NZ carried-forward entries would
// display as ordinary current prices. That's a freshness bug, not resilience.
//
// Instead: on partial failure, the strict validator (≥30 countries + US/GB/MY
// + no failed sources) rejects the publish. The 10-day cache TTL keeps the
// last healthy snapshot serving the panel, and health flips to STALE_SEED
// once maxStaleMin is exceeded — a correct, visible failure signal.
if (failedSources.length > 0) {
  const untolerated = failedSources.filter(n => !TOLERATED_FAILURES.has(n));
  if (untolerated.length > 0) {
    console.warn(`  [DEGRADED] ${failedSources.length} source(s) failed this run (${untolerated.length} untolerated) — publish will be rejected by validator, previous snapshot will continue serving until cache TTL`);
  } else {
    console.warn(`  [DEGRADED] ${failedSources.length} tolerated source(s) failed (${failedSources.join(', ')}) — publishing without them`);
  }
}

const countries = Array.from(countryMap.values());

// Coverage warnings — log but always publish what we have
if (countries.length < MIN_COUNTRIES) {
  console.warn(`  [COVERAGE] Only ${countries.length} countries (min=${MIN_COUNTRIES}) — publishing anyway`);
}
if (prevSnapshot?.countries?.length) {
  const prevCount = prevSnapshot.countries.length;
  const dropPct = (prevCount - countries.length) / prevCount * 100;
  if (dropPct > MAX_DROP_PCT) {
    console.warn(`  [COVERAGE] Drop: was ${prevCount}, now ${countries.length} (${dropPct.toFixed(1)}% drop) — publishing anyway`);
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

// All entries are fresh this run (carry-forward removed).
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

const allSourcesFresh = failedSources.length === 0;
const untoleratedFailures = failedSources.filter(name => !TOLERATED_FAILURES.has(name));
const publishBlocking = untoleratedFailures.length > 0;
console.log(`\n  Summary: ${countries.length} countries, ${successfulSources}/${sourceNames.length} sources`);
if (publishBlocking) console.warn(`  [FRESHNESS] Failed sources this run: ${failedSources.join(', ')} — publish will be rejected, prev snapshot keeps serving`);
else if (!allSourcesFresh) console.warn(`  [FRESHNESS] Tolerated failures this run: ${failedSources.join(', ')} — publishing without them; :prev will rotate`);
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
  totalSources: sourceNames.length,
  failedSources,
  countryCount: countries.length,
  allSourcesFresh,
};

// Rotate :prev when no untolerated source failed. Tolerated-only failures
// (e.g. Brazil ANP unreachable) drop those countries from the published
// snapshot entirely, so rotating is safe — next week has no prev entry to
// compare against, so no false ~0% WoW. Blocking failures (untolerated)
// still freeze :prev to preserve WoW integrity, since the panel would
// otherwise compare fresh-this-week to stale-carried-last-week = ~0%.
const rotatePrev = !publishBlocking;
if (!rotatePrev) console.warn(`  [:prev] Skipping rotation — WoW integrity preserved for next run`);

await runSeed('economic', 'fuel-prices', CANONICAL_KEY, async () => data, {
  ttlSeconds: CACHE_TTL,
  validateFn: validateFuel,
  emptyDataIsFailure: true,
  recordCount: (d) => d?.countries?.length || 0,
  extraKeys: (wowAvailable && rotatePrev) ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => data,
    ttl: CACHE_TTL * 2,
  }] : [],
});
}

if (process.argv[1]?.endsWith('seed-fuel-prices.mjs')) {
  main().catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
