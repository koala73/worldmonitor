#!/usr/bin/env node
// rebuild-trigger: 2026-04-23

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { buildEnvelope, unwrapEnvelope } from './_seed-envelope-source.mjs';
import { resolveRecordCount } from './_seed-contract.mjs';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB per key

const __seed_dirname = dirname(fileURLToPath(import.meta.url));

export { CHROME_UA };

/**
 * Unwrap fetch / network errors so log lines surface the actual cause
 * (DNS / TCP reset / TLS abort) instead of undici's bare "fetch failed".
 * Pulls `err.cause.code` (preferred — `ENOTFOUND`, `ECONNRESET`, etc.),
 * `err.cause.errno`, or `err.cause.message` in that order; falls back to
 * the outer error message when no cause is attached. Used by seeders
 * with multi-tier fallback chains (FATF, GDELT) where the failure mode
 * dictates the next-tier decision and operators need to distinguish
 * routing / DNS / handshake failures from per-host throttling.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeErr(err) {
  if (!err) return 'unknown';
  const cause = err.cause;
  const causeCode = cause?.code || cause?.errno || cause?.message || (typeof cause === 'string' ? cause : null);
  return causeCode ? `${err.message} (cause: ${causeCode})` : (err.message || String(err));
}

/**
 * Return the bundle-run start timestamp injected by `_bundle-runner.mjs`
 * as the `BUNDLE_RUN_STARTED_AT_MS` env var, or `null` when the seeder
 * is running STANDALONE (manual invocation outside the bundle).
 *
 * All sibling seeders in a single bundle run share ONE value (captured
 * at `runBundle` start, not at spawn time). Use this when a consumer
 * seeder reads a peer's output inside the same bundle and must detect
 * stale data from a previous bundle tick:
 *
 *   const bundleStartMs = getBundleRunStartedAtMs();
 *   if (bundleStartMs != null && fetchedAt < bundleStartMs) {
 *     // in-bundle context + peer did NOT run in THIS bundle → fallback
 *   }
 *
 * The null-on-unset contract matters. Earlier designs fell back to
 * `Date.now()` when the env was absent, which regressed standalone
 * runs: a sibling seeder invoked manually just before the consumer
 * wrote `fetchedAt = (process start - 5s)`, and the consumer's own
 * `bundleStartMs = Date.now()` rejected that perfectly-fresh peer
 * envelope as "stale". Returning null keeps the gate scoped to its
 * real purpose: protecting against across-bundle-tick staleness,
 * which has no analog outside a bundle context.
 *
 * @returns {number | null} epoch milliseconds when spawned by the
 *   bundle runner; null when running standalone.
 */
export function getBundleRunStartedAtMs() {
  const raw = Number(process.env.BUNDLE_RUN_STARTED_AT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

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
  if (!data.result) return null;
  // Envelope-aware: returns inner `data` for seeded keys written in contract
  // mode, passes through legacy (bare-shape) values unchanged. Fixes WoW/cross-
  // seed reads that were silently getting `{_seed, data}` after PR 2a enveloped
  // the writer side of 91 canonical keys.
  return unwrapEnvelope(JSON.parse(data.result)).data;
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

export async function atomicPublish(canonicalKey, data, validateFn, ttlSeconds, options = {}) {
  const { url, token } = getRedisCredentials();
  const runId = String(Date.now());
  const stagingKey = `${canonicalKey}:staging:${runId}`;

  if (validateFn) {
    const valid = validateFn(data);
    if (!valid) {
      return { payloadBytes: 0, skipped: true };
    }
  }

  // When the seeder opts into the contract (options.envelopeMeta provided), wrap
  // the payload in the seed envelope before publishing so the data key and its
  // freshness metadata share one lifecycle. Legacy seeders pass no envelopeMeta
  // and publish bare data, preserving pre-contract behavior. seed-meta:* keys
  // are always kept bare (shouldEnvelopeKey invariant).
  const payloadValue = options.envelopeMeta && shouldEnvelopeKey(canonicalKey)
    ? buildEnvelope({ ...options.envelopeMeta, data })
    : data;
  const payload = JSON.stringify(payloadValue);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large: ${(payloadBytes / 1024 / 1024).toFixed(1)}MB > 5MB limit`);
  }

  // Write to staging key
  await redisSet(url, token, stagingKey, payloadValue, 300); // 5 min staging TTL

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

export async function writeFreshnessMetadata(domain, resource, count, source, ttlSeconds, fetchedAtOverride, contentAge) {
  const { url, token } = getRedisCredentials();
  const metaKey = `seed-meta:${domain}:${resource}`;
  const meta = {
    // Default to now; callers that want to mirror an existing canonical
    // envelope (validate-fail branch in runSeed) pass the canonical's
    // original fetchedAt so health doesn't lie about freshness — see
    // readCanonicalEnvelopeMeta() and the skipped-validate path below.
    fetchedAt: typeof fetchedAtOverride === 'number' ? fetchedAtOverride : Date.now(),
    recordCount: count,
    sourceVersion: source || '',
  };
  // Content-age trio (2026-05-04 health-readiness plan). Pass when the seeder
  // opted in. Presence of maxContentAgeMin is the opt-in signal that the
  // health classifier reads. newestItemAt/oldestItemAt may be explicit null
  // when contentMeta returned null — classifier reads as STALE_CONTENT.
  if (contentAge && typeof contentAge === 'object' && Number.isInteger(contentAge.maxContentAgeMin)) {
    meta.newestItemAt = contentAge.newestItemAt ?? null;
    meta.oldestItemAt = contentAge.oldestItemAt ?? null;
    meta.maxContentAgeMin = contentAge.maxContentAgeMin;
  }
  // Use the data TTL if it exceeds 7 days so monthly/annual seeds don't lose
  // their meta key before the health check maxStaleMin threshold is reached.
  const metaTtl = Math.max(86400 * 7, ttlSeconds || 0);
  await redisSet(url, token, metaKey, meta, metaTtl);
  return meta;
}

/**
 * Read the canonical key's contract-mode envelope meta. Used by runSeed's
 * validate-fail branch to mirror canonical state into seed-meta instead
 * of overwriting it with recordCount=0 (which makes /api/health report
 * EMPTY_DATA when the canonical key still holds last-good data — see
 * PR #3581 for the production incident).
 *
 * Returns the {fetchedAt, recordCount, sourceVersion} block when canonicalKey
 * is contract-mode (envelope dual-write) AND has a valid recordCount > 0.
 * Returns null for legacy (bare-shape) keys, missing keys, parse errors,
 * or zero envelopes — caller falls back to its existing default behavior.
 *
 * Defensive: any read/parse error → null. No throws bubble up.
 */
export async function readCanonicalEnvelopeMeta(canonicalKey) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(canonicalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.result) return null;
    let parsed;
    try { parsed = JSON.parse(data.result); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const seed = parsed._seed;
    if (!seed || typeof seed !== 'object') return null;
    if (typeof seed.fetchedAt !== 'number' || typeof seed.recordCount !== 'number') return null;
    if (seed.recordCount <= 0) return null;
    // Content-age fields propagate through the validate-fail mirror so the
    // health classifier doesn't lose the STALE_CONTENT signal exactly when
    // last-good-with-stale-content data is being served (Codex round 1 P0b).
    // All three fields are optional in the envelope; carry them through as a
    // trio when present, otherwise undefined (caller checks).
    const contentAge = (typeof seed.maxContentAgeMin === 'number')
      ? {
          newestItemAt: typeof seed.newestItemAt === 'number' ? seed.newestItemAt : null,
          oldestItemAt: typeof seed.oldestItemAt === 'number' ? seed.oldestItemAt : null,
          maxContentAgeMin: seed.maxContentAgeMin,
        }
      : undefined;
    return {
      fetchedAt: seed.fetchedAt,
      recordCount: seed.recordCount,
      sourceVersion: typeof seed.sourceVersion === 'string' ? seed.sourceVersion : '',
      contentAge,
    };
  } catch {
    return null;
  }
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

/**
 * Shared envelope-aware reader for cross-seed consumers (e.g. seed-forecasts
 * reading ~40 migrated input keys, seed-chokepoint-flows reading portwatch,
 * seed-thermal-escalation reading wildfire:fires). Returns the inner `data`
 * payload for contract-mode writes; passes legacy bare-shape values through
 * unchanged. Callers MUST NOT parse the envelope themselves.
 */
export async function readCanonicalValue(key) {
  const { url, token } = getRedisCredentials();
  return redisGet(url, token, key);
}

export async function verifySeedKey(key) {
  // redisGet() now unwraps envelopes internally, so callers that read migrated
  // canonical keys (e.g. seed-climate-anomalies reading climate:zone-normals:v1,
  // seed-thermal-escalation reading wildfire:fires:v1) see bare legacy-shape
  // payloads regardless of whether the writer has migrated to contract mode.
  const { url, token } = getRedisCredentials();
  return redisGet(url, token, key);
}

/**
 * Invariant: `seed-meta:*` keys MUST be bare-shape `{fetchedAt, recordCount, ...}`.
 * Health + bundle runner + every legacy reader parses them as top-level.
 * Enveloping them turns every downstream read into `{_seed, data}` which breaks
 * the whole freshness-registry flow. Enforced at the helper boundary so future
 * callers can't regress this by passing an envelopeMeta that happens to target
 * a seed-meta key (seed-iea-oil-stocks' ANALYSIS_META_EXTRA_KEY did exactly that).
 */
export function shouldEnvelopeKey(key) {
  return typeof key === 'string' && !key.startsWith('seed-meta:');
}

export async function writeExtraKey(key, data, ttl, envelopeMeta) {
  const { url, token } = getRedisCredentials();
  const value = envelopeMeta && shouldEnvelopeKey(key) ? buildEnvelope({ ...envelopeMeta, data }) : data;
  const payload = JSON.stringify(value);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, payload, 'EX', ttl]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Extra key ${key}: write failed (HTTP ${resp.status})`);
  console.log(`  Extra key ${key}: written`);
}

export async function writeSeedMeta(dataKey, recordCount, metaKeyOverride, metaTtlSeconds) {
  const { url, token } = getRedisCredentials();
  const metaKey = metaKeyOverride || `seed-meta:${dataKey.replace(/:v\d+$/, '')}`;
  const meta = { fetchedAt: Date.now(), recordCount: recordCount ?? 0 };
  const metaTtl = metaTtlSeconds ?? 86400 * 7;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', metaTtl]),
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) console.warn(`  seed-meta ${metaKey}: write failed`);
}

export async function writeExtraKeyWithMeta(key, data, ttl, recordCount, metaKeyOverride, metaTtlSeconds) {
  await writeExtraKey(key, data, ttl);
  await writeSeedMeta(key, recordCount, metaKeyOverride, metaTtlSeconds);
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

// ─── Proxy helpers for sources that block Railway container IPs ───
const { resolveProxyString, resolveProxyStringConnect } = createRequire(import.meta.url)('./_proxy-utils.cjs');

export function resolveProxy() {
  return resolveProxyString();
}

// For HTTP CONNECT tunneling (httpsProxyFetchJson); keeps gate.decodo.com, not us.decodo.com.
export function resolveProxyForConnect() {
  return resolveProxyStringConnect();
}

// curl-based fetch; throws on non-2xx. Returns response body as string.
// NOTE: requires curl binary — available in Dockerfile.relay (apk add curl) and Railway.
// Prefer httpsProxyFetchJson (pure Node.js) when possible; use curlFetch when curl-specific
// features are needed (e.g. --compressed, -L redirect following with proxy).
export function curlFetch(url, proxyAuth, headers = {}) {
  const args = ['-sS', '--compressed', '--max-time', '15', '-L'];
  if (proxyAuth) {
    const proxyUrl = /^https?:\/\//i.test(proxyAuth) ? proxyAuth : `http://${proxyAuth}`;
    args.push('-x', proxyUrl);
  }
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-w', '\n%{http_code}');
  args.push(url);
  const raw = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  const nl = raw.lastIndexOf('\n');
  const status = parseInt(raw.slice(nl + 1).trim(), 10);
  if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status}`), { status });
  return raw.slice(0, nl);
}

// Pure Node.js HTTPS-through-proxy (CONNECT tunnel).
// proxyAuth format: "user:pass@host:port" (bare/Decodo → TLS) OR
//                  "https://user:pass@host:port" (explicit TLS) OR
//                  "http://user:pass@host:port"  (explicit plain TCP)
// Bare/undeclared-scheme proxies always use TLS (Decodo gate.decodo.com requires it).
// Explicit http:// proxies use plain TCP to avoid breaking non-TLS setups.
async function httpsProxyFetchJson(url, proxyAuth) {
  const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json' });
  return JSON.parse(buffer.toString('utf8'));
}

export async function httpsProxyFetchRaw(url, proxyAuth, { accept = '*/*', timeoutMs = 20_000, signal } = {}) {
  const { proxyFetch, parseProxyConfig } = createRequire(import.meta.url)('./_proxy-utils.cjs');
  const proxyConfig = parseProxyConfig(proxyAuth);
  if (!proxyConfig) throw new Error('Invalid proxy auth string');
  const result = await proxyFetch(url, proxyConfig, { accept, timeoutMs, signal, headers: { 'User-Agent': CHROME_UA } });
  if (!result.ok) throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status });
  return { buffer: result.buffer, contentType: result.contentType };
}

// Fetch JSON from a FRED URL, routing through proxy when available.
// Proxy-first: FRED consistently blocks/throttles Railway datacenter IPs,
// so try proxy first to avoid 20s timeout on every direct attempt.
export async function fredFetchJson(url, proxyAuth) {
  if (proxyAuth) {
    // Decodo proxy flaps on 5xx/522 — retry up to 3 times with backoff before falling back direct.
    let lastProxyErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await httpsProxyFetchJson(url, proxyAuth);
      } catch (proxyErr) {
        lastProxyErr = proxyErr;
        const transient = /HTTP 5\d{2}|522|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(proxyErr.message || '');
        if (attempt < 3 && transient) {
          await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 300));
          continue;
        }
        break;
      }
    }
    console.warn(`  [fredFetch] proxy failed after retries (${lastProxyErr?.message}) — retrying direct`);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (r.ok) return r.json();
      throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    } catch (directErr) {
      throw Object.assign(new Error(`direct: ${directErr.message}`), { cause: directErr });
    }
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (r.ok) return r.json();
  throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
}

// Fetch JSON from an IMF DataMapper URL, direct-first with proxy fallback.
// Direct timeout is short (10s) since IMF blocks Railway IPs with 403 quickly.
export async function imfFetchJson(url, proxyAuth) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (directErr) {
    if (!proxyAuth) throw directErr;
    console.warn(`  [IMF] Direct fetch failed (${directErr.message}); retrying via proxy`);
    return httpsProxyFetchJson(url, proxyAuth);
  }
}

// ---------------------------------------------------------------------------
// IMF SDMX 3.0 API (api.imf.org) — replaces blocked DataMapper API
// ---------------------------------------------------------------------------
const IMF_SDMX_BASE = 'https://api.imf.org/external/sdmx/3.0';

/**
 * Normalize an SDMX 3.0 monthly period from `YYYY-MMM` (the on-the-wire
 * shape, e.g. `2026-M03`) to ISO `YYYY-MM` so downstream date math —
 * `period.split('-')`, `parseInt(month, 10)`, key comparisons — works
 * without special-casing. The M-prefix silently corrupts these
 * computations: `parseInt("M03", 10)` returns NaN, so 12-month delta
 * lookups against `byMonth[priorMonth]` always miss.
 *
 * Other SDMX 3.0 frequencies pass through unchanged:
 *   - Annual:    `YYYY`               (e.g. `2024`) — used by WEO/FM
 *   - Quarterly: `YYYY-Q1..Q4`        (e.g. `2024-Q3`) — sortable as-is
 *   - Daily:     `YYYY-MM-DD`         (e.g. `2024-03-15`) — used by ECB
 *   - Monthly:   `YYYY-MMM` → YYYY-MM (e.g. `2026-M03` → `2026-03`)
 *
 * Future monthly/quarterly SDMX consumers MUST call this at ingest
 * (right after reading `timeValues[parseInt(obsKey, 10)]`) so callers
 * downstream can keep using simple string comparisons and ISO splits.
 *
 * @param {string|null|undefined} period
 * @returns {string|null|undefined} Normalized period (or input unchanged for falsy/non-string)
 */
export function normalizeSdmxPeriod(period) {
  if (typeof period !== 'string') return period;
  return period.replace(/-M(\d{2})$/, '-$1');
}

/**
 * IMF WEO/FM annual indicator fetcher. Hardcoded to annual frequency by URL
 * construction (`*.${indicator}.A`) — period values come back as bare year
 * strings (`"2024"`), so no SDMX-period normalization is required here.
 *
 * NOTE for future extensions: if you need IMF monthly or quarterly data
 * (e.g. IRFCL, IFS, BOP), do NOT bolt frequency onto this helper — the
 * dimension layout differs (e.g. IRFCL is 4-dim COUNTRY.INDICATOR.SECTOR.FREQUENCY,
 * not WEO's 2-dim COUNTRY.INDICATOR). Roll a custom fetch and call
 * `normalizeSdmxPeriod()` on every period before storing it as a key.
 * See `scripts/seed-gold-cb-reserves.mjs::fetchIrfclMonthlySeries` for the
 * canonical monthly pattern.
 */
export async function imfSdmxFetchIndicator(indicator, { database = 'WEO', years } = {}) {
  const agencyMap = { WEO: 'IMF.RES', FM: 'IMF.FAD' };
  const agency = agencyMap[database] || 'IMF.RES';
  const url = `${IMF_SDMX_BASE}/data/dataflow/${agency}/${database}/+/*.${indicator}.A?dimensionAtObservation=TIME_PERIOD&attributes=dsd&measures=all`;

  const json = await withRetry(async () => {
    const r = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`IMF SDMX ${indicator}: HTTP ${r.status}`);
    return r.json();
  }, 2, 2000);

  const struct = json?.data?.structures?.[0];
  const ds = json?.data?.dataSets?.[0];
  if (!struct || !ds?.series) return {};

  const countryDim = struct.dimensions.series.find(d => d.id === 'COUNTRY');
  const countryDimPos = struct.dimensions.series.findIndex(d => d.id === 'COUNTRY');
  const timeDim = struct.dimensions.observation.find(d => d.id === 'TIME_PERIOD');
  if (!countryDim || countryDimPos === -1 || !timeDim) return {};

  const countryValues = countryDim.values.map(v => v.id);
  const timeValues = timeDim.values.map(v => v.value || v.id);
  const yearSet = years ? new Set(years.map(String)) : null;

  const result = {};
  for (const [seriesKey, seriesData] of Object.entries(ds.series)) {
    const keyParts = seriesKey.split(':');
    const countryIdx = parseInt(keyParts[countryDimPos], 10);
    const iso3 = countryValues[countryIdx];
    if (!iso3) continue;

    const byYear = {};
    for (const [obsKey, obsVal] of Object.entries(seriesData.observations || {})) {
      const year = timeValues[parseInt(obsKey, 10)];
      if (!year || (yearSet && !yearSet.has(year))) continue;
      const v = obsVal?.[0];
      if (v != null) byYear[year] = parseFloat(v);
    }
    if (Object.keys(byYear).length > 0) result[iso3] = byYear;
  }
  return result;
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
    if (!result) return null;
    // Envelope-aware: WoW/prev baselines (bigmac, grocery-basket, fear-greed)
    // must see bare legacy-shape data whether the last write was pre- or post-
    // contract-migration. unwrapEnvelope is a no-op on legacy values.
    return unwrapEnvelope(JSON.parse(result)).data;
  } catch {
    return null;
  }
}

/**
 * Resolve recordCount for runSeed's freshness metadata write.
 *
 * Resolution order:
 *   1. opts.recordCount (function or number) — the seeder declared it explicitly
 *   2. Auto-detect from a known shape (Array.isArray, .predictions, .events, ...)
 *   3. payloadBytes > 0 → 1 (proven-payload fallback) + warn so the seeder author
 *      adds an explicit opts.recordCount
 *   4. 0
 *
 * The fallback exists because seeders publishing custom shapes would otherwise
 * trigger phantom EMPTY_DATA in /api/health even though the payload is fully
 * populated. See ~/.claude/skills/seed-recordcount-autodetect-phantom-empty.
 *
 * Pure function — extracted from runSeed for unit testing.
 */
export function computeRecordCount({ opts = {}, data, payloadBytes = 0, topicArticleCount, onPhantomFallback }) {
  if (opts.recordCount != null) {
    return typeof opts.recordCount === 'function' ? opts.recordCount(data) : opts.recordCount;
  }
  const detectedFromShape = Array.isArray(data)
    ? data.length
    : (topicArticleCount
      ?? data?.predictions?.length
      ?? data?.events?.length ?? data?.earthquakes?.length ?? data?.outages?.length
      ?? data?.fireDetections?.length ?? data?.anomalies?.length ?? data?.threats?.length
      ?? data?.quotes?.length ?? data?.stablecoins?.length
      ?? data?.cables?.length);
  if (detectedFromShape != null) return detectedFromShape;
  if (payloadBytes > 0) {
    if (typeof onPhantomFallback === 'function') onPhantomFallback();
    return 1;
  }
  return 0;
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
    declareRecords,        // new — contract opt-in. When present, runSeed enters
                           // envelope-dual-write path: writes `{_seed, data}` to
                           // canonicalKey alongside legacy `seed-meta:*` key.
    sourceVersion,         // new — required when declareRecords is passed
    schemaVersion,         // new — required when declareRecords is passed
    zeroIsValid = false,   // new — when true, recordCount=0 is OK_ZERO, not RETRY
    contentMeta,           // (rawData) => {newestItemAt, oldestItemAt} | null
    maxContentAgeMin,      // positive integer minutes — opts in together with contentMeta
  } = opts;
  const contractMode = typeof declareRecords === 'function';
  if (contractMode) {
    // Soft-warn (PR 2) on other mandatory contract fields; PR 3 hard-aborts.
    const missing = [];
    if (typeof sourceVersion !== 'string' || sourceVersion.trim() === '') missing.push('sourceVersion');
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) missing.push('schemaVersion');
    if (typeof opts.maxStaleMin !== 'number') missing.push('maxStaleMin');
    if (missing.length) {
      console.warn(`  [seed-contract] ${domain}:${resource} missing fields: ${missing.join(', ')} — required in PR 3`);
    }
  }
  // Content-age contract validation (2026-05-04 health-readiness plan).
  // contentMeta and maxContentAgeMin opt in TOGETHER. Hard-fail at config time
  // on misconfig — silently disabling the check would defeat the alarm.
  const contentAgeOptedIn = contentMeta != null || maxContentAgeMin != null;
  if (contentAgeOptedIn) {
    if (typeof contentMeta !== 'function') {
      console.error(`  CONTRACT VIOLATION: ${domain}:${resource} declares maxContentAgeMin without contentMeta function`);
      process.exit(1);
    }
    if (!Number.isInteger(maxContentAgeMin) || maxContentAgeMin <= 0) {
      console.error(`  CONTRACT VIOLATION: ${domain}:${resource} maxContentAgeMin must be a positive integer (minutes), got ${JSON.stringify(maxContentAgeMin)}`);
      process.exit(1);
    }
  }
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startMs = Date.now();

  console.log(`=== ${domain}:${resource} Seed ===`);
  console.log(`  Run ID:  ${runId}`);
  console.log(`  Key:     ${canonicalKey}`);
  if (contractMode) console.log(`  Mode:    contract (envelope dual-write)`);

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

  // SIGTERM handler — installed BEFORE fetch and KEPT installed through
  // publish. _bundle-runner.mjs sends SIGTERM when a section's timeout
  // fires, then SIGKILL after KILL_GRACE_MS (5s). Without a publish-phase
  // handler, a timeout that fires during atomicPublish or extendExistingTtl
  // leaves seed-lock:<domain>:<resource> dangling for the full lockTtlMs
  // (default 120s). For seeders bundled in fast-firing crons (e.g.
  // seed-bis-lbs.mjs in seed-bundle-macro.mjs) the next tick can collide
  // with that orphaned lock and SKIP repeatedly — the canonical key never
  // gets published and /api/health reports `EMPTY`.
  //
  // The handler is phase-aware so it preserves the strict-floor invariant
  // (emptyDataIsFailure seeders MUST NOT refresh seed-meta on validation
  // reject — see imf-external Railway log 2026-04-13). During fetch we
  // release lock + extend existing-data TTL so consumers keep seeing
  // last-good. During publish we release lock ONLY: data was fetched but
  // not yet stored; refreshing TTL here would silently re-anchor stale
  // data and corrupt the strict-floor retry path.
  //
  // Releases run in parallel (disjoint keys; serializing compounds Upstash
  // latency during the exact failure mode this handler exists to handle).
  // Exit 143 = POSIX convention for SIGTERM-terminated process.
  let currentPhase = 'fetch';
  const sigTermHandler = async () => {
    console.error(`  [${domain}:${resource}] SIGTERM received during ${currentPhase} phase — releasing lock runId=${runId}`);
    try {
      if (currentPhase === 'fetch') {
        const ttl = ttlSeconds || 600;
        const keys = [canonicalKey, `seed-meta:${domain}:${resource}`];
        if (extraKeys) keys.push(...extraKeys.map((ek) => ek.key));
        await Promise.allSettled([
          releaseLock(`${domain}:${resource}`, runId),
          extendExistingTtl(keys, ttl),
        ]);
      } else {
        await releaseLock(`${domain}:${resource}`, runId);
      }
    } catch (err) {
      console.error(`  [${domain}:${resource}] SIGTERM cleanup error: ${err?.message || err}`);
    } finally {
      process.exit(143);
    }
  };
  process.once('SIGTERM', sigTermHandler);

  // Phase 1: Fetch data (graceful on failure — extend TTL on stale data)
  let data;
  try {
    data = await withRetry(fetchFn);
  } catch (err) {
    // Keep the SIGTERM handler installed across the fetch-failure
    // cleanup. Earlier code did `process.off('SIGTERM', sigTermHandler)`
    // here, which opened a new leak window: SIGTERM during the
    // releaseLock + extendExistingTtl awaits below would fall through
    // to Node's default termination and could strand seed-lock or skip
    // the TTL extension. Both paths (this catch's manual ops and the
    // handler's parallel ops) are idempotent — the LUA verify-and-DEL
    // releases at most once for a given runId, and EXPIRE pipelines on
    // existing keys are safely re-runnable — so a race between the
    // catch path and the handler converges on the correct end state.
    // process.exit(0) below terminates before any pending SIGTERM can
    // fire on the success path of cleanup.
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
  // Transition to publish phase — handler stays installed but switches
  // behavior via the phase tracker.
  currentPhase = 'publish';

  // Phase 2: Publish to Redis (rethrow on failure — data was fetched but not stored)
  try {
    // Content-age contract: invoke contentMeta on RAW fetcher output BEFORE
    // publishTransform runs. This lets seeders carry pre-publish helper fields
    // (e.g. _publishedAtIsSynthetic) on items that contentMeta reads, then
    // strip them via publishTransform before they reach the canonical key
    // and downstream clients. See the 2026-05-04 health-readiness plan,
    // Sprint 1 / Sprint 2 disease-outbreaks pilot.
    //
    // contentMeta returning null OR throwing both signal "no usable item
    // timestamps" → write newestItemAt: null in the envelope, which the
    // health classifier reads as STALE_CONTENT.
    let contentNewestAt = null;
    let contentOldestAt = null;
    if (contentAgeOptedIn) {
      try {
        const result = contentMeta(data);
        if (result && typeof result === 'object'
            && Number.isFinite(result.newestItemAt) && result.newestItemAt > 0
            && Number.isFinite(result.oldestItemAt) && result.oldestItemAt > 0) {
          contentNewestAt = result.newestItemAt;
          contentOldestAt = result.oldestItemAt;
        }
      } catch (err) {
        console.warn(`  [content-age] ${domain}:${resource}: contentMeta threw, treating as null: ${err?.message || err}`);
      }
    }

    const publishData = publishTransform ? publishTransform(data) : data;

    // In contract mode, resolve recordCount from declareRecords BEFORE publish so
    // the envelope carries the correct state. RETRY-on-empty paths skip the
    // publish entirely (leaving the previous envelope in place).
    let contractState = null;   // 'OK' | 'OK_ZERO' | 'RETRY'
    let contractRecordCount = null;
    let envelopeMeta = null;
    if (contractMode) {
      try {
        contractRecordCount = resolveRecordCount(declareRecords, publishData);
      } catch (err) {
        // Contract violation — declareRecords returned non-int / threw. HARD FAIL.
        await releaseLock(`${domain}:${resource}`, runId);
        console.error(`  CONTRACT VIOLATION: ${err.message || err}`);
        process.exit(1);
      }
      if (contractRecordCount > 0) {
        contractState = 'OK';
      } else if (zeroIsValid) {
        contractState = 'OK_ZERO';
      } else {
        contractState = 'RETRY';
      }
      if (contractState !== 'RETRY') {
        envelopeMeta = {
          fetchedAt: Date.now(),
          recordCount: contractRecordCount,
          sourceVersion: sourceVersion || '',
          schemaVersion: schemaVersion || 1,
          state: contractState,
        };
        // Carry content-age fields when seeder opted in. Presence of
        // maxContentAgeMin in the envelope is the opt-in signal for the
        // health classifier. newestItemAt/oldestItemAt may be explicit null
        // when contentMeta returned null OR all items lacked usable
        // timestamps — classifier reads those as STALE_CONTENT.
        if (contentAgeOptedIn) {
          envelopeMeta.newestItemAt = contentNewestAt;
          envelopeMeta.oldestItemAt = contentOldestAt;
          envelopeMeta.maxContentAgeMin = maxContentAgeMin;
        }
      }
    }

    // Contract RETRY on empty (no zeroIsValid) — skip publish, extend TTL, exit 0.
    if (contractState === 'RETRY') {
      const durationMs = Date.now() - startMs;
      const keys = [canonicalKey, `seed-meta:${domain}:${resource}`];
      if (extraKeys) keys.push(...extraKeys.map(ek => ek.key));
      await extendExistingTtl(keys, ttlSeconds || 600);
      console.log(`  RETRY: declareRecords returned 0 (zeroIsValid=false) — envelope unchanged, TTL extended, bundle will retry next cycle`);
      console.log(`\n=== Done (${Math.round(durationMs)}ms, RETRY) ===`);
      await releaseLock(`${domain}:${resource}`, runId);
      process.exit(0);
    }

    const publishResult = await atomicPublish(canonicalKey, publishData, validateFn, ttlSeconds, { envelopeMeta });
    if (publishResult.skipped) {
      const durationMs = Date.now() - startMs;
      const keys = [canonicalKey, `seed-meta:${domain}:${resource}`];
      if (extraKeys) keys.push(...extraKeys.map(ek => ek.key));
      await extendExistingTtl(keys, ttlSeconds || 600);
      const strictFailure = Boolean(opts.emptyDataIsFailure);
      if (strictFailure) {
        // Strict-floor seeders (e.g. IMF-External, floor=180 countries) treat
        // empty data as a real upstream failure. Do NOT refresh seed-meta —
        // letting fetchedAt stay stale lets bundles retry on their next cron
        // fire and lets health flip to STALE_SEED. Writing fresh meta here
        // caused imf-external to skip for the full 30-day interval after a
        // single transient failure (Railway log 2026-04-13).
        console.error(`  FAILURE: validation failed (empty data) — seed-meta NOT refreshed; bundle will retry next cycle`);
      } else {
        // Write seed-meta even when data is empty so health can distinguish
        // "seeder ran but nothing to publish" from "seeder stopped" (quiet-
        // period feeds: news, events, sparse indicators).
        //
        // BUT — when the canonical key still holds last-good contract-mode
        // data with recordCount > 0, mirror its (fetchedAt, recordCount)
        // into seed-meta instead of writing zero. This keeps /api/health
        // reporting an accurate count when validateFn rejects a transient
        // upstream blip (e.g. WB late-reporter variation that drops a
        // resilience indicator from 153 → 149 countries when the floor was
        // 150 — production incident 2026-05-03 for resilience:power-losses
        // where canonical had 216 countries but seed-meta got overwritten
        // with 0 → EMPTY_DATA). The mirrored fetchedAt is canonical's
        // ORIGINAL fetch time, NOT now, so STALE_SEED still fires naturally
        // once the canonical data ages past maxStaleMin — preserving the
        // strict-floor honesty WITHOUT punishing a transient blip with a
        // misleading zero.
        //
        // Falls back to writing 0 (legacy quiet-period behavior) when:
        //   - canonical key is missing
        //   - canonical envelope is malformed / legacy bare shape
        //   - canonical envelope has recordCount <= 0
        const canonicalMeta = await readCanonicalEnvelopeMeta(canonicalKey);
        if (canonicalMeta) {
          // Pass-through canonical's contentAge so health doesn't lose the
          // STALE_CONTENT signal exactly when last-good-with-stale-content
          // data is being served (Codex round 1 P0b).
          await writeFreshnessMetadata(
            domain, resource, canonicalMeta.recordCount,
            canonicalMeta.sourceVersion || opts.sourceVersion,
            ttlSeconds,
            canonicalMeta.fetchedAt,
            canonicalMeta.contentAge,
          );
          console.log(
            `  SKIPPED: validation failed (empty/partial fetch) — seed-meta mirrors canonical ` +
            `(fetchedAt=${new Date(canonicalMeta.fetchedAt).toISOString()}, recordCount=${canonicalMeta.recordCount}` +
            `${canonicalMeta.contentAge ? `, newestItemAt=${canonicalMeta.contentAge.newestItemAt == null ? 'null' : new Date(canonicalMeta.contentAge.newestItemAt).toISOString()}` : ''}); ` +
            `existing cache TTL extended`,
          );
        } else {
          await writeFreshnessMetadata(domain, resource, 0, opts.sourceVersion, ttlSeconds);
          console.log(`  SKIPPED: validation failed (empty data) — seed-meta refreshed (recordCount=0), existing cache TTL extended`);
        }
      }
      console.log(`\n=== Done (${Math.round(durationMs)}ms, no write) ===`);
      await releaseLock(`${domain}:${resource}`, runId);
      // Strict path exits non-zero so _bundle-runner counts it as failed++
      // (otherwise the bundle summary hides upstream outages behind ran++).
      process.exit(strictFailure ? 1 : 0);
    }
    const { payloadBytes } = publishResult;
    const topicArticleCount = Array.isArray(data?.topics)
      ? data.topics.reduce((n, t) => n + (t?.articles?.length || t?.events?.length || 0), 0)
      : undefined;
    const recordCount = contractMode
      ? contractRecordCount
      : computeRecordCount({
          opts, data, payloadBytes, topicArticleCount,
          onPhantomFallback: () => console.warn(
            `  [recordCount] auto-detect did not match a known shape (payloadBytes=${payloadBytes}); falling back to 1. Add opts.recordCount to ${domain}:${resource} for accurate health metrics.`
          ),
        });

    // Write extra keys (e.g., bootstrap hydration keys). In contract mode each
    // extra key gets its own envelope; declareRecords may be per-key or reuse
    // the canonical one.
    if (extraKeys) {
      for (const ek of extraKeys) {
        const ekData = ek.transform ? ek.transform(data) : data;
        let ekEnvelope = null;
        if (contractMode) {
          const ekDeclare = typeof ek.declareRecords === 'function' ? ek.declareRecords : declareRecords;
          let ekCount;
          try {
            ekCount = resolveRecordCount(ekDeclare, ekData);
          } catch (err) {
            await releaseLock(`${domain}:${resource}`, runId);
            console.error(`  CONTRACT VIOLATION on extraKey ${ek.key}: ${err.message || err}`);
            process.exit(1);
          }
          ekEnvelope = {
            fetchedAt: envelopeMeta.fetchedAt,
            recordCount: ekCount,
            sourceVersion: sourceVersion || '',
            schemaVersion: schemaVersion || 1,
            state: ekCount > 0 ? 'OK' : (zeroIsValid ? 'OK_ZERO' : 'OK'),
          };
        }
        await writeExtraKey(ek.key, ekData, ek.ttl || ttlSeconds, ekEnvelope);
      }
    }

    if (afterPublish) {
      await afterPublish(data, { canonicalKey, ttlSeconds, recordCount, runId });
    }

    // Mirror content-age fields into seed-meta when the seeder opted in.
    //
    // Read content-age from the LOCAL `contentNewestAt`/`contentOldestAt`
    // computed back at line ~1088 — NOT from `envelopeMeta`. The local
    // values are populated whenever the seeder opted in (`contentAgeOptedIn`
    // === true); `envelopeMeta` is null for non-contract-mode seeders, so
    // gating on `envelopeMeta` silently dropped the content-age signal for
    // every seeder that hadn't migrated to contract mode yet — defeating
    // the opt-in for the majority of the cohort.
    //
    // Both branches publish the same trio (envelopeMeta carries the same
    // values when contract mode populates it at line ~1141); reading from
    // the local source unifies the two paths and makes the seed-meta
    // mirror match the contract-mode envelope exactly.
    const successContentAge = contentAgeOptedIn ? {
      newestItemAt: contentNewestAt,
      oldestItemAt: contentOldestAt,
      maxContentAgeMin,
    } : undefined;
    const meta = await writeFreshnessMetadata(
      domain, resource, recordCount, opts.sourceVersion, ttlSeconds,
      undefined,            // fetchedAtOverride — success path uses now
      successContentAge,
    );

    const durationMs = Date.now() - startMs;
    logSeedResult(domain, recordCount, durationMs, { payloadBytes, contractMode, state: contractState || 'LEGACY' });

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
