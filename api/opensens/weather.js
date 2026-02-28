/**
 * /api/opensens/weather
 * Fetches hourly meteorological data from Open-Meteo (free, no-API-key, CC-BY 4.0).
 * Returns normalized hourly series + derived daily summaries (p10/p50/p90).
 *
 * Query params:
 *   lat, lon      — WGS-84 coordinates (required)
 *   days          — forecast horizon 1–16 (default 7)
 *   past_days     — historical days to include 0–92 (default 7)
 *
 * Cache: s-maxage=1800 (30 min), SWR=900 (15 min)
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, parseLatLon, percentile, fetchWithTimeout, jsonError } from './_cache.js';

export const config = { runtime: 'edge' };

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'global_tilted_irradiance',   // GTI (uses default tilt=lat)
  'direct_normal_irradiance',   // DNI
  'diffuse_radiation',          // DHI
  'precipitation',
  'cloud_cover',
].join(',');

function buildOpenMeteoUrl(lat, lon, days, pastDays) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY_VARS,
    wind_speed_unit: 'ms',
    timezone: 'UTC',
    forecast_days: String(Math.min(Math.max(parseInt(days) || 7, 1), 16)),
    past_days: String(Math.min(Math.max(parseInt(pastDays) || 7, 0), 92)),
  });
  return `${OPEN_METEO_BASE}?${params}`;
}

/**
 * Compute daily summaries from Open-Meteo hourly arrays.
 * Returns array of { date, temp_avg, humidity_avg, wind_avg_mps, ghi_kwh, ghi_p10, ghi_p90 }.
 */
function computeDailySummaries(hourly) {
  const byDate = {};
  for (let i = 0; i < hourly.time.length; i++) {
    const date = hourly.time[i].slice(0, 10);
    if (!byDate[date]) byDate[date] = { temps: [], humids: [], winds: [], ghis: [] };
    byDate[date].temps.push(hourly.temperature_2m[i] ?? 0);
    byDate[date].humids.push(hourly.relative_humidity_2m[i] ?? 0);
    byDate[date].winds.push(hourly.wind_speed_10m[i] ?? 0);
    // GTI in W/m² — integrate over 1 h to get Wh/m², sum → kWh/m²/day
    byDate[date].ghis.push(hourly.global_tilted_irradiance[i] ?? 0);
  }
  return Object.entries(byDate).map(([date, d]) => {
    const ghiKwh = d.ghis.reduce((s, v) => s + v, 0) / 1000;
    const monthlyGhis = d.ghis.filter((v) => v >= 0);
    return {
      date,
      temp_avg: parseFloat((d.temps.reduce((s, v) => s + v, 0) / d.temps.length).toFixed(1)),
      humidity_avg: parseFloat((d.humids.reduce((s, v) => s + v, 0) / d.humids.length).toFixed(1)),
      wind_avg_mps: parseFloat((d.winds.reduce((s, v) => s + v, 0) / d.winds.length).toFixed(2)),
      ghi_kwh: parseFloat(ghiKwh.toFixed(3)),
      ghi_p10: parseFloat((percentile(monthlyGhis, 10) / 1000).toFixed(3)),
      ghi_p90: parseFloat((percentile(monthlyGhis, 90) / 1000).toFixed(3)),
    };
  });
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

  const days = url.searchParams.get('days') || '7';
  const pastDays = url.searchParams.get('past_days') || '7';
  const upstreamUrl = buildOpenMeteoUrl(lat, lon, days, pastDays);

  let raw;
  try {
    const res = await fetchWithTimeout(upstreamUrl, {
      headers: { 'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)' },
    }, 12000);
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.error('[opensens/weather]', err.message);
    return jsonError(`Upstream weather fetch failed: ${err.message}`, 502, corsHeaders);
  }

  const hourly = raw.hourly ?? {};
  const dailySummaries = computeDailySummaries(hourly);

  const payload = JSON.stringify({
    meta: {
      source: 'Open-Meteo (open-meteo.com) — CC-BY 4.0, ECMWF ERA5 reanalysis + NWP',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 1800,
      confidence: 'high',
      warnings: [],
    },
    lat,
    lon,
    timezone: raw.timezone ?? 'UTC',
    hourly,
    daily_summary: dailySummaries,
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  return withCache(baseResponse, {
    ttl: 1800,
    swr: 900,
    source: 'open-meteo.com',
    confidence: 'high',
  });
}
