import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'military:flights:v1';
const STALE_KEY = 'military:flights:stale:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 120_000;

let negUntil = 0;
const NEG_TTL = 30_000;

async function readFromRedis(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.result) return null;

  try { return JSON.parse(data.result); } catch { return null; }
}

async function fetchMilitaryFlightsData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;

  let data;
  try { data = await readFromRedis(REDIS_KEY); } catch { data = null; }

  if (!data) {
    try { data = await readFromRedis(STALE_KEY); } catch { data = null; }
  }

  if (!data) {
    negUntil = now + NEG_TTL;
    return null;
  }

  cached = data;
  cachedAt = now;
  return data;
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

  const data = await fetchMilitaryFlightsData();

  if (!data) {
    return new Response(JSON.stringify({ error: 'Military flight data temporarily unavailable' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store',
        ...corsHeaders,
      },
    });
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 's-maxage=120, stale-while-revalidate=60, stale-if-error=300',
      ...corsHeaders,
    },
  });
}
