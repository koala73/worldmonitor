/**
 * RPC: getMacroSignals -- 7-signal macro dashboard
 * Port from api/macro-signals.js
 * Sources: Yahoo Finance, Alternative.me, Mempool
 * In-memory cache with 5-minute TTL.
 */

import type {
  ServerContext,
  GetMacroSignalsRequest,
  GetMacroSignalsResponse,
  FearGreedHistoryEntry,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import {
  fetchJSON,
  rateOfChange,
  smaCalc,
  extractClosePrices,
  extractAlignedPriceVolume,
} from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'economic:macro-signals:v1';
const REDIS_CACHE_TTL = 300; // 5 min — matches in-memory TTL

const MACRO_CACHE_TTL = 300; // 5 minutes in seconds
let macroSignalsCached: GetMacroSignalsResponse | null = null;
let macroSignalsCacheTimestamp = 0;

function buildFallbackResult(): GetMacroSignalsResponse {
  return {
    timestamp: new Date().toISOString(),
    verdict: 'UNKNOWN',
    bullishCount: 0,
    totalCount: 0,
    signals: {
      liquidity: { status: 'UNKNOWN', sparkline: [] },
      flowStructure: { status: 'UNKNOWN' },
      macroRegime: { status: 'UNKNOWN' },
      technicalTrend: { status: 'UNKNOWN', sparkline: [] },
      hashRate: { status: 'UNKNOWN' },
      miningCost: { status: 'UNKNOWN' },
      fearGreed: { status: 'UNKNOWN', history: [] },
    },
    meta: { qqqSparkline: [] },
    unavailable: true,
  };
}

async function computeMacroSignals(): Promise<GetMacroSignalsResponse> {
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';

  // Yahoo calls go through global yahooGate() in fetchJSON
  const jpyChart = await Promise.allSettled([fetchJSON(`${yahooBase}/JPY=X?range=1y&interval=1d`)]).then(r => r[0]!);
  const btcChart = await Promise.allSettled([fetchJSON(`${yahooBase}/BTC-USD?range=1y&interval=1d`)]).then(r => r[0]!);
  const qqqChart = await Promise.allSettled([fetchJSON(`${yahooBase}/QQQ?range=1y&interval=1d`)]).then(r => r[0]!);
  const xlpChart = await Promise.allSettled([fetchJSON(`${yahooBase}/XLP?range=1y&interval=1d`)]).then(r => r[0]!);
  // Non-Yahoo calls can go in parallel
  const [fearGreed, mempoolHash] = await Promise.allSettled([
    fetchJSON('https://api.alternative.me/fng/?limit=30&format=json'),
    fetchJSON('https://mempool.space/api/v1/mining/hashrate/1m'),
  ]);

  const jpyPrices = jpyChart.status === 'fulfilled' ? extractClosePrices(jpyChart.value) : [];
  const btcPrices = btcChart.status === 'fulfilled' ? extractClosePrices(btcChart.value) : [];
  const btcAligned = btcChart.status === 'fulfilled' ? extractAlignedPriceVolume(btcChart.value) : [];
  const qqqPrices = qqqChart.status === 'fulfilled' ? extractClosePrices(qqqChart.value) : [];
  const xlpPrices = xlpChart.status === 'fulfilled' ? extractClosePrices(xlpChart.value) : [];

  // 1. Liquidity Signal (JPY 30d ROC)
  const jpyRoc30 = rateOfChange(jpyPrices, 30);
  const liquidityStatus = jpyRoc30 !== null
    ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL')
    : 'UNKNOWN';

  // 2. Flow Structure (BTC vs QQQ 5d return)
  const btcReturn5 = rateOfChange(btcPrices, 5);
  const qqqReturn5 = rateOfChange(qqqPrices, 5);
  let flowStatus = 'UNKNOWN';
  if (btcReturn5 !== null && qqqReturn5 !== null) {
    const gap = btcReturn5 - qqqReturn5;
    flowStatus = Math.abs(gap) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
  }

  // 3. Macro Regime (QQQ/XLP 20d ROC)
  const qqqRoc20 = rateOfChange(qqqPrices, 20);
  const xlpRoc20 = rateOfChange(xlpPrices, 20);
  let regimeStatus = 'UNKNOWN';
  if (qqqRoc20 !== null && xlpRoc20 !== null) {
    regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';
  }

  // 4. Technical Trend (BTC vs SMA50 + VWAP)
  const btcSma50 = smaCalc(btcPrices, 50);
  const btcSma200 = smaCalc(btcPrices, 200);
  const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

  // Compute VWAP from aligned price/volume pairs (30d)
  let btcVwap: number | null = null;
  if (btcAligned.length >= 30) {
    const last30 = btcAligned.slice(-30);
    let sumPV = 0, sumV = 0;
    for (const { price, volume } of last30) {
      sumPV += price * volume;
      sumV += volume;
    }
    if (sumV > 0) btcVwap = +(sumPV / sumV).toFixed(0);
  }

  let trendStatus = 'UNKNOWN';
  let mayerMultiple: number | null = null;
  if (btcCurrent && btcSma50) {
    const aboveSma = btcCurrent > btcSma50 * 1.02;
    const belowSma = btcCurrent < btcSma50 * 0.98;
    const aboveVwap = btcVwap ? btcCurrent > btcVwap : null;
    if (aboveSma && aboveVwap !== false) trendStatus = 'BULLISH';
    else if (belowSma && aboveVwap !== true) trendStatus = 'BEARISH';
    else trendStatus = 'NEUTRAL';
  }
  if (btcCurrent && btcSma200) {
    mayerMultiple = +(btcCurrent / btcSma200).toFixed(2);
  }

  // 5. Hash Rate
  let hashStatus = 'UNKNOWN';
  let hashChange: number | null = null;
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

  // 6. Mining Cost (hashrate-based model)
  let miningStatus = 'UNKNOWN';
  if (btcCurrent && hashChange !== null) {
    miningStatus = btcCurrent > 60000 ? 'PROFITABLE' : btcCurrent > 40000 ? 'TIGHT' : 'SQUEEZE';
  }

  // 7. Fear & Greed
  let fgValue: number | undefined;
  let fgLabel = 'UNKNOWN';
  let fgHistory: FearGreedHistoryEntry[] = [];
  if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
    const data = fearGreed.value.data;
    const parsed = parseInt(data[0]?.value, 10);
    fgValue = Number.isFinite(parsed) ? parsed : undefined;
    fgLabel = data[0]?.value_classification || 'UNKNOWN';
    fgHistory = data.slice(0, 30).map((d: any) => ({
      value: parseInt(d.value, 10),
      date: new Date(parseInt(d.timestamp, 10) * 1000).toISOString().slice(0, 10),
    })).reverse();
  }

  // Sparkline data
  const btcSparkline = btcPrices.slice(-30);
  const qqqSparkline = qqqPrices.slice(-30);
  const jpySparkline = jpyPrices.slice(-30);

  // Overall Verdict
  let bullishCount = 0;
  let totalCount = 0;
  const signalList = [
    { name: 'Liquidity', status: liquidityStatus, bullish: liquidityStatus === 'NORMAL' },
    { name: 'Flow Structure', status: flowStatus, bullish: flowStatus === 'ALIGNED' },
    { name: 'Macro Regime', status: regimeStatus, bullish: regimeStatus === 'RISK-ON' },
    { name: 'Technical Trend', status: trendStatus, bullish: trendStatus === 'BULLISH' },
    { name: 'Hash Rate', status: hashStatus, bullish: hashStatus === 'GROWING' },
    { name: 'Mining Cost', status: miningStatus, bullish: miningStatus === 'PROFITABLE' },
    { name: 'Fear & Greed', status: fgLabel, bullish: fgValue !== undefined && fgValue > 50 },
  ];

  for (const s of signalList) {
    if (s.status !== 'UNKNOWN') {
      totalCount++;
      if (s.bullish) bullishCount++;
    }
  }

  const verdict = totalCount === 0 ? 'UNKNOWN' : (bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH');

  // Stale-while-revalidate: if Yahoo rate-limited all calls, serve cached data
  if (totalCount === 0 && macroSignalsCached && !macroSignalsCached.unavailable) {
    return macroSignalsCached;
  }

  return {
    timestamp: new Date().toISOString(),
    verdict,
    bullishCount,
    totalCount,
    signals: {
      liquidity: {
        status: liquidityStatus,
        value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined,
        sparkline: jpySparkline,
      },
      flowStructure: {
        status: flowStatus,
        btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined,
        qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined,
      },
      macroRegime: {
        status: regimeStatus,
        qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined,
        xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined,
      },
      technicalTrend: {
        status: trendStatus,
        btcPrice: btcCurrent ?? undefined,
        sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined,
        sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined,
        vwap30d: btcVwap ?? undefined,
        mayerMultiple: mayerMultiple ?? undefined,
        sparkline: btcSparkline,
      },
      hashRate: {
        status: hashStatus,
        change30d: hashChange ?? undefined,
      },
      miningCost: { status: miningStatus },
      fearGreed: {
        status: fgLabel,
        value: fgValue,
        history: fgHistory,
      },
    },
    meta: { qqqSparkline },
    unavailable: false,
  };
}

export async function getMacroSignals(
  _ctx: ServerContext,
  _req: GetMacroSignalsRequest,
): Promise<GetMacroSignalsResponse> {
  const now = Date.now();
  if (macroSignalsCached && now - macroSignalsCacheTimestamp < MACRO_CACHE_TTL * 1000) {
    return macroSignalsCached;
  }

  // Redis shared cache (cross-instance)
  const redisCached = (await getCachedJson(REDIS_CACHE_KEY)) as GetMacroSignalsResponse | null;
  if (redisCached && !redisCached.unavailable && redisCached.totalCount > 0) {
    macroSignalsCached = redisCached;
    macroSignalsCacheTimestamp = now;
    return redisCached;
  }

  try {
    const result = await computeMacroSignals();
    macroSignalsCached = result;
    macroSignalsCacheTimestamp = now;
    if (!result.unavailable) {
      setCachedJson(REDIS_CACHE_KEY, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    const fallback = macroSignalsCached || buildFallbackResult();
    macroSignalsCached = fallback;
    macroSignalsCacheTimestamp = now;
    return fallback;
  }
}
