#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// ─── Keys (must match handler cache keys exactly) ───
const KEYS = {
  energyPrices: 'economic:energy:v1:all',
  energyCapacity: 'economic:capacity:v1:COL,SUN,WND:20',
  macroSignals: 'economic:macro-signals:v1',
};

const FRED_KEY_PREFIX = 'economic:fred:v1';
const FRED_TTL = 3600;
const ENERGY_TTL = 3600;
const CAPACITY_TTL = 86400;
const MACRO_TTL = 21600; // 6h — survive extended Yahoo outages

const FRED_SERIES = ['WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS', 'GDP', 'M2SL', 'DCOILWTICO'];

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
    const resp = await fetch(`https://api.eia.gov${c.apiPath}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  EIA ${c.commodity}: HTTP ${resp.status}`); continue; }
    const data = await resp.json();
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
        fetch(`https://api.stlouisfed.org/fred/series/observations?${obsParams}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        }),
        fetch(`https://api.stlouisfed.org/fred/series?${metaParams}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        }),
      ]);

      if (obsResp.status === 'rejected' || !obsResp.value.ok) {
        console.warn(`  FRED ${seriesId}: fetch failed`);
        continue;
      }

      const obsData = await obsResp.value.json();
      const observations = (obsData.observations || [])
        .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
        .filter(Boolean)
        .reverse();

      let title = seriesId, units = '', frequency = '';
      if (metaResp.status === 'fulfilled' && metaResp.value.ok) {
        const metaData = await metaResp.value.json();
        const meta = metaData.seriess?.[0];
        if (meta) { title = meta.title || seriesId; units = meta.units || ''; frequency = meta.frequency || ''; }
      }

      results[seriesId] = { seriesId, title, units, frequency, observations };
      await sleep(200); // be nice to FRED
    } catch (e) {
      console.warn(`  FRED ${seriesId}: ${e.message}`);
    }
  }
  console.log(`  FRED series: ${Object.keys(results).length}/${FRED_SERIES.length}`);
  return results;
}

// ─── Macro Signals (Yahoo, Alternative.me, Mempool) ───

async function fetchJsonSafe(url, timeout = 8000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
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
    const data = await fetchJsonSafe(`https://api.stlouisfed.org/fred/series/observations?${params}`, 10_000);
    return (data.observations || [])
      .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : v; })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
}

async function fetchMacroSignals() {
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';

  // Sequential Yahoo calls (150ms gaps like yahooGate)
  const jpyChart = await fetchJsonSafe(`${yahooBase}/JPY=X?range=1y&interval=1d`).catch(() => null);
  await sleep(150);
  const btcChart = await fetchJsonSafe(`${yahooBase}/BTC-USD?range=1y&interval=1d`).catch(() => null);
  await sleep(150);
  const qqqChart = await fetchJsonSafe(`${yahooBase}/QQQ?range=1y&interval=1d`).catch(() => null);
  await sleep(150);
  const xlpChart = await fetchJsonSafe(`${yahooBase}/XLP?range=1y&interval=1d`).catch(() => null);

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

// ─── Main: seed all economic data ───
// NOTE: runSeed() calls process.exit(0) after writing the primary key.
// All secondary keys MUST be written inside fetchAll() before returning.

async function fetchAll() {
  const [energyPrices, energyCapacity, fredResults, macroSignals] = await Promise.allSettled([
    fetchEnergyPrices(),
    fetchEnergyCapacity(),
    fetchFredSeries(),
    fetchMacroSignals(),
  ]);

  const ep = energyPrices.status === 'fulfilled' ? energyPrices.value : null;
  const ec = energyCapacity.status === 'fulfilled' ? energyCapacity.value : null;
  const fr = fredResults.status === 'fulfilled' ? fredResults.value : null;
  const ms = macroSignals.status === 'fulfilled' ? macroSignals.value : null;

  if (energyPrices.status === 'rejected') console.warn(`  EnergyPrices failed: ${energyPrices.reason?.message || energyPrices.reason}`);
  if (energyCapacity.status === 'rejected') console.warn(`  EnergyCapacity failed: ${energyCapacity.reason?.message || energyCapacity.reason}`);
  if (fredResults.status === 'rejected') console.warn(`  FRED failed: ${fredResults.reason?.message || fredResults.reason}`);
  if (macroSignals.status === 'rejected') console.warn(`  MacroSignals failed: ${macroSignals.reason?.message || macroSignals.reason}`);

  if (!ep && !fr && !ms) throw new Error('All economic fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (ec?.series?.length > 0) await writeExtraKeyWithMeta(KEYS.energyCapacity, ec, CAPACITY_TTL, ec.series.length);

  if (fr) {
    for (const [seriesId, series] of Object.entries(fr)) {
      await writeExtraKeyWithMeta(`${FRED_KEY_PREFIX}:${seriesId}:0`, { series }, FRED_TTL, series.observations?.length ?? 0);
    }
  }

  if (ms && !ms.unavailable && ms.totalCount > 0) await writeExtraKeyWithMeta(KEYS.macroSignals, ms, MACRO_TTL, ms.totalCount ?? 0);

  return ep || { prices: [] };
}

function validate(data) {
  return data?.prices?.length > 0;
}

runSeed('economic', 'energy-prices', KEYS.energyPrices, fetchAll, {
  validateFn: validate,
  ttlSeconds: ENERGY_TTL,
  sourceVersion: 'eia-fred-macro',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
