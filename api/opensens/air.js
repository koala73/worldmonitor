/**
 * /api/opensens/air
 * Air quality data from OpenAQ (openaq.org — CC-BY 4.0).
 * Returns current + recent AQI, PM2.5, PM10, NO2, and a soiling risk proxy.
 *
 * Query params:
 *   lat, lon    — WGS-84 (required)
 *   radius      — search radius in metres (default 25000, max 100000)
 *
 * Soiling risk proxy: derived from PM2.5 and PM10 levels.
 * High soiling → PV panel degradation, increased cleaning frequency.
 *
 * Cache: s-maxage=900 (15 min)
 *
 * OpenAQ ToU: https://openaq.org/about/licenses/
 * — open data, no API key required for moderate usage; rate limit ~10 req/s.
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, parseLatLon, fetchWithTimeout, jsonError } from './_cache.js';

export const config = { runtime: 'edge' };

const OPENAQ_BASE = 'https://api.openaq.org/v3';

/** US EPA AQI breakpoints for PM2.5 µg/m³ (24-h average). */
function pm25ToAqi(pm) {
  if (pm == null) return null;
  const bp = [
    [0, 12,    0,  50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 350.4, 301, 400],
    [350.5, 500.4, 401, 500],
  ];
  for (const [lo, hi, aqiLo, aqiHi] of bp) {
    if (pm >= lo && pm <= hi) {
      return Math.round(((aqiHi - aqiLo) / (hi - lo)) * (pm - lo) + aqiLo);
    }
  }
  return pm > 500 ? 500 : 0;
}

/**
 * Soiling risk proxy: 0 (clean) → 1 (severe).
 * Heuristic: PM2.5 > 75 µg/m³ = high soiling risk.
 */
function soilingRisk(pm25, pm10) {
  const score = Math.min(1, ((pm25 ?? 0) / 75) * 0.7 + ((pm10 ?? 0) / 150) * 0.3);
  return parseFloat(score.toFixed(2));
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (isDisallowedOrigin(req)) return jsonError('Forbidden', 403, corsHeaders);

  const url = new URL(req.url);
  let lat, lon;
  try {
    ({ lat, lon } = parseLatLon(url.searchParams));
  } catch (e) {
    return jsonError(e.message, 400, corsHeaders);
  }
  const radius = Math.min(parseInt(url.searchParams.get('radius') || '25000'), 100000);

  // OpenAQ v3: fetch locations near the point, then latest measurements
  const locParams = new URLSearchParams({
    coordinates: `${lat.toFixed(4)},${lon.toFixed(4)}`,
    radius: String(radius),
    limit: '5',
    order_by: 'distance',
  });
  const locUrl = `${OPENAQ_BASE}/locations?${locParams}`;

  const warnings = [];
  let pm25 = null, pm10 = null, no2 = null;

  try {
    const locRes = await fetchWithTimeout(locUrl, {
      headers: {
        'User-Agent': 'OpenSens-DAMD/1.0',
        'Accept': 'application/json',
      },
    }, 10000);
    if (!locRes.ok) throw new Error(`OpenAQ locations returned ${locRes.status}`);
    const locData = await locRes.json();
    const locations = locData?.results ?? [];

    if (!locations.length) {
      warnings.push(`No OpenAQ stations within ${radius}m; AQI values are unavailable.`);
    } else {
      // Aggregate latest readings across nearest stations
      const counts = { pm25: [], pm10: [], no2: [] };
      for (const loc of locations.slice(0, 3)) {
        for (const sensor of loc.sensors ?? []) {
          const param = sensor.parameter?.name?.toLowerCase();
          const val = sensor.latest?.value;
          if (val == null || val < 0) continue;
          if (param === 'pm25') counts.pm25.push(val);
          if (param === 'pm10') counts.pm10.push(val);
          if (param === 'no2') counts.no2.push(val);
        }
      }
      const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
      pm25 = avg(counts.pm25);
      pm10 = avg(counts.pm10);
      no2  = avg(counts.no2);
    }
  } catch (err) {
    warnings.push(`OpenAQ fetch failed: ${err.message}. AQI data unavailable.`);
  }

  const aqi = pm25ToAqi(pm25);
  const risk = soilingRisk(pm25, pm10);
  const trend = 'stable'; // trend would require historical comparison; future enhancement

  const payload = JSON.stringify({
    meta: {
      source: 'OpenAQ v3 (openaq.org) — CC-BY 4.0, aggregated from official monitoring networks',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 900,
      confidence: warnings.length ? 'low' : 'medium',
      warnings,
    },
    lat,
    lon,
    aqi,
    pm25: pm25 != null ? parseFloat(pm25.toFixed(1)) : null,
    pm10: pm10 != null ? parseFloat(pm10.toFixed(1)) : null,
    no2:  no2  != null ? parseFloat(no2.toFixed(1))  : null,
    soilingRiskProxy: risk,
    trend,
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  return withCache(baseResponse, { ttl: 900, swr: 300, source: 'openaq', confidence: 'medium', warnings });
}
