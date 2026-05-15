/**
 * Rate limiting via ioredis with a sliding window algorithm.
 * Replaces the prior Upstash ratelimit + Upstash Redis stack with direct ioredis calls.
 * Fail-open on Redis errors. Public API preserved so callers in
 * api/wm-session.js, api/_relay.js, api/rss-proxy.js don't change.
 */

import Redis from 'ioredis';
import { jsonResponse } from './_json-response.js';

const WINDOW_MS = 60_000;
const LIMIT = 600;

let redis = null;
function getRedis() {
  if (redis) return redis;
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', (err) => {
    console.warn('[api/_rate-limit] Redis error:', err.message);
  });
  return redis;
}

export function getClientIp(request) {
  // With Cloudflare proxy -> Vercel, x-real-ip is the CF edge IP (shared
  // across users). cf-connecting-ip is the actual client IP — prefer it.
  // (Matches server/_shared/rate-limit.ts)
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

export async function checkRateLimit(request, corsHeaders) {
  const ip = getClientIp(request);
  const key = `rl:${ip}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  try {
    const r = getRedis();
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const pipeline = r.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.pexpire(key, WINDOW_MS);
    const results = await pipeline.exec();
    if (!results) return null;
    const count = Number(results[2]?.[1] ?? 0);
    if (count > LIMIT) {
      const reset = now + WINDOW_MS;
      return jsonResponse({ error: 'Too many requests' }, 429, {
        'X-RateLimit-Limit': String(LIMIT),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(Math.ceil(WINDOW_MS / 1000)),
        ...corsHeaders,
      });
    }
    return null;
  } catch {
    return null;
  }
}
