import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'intelligence:gpsjam:v2';
const REDIS_KEY_V1 = 'intelligence:gpsjam:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 300_000;

let negUntil = 0;
const NEG_TTL = 60_000;

async function fetchGpsJamData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;

  let data;
  try { data = await readJsonFromUpstash(REDIS_KEY); } catch { data = null; }

  if (!data) {
    let v1;
    try { v1 = await readJsonFromUpstash(REDIS_KEY_V1); } catch { v1 = null; }
    if (v1?.hexes) {
      data = {
        ...v1,
        source: v1.source || 'gpsjam.org (normalized)',
        hexes: v1.hexes.map(hex => {
          if ('npAvg' in hex) return hex;
          const pct = hex.pct || 0;
          return {
            h3: hex.h3,
            lat: hex.lat,
            lon: hex.lon,
            level: hex.level,
            region: hex.region,
            npAvg: pct > 10 ? 0.3 : pct >= 2 ? 0.8 : 1.5,
            sampleCount: hex.bad || 0,
            aircraftCount: hex.total || 0,
          };
        }),
      };
    }
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

  const data = await fetchGpsJamData();

  if (!data) {
    return jsonResponse(
      { error: 'GPS interference data temporarily unavailable' },
      503,
      { 'Cache-Control': 'no-cache, no-store', ...corsHeaders },
    );
  }

  return jsonResponse(
    data,
    200,
    {
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=1800, stale-if-error=3600',
      ...corsHeaders,
    },
  );
}
