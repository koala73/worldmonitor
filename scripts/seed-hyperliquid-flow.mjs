#!/usr/bin/env node
// @ts-check
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

import { loadEnvFile, runSeed, readSeedSnapshot, writeExtraKeyWithMeta } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'market:hyperliquid:flow:v1';
export const BASELINE_KEY = 'market:hyperliquid:flow:baseline:v1';
export const CACHE_TTL_SECONDS = 2700; // 9× cron cadence (5 min); honest grace window
export const BASELINE_TTL_SECONDS = 604800; // 7d — baseline state survives live-key expiry/redeploy gaps
export const SPARK_MAX = 60;             // 5h @ 5min
export const HYPERLIQUID_URL = 'https://api.hyperliquid.xyz/info';
export const REQUEST_TIMEOUT_MS = 15_000;
export const MIN_NOTIONAL_USD_24H = 500_000;
export const STALE_SYMBOL_DROP_AFTER_POLLS = 3;
export const VOLUME_BASELINE_MIN_SAMPLES = 12; // 1h @ 5min cadence — minimum history to score volume spike
export const MAX_UPSTREAM_UNIVERSE = 2000;     // defensive cap; Hyperliquid has ~200 perps today

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

function parsePositiveOpenInterest(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : Number.NaN;
  }
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function trailingValidOiSamples(values) {
  if (!Array.isArray(values)) return [];
  let start = values.length;
  while (start > 0) {
    const sample = values[start - 1];
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0) break;
    start -= 1;
  }
  return /** @type {number[]} */ (values.slice(start));
}

/**
 * Compute composite score and alerts for one asset.
 *
 * `prevAsset` may be null/undefined for cold start; in that case OI delta and
 * volume spike are scored as 0 (we lack baselines).
 *
 * Per-asset `warmup` is TRUE until the volume baseline has VOLUME_BASELINE_MIN_SAMPLES
 * and OI has 13 consecutive samples for a real one-hour window — NOT just on the
 * first poll after cold start. Without this, the "warming up" badge flips to false
 * while the score is still missing comparable baseline history.
 *
 * @param {{ symbol: string; display: string; class: 'crypto'|'commodity'; group: string }} meta
 * @param {Record<string, unknown>} ctx
 * @param {any} prevAsset
 * @param {{ coldStart?: boolean; suppressOiDelta?: boolean }} [opts]
 */
export function computeAsset(meta, ctx, prevAsset, opts = {}) {
  const t = THRESHOLDS[meta.class];
  const fundingRate = Number(ctx.funding);
  // `Number(null)` and `Number('')` both produce zero. Treat those upstream
  // shapes, nonnumeric values, and non-positive OI as a continuity break.
  const currentOi = parsePositiveOpenInterest(ctx.openInterest);
  const currentOiValid = Number.isFinite(currentOi);
  const markPx = Number(ctx.markPx);
  const oraclePx = Number(ctx.oraclePx);
  const dayNotional = Number(ctx.dayNtlVlm);
  const prevOi = prevAsset?.openInterest ?? null;
  const prevOiSamples = opts.suppressOiDelta
    ? []
    : trailingValidOiSamples(prevAsset?.sparkOi);
  const prevVolSamples = /** @type {number[]} */ ((prevAsset?.sparkVol || []).filter(
    /** @param {unknown} v */ (v) => Number.isFinite(v)
  ));

  const fundingScore = scoreFunding(fundingRate, t.funding);

  // Volume spike scored against the MOST RECENT 12 samples in sparkVol.
  // sparkVol is newest-at-tail (see shiftAndAppend), so we must slice(-N) — NOT
  // slice(0, N), which would anchor the baseline to the oldest window and never
  // update after the first hour.
  let volumeScore = 0;
  const volumeBaselineReady = prevVolSamples.length >= VOLUME_BASELINE_MIN_SAMPLES;
  if (dayNotional >= MIN_NOTIONAL_USD_24H && volumeBaselineReady) {
    const recent = prevVolSamples.slice(-VOLUME_BASELINE_MIN_SAMPLES);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    volumeScore = scoreVolume(dayNotional, avg, t.volume);
  }

  // A valid OI component needs 12 consecutive prior samples: after appending
  // the current poll that forms the 13-point, one-hour window consumers render.
  // A long gap resets only OI-derived history; volume remains a rolling 24h
  // baseline and is intentionally retained.
  const oiBaselineReady = opts.suppressOiDelta !== true
    && currentOiValid
    && prevOiSamples.length >= 12
    && Number.isFinite(prevOi)
    && prevOi > 0;
  const oiScore = oiBaselineReady ? scoreOi(currentOi, prevOi, t.oi) : 0;
  const basisScore = scoreBasis(markPx, oraclePx, t.basis);

  const composite = clamp(
    fundingScore * WEIGHTS.funding +
    volumeScore  * WEIGHTS.volume  +
    oiScore      * WEIGHTS.oi      +
    basisScore   * WEIGHTS.basis,
  );

  const sparkFunding = shiftAndAppend(prevAsset?.sparkFunding, Number.isFinite(fundingRate) ? fundingRate : 0);
  // Never append a synthetic zero for invalid OI. Reset the series so the next
  // valid poll must build a new consecutive one-hour baseline.
  const sparkOi      = currentOiValid
    ? shiftAndAppend(opts.suppressOiDelta ? [] : prevOiSamples, currentOi)
    : [];
  // Score history is also discontinuous across an outage because its OI
  // component is rebuilding. Restart it so downstream charts do not join two
  // non-comparable regimes into one continuous sparkline.
  const sparkScore   = shiftAndAppend(opts.suppressOiDelta || !currentOiValid ? [] : prevAsset?.sparkScore, composite);
  const sparkVol     = shiftAndAppend(prevAsset?.sparkVol,     Number.isFinite(dayNotional) ? dayNotional : 0);

  // Warmup stays TRUE until both baselines are usable — cold-start OR insufficient
  // volume history OR a complete one-hour OI window. Clears only when the asset
  // can produce all four component scores on a comparable cadence.
  const warmup = opts.coldStart === true || !volumeBaselineReady || !oiBaselineReady;

  const alerts = [];
  // The partial composite remains inspectable during warmup, but must not emit
  // a fully-comparable risk alert while one of its four components is absent.
  if (!warmup && composite >= ALERT_THRESHOLD) {
    alerts.push(`HIGH RISK ${composite.toFixed(0)}/100`);
  }

  return {
    symbol: meta.symbol,
    display: meta.display,
    class: meta.class,
    group: meta.group,
    funding: Number.isFinite(fundingRate) ? fundingRate : null,
    openInterest: currentOiValid ? currentOi : null,
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
    warmup,
  };
}

function shiftAndAppend(prev, value) {
  const arr = Array.isArray(prev) ? prev.slice(-(SPARK_MAX - 1)) : [];
  arr.push(value);
  return arr;
}

// ── Hyperliquid client ────────────────────────────────────────────────────────

// Minimum universe size expected per dex. Default perps have ~200; xyz builder
// dex has ~60. Each threshold is half the observed size so we still reject
// genuinely broken payloads without false-positives on a thinner dex.
const MIN_UNIVERSE_DEFAULT = 50;
const MIN_UNIVERSE_XYZ = 30;

/**
 * POST /info {type:'metaAndAssetCtxs', [dex]}. Returns raw [meta, assetCtxs].
 * @param {string|undefined} dex
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchHyperliquidMetaAndCtxs(dex = undefined, fetchImpl = fetch) {
  const body = dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' };
  const resp = await fetchImpl(HYPERLIQUID_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Hyperliquid HTTP ${resp.status}${dex ? ` (dex=${dex})` : ''}`);
  const ct = resp.headers?.get?.('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new Error(`Hyperliquid wrong content-type: ${ct || '<missing>'}${dex ? ` (dex=${dex})` : ''}`);
  }
  return resp.json();
}

/**
 * Fetch both the default perp dex (BTC/ETH/SOL/PAXG...) and the xyz builder
 * dex (commodities + FX perps) in parallel, validate each payload, and merge
 * into a single `{universe, assetCtxs}`.
 *
 * xyz: asset names already carry the `xyz:` prefix in their universe entries,
 * so no rewriting is needed — just concatenate.
 */
export async function fetchAllMetaAndCtxs(fetchImpl = fetch) {
  const [defaultRaw, xyzRaw] = await Promise.all([
    fetchHyperliquidMetaAndCtxs(undefined, fetchImpl),
    fetchHyperliquidMetaAndCtxs('xyz', fetchImpl),
  ]);
  const def = validateDexPayload(defaultRaw, 'default', MIN_UNIVERSE_DEFAULT);
  const xyz = validateDexPayload(xyzRaw, 'xyz', MIN_UNIVERSE_XYZ);
  return {
    universe: [...def.universe, ...xyz.universe],
    assetCtxs: [...def.assetCtxs, ...xyz.assetCtxs],
  };
}

/**
 * Strict shape validation for ONE dex payload. Returns `[meta, assetCtxs]` where
 *   meta = { universe: [{ name, ... }, ...] }
 *   assetCtxs = [{ funding, openInterest, markPx, oraclePx, dayNtlVlm, ... }, ...]
 * with assetCtxs[i] aligned to universe[i].
 *
 * Throws on any mismatch — never persist a partial / malformed payload.
 *
 * @param {unknown} raw
 * @param {string} dexLabel
 * @param {number} minUniverse
 */
export function validateDexPayload(raw, dexLabel, minUniverse) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(`Hyperliquid ${dexLabel} payload not a [meta, assetCtxs] tuple`);
  }
  const [meta, assetCtxs] = raw;
  if (!meta || !Array.isArray(meta.universe)) {
    throw new Error(`Hyperliquid ${dexLabel} meta.universe missing or not array`);
  }
  if (meta.universe.length < minUniverse) {
    throw new Error(`Hyperliquid ${dexLabel} universe suspiciously small: ${meta.universe.length} < ${minUniverse}`);
  }
  if (meta.universe.length > MAX_UPSTREAM_UNIVERSE) {
    throw new Error(`Hyperliquid ${dexLabel} universe over cap: ${meta.universe.length} > ${MAX_UPSTREAM_UNIVERSE}`);
  }
  if (!Array.isArray(assetCtxs) || assetCtxs.length !== meta.universe.length) {
    throw new Error(`Hyperliquid ${dexLabel} assetCtxs length does not match universe`);
  }
  for (const m of meta.universe) {
    if (typeof m?.name !== 'string') throw new Error(`Hyperliquid ${dexLabel} universe entry missing name`);
  }
  return { universe: meta.universe, assetCtxs };
}

/**
 * Back-compat wrapper used by buildSnapshot. Accepts either a single-dex raw
 * `[meta, assetCtxs]` tuple (tests) or the merged `{universe, assetCtxs}` shape
 * produced by fetchAllMetaAndCtxs. Returns the merged shape.
 */
export function validateUpstream(raw) {
  // Merged shape from fetchAllMetaAndCtxs: already validated per-dex.
  if (raw && !Array.isArray(raw) && Array.isArray(raw.universe) && Array.isArray(raw.assetCtxs)) {
    return { universe: raw.universe, assetCtxs: raw.assetCtxs };
  }
  // Single-dex tuple (legacy / tests): validate as default dex.
  return validateDexPayload(raw, 'default', MIN_UNIVERSE_DEFAULT);
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
  const coldStart = !prevSnapshot;
  // A long gap invalidates a 5m OI delta, not the accumulated volume baseline.
  // The dedicated 7d baseline key lets us retain that history across expiry.
  const longPollGap = !coldStart && prevAgeMs > 900_000;

  // Info-log unseen xyz: perps once per run so ops sees when Hyperliquid adds
  // commodity/FX markets we could add to the whitelist.
  const whitelisted = new Set(ASSETS.map((a) => a.symbol));
  const unknownXyz = validated.universe
    .map((/** @type {{ name: string }} */ u) => u.name)
    .filter((name) => typeof name === 'string' && name.startsWith('xyz:') && !whitelisted.has(name));
  if (unknownXyz.length > 0) {
    console.log(`  Unknown xyz: perps upstream (not whitelisted): ${unknownXyz.slice(0, 20).join(', ')}${unknownXyz.length > 20 ? ` (+${unknownXyz.length - 20} more)` : ''}`);
  }

  const assets = [];
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
        // Any per-asset miss breaks the five-minute OI sampling cadence, even
        // when the rest of the snapshot arrived on time. Keep the independent
        // rolling volume baseline, but restart OI-derived history so recovery
        // cannot join samples across an unknown gap or emit a stale alert.
        sparkOi: [],
        sparkScore: [],
        oiScore: 0,
        alerts: [],
        warmup: true,
        stale: true,
        staleSince: prev.staleSince || now,
        missingPolls: missing,
      });
      continue;
    }
    const prev = coldStart ? null : prevByName.get(meta.symbol);
    const assetGap = prev?.stale === true || (prev?.missingPolls || 0) > 0;
    const asset = computeAsset(meta, ctx, prev, {
      coldStart,
      suppressOiDelta: longPollGap || assetGap,
    });
    assets.push(asset);
  }

  // Snapshot warmup = any asset still building a baseline. Reflects real
  // component-score readiness, not just the first poll after cold start.
  const warmup = assets.some((a) => a.warmup === true);

  return {
    ts: now,
    fetchedAt: new Date(now).toISOString(),
    warmup,
    assetCount: assets.length,
    assets,
  };
}

export function validateFn(snapshot) {
  return !!snapshot && Array.isArray(snapshot.assets) && snapshot.assets.length >= 12;
}

export function declareRecords(data) {
  return Array.isArray(data?.assets) ? data.assets.length : 0;
}

/**
 * Run one protected Hyperliquid seed cycle.
 *
 * Reading accumulated state is part of runSeed's locked fetch phase so two
 * overlapping invocations cannot both derive and publish from the same stale
 * baseline. Strict reads distinguish a genuinely absent key from an ambiguous
 * Redis failure; accumulated history is too valuable to cold-start on an
 * unreadable response.
 *
 * @param {{
 *   runSeedImpl?: typeof runSeed;
 *   readSeedSnapshotImpl?: typeof readSeedSnapshot;
 *   writeExtraKeyWithMetaImpl?: typeof writeExtraKeyWithMeta;
 *   fetchAllMetaAndCtxsImpl?: typeof fetchAllMetaAndCtxs;
 * }} [deps]
 */
export async function runHyperliquidFlowSeed(deps = {}) {
  const {
    readSeedSnapshotImpl = readSeedSnapshot,
    writeExtraKeyWithMetaImpl = writeExtraKeyWithMeta,
    fetchAllMetaAndCtxsImpl = fetchAllMetaAndCtxs,
  } = deps;

  const fetchSnapshot = async () => {
    const canonicalSnapshot = await readSeedSnapshotImpl(CANONICAL_KEY, { strict: true });
    const prevSnapshot = canonicalSnapshot
      ?? await readSeedSnapshotImpl(BASELINE_KEY, { strict: true });

    // Commodity + FX perps live on the xyz builder dex, NOT the default dex.
    // Must fetch both and merge before scoring (see fetchAllMetaAndCtxs).
    const upstream = await fetchAllMetaAndCtxsImpl();
    return buildSnapshot(upstream, prevSnapshot);
  };
  const seedOptions = {
    ttlSeconds: CACHE_TTL_SECONDS,
    validateFn,
    sourceVersion: 'hyperliquid-info-metaAndAssetCtxs-v1',
    recordCount: (snap) => snap?.assets?.length || 0,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 30,
    // runSeed invokes afterPublish only after validation and canonical publish.
    // Invalid or partial snapshots can therefore never replace the durable
    // seven-day baseline.
    afterPublish: async (snapshot) => {
      const wroteMeta = await writeExtraKeyWithMetaImpl(
        BASELINE_KEY,
        snapshot,
        BASELINE_TTL_SECONDS,
        snapshot.assets.length,
        'seed-meta:market:hyperliquid-flow-baseline',
      );
      if (wroteMeta !== true) {
        throw new Error('Hyperliquid baseline seed-meta write failed');
      }
    },
  };

  if (deps.runSeedImpl) {
    return deps.runSeedImpl('market', 'hyperliquid-flow', CANONICAL_KEY, fetchSnapshot, seedOptions);
  }
  return runSeed('market', 'hyperliquid-flow', CANONICAL_KEY, fetchSnapshot, seedOptions);
}

// ── Entry point ──────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('seed-hyperliquid-flow.mjs');
if (isMain) {
  // The live key has an intentionally short TTL so consumers cannot mistake an
  // abandoned feed for current data. Baseline state has a separate, longer TTL:
  // losing the live key during a deploy/outage must not erase accumulated
  // samples and force every asset back through warmup.
  await runHyperliquidFlowSeed().catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
