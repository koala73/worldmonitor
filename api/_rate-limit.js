import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';

let ratelimit = null;

function getRatelimit() {
  if (ratelimit) return ratelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(600, '60 s'),
    prefix: 'rl',
    analytics: false,
  });

  return ratelimit;
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
  const rl = getRatelimit();
  if (!rl) return null;

  const ip = getClientIp(request);
  try {
    const { success, limit, reset } = await rl.limit(ip);

    if (!success) {
      return jsonResponse({ error: 'Too many requests' }, 429, {
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
        ...corsHeaders,
      });
    }

    return null;
  } catch {
    return null;
  }
}
