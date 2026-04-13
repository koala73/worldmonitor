#!/usr/bin/env node
/**
 * Hyperliquid perp positioning flow seeder.
 *
 * Polls the public Hyperliquid /info endpoint every 5 minutes, computes a
 * 4-component composite "positioning stress" score (funding / volume / OI /
 * basis) per asset, and publishes a self-contained snapshot — current metrics
 * plus short per-asset sparkline arrays for funding, OI and score.
 *
 * Used as a leading indicator for commodities / crypto / FX in CommoditiesPanel.
 */

import { loadEnvFile, runSeed, readSeedSnapshot } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'market:hyperliquid:flow:v1';
export const CACHE_TTL_SECONDS = 2700; // 9× cron cadence (5 min); honest grace window
export const SPARK_MAX = 60;             // 5h @ 5min
export const HYPERLIQUID_URL = 'https://api.hyperliquid.xyz/info';
export const REQUEST_TIMEOUT_MS = 15_000;
export const MIN_NOTIONAL_USD_24H = 500_000;
export const STALE_SYMBOL_DROP_AFTER_POLLS = 3;

// Hardcoded symbol whitelist — never iterate the full universe.
// `class`: scoring threshold class. `display`: UI label. `group`: panel section.
export const ASSETS = [
  { symbol: 'BTC',           class: 'crypto',    display: 'BTC',           group: 'crypto' },
  { symbol: 'ETH',           class: 'crypto',    display: 'ETH',           group: 'crypto' },
  { symbol: 'SOL',           class: 'crypto',    display: 'SOL',           group: 'crypto' },
  { symbol: 'PAXG',          class: 'commodity', display: 'PAXG (gold)',   group: 'metals' },
  { symbol: 'xyz:CL',        class: 'commodity', display: 'WTI Crude',     group: 'oil' },
  { symbol: 'xyz:BRENTOIL',  class: 'commodity', display: 'Brent Crude',   group: 'oil' },
  { symbol: 'xyz:GOLD',      class: 'commodity', display: 'Gold',          group: 'metals' },
  { symbol: 'xyz:SILVER',    class: 'commodity', display: 'Silver',        group: 'metals' },
  { symbol: 'xyz:PLATINUM',  class: 'commodity', display: 'Platinum',      group: 'metals' },
  { symbol: 'xyz:PALLADIUM', class: 'commodity', display: 'Palladium',     group: 'metals' },
  { symbol: 'xyz:COPPER',    class: 'commodity', display: 'Copper',        group: 'industrial' },
  { symbol: 'xyz:NATGAS',    class: 'commodity', display: 'Natural Gas',   group: 'gas' },
  { symbol: 'xyz:EUR',       class: 'commodity', display: 'EUR',           group: 'fx' },
  { symbol: 'xyz:JPY',       class: 'commodity', display: 'JPY',           group: 'fx' },
];

// Risk weights — must sum to 1.0
export const WEIGHTS = { funding: 0.30, volume: 0.25, oi: 0.25, basis: 0.20 };

export const THRESHOLDS = {
  crypto:    { funding: 0.001,  volume: 5.0, oi: 0.20, basis: 0.05 },
  commodity: { funding: 0.0005, volume: 3.0, oi: 0.15, basis: 0.03 },
};

export const ALERT_THRESHOLD = 60;

// ── Pure scoring helpers ──────────────────────────────────────────────────────

export function clamp(x, lo = 0, hi = 100) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

export function scoreFunding(rate, threshold) {
  if (!Number.isFinite(rate) || threshold <= 0) return 0;
  return clamp((Math.abs(rate) / threshold) * 100);
}

export function scoreVolume(currentVol, avgVol, threshold) {
  if (!Number.isFinite(currentVol) || !(avgVol > 0) || threshold <= 0) return 0;
  return clamp(((currentVol / avgVol) / threshold) * 100);
}

export function scoreOi(currentOi, prevOi, threshold) {
  if (!Number.isFinite(currentOi) || !(prevOi > 0) || threshold <= 0) return 0;
  return clamp((Math.abs(currentOi - prevOi) / prevOi / threshold) * 100);
}

export function scoreBasis(mark, oracle, threshold) {
  if (!Number.isFinite(mark) || !(oracle > 0) || threshold <= 0) return 0;
  return clamp((Math.abs(mark - oracle) / oracle / threshold) * 100);
}

/**
 * Compute composite score and alerts for one asset.
 * `prevAsset` may be null/undefined for cold start; in that case OI delta and
 * volume spike are scored as 0 (we lack baselines).
 */
export function computeAsset(meta, ctx, prevAsset, opts = {}) {
  const t = THRESHOLDS[meta.class];
  const fundingRate = Number(ctx.funding);
  const currentOi = Number(ctx.openInterest);
  const markPx = Number(ctx.markPx);
  const oraclePx = Number(ctx.oraclePx);
  const dayNotional = Number(ctx.dayNtlVlm);
  const prevOi = prevAsset?.openInterest ?? null;
  const prevVolSamples = (prevAsset?.sparkVol || []).filter((v) => Number.isFinite(v));

  const fundingScore = scoreFunding(fundingRate, t.funding);

  // Volume spike scored against rolling 12-sample mean of prior dayNotional.
  let volumeScore = 0;
  if (dayNotional >= MIN_NOTIONAL_USD_24H && prevVolSamples.length >= 12) {
    const recent = prevVolSamples.slice(0, 12);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    volumeScore = scoreVolume(dayNotional, avg, t.volume);
  }

  const oiScore = prevOi != null ? scoreOi(currentOi, prevOi, t.oi) : 0;
  const basisScore = scoreBasis(markPx, oraclePx, t.basis);

  const composite = clamp(
    fundingScore * WEIGHTS.funding +
    volumeScore  * WEIGHTS.volume  +
    oiScore      * WEIGHTS.oi      +
    basisScore   * WEIGHTS.basis,
  );

  const sparkFunding = shiftAndAppend(prevAsset?.sparkFunding, Number.isFinite(fundingRate) ? fundingRate : 0);
  const sparkOi      = shiftAndAppend(prevAsset?.sparkOi,      Number.isFinite(currentOi) ? currentOi : 0);
  const sparkScore   = shiftAndAppend(prevAsset?.sparkScore,   composite);
  const sparkVol     = shiftAndAppend(prevAsset?.sparkVol,     Number.isFinite(dayNotional) ? dayNotional : 0);

  const alerts = [];
  if (composite >= ALERT_THRESHOLD) {
    alerts.push(`HIGH RISK ${composite.toFixed(0)}/100`);
  }

  return {
    symbol: meta.symbol,
    display: meta.display,
    class: meta.class,
    group: meta.group,
    funding: Number.isFinite(fundingRate) ? fundingRate : null,
    openInterest: Number.isFinite(currentOi) ? currentOi : null,
    markPx: Number.isFinite(markPx) ? markPx : null,
    oraclePx: Number.isFinite(oraclePx) ? oraclePx : null,
    dayNotional: Number.isFinite(dayNotional) ? dayNotional : null,
    fundingScore,
    volumeScore,
    oiScore,
    basisScore,
    composite,
    sparkFunding,
    sparkOi,
    sparkScore,
    sparkVol,
    stale: false,
    staleSince: null,
    missingPolls: 0,
    alerts,
    warmup: opts.warmup === true,
  };
}

function shiftAndAppend(prev, value) {
  const arr = Array.isArray(prev) ? prev.slice(-(SPARK_MAX - 1)) : [];
  arr.push(value);
  return arr;
}

// ── Hyperliquid client ────────────────────────────────────────────────────────

export async function fetchHyperliquidMetaAndCtxs(fetchImpl = fetch) {
  const resp = await fetchImpl(HYPERLIQUID_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Hyperliquid HTTP ${resp.status}`);
  const ct = resp.headers?.get?.('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new Error(`Hyperliquid wrong content-type: ${ct || '<missing>'}`);
  }
  const json = await resp.json();
  return json;
}

/**
 * Strict shape validation. Hyperliquid returns `[meta, assetCtxs]` where
 *   meta = { universe: [{ name, ... }, ...] }
 *   assetCtxs = [{ funding, openInterest, markPx, oraclePx, dayNtlVlm, ... }, ...]
 * with assetCtxs[i] aligned to universe[i].
 *
 * Throws on any mismatch — never persist a partial / malformed payload.
 */
export function validateUpstream(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('Hyperliquid payload not a [meta, assetCtxs] tuple');
  }
  const [meta, assetCtxs] = raw;
  if (!meta || !Array.isArray(meta.universe)) {
    throw new Error('Hyperliquid meta.universe missing or not array');
  }
  if (meta.universe.length < 50) {
    throw new Error(`Hyperliquid universe suspiciously small: ${meta.universe.length}`);
  }
  if (!Array.isArray(assetCtxs) || assetCtxs.length !== meta.universe.length) {
    throw new Error('Hyperliquid assetCtxs length does not match universe');
  }
  for (const m of meta.universe) {
    if (typeof m?.name !== 'string') throw new Error('Hyperliquid universe entry missing name');
  }
  return { universe: meta.universe, assetCtxs };
}

export function indexBySymbol({ universe, assetCtxs }) {
  const out = new Map();
  for (let i = 0; i < universe.length; i++) {
    out.set(universe[i].name, assetCtxs[i] || {});
  }
  return out;
}

// ── Main build path ──────────────────────────────────────────────────────────

/**
 * Build a fresh snapshot from the upstream payload + the previous Redis snapshot.
 * Pure function — caller passes both inputs.
 */
export function buildSnapshot(upstream, prevSnapshot, opts = {}) {
  const validated = validateUpstream(upstream);
  const ctxBySymbol = indexBySymbol(validated);
  const now = opts.now || Date.now();
  const prevByName = new Map();
  if (prevSnapshot?.assets && Array.isArray(prevSnapshot.assets)) {
    for (const a of prevSnapshot.assets) prevByName.set(a.symbol, a);
  }
  const prevAgeMs = prevSnapshot?.ts ? now - prevSnapshot.ts : Infinity;
  // Treat stale prior snapshot (>3× cadence = 900s) as cold start.
  const coldStart = !prevSnapshot || prevAgeMs > 900_000;

  const assets = [];
  let warmupAny = false;
  for (const meta of ASSETS) {
    const ctx = ctxBySymbol.get(meta.symbol);
    if (!ctx) {
      // Whitelisted symbol absent from upstream — carry forward prior with stale flag.
      const prev = prevByName.get(meta.symbol);
      if (!prev) continue; // never seen, skip silently (don't synthesize)
      const missing = (prev.missingPolls || 0) + 1;
      if (missing >= STALE_SYMBOL_DROP_AFTER_POLLS) {
        console.warn(`  Dropping ${meta.symbol} — missing for ${missing} consecutive polls`);
        continue;
      }
      assets.push({
        ...prev,
        stale: true,
        staleSince: prev.staleSince || now,
        missingPolls: missing,
      });
      continue;
    }
    const prev = coldStart ? null : prevByName.get(meta.symbol);
    const asset = computeAsset(meta, ctx, prev, { warmup: coldStart });
    assets.push(asset);
    if (coldStart) warmupAny = true;
  }

  return {
    ts: now,
    fetchedAt: new Date(now).toISOString(),
    warmup: warmupAny,
    assetCount: assets.length,
    assets,
  };
}

export function validateFn(snapshot) {
  return !!snapshot && Array.isArray(snapshot.assets) && snapshot.assets.length >= 12;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('seed-hyperliquid-flow.mjs');
if (isMain) {
  const prevSnapshot = await readSeedSnapshot(CANONICAL_KEY);
  await runSeed('market', 'hyperliquid-flow', CANONICAL_KEY, async () => {
    const upstream = await fetchHyperliquidMetaAndCtxs();
    return buildSnapshot(upstream, prevSnapshot);
  }, {
    ttlSeconds: CACHE_TTL_SECONDS,
    validateFn,
    sourceVersion: 'hyperliquid-info-metaAndAssetCtxs-v1',
    recordCount: (snap) => snap?.assets?.length || 0,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
