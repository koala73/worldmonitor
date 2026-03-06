import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'intelligence:gpsjam:v2';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 300_000; // 5 min in-memory, Redis is source of truth

async function readFromRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.result) return null;

  try { return JSON.parse(data.result); } catch { return null; }
}

async function fetchGpsJamData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;

  const redisData = await readFromRedis();
  if (redisData && redisData.hexes?.length > 0) {
    cached = redisData;
    cachedAt = now;
    return redisData;
  }

  return cached;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const data = await fetchGpsJamData();
    if (!data) {
      return new Response(JSON.stringify({ error: 'GPS interference data not yet available' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=1800, stale-if-error=3600',
        ...corsHeaders,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'GPS interference data temporarily unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
