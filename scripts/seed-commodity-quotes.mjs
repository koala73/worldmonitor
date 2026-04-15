#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, sleep, runSeed, parseYahooChart, writeExtraKey, writeExtraKeyWithMeta, CHROME_UA } from './_seed-utils.mjs';
import { AV_PHYSICAL_MAP, fetchAvPhysicalCommodity, fetchAvBulkQuotes } from './_shared-av.mjs';

const commodityConfig = loadSharedConfig('commodities.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:commodities-bootstrap:v1';
const GOLD_EXTENDED_KEY = 'market:gold-extended:v1';
const CACHE_TTL = 1800;
const YAHOO_DELAY_MS = 200;

const GOLD_HISTORY_SYMBOLS = ['GC=F', 'SI=F'];
const GOLD_DRIVER_SYMBOLS = [
  { symbol: '^TNX', label: 'US 10Y Yield' },
  { symbol: 'DX-Y.NYB', label: 'DXY' },
];

async function fetchYahooChart1y(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta;
    const ts = r.timestamp || [];
    const closes = r.indicators?.quote?.[0]?.close || [];
    const history = ts.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: closes[i] }))
      .filter(p => p.c != null && Number.isFinite(p.c));
    return {
      symbol,
      price: meta?.regularMarketPrice ?? null,
      dayHigh: meta?.regularMarketDayHigh ?? null,
      dayLow: meta?.regularMarketDayLow ?? null,
      prevClose: meta?.chartPreviousClose ?? meta?.previousClose ?? null,
      fiftyTwoWeekHigh: meta?.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta?.fiftyTwoWeekLow ?? null,
      history,
    };
  } catch {
    return null;
  }
}

function computeReturns(history, currentPrice) {
  if (!history.length || !Number.isFinite(currentPrice)) return { w1: 0, m1: 0, ytd: 0, y1: 0 };
  const byAgo = (days) => {
    const target = history[Math.max(0, history.length - 1 - days)];
    return target?.c;
  };
  const firstOfYear = history.find(p => p.d.startsWith(new Date().getUTCFullYear().toString()))?.c
    ?? history[0].c;
  const pct = (from) => from ? ((currentPrice - from) / from) * 100 : 0;
  return {
    w1: +pct(byAgo(5)).toFixed(2),
    m1: +pct(byAgo(21)).toFixed(2),
    ytd: +pct(firstOfYear).toFixed(2),
    y1: +pct(history[0].c).toFixed(2),
  };
}

function computeRange52w(history, currentPrice) {
  if (!history.length) return { hi: 0, lo: 0, positionPct: 0 };
  const closes = history.map(p => p.c);
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  const span = hi - lo;
  const positionPct = span > 0 ? ((currentPrice - lo) / span) * 100 : 50;
  return { hi: +hi.toFixed(2), lo: +lo.toFixed(2), positionPct: +positionPct.toFixed(1) };
}

// Pearson correlation over the last N aligned daily returns
function pearsonCorrelation(aReturns, bReturns) {
  const n = Math.min(aReturns.length, bReturns.length);
  if (n < 5) return 0;
  const a = aReturns.slice(-n);
  const b = bReturns.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  return denom > 0 ? +(num / denom).toFixed(3) : 0;
}

function dailyReturns(history) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].c;
    if (prev > 0) out.push((history[i].c - prev) / prev);
  }
  return out;
}

async function fetchGoldExtended() {
  const goldHistory = {};
  for (const sym of GOLD_HISTORY_SYMBOLS) {
    await sleep(YAHOO_DELAY_MS);
    const chart = await fetchYahooChart1y(sym);
    if (chart) goldHistory[sym] = chart;
  }

  const drivers = [];
  const goldReturns = goldHistory['GC=F'] ? dailyReturns(goldHistory['GC=F'].history) : [];

  for (const cfg of GOLD_DRIVER_SYMBOLS) {
    await sleep(YAHOO_DELAY_MS);
    const chart = await fetchYahooChart1y(cfg.symbol);
    if (!chart || chart.price == null) continue;
    const changePct = chart.prevClose ? ((chart.price - chart.prevClose) / chart.prevClose) * 100 : 0;
    const driverReturns = dailyReturns(chart.history).slice(-30);
    const goldLast30 = goldReturns.slice(-30);
    const correlation = pearsonCorrelation(goldLast30, driverReturns);
    drivers.push({
      symbol: cfg.symbol,
      label: cfg.label,
      value: +chart.price.toFixed(2),
      changePct: +changePct.toFixed(2),
      correlation30d: correlation,
    });
  }

  const gold = goldHistory['GC=F'];
  const silver = goldHistory['SI=F'];

  const build = (chart) => {
    if (!chart || chart.price == null) return null;
    return {
      price: chart.price,
      dayHigh: chart.dayHigh ?? 0,
      dayLow: chart.dayLow ?? 0,
      prevClose: chart.prevClose ?? 0,
      returns: computeReturns(chart.history, chart.price),
      range52w: computeRange52w(chart.history, chart.price),
    };
  };

  return {
    updatedAt: new Date().toISOString(),
    gold: build(gold),
    silver: build(silver),
    drivers,
  };
}

async function fetchYahooWithRetry(url, label, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 429) {
      const wait = 5000 * (i + 1);
      console.warn(`  [Yahoo] ${label} 429 — waiting ${wait / 1000}s (attempt ${i + 1}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) {
      console.warn(`  [Yahoo] ${label} HTTP ${resp.status}`);
      return null;
    }
    return resp;
  }
  console.warn(`  [Yahoo] ${label} rate limited after ${maxAttempts} attempts`);
  return null;
}

const COMMODITY_SYMBOLS = commodityConfig.commodities.map(c => c.symbol);

async function fetchCommodityQuotes() {
  const quotes = [];
  let misses = 0;
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;

  // --- Primary: Alpha Vantage ---
  if (avKey) {
    // Physical commodity functions for WTI, BRENT, NATURAL_GAS, COPPER, ALUMINUM
    const physicalSymbols = COMMODITY_SYMBOLS.filter(s => AV_PHYSICAL_MAP[s]);
    for (const sym of physicalSymbols) {
      const q = await fetchAvPhysicalCommodity(sym, avKey);
      if (q) {
        const meta = commodityConfig.commodities.find(c => c.symbol === sym);
        quotes.push({ symbol: sym, name: meta?.name || sym, display: meta?.display || sym, ...q });
        console.log(`  [AV:physical] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
      }
    }

    // REALTIME_BULK_QUOTES for ETF-style symbols (URA, LIT)
    const bulkCandidates = COMMODITY_SYMBOLS.filter(s => !AV_PHYSICAL_MAP[s] && !quotes.some(q => q.symbol === s) && !s.includes('=F') && !s.startsWith('^'));
    const bulkResults = await fetchAvBulkQuotes(bulkCandidates, avKey);
    for (const [sym, q] of bulkResults) {
      const meta = commodityConfig.commodities.find(c => c.symbol === sym);
      quotes.push({ symbol: sym, name: meta?.name || sym, display: meta?.display || sym, price: q.price, change: q.change, sparkline: [] });
      console.log(`  [AV:bulk] ${sym}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
    }
  }

  const covered = new Set(quotes.map(q => q.symbol));

  // --- Fallback: Yahoo (for remaining symbols: futures not covered by AV, ^VIX, Indian markets) ---
  let yahooIdx = 0;
  for (let i = 0; i < COMMODITY_SYMBOLS.length; i++) {
    const symbol = COMMODITY_SYMBOLS[i];
    if (covered.has(symbol)) continue;
    if (yahooIdx > 0) await sleep(YAHOO_DELAY_MS);
    yahooIdx++;

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetchYahooWithRetry(url, symbol);
      if (!resp) { misses++; continue; }
      const parsed = parseYahooChart(await resp.json(), symbol);
      if (parsed) {
        quotes.push(parsed);
        covered.add(symbol);
        console.log(`  [Yahoo] ${symbol}: $${parsed.price} (${parsed.change > 0 ? '+' : ''}${parsed.change}%)`);
      } else {
        misses++;
      }
    } catch (err) {
      console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
      misses++;
    }
  }

  if (quotes.length === 0) {
    throw new Error(`All commodity fetches failed (${misses} misses)`);
  }

  return { quotes };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.quotes) ? data.quotes.length : 0;
}

// fetchCommodityQuotes returns the canonical {quotes} payload that runSeed
// then writes to CANONICAL_KEY. The same value is passed to opts.afterPublish
// as `data`, which is where the companion-key writes happen.

/**
 * Required companion writes — alias keys that must succeed alongside the
 * canonical commodity publish.
 *
 * BACKGROUND (do NOT regress to .then() pattern):
 * runSeed() in scripts/_seed-utils.mjs ends with process.exit(0) on success,
 * which terminates Node before any .then() microtask chained on its returned
 * promise can run. The previous implementation used `runSeed(...).then(write...)`
 * and these three keys (market:commodities:v1:<symbols>, market:quotes:v1:<symbols>,
 * market:gold-extended:v1) were silently dead for months — Railway log
 * 2026-04-14 08:50:31 confirms zero [Gold] log lines and goldExtended
 * health=EMPTY since the seeder was added. The fix is to wire post-publish
 * writes via opts.afterPublish, which runSeed awaits BEFORE process.exit
 * (see _seed-utils.mjs runSeed() lines ~792-794).
 *
 * ERROR SEMANTICS (per Codex review on PR #3088):
 * Required alias writes propagate errors. Any failure here MUST bubble up so
 * runSeed's outer try/catch rejects the run, the lock is released, and
 * process.exit(1) fires via the outer .catch. Otherwise seed-meta on the
 * canonical key would be stamped fresh while the alias keys are stale or
 * missing — phantom-success returns by a different door. Only the OPTIONAL
 * gold-extended branch (separate function below) is downgraded to a warning,
 * because it has its own independent seed-meta key.
 *
 * Writes are parallelized via Promise.all — independent Redis writes, no
 * read-after-write ordering required (per Greptile review on PR #3088).
 */
async function writeRequiredCompanionKeys(data) {
  const commodityKey = `market:commodities:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesKey = `market:quotes:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesPayload = { ...data, finnhubSkipped: false, skipReason: '', rateLimited: false };
  await Promise.all([
    writeExtraKey(commodityKey, data, CACHE_TTL),
    writeExtraKey(quotesKey, quotesPayload, CACHE_TTL),
  ]);
}

/**
 * Optional gold-extended write — Yahoo cross-currency XAU + drivers. Has its
 * own seed-meta:market:gold-extended key with independent maxStaleMin in
 * api/health.js, so a Yahoo outage here degrades only the gold panel; the
 * canonical commodity publish stays healthy. Errors are caught and logged so
 * Yahoo flakiness does NOT poison runSeed's success path.
 */
async function writeOptionalGoldExtended() {
  try {
    const extended = await fetchGoldExtended();
    // Require gold (the core metal) AND at least one driver or silver. Writing a
    // partial payload would overwrite a healthy prior key with degraded data and
    // stamp seed-meta as fresh, masking a broken Yahoo fetch in health checks.
    const hasCore = extended.gold != null;
    const hasContext = extended.silver != null || extended.drivers.length > 0;
    if (hasCore && hasContext) {
      const recordCount = (extended.gold ? 1 : 0) + (extended.silver ? 1 : 0) + extended.drivers.length;
      await writeExtraKeyWithMeta(GOLD_EXTENDED_KEY, extended, CACHE_TTL, recordCount, 'seed-meta:market:gold-extended');
      console.log(`  [Gold] extended: gold=${!!extended.gold} silver=${!!extended.silver} drivers=${extended.drivers.length}`);
    } else {
      // Preserve prior key (if any) and do NOT bump seed-meta — health will flag stale.
      console.warn(`  [Gold] extended: incomplete (gold=${!!extended.gold} silver=${!!extended.silver} drivers=${extended.drivers.length}) — skipping write, letting seed-meta go stale`);
    }
  } catch (e) {
    console.warn(`  [Gold] extended fetch error: ${e?.message || e} — skipping write, letting seed-meta go stale`);
  }
}

runSeed('market', 'commodities', CANONICAL_KEY, fetchCommodityQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alphavantage+yahoo-chart',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
  afterPublish: async (data) => {
    // afterPublish is awaited inside runSeed BEFORE process.exit, so these
    // writes actually run. SPLIT semantics:
    //
    //   - Required alias keys (commodityKey, quotesKey): errors PROPAGATE so
    //     the seed run fails (lock released, process.exit(1) via outer catch,
    //     seed-meta NOT stamped fresh). Health correctly flags STALE_SEED.
    //
    //   - Optional gold-extended: errors are caught + warned inside
    //     writeOptionalGoldExtended; gold has its own seed-meta key that goes
    //     stale independently if Yahoo XAU is down.
    if (!data) return;
    await writeRequiredCompanionKeys(data);
    await writeOptionalGoldExtended();
  },
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
