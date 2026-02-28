import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

declare const process: { env: Record<string, string | undefined> };

let ratelimit: Ratelimit | null = null;

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl',
    analytics: false,
  });
  return ratelimit;
}

function getClientIp(request: Request): string {
  // Vercel injects x-real-ip from the TCP connection — cannot be spoofed by clients.
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate limiting.
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

export async function checkRateLimit(
  request: Request,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const rl = getRatelimit();
  if (!rl) return null;

  const ip = getClientIp(request);

  try {
    const { success, limit, reset } = await rl.limit(ip);

    if (!success) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset),
          'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
          ...corsHeaders,
        },
      });
    }

    return null;
  } catch {
    return null;
  }
}
