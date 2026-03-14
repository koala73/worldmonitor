#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB per key

const __seed_dirname = dirname(fileURLToPath(import.meta.url));

export { CHROME_UA };

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

export async function acquireLock(domain, runId, ttlMs) {
  const { url, token } = getRedisCredentials();
  const lockKey = `seed-lock:${domain}`;
  const result = await redisCommand(url, token, ['SET', lockKey, runId, 'NX', 'PX', ttlMs]);
  return result?.result === 'OK';
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
        const wait = delayMs * Math.pow(2, attempt);
        console.warn(`  Retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${err.message || err}`);
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
  if (!resp.ok) console.warn(`  Extra key ${key}: write failed (HTTP ${resp.status})`);
  else console.log(`  Extra key ${key}: written`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const { validateFn, ttlSeconds, lockTtlMs = 120_000, extraKeys } = opts;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startMs = Date.now();

  console.log(`=== ${domain}:${resource} Seed ===`);
  console.log(`  Run ID:  ${runId}`);
  console.log(`  Key:     ${canonicalKey}`);

  // Acquire lock
  const locked = await acquireLock(`${domain}:${resource}`, runId, lockTtlMs);
  if (!locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  try {
    const data = await withRetry(fetchFn);
    const publishResult = await atomicPublish(canonicalKey, data, validateFn, ttlSeconds);
    if (publishResult.skipped) {
      const durationMs = Date.now() - startMs;
      console.log(`  SKIPPED: validation failed (empty data) — preserving existing cache`);
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

    const meta = await writeFreshnessMetadata(domain, resource, recordCount, opts.sourceVersion);

    const durationMs = Date.now() - startMs;
    logSeedResult(domain, recordCount, durationMs, { payloadBytes });

    // Verify
    const verified = await verifySeedKey(canonicalKey);
    if (verified) {
      console.log(`  Verified: data present in Redis`);
    } else {
      console.warn('  WARNING: verification read returned null');
    }

    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
    await releaseLock(`${domain}:${resource}`, runId);
    process.exit(0);
  } catch (err) {
    await releaseLock(`${domain}:${resource}`, runId);
    throw err;
  }
}
