import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'military:flights:v1';
const STALE_KEY = 'military:flights:stale:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 120_000;

let negUntil = 0;
const NEG_TTL = 30_000;

async function fetchMilitaryFlightsData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;

  let data;
  try { data = await readJsonFromUpstash(REDIS_KEY); } catch { data = null; }

  if (!data) {
    try { data = await readJsonFromUpstash(STALE_KEY); } catch { data = null; }
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
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }

  const data = await fetchMilitaryFlightsData();

  if (!data) {
    return jsonResponse(
      { error: 'Military flight data temporarily unavailable' },
      503,
      { 'Cache-Control': 'no-cache, no-store', ...corsHeaders },
    );
  }

  return jsonResponse(
    data,
    200,
    {
      'Cache-Control': 's-maxage=120, stale-while-revalidate=60, stale-if-error=300',
      ...corsHeaders,
    },
  );
}
