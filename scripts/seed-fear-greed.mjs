#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, readSeedSnapshot, sleep } from './_seed-utils.mjs';
import { ProxyAgent, fetch as undiciF } from 'undici';

loadEnvFile(import.meta.url);

const _proxyAuth = process.env.OREF_PROXY_AUTH || '';
const _proxyAgent = _proxyAuth ? new ProxyAgent(`http://${_proxyAuth}`) : null;
const fetchViaProxy = _proxyAgent
  ? (url, opts = {}) => undiciF(url, { ...opts, dispatcher: _proxyAgent })
  : fetch;

const FEAR_GREED_KEY = 'market:fear-greed:v1';
const FEAR_GREED_TTL = 64800; // 18h = 3x 6h interval

const FRED_PREFIX = 'economic:fred:v1';

// --- Yahoo Finance fetching (15 symbols, 150ms gaps) ---
const YAHOO_SYMBOLS = ['^GSPC','^VIX','^VIX9D','^VIX3M','^SKEW','C:ISSU','GLD','TLT','SPY','RSP','DX-Y.NYB','XLK','XLF','XLE','XLV'];

async function fetchYahooSymbol(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  Yahoo ${symbol}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(v => v != null);
    const price = result.meta?.regularMarketPrice ?? validCloses.at(-1) ?? null;
    return { symbol, price, closes: validCloses };
  } catch (e) {
    console.warn(`  Yahoo ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchAllYahoo() {
  const results = {};
  for (const sym of YAHOO_SYMBOLS) {
    results[sym] = await fetchYahooSymbol(sym);
    await sleep(150);
  }
  return results;
}

// --- CBOE P/C ratios ---
async function fetchCBOE() {
  const headers = { 'User-Agent': CHROME_UA, Referer: 'https://www.cboe.com/' };
  const [totalResp, equityResp] = await Promise.allSettled([
    fetchViaProxy('https://cdn.cboe.com/api/global/us_indices/daily_prices/totalpc.csv', { headers, signal: AbortSignal.timeout(10_000) }),
    fetchViaProxy('https://cdn.cboe.com/api/global/us_indices/daily_prices/equitypc.csv', { headers, signal: AbortSignal.timeout(10_000) }),
  ]);
  const parseLastValue = async (resp, name) => {
    if (resp.status !== 'fulfilled') return null;
    if (!resp.value.ok) { console.warn(`  CBOE ${name}: HTTP ${resp.value.status}`); return null; }
    const text = await resp.value.text();
    const lines = text.trim().split('\n').filter(l => l.trim());
    const last = lines.at(-1)?.split(',');
    return last?.length >= 2 ? parseFloat(last[1]) : null;
  };
  const [totalPc, equityPc] = await Promise.all([parseLastValue(totalResp, 'totalpc'), parseLastValue(equityResp, 'equitypc')]);
  return { totalPc, equityPc };
}

// --- Barchart $S5TH: % of S&P 500 above 200d MA ---
async function fetchBarchartS5TH() {
  try {
    const resp = await fetch('https://www.barchart.com/stocks/quotes/%24S5TH', {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) { console.warn(`  Barchart $S5TH: HTTP ${resp.status}`); return null; }
    const html = await resp.text();
    const block = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? html;
    const m = block.match(/"lastPrice"\s*:\s*"?([\d.]+)"?/);
    const val = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(val) ? val : null;
  } catch (e) { console.warn('  Barchart $S5TH fetch failed:', e.message); return null; }
}

// --- CNN Fear & Greed ---
async function fetchCNN() {
  try {
    const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const resp = await fetchViaProxy(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${date}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', Referer: 'https://www.cnn.com/markets/fear-and-greed' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) { console.warn(`  CNN F&G: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const score = data?.fear_and_greed?.score;
    const rating = data?.fear_and_greed?.rating;
    return score != null ? { score: Math.round(score), label: rating ?? labelFromScore(Math.round(score)) } : null;
  } catch (e) { console.warn(`  CNN F&G: ${e.message}`); return null; }
}

// --- AAII Sentiment (LOW reliability, always wrapped, non-blocking) ---
async function fetchAAII() {
  try {
    const resp = await fetch('https://www.aaii.com/sentimentsurvey/sent_results', {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const bullMatch = html.match(/Bullish[^%]*?([\d.]+)%/i);
    const bearMatch = html.match(/Bearish[^%]*?([\d.]+)%/i);
    if (!bullMatch || !bearMatch) return null;
    return { bull: parseFloat(bullMatch[1]), bear: parseFloat(bearMatch[1]) };
  } catch (e) {
    console.warn('  AAII: fetch failed:', e.message, '(using degraded Sentiment)');
    return null;
  }
}

// --- FRED Redis reads ---
async function readFred(seriesId) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(`${FRED_PREFIX}:${seriesId}:0`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    if (!result) return null;
    const parsed = JSON.parse(result);
    const obs = parsed?.series?.observations;
    if (!obs?.length) return null;
    return obs;
  } catch { return null; }
}

async function readMacroSignals() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent('economic:macro-signals:v1')}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}

// --- Math helpers ---
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sma(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a,b) => a+b, 0) / period;
}
function roc(prices, period) {
  if (prices.length < period+1) return null;
  const prev = prices[prices.length - period - 1];
  const curr = prices[prices.length - 1];
  return prev ? ((curr - prev) / prev) * 100 : null;
}
function rsi(prices, period=14) {
  if (prices.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=prices.length-period; i<prices.length; i++) {
    const d = prices[i]-prices[i-1];
    if (d>0) gains+=d; else losses+=Math.abs(d);
  }
  if (losses===0) return 100;
  const rs = (gains/period)/(losses/period);
  return 100 - (100/(1+rs));
}
function fredLatest(obs) {
  if (!obs) return null;
  const v = parseFloat(obs.at(-1)?.value ?? 'NaN');
  return Number.isFinite(v) ? v : null;
}
function fredNMonthsAgo(obs, months) {
  if (!obs) return null;
  const idx = obs.length - 1 - months;
  if (idx < 0) return null;
  const v = parseFloat(obs[idx]?.value ?? 'NaN');
  return Number.isFinite(v) ? v : null;
}
function labelFromScore(s) {
  if (s <= 20) return 'Extreme Fear';
  if (s <= 40) return 'Fear';
  if (s <= 60) return 'Neutral';
  if (s <= 80) return 'Greed';
  return 'Extreme Greed';
}

// --- Scoring ---
function scoreCategory(name, inputs) {
  switch(name) {
    case 'sentiment': {
      const { cnnFg, aaiBull, aaiBear, cryptoFg } = inputs;
      const degraded = aaiBull == null || aaiBear == null;
      let score;
      if (!degraded) {
        const bullPct = clamp(aaiBull, 0, 100);
        const bearPct = clamp(aaiBear, 0, 100);
        const bullPercentile = clamp((bullPct / 60) * 100, 0, 100);
        const bearPercentile = clamp((bearPct / 55) * 100, 0, 100);
        if (cnnFg != null) {
          score = (cnnFg * 0.4) + (bullPercentile * 0.3) + ((100 - bearPercentile) * 0.3);
        } else {
          score = (bullPercentile * 0.5) + ((100 - bearPercentile) * 0.5);
        }
      } else if (cnnFg != null) {
        score = cnnFg;
      } else if (cryptoFg != null) {
        score = cryptoFg;
      } else {
        score = 50;
      }
      return { score: clamp(Math.round(score), 0, 100), degraded, inputs: { cnnFearGreed: cnnFg, aaiBull: aaiBull ?? null, aaiBear: aaiBear ?? null, cryptoFg } };
    }
    case 'volatility': {
      const { vix, vix9d, vix3m } = inputs;
      if (vix == null) return { score: 50, inputs };
      const vixScore = clamp(100 - ((vix - 12) / 28) * 100, 0, 100);
      const termScore = (vix9d != null && vix3m != null) ? (vix / vix3m < 1 ? 70 : 30) : 50;
      const termStructure = (vix9d != null && vix3m != null) ? (vix / vix3m < 1 ? 'contango' : 'backwardation') : 'unknown';
      return { score: Math.round(vixScore * 0.7 + termScore * 0.3), inputs: { vix, vix9d, vix3m, termStructure } };
    }
    case 'positioning': {
      const { totalPc, equityPc, skew } = inputs;
      const pc = totalPc ?? equityPc;
      if (pc == null && skew == null) return { score: 50, inputs };
      const pcScore = pc != null ? clamp(100 - ((pc - 0.7) / 0.6) * 100, 0, 100) : 50;
      const skewScore = skew != null ? clamp(100 - ((skew - 100) / 50) * 100, 0, 100) : 50;
      const w = pc != null && skew != null ? [0.6, 0.4] : [1.0, 0.0];
      return { score: Math.round(pcScore * w[0] + skewScore * w[1]), inputs: { putCallRatio: pc, skew } };
    }
    case 'trend': {
      const { prices } = inputs;
      if (!prices?.length) return { score: 50, inputs: {} };
      const price = prices.at(-1);
      const s20 = sma(prices, 20), s50 = sma(prices, 50), s200 = sma(prices, 200);
      const aboveCount = [s20, s50, s200].filter(s => s != null && price > s).length;
      const dist200 = s200 ? (price - s200) / s200 : 0;
      const score = (aboveCount / 3) * 50 + clamp(dist200 * 500 + 50, 0, 100) * 0.5;
      return { score: Math.round(clamp(score, 0, 100)), inputs: { spxPrice: price, sma20: s20, sma50: s50, sma200: s200, aboveMaCount: aboveCount } };
    }
    case 'breadth': {
      const { mmthPrice, rspCloses, spyCloses, advDecRatio } = inputs;
      const breadthScore = mmthPrice != null ? clamp(mmthPrice, 0, 100) : 50;
      const rspRoc = (rspCloses?.length && spyCloses?.length) ? (roc(rspCloses, 30) ?? 0) - (roc(spyCloses, 30) ?? 0) : null;
      const rspScore = rspRoc != null ? clamp(rspRoc * 10 + 50, 0, 100) : 50;
      const adScore = advDecRatio != null ? clamp((advDecRatio - 0.5) / 1.5 * 100, 0, 100) : 50;
      const hasAd = advDecRatio != null;
      const w = hasAd ? [0.4, 0.3, 0.3] : [0.57, 0, 0.43];
      const score = breadthScore * w[0] + adScore * w[1] + rspScore * w[2];
      return { score: Math.round(clamp(score, 0, 100)), degraded: mmthPrice == null, inputs: { pctAbove200d: mmthPrice, rspSpyRatio: rspRoc, advDecRatio: advDecRatio ?? null } };
    }
    case 'momentum': {
      const { spxCloses, sectorCloses } = inputs;
      const spxRoc = spxCloses?.length ? roc(spxCloses, 20) : null;
      const rocScore = spxRoc != null ? clamp(spxRoc * 10 + 50, 0, 100) : 50;
      const sectorRsiValues = sectorCloses ? Object.values(sectorCloses).filter(Boolean).map(c => rsi(c)) : [];
      const avgRsi = sectorRsiValues.length ? sectorRsiValues.reduce((a,b)=>a+b,0)/sectorRsiValues.length : 50;
      const rsiScore = clamp((avgRsi - 30) / 40 * 100, 0, 100);
      return { score: Math.round((rsiScore * 0.5 + rocScore * 0.5)), inputs: { spxRoc20d: spxRoc, sectorRsiAvg: Math.round(avgRsi) } };
    }
    case 'liquidity': {
      const { m2Obs, walclObs, sofr } = inputs;
      const m2Latest = fredLatest(m2Obs), m2Ago = fredNMonthsAgo(m2Obs, 12);
      const m2Yoy = (m2Latest && m2Ago && m2Ago !== 0) ? ((m2Latest - m2Ago) / m2Ago) * 100 : null;
      const walclLatest = fredLatest(walclObs), walclAgo = fredNMonthsAgo(walclObs, 1);
      const fedBsMom = (walclLatest && walclAgo && walclAgo !== 0) ? ((walclLatest - walclAgo) / walclAgo) * 100 : null;
      const m2Score = m2Yoy != null ? clamp(m2Yoy * 10 + 50, 0, 100) : 50;
      const fedScore = fedBsMom != null ? clamp(fedBsMom * 20 + 50, 0, 100) : 50;
      const sofrScore = sofr != null ? clamp(100 - sofr * 15, 0, 100) : 50;
      return { score: Math.round(m2Score * 0.4 + fedScore * 0.3 + sofrScore * 0.3), inputs: { m2Yoy, fedBsMom, sofr } };
    }
    case 'credit': {
      const { hyObs, igObs } = inputs;
      const hySpread = fredLatest(hyObs), igSpread = fredLatest(igObs);
      const hyScore = hySpread != null ? clamp(100 - ((hySpread - 3.0) / 5.0) * 100, 0, 100) : 50;
      const igScore = igSpread != null ? clamp(100 - ((igSpread - 0.8) / 2.0) * 100, 0, 100) : 50;
      const hyPrev = fredNMonthsAgo(hyObs, 1);
      const hyTrend = (hySpread != null && hyPrev != null) ? (hySpread < hyPrev ? 'narrowing' : hySpread > hyPrev ? 'widening' : 'stable') : 'stable';
      const trendScore = hyTrend === 'narrowing' ? 70 : hyTrend === 'widening' ? 30 : 50;
      return { score: Math.round(hyScore * 0.4 + igScore * 0.3 + trendScore * 0.3), inputs: { hySpread, igSpread, hyTrend30d: hyTrend } };
    }
    case 'macro': {
      const { fedObs, curveObs, unrateObs } = inputs;
      const fedRate = fredLatest(fedObs), t10y2y = fredLatest(curveObs), unrate = fredLatest(unrateObs);
      const rateScore = fedRate != null ? clamp(100 - fedRate * 15, 0, 100) : 50;
      const curveScore = t10y2y != null ? (t10y2y > 0 ? clamp(60 + t10y2y * 20, 0, 100) : clamp(40 + t10y2y * 40, 0, 100)) : 50;
      const unempScore = unrate != null ? clamp(100 - (unrate - 3.5) * 20, 0, 100) : 50;
      return { score: Math.round(rateScore * 0.3 + curveScore * 0.4 + unempScore * 0.3), inputs: { fedRate, t10y2y, unrate } };
    }
    case 'crossAsset': {
      const { gldCloses, tltCloses, spyCloses, dxyCloses } = inputs;
      const goldRoc = gldCloses?.length ? roc(gldCloses, 30) : null;
      const tltRoc = tltCloses?.length ? roc(tltCloses, 30) : null;
      const spyRoc = spyCloses?.length ? roc(spyCloses, 30) : null;
      const dxyRoc = dxyCloses?.length ? roc(dxyCloses, 30) : null;
      const goldSignal = (goldRoc != null && spyRoc != null) ? (goldRoc > spyRoc ? 30 : 70) : 50;
      const bondSignal = (tltRoc != null && spyRoc != null) ? (tltRoc > spyRoc ? 30 : 70) : 50;
      const dxySignal = dxyRoc != null ? (dxyRoc > 0 ? 40 : 60) : 50;
      return { score: Math.round((goldSignal + bondSignal + dxySignal) / 3), inputs: { goldReturn30d: goldRoc, tltReturn30d: tltRoc, spyReturn30d: spyRoc, dxyChange30d: dxyRoc } };
    }
    default: return { score: 50, inputs };
  }
}

const WEIGHTS = { sentiment: 0.10, volatility: 0.10, positioning: 0.15, trend: 0.10, breadth: 0.10, momentum: 0.10, liquidity: 0.15, credit: 0.10, macro: 0.05, crossAsset: 0.05 };

async function fetchAll() {
  const prevSnapshot = await readSeedSnapshot(FEAR_GREED_KEY).catch(() => null);
  const previousScore = prevSnapshot?.composite?.score ?? null;

  const [yahooResults, cboeResult, cnnResult, aaiiResult, macroSignals, barchartResult] = await Promise.allSettled([
    fetchAllYahoo(),
    fetchCBOE(),
    fetchCNN(),
    fetchAAII(),
    readMacroSignals(),
    fetchBarchartS5TH(),
  ]);

  const yahoo = yahooResults.status === 'fulfilled' ? yahooResults.value : {};
  const cboe = cboeResult.status === 'fulfilled' ? cboeResult.value : {};
  const cnn = cnnResult.status === 'fulfilled' ? cnnResult.value : null;
  const aaii = aaiiResult.status === 'fulfilled' ? aaiiResult.value : null;
  const macro = macroSignals.status === 'fulfilled' ? macroSignals.value : null;

  // Source status summary — visible in Railway container logs
  const yahooCount = Object.values(yahoo).filter(Boolean).length;
  console.log(`  Sources: Yahoo=${yahooCount}/${YAHOO_SYMBOLS.length} | CBOE totalPc=${cboe.totalPc ?? 'null'} equityPc=${cboe.equityPc ?? 'null'} | CNN=${cnn ? cnn.score : 'null'} | AAII bull=${aaii ? aaii.bull : 'null'} | Barchart=${barchartResult.status === 'fulfilled' ? (barchartResult.value ?? 'null') : 'err'} | proxy=${_proxyAuth ? 'yes' : 'no'}`);

  if (yahooResults.status === 'rejected') console.warn('  Yahoo batch failed:', yahooResults.reason?.message);
  if (cboeResult.status === 'rejected') console.warn('  CBOE failed:', cboeResult.reason?.message);
  if (cnnResult.status === 'rejected') console.warn('  CNN failed:', cnnResult.reason?.message);
  if (aaiiResult.status === 'rejected') console.warn('  AAII failed:', aaiiResult.reason?.message);
  if (barchartResult.status === 'fulfilled' && barchartResult.value == null) console.warn('  Barchart $S5TH: unavailable (using RSP/SPY proxy if possible)');

  const [hyObs, igObs, m2Obs, walclObs, sofrObs, fedObs, curveObs, unrateObs, vixObs, dgs10Obs] = await Promise.all([
    readFred('BAMLH0A0HYM2'), readFred('BAMLC0A0CM'), readFred('M2SL'), readFred('WALCL'),
    readFred('SOFR'), readFred('FEDFUNDS'), readFred('T10Y2Y'), readFred('UNRATE'), readFred('VIXCLS'), readFred('DGS10'),
  ]);

  const gspc = yahoo['^GSPC'];
  const vixData = yahoo['^VIX'];
  const vix9d = yahoo['^VIX9D'];
  const vix3m = yahoo['^VIX3M'];
  const skew = yahoo['^SKEW'];
  const cissu = yahoo['C:ISSU'];
  const gld = yahoo['GLD'], tlt = yahoo['TLT'], spy = yahoo['SPY'], rsp = yahoo['RSP'];
  const dxy = yahoo['DX-Y.NYB'];
  const xlk = yahoo['XLK'], xlf = yahoo['XLF'], xle = yahoo['XLE'], xlv = yahoo['XLV'];

  const vixLive = vixData?.price ?? fredLatest(vixObs);
  const vix9dPrice = vix9d?.price ?? null;
  const vix3mPrice = vix3m?.price ?? null;
  const skewPrice = skew?.price ?? null;
  const sofrRate = fredLatest(sofrObs);

  // Barchart $S5TH: exact % of S&P 500 above 200d MA.
  // Used for both breadth scoring and header display. Null → header shows N/A, breadth
  // defaults to neutral 50 (rspScore still captures RSP/SPY signal independently).
  const pctAbove200d = barchartResult.status === 'fulfilled' ? barchartResult.value : null;
  const cryptoFg = macro?.fearGreed?.score ?? macro?.signals?.fearGreed?.value ?? null;

  let advDecRatio = null;
  if (cissu?.price != null) {
    advDecRatio = cissu.price > 0 ? Math.min(cissu.price / 100, 2.0) : null;
  }

  const cats = {
    sentiment: scoreCategory('sentiment', { cnnFg: cnn?.score ?? null, aaiBull: aaii?.bull ?? null, aaiBear: aaii?.bear ?? null, cryptoFg }),
    volatility: scoreCategory('volatility', { vix: vixLive, vix9d: vix9dPrice, vix3m: vix3mPrice }),
    positioning: scoreCategory('positioning', { totalPc: cboe.totalPc, equityPc: cboe.equityPc, skew: skewPrice }),
    trend: scoreCategory('trend', { prices: gspc?.closes ?? [] }),
    breadth: scoreCategory('breadth', { mmthPrice: pctAbove200d, rspCloses: rsp?.closes, spyCloses: spy?.closes, advDecRatio }),
    momentum: scoreCategory('momentum', { spxCloses: gspc?.closes, sectorCloses: { XLK: xlk?.closes, XLF: xlf?.closes, XLE: xle?.closes, XLV: xlv?.closes } }),
    liquidity: scoreCategory('liquidity', { m2Obs, walclObs, sofr: sofrRate }),
    credit: scoreCategory('credit', { hyObs, igObs }),
    macro: scoreCategory('macro', { fedObs, curveObs, unrateObs }),
    crossAsset: scoreCategory('crossAsset', { gldCloses: gld?.closes, tltCloses: tlt?.closes, spyCloses: spy?.closes, dxyCloses: dxy?.closes }),
  };

  const compositeScore = Math.round(
    Object.entries(cats).reduce((sum, [name, cat]) => sum + cat.score * WEIGHTS[name], 0) * 10
  ) / 10;
  const compositeLabel = labelFromScore(compositeScore);

  const fedRate = fredLatest(fedObs);
  const fedRateStr = fedRate != null ? `${fedRate.toFixed(2)}%` : null;
  const hySpreadVal = fredLatest(hyObs);

  const payload = {
    timestamp: new Date().toISOString(),
    composite: { score: compositeScore, label: compositeLabel, previous: previousScore },
    categories: {
      sentiment:   { score: cats.sentiment.score, weight: WEIGHTS.sentiment, contribution: Math.round(cats.sentiment.score * WEIGHTS.sentiment * 10)/10, inputs: cats.sentiment.inputs, degraded: cats.sentiment.degraded ?? false },
      volatility:  { score: cats.volatility.score, weight: WEIGHTS.volatility, contribution: Math.round(cats.volatility.score * WEIGHTS.volatility * 10)/10, inputs: cats.volatility.inputs },
      positioning: { score: cats.positioning.score, weight: WEIGHTS.positioning, contribution: Math.round(cats.positioning.score * WEIGHTS.positioning * 10)/10, inputs: cats.positioning.inputs },
      trend:       { score: cats.trend.score, weight: WEIGHTS.trend, contribution: Math.round(cats.trend.score * WEIGHTS.trend * 10)/10, inputs: cats.trend.inputs },
      breadth:     { score: cats.breadth.score, weight: WEIGHTS.breadth, contribution: Math.round(cats.breadth.score * WEIGHTS.breadth * 10)/10, inputs: cats.breadth.inputs, degraded: cats.breadth.degraded ?? false },
      momentum:    { score: cats.momentum.score, weight: WEIGHTS.momentum, contribution: Math.round(cats.momentum.score * WEIGHTS.momentum * 10)/10, inputs: cats.momentum.inputs },
      liquidity:   { score: cats.liquidity.score, weight: WEIGHTS.liquidity, contribution: Math.round(cats.liquidity.score * WEIGHTS.liquidity * 10)/10, inputs: cats.liquidity.inputs },
      credit:      { score: cats.credit.score, weight: WEIGHTS.credit, contribution: Math.round(cats.credit.score * WEIGHTS.credit * 10)/10, inputs: cats.credit.inputs },
      macro:       { score: cats.macro.score, weight: WEIGHTS.macro, contribution: Math.round(cats.macro.score * WEIGHTS.macro * 10)/10, inputs: cats.macro.inputs },
      crossAsset:  { score: cats.crossAsset.score, weight: WEIGHTS.crossAsset, contribution: Math.round(cats.crossAsset.score * WEIGHTS.crossAsset * 10)/10, inputs: cats.crossAsset.inputs },
    },
    headerMetrics: {
      cnnFearGreed: cnn ? { value: cnn.score, label: cnn.label } : null,
      aaiBear:  aaii ? { value: Math.round(aaii.bear), context: `${aaii.bear.toFixed(1)}%` } : null,
      aaiBull:  aaii ? { value: Math.round(aaii.bull), context: `${aaii.bull.toFixed(1)}%` } : null,
      putCall:  cboe.totalPc != null ? { value: cboe.totalPc } : null,
      vix:      vixLive != null ? { value: vixLive } : null,
      hySpread: hySpreadVal != null ? { value: hySpreadVal } : null,
      pctAbove200d: pctAbove200d != null ? { value: pctAbove200d } : null,
      yield10y: fredLatest(dgs10Obs) != null ? { value: fredLatest(dgs10Obs) } : null,
      fedRate:  fedRateStr ? { value: fedRateStr } : null,
    },
    unavailable: false,
  };

  return payload;
}

function validate(data) {
  return data?.composite?.score != null && data.timestamp != null;
}

runSeed('market', 'fear-greed', FEAR_GREED_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: FEAR_GREED_TTL,
  sourceVersion: 'yahoo-cboe-cnn-fred-v1',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
