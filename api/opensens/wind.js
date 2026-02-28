/**
 * /api/opensens/wind
 * Wind viability pre-screening for small rooftop turbines.
 *
 * Uses Open-Meteo wind speed at 10 m, applies:
 *   1. Power-law height correction to user-specified hub height (default 15 m).
 *   2. Urban derating factor (default 0.60 — rooftop turbulence penalty).
 *   3. Betz-limit power curve for a 1 kW turbine (rated at 12 m/s).
 *
 * IMPORTANT DISCLAIMER: Rooftop wind in built environments is highly
 * site-specific. This endpoint is PRE-SCREENING ONLY. A physical
 * micrositing assessment is required before any installation.
 *
 * Query params:
 *   lat, lon          — WGS-84 (required)
 *   hub_height        — metres (default 15, range 5–50)
 *   urban_derate      — 0.0–1.0 (default 0.60)
 *   turbine_rated_w   — rated output watts at rated wind speed (default 1000)
 *   turbine_rated_mps — rated wind speed m/s (default 12)
 *
 * Cache: s-maxage=3600 (1 h)
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, parseLatLon, fetchWithTimeout, jsonError, percentile } from './_cache.js';

export const config = { runtime: 'edge' };

const DISCLAIMER =
  'PRE-SCREENING ONLY. Rooftop wind in urban environments is highly site-specific ' +
  'due to turbulence, shadowing, and structural loads. Do NOT use this estimate for ' +
  'investment decisions without a physical micrositing survey by a qualified engineer.';

function clamp(v, lo, hi) { return Math.min(Math.max(Number(v), lo), hi); }

/**
 * Power-law wind speed extrapolation from reference height to hub height.
 * α = 0.25 for urban terrain (Hellmann exponent, urban category IV).
 */
function heightCorrect(speedRef, zRef, zHub, alpha = 0.25) {
  return speedRef * Math.pow(zHub / zRef, alpha);
}

/**
 * Simple wind turbine power model (variable-speed below rated, flat above rated, zero below cut-in).
 * Returns watts.
 */
function turbinePower(windSpeed, ratedW, ratedMps, cutInMps = 2.5, cutOutMps = 25) {
  if (windSpeed < cutInMps || windSpeed > cutOutMps) return 0;
  if (windSpeed >= ratedMps) return ratedW;
  return ratedW * Math.pow(windSpeed / ratedMps, 3);
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

  const hubHeight      = clamp(url.searchParams.get('hub_height')       || 15,   5,  50);
  const urbanDerate    = clamp(url.searchParams.get('urban_derate')      || 0.60, 0,  1);
  const ratedW         = clamp(url.searchParams.get('turbine_rated_w')  || 1000, 50, 50000);
  const ratedMps       = clamp(url.searchParams.get('turbine_rated_mps')|| 12,   5,  25);

  // Fetch 30-day wind data from Open-Meteo
  const omParams = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'wind_speed_10m',
    wind_speed_unit: 'ms',
    timezone: 'UTC',
    past_days: '30',
    forecast_days: '1',
  });
  const omUrl = `https://api.open-meteo.com/v1/forecast?${omParams}`;

  let windSpeeds10m = [];
  const warnings = [];
  try {
    const res = await fetchWithTimeout(omUrl, {
      headers: { 'User-Agent': 'OpenSens-DAMD/1.0' },
    }, 12000);
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    const data = await res.json();
    windSpeeds10m = (data?.hourly?.wind_speed_10m ?? []).filter((v) => v != null);
  } catch (err) {
    warnings.push(`Wind data fetch failed: ${err.message}. Using latitude-band default.`);
    // Conservative fallback: 3.5 m/s average (typical sheltered urban)
    windSpeeds10m = Array(720).fill(3.5);
  }

  // Correct to hub height and apply urban derating
  const correctedSpeeds = windSpeeds10m.map((v) =>
    heightCorrect(v, 10, hubHeight) * urbanDerate
  );

  // Compute power at each hour
  const powerValues = correctedSpeeds.map((v) => turbinePower(v, ratedW, ratedMps));
  const avgPowerW = powerValues.reduce((s, v) => s + v, 0) / (powerValues.length || 1);
  const avgSpeedCorr = correctedSpeeds.reduce((s, v) => s + v, 0) / (correctedSpeeds.length || 1);

  // Viability score: 0–100 based on how often wind exceeds cut-in speed
  const aboveCutIn = correctedSpeeds.filter((v) => v >= 2.5).length;
  const viabilityScore = parseFloat(((aboveCutIn / (correctedSpeeds.length || 1)) * 100).toFixed(1));

  const payload = JSON.stringify({
    meta: {
      source: 'Open-Meteo (open-meteo.com) 10 m wind speed — 30-day reanalysis',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      confidence: warnings.length ? 'low' : 'medium',
      warnings: [DISCLAIMER, ...warnings],
    },
    lat,
    lon,
    windSpeedMps: parseFloat(avgSpeedCorr.toFixed(2)),
    hubHeightM: hubHeight,
    roughnessLength: 0.5, // urban terrain assumed
    urbanDerate,
    viabilityScore,
    avgOutputW: {
      p10: parseFloat(percentile(powerValues, 10).toFixed(1)),
      p50: parseFloat(avgPowerW.toFixed(1)),
      p90: parseFloat(percentile(powerValues, 90).toFixed(1)),
    },
    disclaimer: DISCLAIMER,
    assumptions: {
      hellmann_alpha: 0.25,
      terrain: 'urban-IV',
      turbine_rated_w: ratedW,
      turbine_rated_mps: ratedMps,
      cut_in_mps: 2.5,
      cut_out_mps: 25,
      data_window_days: 30,
    },
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  return withCache(baseResponse, { ttl: 3600, swr: 900, source: 'open-meteo-wind', confidence: 'medium', warnings });
}
