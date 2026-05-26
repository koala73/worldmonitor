#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep, resolveProxy, resolveProxyForConnect, fredFetchJson, curlFetch, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect(); // gate.decodo.com — HTTP CONNECT tunneling for FRED
const _curlProxyAuth = resolveProxy();       // us.decodo.com  — curl for Yahoo/macro signals

// ─── Keys (must match handler cache keys exactly) ───
const KEYS = {
  energyPrices: 'economic:energy:v1:all',
  energyCapacity: 'economic:capacity:v1:COL,SUN,WND:20',
  macroSignals: 'economic:macro-signals:v1',
  crudeInventories: 'economic:crude-inventories:v1',
  natGasStorage: 'economic:nat-gas-storage:v1',
  spr: 'economic:spr:v1',
  refineryInputs: 'economic:refinery-inputs:v1',
};

const FRED_KEY_PREFIX = 'economic:fred:v1';
const STRESS_INDEX_KEY = 'economic:stress-index:v1';
const STRESS_INDEX_TTL = 21600; // 6h
const FRED_TTL = 93600; // 26h — survive daily cron scheduling drift
const ENERGY_TTL = 3600;
const CAPACITY_TTL = 86400;
const MACRO_TTL = 21600; // 6h — survive extended Yahoo outages
const CRUDE_INVENTORIES_TTL = 1_814_400; // 21 days — EIA publishes weekly; 3x cadence per gold standard
const CRUDE_MIN_WEEKS = 4; // require at least 4 weeks to guard against quota-hit empty responses
const NAT_GAS_TTL = 1_814_400; // 21 days — EIA publishes weekly; 3x cadence per gold standard
const NAT_GAS_MIN_WEEKS = 4; // require at least 4 weeks to guard against quota-hit empty responses
export const SPR_TTL = 1_814_400;             // 21 days (3× weekly)
export const REFINERY_INPUTS_TTL = 1_814_400; // 21 days (3× weekly)
const SPR_MIN_WEEKS = 4; // require at least 4 weeks to guard against quota-hit empty responses
const REFINERY_MIN_WEEKS = 4; // require at least 4 weeks to guard against quota-hit empty responses

// EIA retries transient upstream failures: timeouts and 5xx. Returns parsed JSON.
// 4xx and other non-network errors are thrown immediately (no retry).
function isTransientFetchError(e) {
  const msg = e?.message || '';
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' ||
    /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket hang up/i.test(msg);
}

async function eiaFetchJson(url, label, { timeoutMs = 20_000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) return await resp.json();
      const err = Object.assign(new Error(`EIA ${label}: HTTP ${resp.status}`), { status: resp.status });
      // Only 5xx is transient; 4xx is a permanent config/request error — bail immediately.
      if (resp.status < 500) throw err;
      lastErr = err;
      if (i === attempts) throw err;
    } catch (e) {
      if (!isTransientFetchError(e) && !(e?.status >= 500)) throw e;
      lastErr = e;
      if (i === attempts) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * i + Math.random() * 400));
  }
  throw lastErr;
}

const FRED_SERIES = ['WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS', 'GDP', 'M2SL', 'DCOILWTICO', 'BAMLH0A0HYM2', 'ICSA', 'MORTGAGE30US', 'BAMLC0A0CM', 'SOFR', 'DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS30', 'T10Y3M', 'STLFSI4'];

// ─── Economic Stress Index (computed last from FRED data in fetchAll) ───

/** @param {number} v */
function clamp(v) { return Math.min(100, Math.max(0, v)); }

const STRESS_COMPONENTS = [
  { id: 'T10Y2Y',  label: 'Yield Curve',      weight: 0.20, /** @param {number} v */ score: (v) => clamp((0.5 - v) / (0.5 - (-1.5)) * 100) },
  { id: 'T10Y3M',  label: 'Bank Spread',       weight: 0.15, /** @param {number} v */ score: (v) => clamp((0.5 - v) / (0.5 - (-1.0)) * 100) },
  { id: 'VIXCLS',  label: 'Volatility',        weight: 0.20, /** @param {number} v */ score: (v) => clamp((v - 15) / (80 - 15) * 100) },
  { id: 'STLFSI4', label: 'Financial Stress',  weight: 0.20, /** @param {number} v */ score: (v) => clamp((v - (-1)) / (5 - (-1)) * 100) },
  { id: 'GSCPI',   label: 'Supply Chain',      weight: 0.15, /** @param {number} v */ score: (v) => clamp((v - (-2)) / (4 - (-2)) * 100) },
  { id: 'ICSA',    label: 'Job Claims',        weight: 0.10, /** @param {number} v */ score: (v) => clamp((v - 180000) / (500000 - 180000) * 100) },
];

/** @param {number} score */
function stressLabel(score) {
  if (score < 20) return 'Low';
  if (score < 40) return 'Moderate';
  if (score < 60) return 'Elevated';
  if (score < 80) return 'Severe';
  return 'Critical';
}

/**
 * Extract GSCPI observations from the Redis-stored payload.
 * ais-relay writes the FRED-compatible shape `{ series: { series_id, title, units,
 * frequency, observations: [{ date, value }] } }` (see seedGscpi() in ais-relay.cjs).
 * Earlier versions stored a flat `{ observations }` shape, so accept both.
 * Exported for unit testing.
 * @param {unknown} parsed
 * @returns {{ observations: { date: string; value: number }[] } | null}
 */
export function extractGscpiObservations(parsed) {
  const p = /** @type {any} */ (parsed);
  const obs = p?.series?.observations ?? p?.observations;
  return Array.isArray(obs) ? { observations: obs } : null;
}

/**
 * Read GSCPI from Redis (seeded by ais-relay from NY Fed, not available via FRED API).
 * @returns {Promise<{ observations: { date: string; value: number }[] } | null>}
 */
async function fetchGscpiFromRedis() {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(`${FRED_KEY_PREFIX}:GSCPI:0`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = /** @type {{ result: string | null }} */ (await resp.json());
    if (!body.result) return null;
    return extractGscpiObservations(unwrapEnvelope(JSON.parse(body.result)).data);
  } catch {
    return null;
  }
}

/**
 * Compute the composite stress index from freshly-fetched FRED data.
 * Scan backwards through observations to skip FRED's end-of-series null sentinels.
 * @param {Record<string, { observations: { date: string; value: number }[] }>} fr
 * @returns {{ compositeScore: number; label: string; components: object[]; seededAt: string; unavailable: false } | null}
 */
function computeStressIndex(fr) {
  const components = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let missingCount = 0;

  for (const comp of STRESS_COMPONENTS) {
    const obs = fr[comp.id]?.observations;
    let rawValue = null;
    if (obs?.length > 0) {
      for (let j = obs.length - 1; j >= 0; j--) {
        const v = obs[j]?.value;
        if (typeof v === 'number' && Number.isFinite(v)) { rawValue = v; break; }
      }
    }

    if (rawValue === null) {
      missingCount++;
      if (comp.id !== 'GSCPI') {
        // FRED-sourced component missing = refuse to publish degraded composite.
        throw new Error(`StressIndex: required FRED component ${comp.id} missing — refusing to publish partial composite`);
      }
      console.warn(`  [StressIndex] ${comp.id} missing (ais-relay lag) — excluding`);
      components.push({ id: comp.id, label: comp.label, rawValue: null, missing: true, score: 0, weight: comp.weight });
      continue;
    }

    const score = comp.score(rawValue);
    weightedSum += score * comp.weight;
    totalWeight += comp.weight;
    console.log(`  [StressIndex] ${comp.id}: raw=${rawValue.toFixed(4)} score=${score.toFixed(1)}`);
    components.push({ id: comp.id, label: comp.label, rawValue, score, weight: comp.weight });
  }

  if (totalWeight === 0) {
    console.warn('  [StressIndex] No FRED data — skipping write');
    return null;
  }

  const compositeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
  const label = stressLabel(compositeScore);
  console.log(`  [StressIndex] Composite: ${compositeScore} (${label}) — ${STRESS_COMPONENTS.length - missingCount}/${STRESS_COMPONENTS.length} components`);
  return { compositeScore, label, components, seededAt: new Date().toISOString(), unavailable: false };
}

// ─── EIA Energy Prices (WTI + Brent) ───

const EIA_COMMODITIES = [
  { commodity: 'wti', name: 'WTI Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', facet: 'RWTC' },
  { commodity: 'brent', name: 'Brent Crude Oil', unit: '$/barrel', apiPath: '/v2/petroleum/pri/spt/data/', facet: 'RBRTE' },
];

async function fetchEnergyPrices() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');

  const prices = [];
  for (const c of EIA_COMMODITIES) {
    const params = new URLSearchParams({
      api_key: apiKey,
      'data[]': 'value',
      frequency: 'weekly',
      'facets[series][]': c.facet,
      'sort[0][column]': 'period',
      'sort[0][direction]': 'desc',
      length: '2',
    });
    let data;
    try {
      data = await eiaFetchJson(`https://api.eia.gov${c.apiPath}?${params}`, c.commodity);
    } catch (e) { console.warn(`  EIA ${c.commodity}: ${e.message}`); continue; }
    const rows = data.response?.data;
    if (!rows || rows.length === 0) continue;
    const current = rows[0];
    const previous = rows[1];
    const price = current.value ?? 0;
    const prevPrice = previous?.value ?? price;
    const change = prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
    const priceAt = current.period ? new Date(current.period).getTime() : Date.now();
    prices.push({
      commodity: c.commodity, name: c.name, price, unit: c.unit,
      change: Math.round(change * 10) / 10,
      priceAt: Number.isFinite(priceAt) ? priceAt : Date.now(),
    });
  }
  console.log(`  Energy prices: ${prices.length} commodities`);
  return { prices };
}

// ─── EIA Energy Capacity (Solar, Wind, Coal) ───

const CAPACITY_SOURCES = [
  { code: 'SUN', name: 'Solar' },
  { code: 'WND', name: 'Wind' },
  { code: 'COL', name: 'Coal' },
];
const COAL_SUBTYPES = ['BIT', 'SUB', 'LIG', 'RC'];

async function fetchCapacityForSource(sourceCode, apiKey, startYear) {
  const params = new URLSearchParams({
    api_key: apiKey,
    'data[]': 'capability',
    frequency: 'annual',
    'facets[energysourceid][]': sourceCode,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '5000',
    start: String(startYear),
  });
  const resp = await fetch(
    `https://api.eia.gov/v2/electricity/state-electricity-profiles/capability/data/?${params}`,
    { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!resp.ok) return new Map();
  const data = await resp.json();
  const rows = data.response?.data || [];
  const yearTotals = new Map();
  for (const row of rows) {
    if (row.period == null || row.capability == null) continue;
    const year = parseInt(row.period, 10);
    if (Number.isNaN(year)) continue;
    const mw = typeof row.capability === 'number' ? row.capability : parseFloat(String(row.capability));
    if (!Number.isFinite(mw)) continue;
    yearTotals.set(year, (yearTotals.get(year) ?? 0) + mw);
  }
  return yearTotals;
}

async function fetchEnergyCapacity() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 20;

  const series = [];
  for (const source of CAPACITY_SOURCES) {
    try {
      let yearTotals;
      if (source.code === 'COL') {
        yearTotals = await fetchCapacityForSource('COL', apiKey, startYear);
        if (yearTotals.size === 0) {
          const merged = new Map();
          for (const sub of COAL_SUBTYPES) {
            const subMap = await fetchCapacityForSource(sub, apiKey, startYear);
            for (const [year, mw] of subMap) merged.set(year, (merged.get(year) ?? 0) + mw);
          }
          yearTotals = merged;
        }
      } else {
        yearTotals = await fetchCapacityForSource(source.code, apiKey, startYear);
      }
      const data = Array.from(yearTotals.entries())
        .sort(([a], [b]) => a - b)
        .map(([year, mw]) => ({ year, capacityMw: mw }));
      series.push({ energySource: source.code, name: source.name, data });
    } catch (e) {
      console.warn(`  EIA ${source.code}: ${e.message}`);
    }
  }
  console.log(`  Energy capacity: ${series.length} sources`);
  return { series };
}

// ─── FRED Series (10 allowed series) ───

async function fetchFredSeries() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const results = {};
  for (const seriesId of FRED_SERIES) {
    try {
      const limit = 120;
      const obsParams = new URLSearchParams({
        series_id: seriesId, api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: String(limit),
      });
      const metaParams = new URLSearchParams({
        series_id: seriesId, api_key: apiKey, file_type: 'json',
      });

      const [obsResp, metaResp] = await Promise.allSettled([
        fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${obsParams}`, _proxyAuth),
        fredFetchJson(`https://api.stlouisfed.org/fred/series?${metaParams}`, _proxyAuth),
      ]);

      if (obsResp.status === 'rejected') {
        console.warn(`  FRED ${seriesId}: fetch failed — ${obsResp.reason?.message || obsResp.reason}`);
        continue;
      }

      const obsData = obsResp.value;
      const observations = (obsData.observations || [])
        .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
        .filter(Boolean)
        .reverse();

      let title = seriesId, units = '', frequency = '';
      if (metaResp.status === 'fulfilled') {
        const meta = metaResp.value.seriess?.[0];
        if (meta) { title = meta.title || seriesId; units = meta.units || ''; frequency = meta.frequency || ''; }
      }

      results[seriesId] = { seriesId, title, units, frequency, observations };
      await sleep(200); // be nice to FRED
    } catch (e) {
      console.warn(`  FRED ${seriesId}: ${e.message}`);
    }
  }
  const fredCount = Object.keys(results).length;
  console.log(`  FRED series: ${fredCount}/${FRED_SERIES.length}`);
  if (fredCount === 0) console.warn('  [WARN] FRED series: 0 fetched — all series failed. Check FRED_API_KEY and PROXY_URL. FRED-dependent panels will go stale.');
  return results;
}

// ─── Macro Signals (Yahoo, Alternative.me, Mempool) ───

async function fetchJsonSafe(url, timeout = 8000, proxyAuth = null) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(timeout),
    });
    if (resp.ok) return resp.json();
    throw new Error(`HTTP ${resp.status}`);
  } catch (directErr) {
    if (!proxyAuth) throw directErr;
    // Direct fetch failed; retry via proxy
    return JSON.parse(curlFetch(url, proxyAuth, { 'User-Agent': CHROME_UA }));
  }
}

function extractClosePrices(chart) {
  const result = chart?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  return Array.isArray(closes) ? closes.filter((v) => v != null) : [];
}

function extractAlignedPriceVolume(chart) {
  const result = chart?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const volumes = result?.indicators?.quote?.[0]?.volume || [];
  const aligned = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null && volumes[i] != null) aligned.push({ price: closes[i], volume: volumes[i] });
  }
  return aligned;
}

function rateOfChange(prices, days) {
  if (prices.length < days + 1) return null;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  return past !== 0 ? ((current - past) / past) * 100 : null;
}

function smaCalc(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

async function fetchFinnhubCandles(endpoint, symbol) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];
  const to = Math.floor(Date.now() / 1000);
  const from = to - 365 * 86400;
  try {
    const url = `https://finnhub.io/api/v1/${endpoint}?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${apiKey}`;
    const data = await fetchJsonSafe(url, 10_000);
    return data.s === 'ok' && Array.isArray(data.c) ? data.c.filter((v) => v != null) : [];
  } catch { return []; }
}

async function fetchFredJpyFallback() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ series_id: 'DEXJPUS', api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: '250' });
    const data = await fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, _proxyAuth);
    return (data.observations || [])
      .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : v; })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
}

async function fetchMacroSignals(proxyAuth = null) {
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';

  // Sequential Yahoo calls (150ms gaps like yahooGate); route through proxy to bypass Railway IP blocks
  const jpyChart = await fetchJsonSafe(`${yahooBase}/JPY=X?range=1y&interval=1d`, 8000, proxyAuth).catch(() => null);
  await sleep(150);
  const btcChart = await fetchJsonSafe(`${yahooBase}/BTC-USD?range=1y&interval=1d`, 8000, proxyAuth).catch(() => null);
  await sleep(150);
  const qqqChart = await fetchJsonSafe(`${yahooBase}/QQQ?range=1y&interval=1d`, 8000, proxyAuth).catch(() => null);
  await sleep(150);
  const xlpChart = await fetchJsonSafe(`${yahooBase}/XLP?range=1y&interval=1d`, 8000, proxyAuth).catch(() => null);

  const [fearGreed, mempoolHash] = await Promise.allSettled([
    fetchJsonSafe('https://api.alternative.me/fng/?limit=30&format=json'),
    fetchJsonSafe('https://mempool.space/api/v1/mining/hashrate/1m'),
  ]);

  let jpyPrices = jpyChart ? extractClosePrices(jpyChart) : [];
  if (jpyPrices.length === 0) {
    console.log('  JPY: Yahoo unavailable, falling back to FRED DEXJPUS');
    jpyPrices = await fetchFredJpyFallback();
  }

  let btcPrices = btcChart ? extractClosePrices(btcChart) : [];
  let btcAligned = btcChart ? extractAlignedPriceVolume(btcChart) : [];
  if (btcPrices.length === 0) {
    console.log('  BTC: Yahoo unavailable, falling back to Finnhub crypto/candle');
    btcPrices = await fetchFinnhubCandles('crypto/candle', 'BINANCE:BTCUSDT');
  }

  let qqqPrices = qqqChart ? extractClosePrices(qqqChart) : [];
  if (qqqPrices.length === 0) {
    console.log('  QQQ: Yahoo unavailable, falling back to Finnhub stock/candle');
    qqqPrices = await fetchFinnhubCandles('stock/candle', 'QQQ');
  }

  let xlpPrices = xlpChart ? extractClosePrices(xlpChart) : [];
  if (xlpPrices.length === 0) {
    console.log('  XLP: Yahoo unavailable, falling back to Finnhub stock/candle');
    xlpPrices = await fetchFinnhubCandles('stock/candle', 'XLP');
  }

  const jpyRoc30 = rateOfChange(jpyPrices, 30);
  const liquidityStatus = jpyRoc30 !== null ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL') : 'UNKNOWN';

  const btcReturn5 = rateOfChange(btcPrices, 5);
  const qqqReturn5 = rateOfChange(qqqPrices, 5);
  let flowStatus = 'UNKNOWN';
  if (btcReturn5 !== null && qqqReturn5 !== null) {
    flowStatus = Math.abs(btcReturn5 - qqqReturn5) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
  }

  const qqqRoc20 = rateOfChange(qqqPrices, 20);
  const xlpRoc20 = rateOfChange(xlpPrices, 20);
  let regimeStatus = 'UNKNOWN';
  if (qqqRoc20 !== null && xlpRoc20 !== null) regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';

  const btcSma50 = smaCalc(btcPrices, 50);
  const btcSma200 = smaCalc(btcPrices, 200);
  const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

  let btcVwap = null;
  if (btcAligned.length >= 30) {
    const last30 = btcAligned.slice(-30);
    let sumPV = 0, sumV = 0;
    for (const { price, volume } of last30) { sumPV += price * volume; sumV += volume; }
    if (sumV > 0) btcVwap = +(sumPV / sumV).toFixed(0);
  }

  let trendStatus = 'UNKNOWN';
  let mayerMultiple = null;
  if (btcCurrent && btcSma50) {
    const aboveSma = btcCurrent > btcSma50 * 1.02;
    const belowSma = btcCurrent < btcSma50 * 0.98;
    const aboveVwap = btcVwap ? btcCurrent > btcVwap : null;
    if (aboveSma && aboveVwap !== false) trendStatus = 'BULLISH';
    else if (belowSma && aboveVwap !== true) trendStatus = 'BEARISH';
    else trendStatus = 'NEUTRAL';
  }
  if (btcCurrent && btcSma200) mayerMultiple = +(btcCurrent / btcSma200).toFixed(2);

  let hashStatus = 'UNKNOWN', hashChange = null;
  if (mempoolHash.status === 'fulfilled') {
    const hr = mempoolHash.value?.hashrates || mempoolHash.value;
    if (Array.isArray(hr) && hr.length >= 2) {
      const recent = hr[hr.length - 1]?.avgHashrate || hr[hr.length - 1];
      const older = hr[0]?.avgHashrate || hr[0];
      if (recent && older && older > 0) {
        hashChange = +((recent - older) / older * 100).toFixed(1);
        hashStatus = hashChange > 3 ? 'GROWING' : hashChange < -3 ? 'DECLINING' : 'STABLE';
      }
    }
  }

  let momentumStatus = 'UNKNOWN';
  if (mayerMultiple !== null) momentumStatus = mayerMultiple > 1.0 ? 'STRONG' : mayerMultiple > 0.8 ? 'MODERATE' : 'WEAK';

  let fgValue, fgLabel = 'UNKNOWN', fgHistory = [];
  if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
    const data = fearGreed.value.data;
    fgValue = parseInt(data[0]?.value, 10);
    if (!Number.isFinite(fgValue)) fgValue = undefined;
    fgLabel = data[0]?.value_classification || 'UNKNOWN';
    fgHistory = data.slice(0, 30).map((d) => ({
      value: parseInt(d.value, 10),
      date: new Date(parseInt(d.timestamp, 10) * 1000).toISOString().slice(0, 10),
    })).reverse();
  }

  const signalList = [
    { name: 'Liquidity', status: liquidityStatus, bullish: liquidityStatus === 'NORMAL' },
    { name: 'Flow Structure', status: flowStatus, bullish: flowStatus === 'ALIGNED' },
    { name: 'Macro Regime', status: regimeStatus, bullish: regimeStatus === 'RISK-ON' },
    { name: 'Technical Trend', status: trendStatus, bullish: trendStatus === 'BULLISH' },
    { name: 'Hash Rate', status: hashStatus, bullish: hashStatus === 'GROWING' },
    { name: 'Price Momentum', status: momentumStatus, bullish: momentumStatus === 'STRONG' },
    { name: 'Fear & Greed', status: fgLabel, bullish: fgValue !== undefined && fgValue > 50 },
  ];

  let bullishCount = 0, totalCount = 0;
  for (const s of signalList) {
    if (s.status !== 'UNKNOWN') { totalCount++; if (s.bullish) bullishCount++; }
  }
  const verdict = totalCount === 0 ? 'UNKNOWN' : (bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH');

  console.log(`  Macro signals: ${totalCount} active, verdict=${verdict}`);
  return {
    timestamp: new Date().toISOString(),
    verdict, bullishCount, totalCount,
    signals: {
      liquidity: { status: liquidityStatus, value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined, sparkline: jpyPrices.slice(-30) },
      flowStructure: { status: flowStatus, btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined, qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined },
      macroRegime: { status: regimeStatus, qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined, xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined },
      technicalTrend: { status: trendStatus, btcPrice: btcCurrent ?? undefined, sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined, sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined, vwap30d: btcVwap ?? undefined, mayerMultiple: mayerMultiple ?? undefined, sparkline: btcPrices.slice(-30) },
      hashRate: { status: hashStatus, change30d: hashChange ?? undefined },
      priceMomentum: { status: momentumStatus },
      fearGreed: { status: fgLabel, value: fgValue, history: fgHistory },
    },
    meta: { qqqSparkline: qqqPrices.slice(-30) },
    unavailable: false,
  };
}

// ─── EIA Crude Oil Inventories (WCRSTUS1) ───

async function fetchCrudeInventories() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'WCRSTUS1',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9', // fetch 9 so the oldest of 8 has a prior week for weeklyChangeMb
  });
  const data = await eiaFetchJson(`https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params}`, 'WCRSTUS1');
  const rows = data.response?.data;
  if (!rows || rows.length === 0) throw new Error('EIA WCRSTUS1: no data rows');

  // rows are sorted newest-first; compute weeklyChangeMb for each week vs. next (older)
  const weeks = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const row = rows[i];
    const stocksMb = row.value != null ? parseFloat(String(row.value)) : null;
    if (stocksMb == null || !Number.isFinite(stocksMb)) continue;
    const period = typeof row.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.period) ? row.period : '';

    const olderRow = rows[i + 1];
    let weeklyChangeMb = null;
    if (olderRow?.value != null) {
      const olderStocks = parseFloat(String(olderRow.value));
      if (Number.isFinite(olderStocks)) weeklyChangeMb = +(stocksMb - olderStocks).toFixed(3);
    }

    weeks.push({
      period,
      stocksMb: +stocksMb.toFixed(3),
      weeklyChangeMb,
    });

    if (weeks.length === 8) break; // only return 8 weeks to client
  }

  if (weeks.length < CRUDE_MIN_WEEKS) throw new Error(`EIA WCRSTUS1: only ${weeks.length} valid rows (need >= ${CRUDE_MIN_WEEKS})`);
  const latestPeriod = weeks[0]?.period ?? '';
  console.log(`  Crude inventories: ${weeks.length} weeks, latest=${latestPeriod}`);
  return { weeks, latestPeriod };
}

// ─── EIA Natural Gas Storage (NW2_EPG0_SWO_R48_BCF) ───

async function fetchNatGasStorage() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'NW2_EPG0_SWO_R48_BCF',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9', // fetch 9 so the oldest of 8 has a prior week for weeklyChangeBcf
  });
  const data = await eiaFetchJson(`https://api.eia.gov/v2/natural-gas/stor/wkly/data/?${params}`, 'NW2_EPG0_SWO_R48_BCF');
  const rows = data.response?.data;
  if (!rows || rows.length === 0) throw new Error('EIA NW2_EPG0_SWO_R48_BCF: no data rows');

  // rows are sorted newest-first; compute weeklyChangeBcf for each week vs. next (older)
  const weeks = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const row = rows[i];
    const storBcf = row.value != null ? parseFloat(String(row.value)) : null;
    if (storBcf == null || !Number.isFinite(storBcf)) continue;
    const period = typeof row.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.period) ? row.period : '';

    const olderRow = rows[i + 1];
    let weeklyChangeBcf = null;
    if (olderRow?.value != null) {
      const olderStor = parseFloat(String(olderRow.value));
      if (Number.isFinite(olderStor)) weeklyChangeBcf = +(storBcf - olderStor).toFixed(3);
    }

    weeks.push({
      period,
      storBcf: +storBcf.toFixed(3),
      weeklyChangeBcf,
    });

    if (weeks.length === 8) break; // only return 8 weeks to client
  }

  if (weeks.length < NAT_GAS_MIN_WEEKS) throw new Error(`EIA NW2_EPG0_SWO_R48_BCF: only ${weeks.length} valid rows (need >= ${NAT_GAS_MIN_WEEKS})`);
  const latestPeriod = weeks[0]?.period ?? '';
  console.log(`  Nat gas storage: ${weeks.length} weeks, latest=${latestPeriod}`);
  return { weeks, latestPeriod };
}

// ─── EIA Strategic Petroleum Reserve (WCSSTUS1) ───

/**
 * @param {{ value: unknown, period: unknown } | null | undefined} row
 * @returns {{ barrels: number, period: string } | null}
 */
export function parseEiaSprRow(row) {
  if (!row) return null;
  const barrels = row.value != null ? parseFloat(String(row.value)) : null;
  if (barrels == null || !Number.isFinite(barrels)) return null;
  const period = typeof row.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.period) ? row.period : '';
  return { barrels: +barrels.toFixed(3), period };
}

async function fetchSprLevels() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'WCSSTUS1',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9', // fetch 9 so we can compute 4-week change
  });
  const data = await eiaFetchJson(`https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params}`, 'WCSSTUS1');
  const rows = data.response?.data;
  if (!rows || rows.length === 0) throw new Error('EIA WCSSTUS1: no data rows');

  // rows are sorted newest-first
  const weeks = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const parsed = parseEiaSprRow(rows[i]);
    if (!parsed) continue;
    weeks.push(parsed);
    if (weeks.length === 8) break; // only return 8 weeks to client
  }

  if (weeks.length < SPR_MIN_WEEKS) throw new Error(`EIA WCSSTUS1: only ${weeks.length} valid rows (need >= ${SPR_MIN_WEEKS})`);

  const latest = weeks[0];
  const prev = weeks[1] ?? null;
  const prev4 = weeks[4] ?? null;

  const changeWoW = prev ? +(latest.barrels - prev.barrels).toFixed(3) : null;
  const changeWoW4 = prev4 ? +(latest.barrels - prev4.barrels).toFixed(3) : null;

  const latestPeriod = latest.period;
  console.log(`  SPR levels: ${weeks.length} weeks, latest=${latestPeriod}, barrels=${latest.barrels}M`);

  return {
    latestPeriod,
    barrels: latest.barrels,
    changeWoW,
    changeWoW4,
    weeks: weeks.map((w) => ({ period: w.period, barrels: w.barrels })),
    seededAt: new Date().toISOString(),
  };
}

// ─── EIA Refinery Crude Inputs (WCRRIUS2) ───
// Note: EIA v2 API does not expose refinery utilization rate (%) as a direct weekly series.
// WCRRIUS2 = U.S. Refiner Net Input of Crude Oil (Thousand Barrels per Day, MBBL/D).
// This is the closest available weekly proxy for refinery activity.

/**
 * @param {{ value: unknown, period: unknown } | null | undefined} row
 * @returns {{ inputsMbblpd: number, period: string } | null}
 */
export function parseEiaRefineryRow(row) {
  if (!row) return null;
  const inputsMbblpd = row.value != null ? parseFloat(String(row.value)) : null;
  if (inputsMbblpd == null || !Number.isFinite(inputsMbblpd)) return null;
  const period = typeof row.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.period) ? row.period : '';
  return { inputsMbblpd: +inputsMbblpd.toFixed(3), period };
}

async function fetchRefineryInputs() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'WCRRIUS2',
    'facets[duoarea][]': 'NUS',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9', // fetch 9 so the oldest of 8 has a prior week for WoW change
  });
  const data = await eiaFetchJson(`https://api.eia.gov/v2/petroleum/pnp/wiup/data/?${params}`, 'WCRRIUS2');
  const rows = data.response?.data;
  if (!rows || rows.length === 0) throw new Error('EIA WCRRIUS2: no data rows');

  // rows are sorted newest-first
  const weeks = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const parsed = parseEiaRefineryRow(rows[i]);
    if (!parsed) continue;
    weeks.push(parsed);
    if (weeks.length === 8) break; // only return 8 weeks to client
  }

  if (weeks.length < REFINERY_MIN_WEEKS) throw new Error(`EIA WCRRIUS2: only ${weeks.length} valid rows (need >= ${REFINERY_MIN_WEEKS})`);

  const latest = weeks[0];
  const prev = weeks[1] ?? null;

  const changeWoW = prev ? +(latest.inputsMbblpd - prev.inputsMbblpd).toFixed(3) : null;

  const latestPeriod = latest.period;
  console.log(`  Refinery inputs: ${weeks.length} weeks, latest=${latestPeriod}, inputs=${latest.inputsMbblpd} MBBL/D`);

  return {
    latestPeriod,
    inputsMbblpd: latest.inputsMbblpd,
    changeWoW,
    weeks: weeks.map((w) => ({ period: w.period, inputsMbblpd: w.inputsMbblpd })),
    seededAt: new Date().toISOString(),
  };
}

// ─── Main: seed all economic data ───
// NOTE: runSeed() calls process.exit(0) after writing the primary key.
// All secondary keys MUST be written inside fetchAll() before returning.

async function fetchAll() {
  const [energyPrices, energyCapacity, fredResults, macroSignals, crudeInventories, natGasStorage, sprLevels, refineryInputs] = await Promise.allSettled([
    fetchEnergyPrices(),
    fetchEnergyCapacity(),
    fetchFredSeries(),
    fetchMacroSignals(_curlProxyAuth),
    fetchCrudeInventories(),
    fetchNatGasStorage(),
    fetchSprLevels(),
    fetchRefineryInputs(),
  ]);

  const ep = energyPrices.status === 'fulfilled' ? energyPrices.value : null;
  const ec = energyCapacity.status === 'fulfilled' ? energyCapacity.value : null;
  const fr = fredResults.status === 'fulfilled' ? fredResults.value : null;
  const ms = macroSignals.status === 'fulfilled' ? macroSignals.value : null;
  const ci = crudeInventories.status === 'fulfilled' ? crudeInventories.value : null;
  const ng = natGasStorage.status === 'fulfilled' ? natGasStorage.value : null;
  const spr = sprLevels.status === 'fulfilled' ? sprLevels.value : null;
  const ru = refineryInputs.status === 'fulfilled' ? refineryInputs.value : null;

  if (energyPrices.status === 'rejected') console.warn(`  EnergyPrices failed: ${energyPrices.reason?.message || energyPrices.reason}`);
  if (energyCapacity.status === 'rejected') console.warn(`  EnergyCapacity failed: ${energyCapacity.reason?.message || energyCapacity.reason}`);
  if (fredResults.status === 'rejected') console.warn(`  FRED failed: ${fredResults.reason?.message || fredResults.reason}`);
  if (macroSignals.status === 'rejected') console.warn(`  MacroSignals failed: ${macroSignals.reason?.message || macroSignals.reason}`);
  if (crudeInventories.status === 'rejected') console.warn(`  CrudeInventories failed: ${crudeInventories.reason?.message || crudeInventories.reason}`);
  if (natGasStorage.status === 'rejected') console.warn(`  NatGasStorage failed: ${natGasStorage.reason?.message || natGasStorage.reason}`);
  if (sprLevels.status === 'rejected') console.warn(`  SPRLevels failed: ${sprLevels.reason?.message || sprLevels.reason}`);
  if (refineryInputs.status === 'rejected') console.warn(`  RefineryInputs failed: ${refineryInputs.reason?.message || refineryInputs.reason}`);

  const frHasData = fr && Object.keys(fr).length > 0;
  if (!ep && !frHasData && !ms) throw new Error('All economic fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ec?.series?.length > 0) await writeExtraKeyWithMeta(KEYS.energyCapacity, ec, CAPACITY_TTL, ec.series.length);

  if (frHasData) {
    for (const [seriesId, series] of Object.entries(fr)) {
      await writeExtraKeyWithMeta(`${FRED_KEY_PREFIX}:${seriesId}:0`, { series }, FRED_TTL, series.observations?.length ?? 0);
    }
  }

  if (ms && !ms.unavailable && ms.totalCount > 0) await writeExtraKeyWithMeta(KEYS.macroSignals, ms, MACRO_TTL, ms.totalCount ?? 0);

  const isValidWeek = (w) => typeof w.period === 'string' && typeof w.stocksMb === 'number' && Number.isFinite(w.stocksMb);
  if (ci?.weeks?.length >= CRUDE_MIN_WEEKS && ci.weeks.every(isValidWeek)) {
    await writeExtraKeyWithMeta(KEYS.crudeInventories, ci, CRUDE_INVENTORIES_TTL, ci.weeks.length);
  } else if (ci) {
    console.warn(`  CrudeInventories: skipped write — ${ci.weeks?.length ?? 0} weeks or schema invalid`);
  }

  const isValidNgWeek = (w) => typeof w.period === 'string' && typeof w.storBcf === 'number' && Number.isFinite(w.storBcf);
  if (ng?.weeks?.length >= NAT_GAS_MIN_WEEKS && ng.weeks.every(isValidNgWeek)) {
    await writeExtraKeyWithMeta(KEYS.natGasStorage, ng, NAT_GAS_TTL, ng.weeks.length);
  } else if (ng) {
    console.warn(`  NatGasStorage: skipped write — ${ng.weeks?.length ?? 0} weeks or schema invalid`);
  }

  const isValidSprWeek = (w) => typeof w.period === 'string' && typeof w.barrels === 'number' && Number.isFinite(w.barrels);
  if (spr?.weeks?.length >= SPR_MIN_WEEKS && spr.weeks.every(isValidSprWeek)) {
    await writeExtraKeyWithMeta(KEYS.spr, spr, SPR_TTL, spr.weeks.length);
  } else if (spr) {
    console.warn(`  SPRLevels: skipped write — ${spr.weeks?.length ?? 0} weeks or schema invalid`);
  }

  const isValidRuWeek = (w) => typeof w.period === 'string' && typeof w.inputsMbblpd === 'number' && Number.isFinite(w.inputsMbblpd);
  if (ru?.weeks?.length >= REFINERY_MIN_WEEKS && ru.weeks.every(isValidRuWeek)) {
    await writeExtraKeyWithMeta(KEYS.refineryInputs, ru, REFINERY_INPUTS_TTL, ru.weeks.length);
  } else if (ru) {
    console.warn(`  RefineryInputs: skipped write — ${ru.weeks?.length ?? 0} weeks or schema invalid`);
  }

  // Compute stress index — GSCPI is seeded by ais-relay (NY Fed), not FRED; read from Redis
  if (frHasData) {
    const gscpi = await fetchGscpiFromRedis();
    if (gscpi) {
      fr['GSCPI'] = gscpi;
      console.log('  [StressIndex] GSCPI loaded from Redis');
    } else {
      console.warn('  [StressIndex] GSCPI not in Redis yet (ais-relay lag or first run) — excluding');
    }
    let stressResult = null;
    try {
      stressResult = computeStressIndex(fr);
    } catch (e) {
      console.warn(`  [StressIndex] skipped write — ${e.message}`);
    }
    if (stressResult) {
      await writeExtraKeyWithMeta(STRESS_INDEX_KEY, stressResult, STRESS_INDEX_TTL, STRESS_COMPONENTS.length);
    }
  }

  return ep || { prices: [] };
}

function validate(data) {
  return data?.prices?.length > 0;
}

export function declareRecords(data) {
  return data?.prices?.length ?? 0;
}

if (process.argv[1]?.endsWith('seed-economy.mjs')) {
  runSeed('economic', 'energy-prices', KEYS.energyPrices, fetchAll, {
    validateFn: validate,
    ttlSeconds: ENERGY_TTL,
    sourceVersion: 'eia-fred-macro',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 150,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
