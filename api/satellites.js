import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'intelligence:satellites:tle:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 600_000;

let negUntil = 0;
const NEG_TTL = 60_000;

async function fetchSatelliteData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;
  let data;
  try { data = await readJsonFromUpstash(REDIS_KEY); } catch { data = null; }
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
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  const data = await fetchSatelliteData();
  if (!data) {
    return jsonResponse({ error: 'Satellite data temporarily unavailable' }, 503, {
      'Cache-Control': 'no-cache, no-store', ...corsHeaders,
    });
  }
  return jsonResponse(data, 200, {
    'Cache-Control': 's-maxage=3600, stale-while-revalidate=1800, stale-if-error=3600',
    ...corsHeaders,
  });
}
