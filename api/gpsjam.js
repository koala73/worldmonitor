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

// Normalize any stored hex to the web-UI shape the map reads (pct + affected/total
// aircraft), regardless of which schema produced it: new gpsjam.org v2 (pct),
// legacy Wingbits v2 (npAvg, still lingering under its 48h TTL right after the
// 2026-07 source switch), or the v1 dual-write (pct/good/bad/total).
export function toWebHex(hex) {
  const base = { h3: hex.h3, lat: hex.lat, lon: hex.lon, level: hex.level, region: hex.region };
  if (Number.isFinite(hex.pct)) {
    return {
      ...base,
      pct: hex.pct,
      affectedAircraft: hex.affectedAircraft ?? hex.bad ?? hex.sampleCount ?? 0,
      totalAircraft: hex.totalAircraft ?? hex.total ?? hex.aircraftCount ?? 0,
    };
  }
  // Legacy Wingbits v2 (npAvg, no pct): derive a coarse pct from the level buckets.
  const npAvg = Number.isFinite(hex.npAvg) ? hex.npAvg : 2;
  return {
    ...base,
    pct: npAvg <= 0.5 ? 15 : npAvg <= 1.0 ? 5 : 0,
    affectedAircraft: hex.sampleCount ?? 0,
    totalAircraft: hex.aircraftCount ?? 0,
  };
}

async function fetchGpsJamData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;

  let raw;
  try { raw = await readJsonFromUpstash(REDIS_KEY); } catch { raw = null; }
  if (!raw) {
    try { raw = await readJsonFromUpstash(REDIS_KEY_V1); } catch { raw = null; }
  }

  if (!raw?.hexes) {
    negUntil = now + NEG_TTL;
    return null;
  }

  const data = { ...raw, source: raw.source || 'gpsjam.org', hexes: raw.hexes.map(toWebHex) };
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
