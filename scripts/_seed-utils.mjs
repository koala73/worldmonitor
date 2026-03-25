#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB per key

const __seed_dirname = dirname(fileURLToPath(import.meta.url));

export { CHROME_UA };

// Canonical FX fallback rates — used when Yahoo Finance returns null/zero.
// Single source of truth shared by seed-bigmac, seed-grocery-basket, seed-fx-rates.
// EGP: 0.0192 is the most recently observed live rate (2026-03-21 seed run).
export const SHARED_FX_FALLBACKS = {
  USD: 1.0000, GBP: 1.2700, EUR: 1.0850, JPY: 0.0067, CHF: 1.1300,
  CNY: 0.1380, INR: 0.0120, AUD: 0.6500, CAD: 0.7400, NZD: 0.5900,
  BRL: 0.1900, MXN: 0.0490, ZAR: 0.0540, TRY: 0.0290, KRW: 0.0007,
  SGD: 0.7400, HKD: 0.1280, TWD: 0.0310, THB: 0.0280, IDR: 0.000063,
  NOK: 0.0920, SEK: 0.0930, DKK: 0.1450, PLN: 0.2450, CZK: 0.0430,
  HUF: 0.0028, RON: 0.2200, PHP: 0.0173, VND: 0.000040, MYR: 0.2250,
  PKR: 0.0036, ILS: 0.2750, ARS: 0.00084, COP: 0.000240, CLP: 0.00108,
  UAH: 0.0240, NGN: 0.00062, KES: 0.0077,
  AED: 0.2723, SAR: 0.2666, QAR: 0.2747, KWD: 3.2520,
  BHD: 2.6525, OMR: 2.5974, JOD: 1.4104, EGP: 0.0192, LBP: 0.0000112,
};

export function loadSharedConfig(filename) {
  for (const base of [join(__seed_dirname, '..', 'shared'), join(__seed_dirname, 'shared')]) {
    const p = join(base, filename);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`Cannot find shared/${filename} — checked ../shared/ and ./shared/`);
}

export function loadEnvFile(metaUrl) {
  const __dirname = metaUrl ? dirname(fileURLToPath(metaUrl)) : process.cwd();
  const candidates = [
    join(__dirname, '..', '.env.local'),
    join(__dirname, '..', '..', '.env.local'),
  ];
  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, 'Documents/GitHub/worldmonitor', '.env.local'));
  }
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    return;
  }
}

export function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

export function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }
  return { url, token };
}

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis command failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(url, token, key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  const cmd = ttlSeconds
    ? ['SET', key, payload, 'EX', ttlSeconds]
    : ['SET', key, payload];
  return redisCommand(url, token, cmd);
}

async function redisDel(url, token, key) {
  return redisCommand(url, token, ['DEL', key]);
}

// Upstash REST calls surface transient network issues through fetch/undici
// errors rather than stable app-level error codes, so we normalize the common
// timeout/reset/DNS variants here before deciding to skip a seed run.
export function isTransientRedisError(err) {
  const message = String(err?.message || '');
  const causeMessage = String(err?.cause?.message || '');
  const code = String(err?.code || err?.cause?.code || '');
  const combined = `${message} ${causeMessage} ${code}`;
  return /UND_ERR_|Connect Timeout Error|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(combined);
}

export async function acquireLock(domain, runId, ttlMs) {
  const { url, token } = getRedisCredentials();
  const lockKey = `seed-lock:${domain}`;
  const result = await redisCommand(url, token, ['SET', lockKey, runId, 'NX', 'PX', ttlMs]);
  return result?.result === 'OK';
}

export async function acquireLockSafely(domain, runId, ttlMs, opts = {}) {
  const label = opts.label || domain;
  try {
    const locked = await withRetry(() => acquireLock(domain, runId, ttlMs), opts.maxRetries ?? 2, opts.delayMs ?? 1000);
    return { locked, skipped: false, reason: null };
  } catch (err) {
    if (isTransientRedisError(err)) {
      console.warn(`  SKIPPED: Redis unavailable during lock acquisition for ${label}`);
      return { locked: false, skipped: true, reason: 'redis_unavailable' };
    }
    throw err;
  }
}

export async function releaseLock(domain, runId) {
  const { url, token } = getRedisCredentials();
  const lockKey = `seed-lock:${domain}`;
  const script = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
  try {
    await redisCommand(url, token, ['EVAL', script, 1, lockKey, runId]);
  } catch {
    // Best-effort release; lock will expire via TTL
  }
}

export async function atomicPublish(canonicalKey, data, validateFn, ttlSeconds) {
  const { url, token } = getRedisCredentials();
  const runId = String(Date.now());
  const stagingKey = `${canonicalKey}:staging:${runId}`;

  const payload = JSON.stringify(data);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large: ${(payloadBytes / 1024 / 1024).toFixed(1)}MB > 5MB limit`);
  }

  if (validateFn) {
    const valid = validateFn(data);
    if (!valid) {
      return { payloadBytes: 0, skipped: true };
    }
  }

  // Write to staging key
  await redisSet(url, token, stagingKey, data, 300); // 5 min staging TTL

  // Overwrite canonical key
  if (ttlSeconds) {
    await redisCommand(url, token, ['SET', canonicalKey, payload, 'EX', ttlSeconds]);
  } else {
    await redisCommand(url, token, ['SET', canonicalKey, payload]);
  }

  // Cleanup staging
  await redisDel(url, token, stagingKey).catch(() => {});

  return { payloadBytes, recordCount: Array.isArray(data) ? data.length : null };
}

export async function writeFreshnessMetadata(domain, resource, count, source) {
  const { url, token } = getRedisCredentials();
  const metaKey = `seed-meta:${domain}:${resource}`;
  const meta = {
    fetchedAt: Date.now(),
    recordCount: count,
    sourceVersion: source || '',
  };
  await redisSet(url, token, metaKey, meta, 86400 * 7); // 7 day TTL on metadata
  return meta;
}

export async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const wait = delayMs * 2 ** attempt;
        const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
        console.warn(`  Retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${err.message || err}${cause}`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

export function logSeedResult(domain, count, durationMs, extra = {}) {
  console.log(JSON.stringify({
    event: 'seed_complete',
    domain,
    recordCount: count,
    durationMs: Math.round(durationMs),
    timestamp: new Date().toISOString(),
    ...extra,
  }));
}

export async function verifySeedKey(key) {
  const { url, token } = getRedisCredentials();
  const data = await redisGet(url, token, key);
  return data;
}

export async function writeExtraKey(key, data, ttl) {
  const { url, token } = getRedisCredentials();
  const payload = JSON.stringify(data);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, payload, 'EX', ttl]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Extra key ${key}: write failed (HTTP ${resp.status})`);
  console.log(`  Extra key ${key}: written`);
}

export async function writeExtraKeyWithMeta(key, data, ttl, recordCount, metaKeyOverride) {
  await writeExtraKey(key, data, ttl);
  const { url, token } = getRedisCredentials();
  const metaKey = metaKeyOverride || `seed-meta:${key.replace(/:v\d+$/, '')}`;
  const meta = { fetchedAt: Date.now(), recordCount: recordCount ?? 0 };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 86400 * 7]),
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) console.warn(`  seed-meta ${metaKey}: write failed`);
}

export async function extendExistingTtl(keys, ttlSeconds = 600) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('  Cannot extend TTL: missing Redis credentials');
    return;
  }
  try {
    // EXPIRE only refreshes TTL when key already exists (returns 0 on missing keys — no-op).
    // Check each result: keys that returned 0 are missing/expired and cannot be extended.
    const pipeline = keys.map(k => ['EXPIRE', k, ttlSeconds]);
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const results = await resp.json();
      const extended = results.filter(r => r?.result === 1).length;
      const missing = results.filter(r => r?.result === 0).length;
      if (extended > 0) console.log(`  Extended TTL on ${extended} key(s) (${ttlSeconds}s)`);
      if (missing > 0) console.warn(`  WARNING: ${missing} key(s) were expired/missing — EXPIRE was a no-op; manual seed required`);
    }
  } catch (e) {
    console.error(`  TTL extension failed: ${e.message}`);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Learned Routes — persist successful scrape URLs across seed runs
// ---------------------------------------------------------------------------

// Validate a URL's hostname against a list of allowed domains (same list used
// for EXA includeDomains). Prevents stored-SSRF from Redis-persisted URLs.
export function isAllowedRouteHost(url, allowedHosts) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return allowedHosts.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Batch-read all learned routes for a scope via single Upstash pipeline request.
// Returns Map<key → routeData>. Non-fatal: throws on HTTP error (caller catches).
export async function bulkReadLearnedRoutes(scope, keys) {
  if (!keys.length) return new Map();
  const { url, token } = getRedisCredentials();
  const pipeline = keys.map(k => ['GET', `seed-routes:${scope}:${k}`]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`bulkReadLearnedRoutes HTTP ${resp.status}`);
  const results = await resp.json();
  const map = new Map();
  for (let i = 0; i < keys.length; i++) {
    const raw = results[i]?.result;
    if (!raw) continue;
    try { map.set(keys[i], JSON.parse(raw)); }
    catch { console.warn(`  [routes] malformed JSON for ${keys[i]} — skipping`); }
  }
  return map;
}

// Batch-write route updates and hard-delete evicted routes via single pipeline.
// Keys in updates always win over deletes (SET/DEL conflict resolution).
// DELs are sent before SETs to ensure correct ordering.
export async function bulkWriteLearnedRoutes(scope, updates, deletes = new Set()) {
  const { url, token } = getRedisCredentials();
  const ROUTE_TTL = 14 * 24 * 3600; // 14 days
  const effectiveDeletes = [...deletes].filter(k => !updates.has(k));
  const pipeline = [];
  for (const k of effectiveDeletes)
    pipeline.push(['DEL', `seed-routes:${scope}:${k}`]);
  for (const [k, v] of updates)
    pipeline.push(['SET', `seed-routes:${scope}:${k}`, JSON.stringify(v), 'EX', ROUTE_TTL]);
  if (!pipeline.length) return;
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`bulkWriteLearnedRoutes HTTP ${resp.status}`);
  console.log(`  [routes] written: ${updates.size} updated, ${effectiveDeletes.length} deleted`);
}

// Decision tree for a single seed item: try learned route first, fall back to EXA.
// All external I/O is injected so this function can be unit-tested without Redis or HTTP.
//
// Returns: { localPrice, sourceSite, routeUpdate, routeDelete }
//   routeUpdate — route object to persist (null = nothing to write)
//   routeDelete — true if the Redis key should be hard-deleted
export async function processItemRoute({
  learned,           // route object from Redis, or undefined/null on first run
  allowedHosts,      // string[] — normalised (no www.), same as EXA includeDomains
  currency,          // e.g. 'AED'
  itemId,            // e.g. 'sugar' — used only for log messages
  fxRate,            // number | null
  itemUsdMax = null, // per-item bulk cap in USD (ITEM_USD_MAX[itemId])
  tryDirectFetch,    // async (url, currency, itemId, fxRate) => number | null
  scrapeFirecrawl,   // async (url, currency) => { price, source } | null
  fetchViaExa,       // async () => { localPrice, sourceSite } | null  (caller owns EXA+FC logic)
  sleep: sleepFn,    // async ms => void
  firecrawlDelayMs = 0,
}) {
  let localPrice = null;
  let sourceSite = '';
  let routeUpdate = null;
  let routeDelete = false;

  if (learned) {
    if (learned.failsSinceSuccess >= 2 || !isAllowedRouteHost(learned.url, allowedHosts)) {
      routeDelete = true;
      console.log(`    [learned✗] ${itemId}: evicting (${learned.failsSinceSuccess >= 2 ? '2 failures' : 'invalid host'})`);
    } else {
      localPrice = await tryDirectFetch(learned.url, currency, itemId, fxRate);
      if (localPrice !== null) {
        sourceSite = learned.url;
        routeUpdate = { ...learned, hits: learned.hits + 1, failsSinceSuccess: 0, lastSuccessAt: Date.now() };
        console.log(`    [learned✓] ${itemId}: ${localPrice} ${currency}`);
      } else {
        await sleepFn(firecrawlDelayMs);
        const fc = await scrapeFirecrawl(learned.url, currency);
        const fcSkip = fc && fxRate && itemUsdMax && (fc.price * fxRate) > itemUsdMax;
        if (fc && !fcSkip) {
          localPrice = fc.price;
          sourceSite = fc.source;
          routeUpdate = { ...learned, hits: learned.hits + 1, failsSinceSuccess: 0, lastSuccessAt: Date.now() };
          console.log(`    [learned-FC✓] ${itemId}: ${localPrice} ${currency}`);
        } else {
          const newFails = learned.failsSinceSuccess + 1;
          if (newFails >= 2) {
            routeDelete = true;
            console.log(`    [learned✗→EXA] ${itemId}: 2 failures — evicting, retrying via EXA`);
          } else {
            routeUpdate = { ...learned, failsSinceSuccess: newFails };
            console.log(`    [learned✗→EXA] ${itemId}: failed (${newFails}/2), retrying via EXA`);
          }
        }
      }
    }
  }

  if (localPrice === null) {
    const exaResult = await fetchViaExa();
    if (exaResult?.localPrice != null) {
      localPrice = exaResult.localPrice;
      sourceSite = exaResult.sourceSite || '';
      if (sourceSite && isAllowedRouteHost(sourceSite, allowedHosts)) {
        routeUpdate = { url: sourceSite, lastSuccessAt: Date.now(), hits: 1, failsSinceSuccess: 0, currency };
        console.log(`    [EXA->learned] ${itemId}: saved ${sourceSite.slice(0, 55)}`);
      }
    }
  }

  return { localPrice, sourceSite, routeUpdate, routeDelete };
}

/**
 * Shared FX rates cache — reads from Redis `shared:fx-rates:v1` (4h TTL).
 * Falls back to fetching from Yahoo Finance if the key is missing/expired.
 * All seeds needing currency conversion should call this instead of their own fetchFxRates().
 *
 * @param {Record<string, string>} fxSymbols  - map of { CCY: 'CCYUSD=X' }
 * @param {Record<string, number>} fallbacks  - hardcoded rates to use if Yahoo fails
 */
export async function getSharedFxRates(fxSymbols, fallbacks) {
  const SHARED_KEY = 'shared:fx-rates:v1';
  const { url, token } = getRedisCredentials();

  // Try reading cached rates first (read-only — only seed-fx-rates.mjs writes this key)
  try {
    const cached = await redisGet(url, token, SHARED_KEY);
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
      console.log('  FX rates: loaded from shared cache');
      // Fill any missing currencies this seed needs using Yahoo or fallback
      const missing = Object.keys(fxSymbols).filter(c => cached[c] == null);
      if (missing.length === 0) return cached;
      console.log(`  FX rates: fetching ${missing.length} missing currencies from Yahoo`);
      const extra = await fetchYahooFxRates(
        Object.fromEntries(missing.map(c => [c, fxSymbols[c]])),
        fallbacks,
      );
      return { ...cached, ...extra };
    }
  } catch {
    // Cache read failed — fall through to live fetch
  }

  console.log('  FX rates: cache miss — fetching from Yahoo Finance');
  return fetchYahooFxRates(fxSymbols, fallbacks);
}

export async function fetchYahooFxRates(fxSymbols, fallbacks) {
  const rates = {};
  for (const [currency, symbol] of Object.entries(fxSymbols)) {
    if (currency === 'USD') { rates['USD'] = 1.0; continue; }
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) { rates[currency] = fallbacks[currency] ?? null; continue; }
      const data = await resp.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      rates[currency] = (price != null && price > 0) ? price : (fallbacks[currency] ?? null);
    } catch {
      rates[currency] = fallbacks[currency] ?? null;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('  FX rates fetched:', JSON.stringify(rates));
  return rates;
}

/**
 * Read the current canonical snapshot from Redis before a seed run overwrites it.
 * Used by seed scripts that compute WoW deltas (bigmac, grocery-basket).
 * Returns null on any error — scripts must handle first-run (no prev data).
 */
export async function readSeedSnapshot(canonicalKey) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(canonicalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? JSON.parse(result) : null;
  } catch {
    return null;
  }
}

export function parseYahooChart(data, symbol) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = Array.isArray(closes) ? closes.filter((v) => v != null) : [];

  return { symbol, name: symbol, display: symbol, price, change: +change.toFixed(2), sparkline };
}

export async function runSeed(domain, resource, canonicalKey, fetchFn, opts = {}) {
  const {
    validateFn,
    ttlSeconds,
    lockTtlMs = 120_000,
    extraKeys,
    afterPublish,
    publishTransform,
  } = opts;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startMs = Date.now();

  console.log(`=== ${domain}:${resource} Seed ===`);
  console.log(`  Run ID:  ${runId}`);
  console.log(`  Key:     ${canonicalKey}`);

  // Acquire lock
  const lockResult = await acquireLockSafely(`${domain}:${resource}`, runId, lockTtlMs, {
    label: `${domain}:${resource}`,
  });
  if (lockResult.skipped) {
    process.exit(0);
  }
  if (!lockResult.locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  // Phase 1: Fetch data (graceful on failure — extend TTL on stale data)
  let data;
  try {
    data = await withRetry(fetchFn);
  } catch (err) {
    await releaseLock(`${domain}:${resource}`, runId);
    const durationMs = Date.now() - startMs;
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error(`  FETCH FAILED: ${err.message || err}${cause}`);

    const ttl = ttlSeconds || 600;
    const keys = [canonicalKey, `seed-meta:${domain}:${resource}`];
    if (extraKeys) keys.push(...extraKeys.map(ek => ek.key));
    await extendExistingTtl(keys, ttl);

    console.log(`\n=== Failed gracefully (${Math.round(durationMs)}ms) ===`);
    process.exit(0);
  }

  // Phase 2: Publish to Redis (rethrow on failure — data was fetched but not stored)
  try {
    const publishData = publishTransform ? publishTransform(data) : data;
    const publishResult = await atomicPublish(canonicalKey, publishData, validateFn, ttlSeconds);
    if (publishResult.skipped) {
      const durationMs = Date.now() - startMs;
      const keys = [canonicalKey, `seed-meta:${domain}:${resource}`];
      if (extraKeys) keys.push(...extraKeys.map(ek => ek.key));
      await extendExistingTtl(keys, ttlSeconds || 600);
      console.log(`  SKIPPED: validation failed (empty data) — extended existing cache TTL`);
      console.log(`\n=== Done (${Math.round(durationMs)}ms, no write) ===`);
      await releaseLock(`${domain}:${resource}`, runId);
      process.exit(0);
    }
    const { payloadBytes } = publishResult;
    const topicArticleCount = Array.isArray(data?.topics)
      ? data.topics.reduce((n, t) => n + (t?.articles?.length || t?.events?.length || 0), 0)
      : undefined;
    const recordCount = opts.recordCount != null
      ? (typeof opts.recordCount === 'function' ? opts.recordCount(data) : opts.recordCount)
      : Array.isArray(data) ? data.length
      : (topicArticleCount
        ?? data?.predictions?.length
        ?? data?.events?.length ?? data?.earthquakes?.length ?? data?.outages?.length
        ?? data?.fireDetections?.length ?? data?.anomalies?.length ?? data?.threats?.length
        ?? data?.quotes?.length ?? data?.stablecoins?.length
        ?? data?.cables?.length ?? 0);

    // Write extra keys (e.g., bootstrap hydration keys)
    if (extraKeys) {
      for (const ek of extraKeys) {
        await writeExtraKey(ek.key, ek.transform ? ek.transform(data) : data, ek.ttl || ttlSeconds);
      }
    }

    if (afterPublish) {
      await afterPublish(data, { canonicalKey, ttlSeconds, recordCount, runId });
    }

    const meta = await writeFreshnessMetadata(domain, resource, recordCount, opts.sourceVersion);

    const durationMs = Date.now() - startMs;
    logSeedResult(domain, recordCount, durationMs, { payloadBytes });

    // Verify (best-effort: write already succeeded, don't fail the job on transient read issues)
    let verified = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        verified = !!(await verifySeedKey(canonicalKey));
        if (verified) break;
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (verified) {
      console.log(`  Verified: data present in Redis`);
    } else {
      console.warn(`  WARNING: verification read returned null for ${canonicalKey} (write succeeded, may be transient)`);
    }

    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
    await releaseLock(`${domain}:${resource}`, runId);
    process.exit(0);
  } catch (err) {
    await releaseLock(`${domain}:${resource}`, runId);
    throw err;
  }
}
