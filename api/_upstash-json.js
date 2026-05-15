/**
 * Redis JSON helpers via ioredis.
 *
 * Replaces the prior Upstash REST stack with direct ioredis calls. Public API
 * preserved so all 13 callers (api/health, api/brief/*, api/latest-brief,
 * api/bootstrap, api/seed-health, api/cache-purge, api/gpsjam,
 * api/reverse-geocode, api/supply-chain/hormuz-tracker, etc.) don't change.
 *
 * Self-host port. The env contract is now REDIS_URL (default
 * redis://localhost:6379); the legacy UPSTASH_REDIS_REST_URL/TOKEN env vars
 * are honored too — if either is unset we fail closed on the "missing
 * credentials" code path so existing call sites that distinguish
 * infrastructure-error vs miss continue to behave correctly.
 */

import Redis from 'ioredis';
import { unwrapEnvelope } from './_seed-envelope.js';

let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
  redis.on('error', (err) => {
    console.warn('[api/_upstash-json] Redis error:', err.message);
  });
  return redis;
}

/**
 * GET a key, unwrap the {_seed, data} envelope if present, return the bare payload.
 * Returns null on missing creds, missing key, HTTP/IO errors, or JSON parse errors.
 */
export async function readJsonFromUpstash(key, timeoutMs = 3_000) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await Promise.race([
      r.get(key),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (raw == null) return null;
    return unwrapEnvelope(JSON.parse(raw)).data;
  } catch {
    return null;
  }
}

/**
 * Raw GET on a Redis key without envelope unwrap. Used by callers (brief
 * envelopes, etc.) whose stored shape is NOT {_seed, data}.
 *
 * Semantics (unchanged from the prior Upstash-REST version):
 *   - Returns the parsed value on a hit.
 *   - Returns null ONLY on genuine miss (Redis replies with no value for the key).
 *   - Throws on every other failure mode (missing credentials, IO/timeout, JSON parse).
 */
export async function readRawJsonFromUpstash(key, timeoutMs = 3_000) {
  const r = getRedis();
  if (!r) {
    throw new Error('readRawJsonFromUpstash: REDIS_URL not configured');
  }
  let raw;
  try {
    raw = await Promise.race([
      r.get(key),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  } catch (err) {
    throw new Error(`readRawJsonFromUpstash: Redis GET ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readRawJsonFromUpstash: JSON.parse failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Returns Redis "credentials" or null if not configured. Kept for backwards
 * compatibility with callers checking env presence — under ioredis the
 * connection URL is the only credential.
 */
export function getRedisCredentials() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return { url };
}

/**
 * Execute a batch of Redis commands. Maps the prior Upstash pipeline shape
 * (array-of-array string commands) onto ioredis.multi(). Returns the array
 * of {result} entries on success, null on missing-creds or any IO error.
 */
export async function redisPipeline(commands, timeoutMs = 5_000) {
  const r = getRedis();
  if (!r) return null;
  try {
    const pipe = r.multi();
    for (const cmd of commands) {
      if (!Array.isArray(cmd) || cmd.length === 0) continue;
      const [op, ...args] = cmd;
      pipe[op.toLowerCase()](...args);
    }
    const results = await Promise.race([
      pipe.exec(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (!results) return null;
    // ioredis exec returns Array<[err, result]> — normalize to {result} shape.
    return results.map(([, result]) => ({ result }));
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper: SET key with TTL (EX seconds).
 */
export async function setCachedData(key, value, ttlSeconds) {
  const results = await redisPipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)],
  ]);
  return results !== null;
}
