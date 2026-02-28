/**
 * /api/opensens/pv
 * Server-side PV yield estimation via PVGIS (EU JRC, free API, EUPL licence).
 * Falls back to a simple Clear-Sky model if PVGIS is unavailable.
 *
 * Query params:
 *   lat, lon          — WGS-84 (required)
 *   kwp               — system size kWp (default 3, range 0.5–20)
 *   tilt              — panel tilt degrees from horizontal (default: abs(lat), optimum)
 *   azimuth           — panel azimuth degrees (0=S in PVGIS convention, default 0)
 *   system_loss       — percent (default 14)
 *
 * Cache: s-maxage=86400 (24 h) keyed at 0.1° bucket.
 *
 * PVGIS ToU: https://re.jrc.ec.europa.eu/pvg_tools/en/
 * — free for research & non-commercial; results must cite JRC/PVGIS.
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, parseLatLon, coarseBucket, fetchWithTimeout, jsonError, percentile } from './_cache.js';

export const config = { runtime: 'edge' };

const PVGIS_BASE = 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc';

function clamp(val, min, max) {
  return Math.min(Math.max(Number(val), min), max);
}

function buildPvgisUrl(lat, lon, kwp, tilt, azimuth, systemLoss) {
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    peakpower: kwp.toFixed(2),
    loss: systemLoss.toFixed(1),
    angle: tilt.toFixed(1),
    aspect: azimuth.toFixed(1), // PVGIS: 0=S, -90=E, 90=W
    outputformat: 'json',
    browser: '0',
  });
  return `${PVGIS_BASE}?${params}`;
}

/**
 * Parse PVGIS monthly output into our normalized format.
 * PVGIS returns E_m (kWh/month) per month; we convert to daily.
 */
function parsePvgisMonthly(pvgisData, kwp) {
  const monthly = pvgisData?.outputs?.monthly?.fixed ?? [];
  return monthly.map((m) => ({
    month: m.month,
    kwhEstimate: parseFloat((m['E_m'] / 30.44).toFixed(3)), // kWh/day (monthly average)
  }));
}

/**
 * Fallback: simple clear-sky model based on latitude and season.
 * Returns a reasonable p50 estimate ±30% uncertainty.
 * This is NOT a substitute for PVGIS; used only when PVGIS is unreachable.
 */
function fallbackPvEstimate(lat, kwp) {
  // Annual average peak sun hours by latitude band (very approximate)
  const absLat = Math.abs(lat);
  let psh; // peak sun hours / day
  if (absLat < 15) psh = 5.5;
  else if (absLat < 25) psh = 5.2;
  else if (absLat < 35) psh = 4.8;
  else if (absLat < 45) psh = 4.2;
  else if (absLat < 55) psh = 3.5;
  else psh = 2.8;
  const pr = 0.80; // performance ratio
  const p50 = parseFloat((kwp * psh * pr).toFixed(2));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    // Seasonal variation: summer ±20%, winter ∓20% (NH); invert for SH
    const seasonFactor = lat >= 0
      ? 1 + 0.2 * Math.cos(((i - 5) * Math.PI) / 6)
      : 1 + 0.2 * Math.cos(((i - 11) * Math.PI) / 6);
    return { month: i + 1, kwhEstimate: parseFloat((p50 * seasonFactor).toFixed(3)) };
  });
  return { p50, p10: parseFloat((p50 * 0.70).toFixed(2)), p90: parseFloat((p50 * 1.30).toFixed(2)), monthly };
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

  const kwp      = clamp(url.searchParams.get('kwp') || 3, 0.5, 20);
  const tilt     = clamp(url.searchParams.get('tilt') || Math.abs(lat), 0, 90);
  const azimuth  = clamp(url.searchParams.get('azimuth') || 0, -180, 180);
  const sysLoss  = clamp(url.searchParams.get('system_loss') || 14, 0, 30);
  const bucket   = coarseBucket(lat, lon, 1);

  const warnings = [];
  let source = 'PVGIS v5.2 (re.jrc.ec.europa.eu) — EU JRC, EUPL licence';
  let monthly, kwhPerDay;
  let performanceRatio = (100 - sysLoss) / 100;

  try {
    const pvgisUrl = buildPvgisUrl(lat, lon, kwp, tilt, azimuth, sysLoss);
    const res = await fetchWithTimeout(pvgisUrl, {
      headers: { 'User-Agent': 'OpenSens-DAMD/1.0 (+https://opensens.io)' },
    }, 20000);

    if (!res.ok) throw new Error(`PVGIS returned ${res.status}`);
    const pvgisData = await res.json();

    monthly = parsePvgisMonthly(pvgisData, kwp);
    const dailyValues = monthly.map((m) => m.kwhEstimate);
    kwhPerDay = {
      p10: parseFloat(percentile(dailyValues, 10).toFixed(2)),
      p50: parseFloat(percentile(dailyValues, 50).toFixed(2)),
      p90: parseFloat(percentile(dailyValues, 90).toFixed(2)),
    };
  } catch (err) {
    warnings.push(`PVGIS unavailable (${err.message}); using fallback clear-sky model — results are approximate ±30%`);
    source = 'Fallback clear-sky model (latitude-band average) — NOT a substitute for PVGIS';
    const fb = fallbackPvEstimate(lat, kwp);
    monthly = fb.monthly;
    kwhPerDay = { p10: fb.p10, p50: fb.p50, p90: fb.p90 };
    performanceRatio = 0.80;
  }

  const payload = JSON.stringify({
    meta: {
      source,
      cachedAt: new Date().toISOString(),
      ttlSeconds: 86400,
      confidence: warnings.length ? 'low' : 'high',
      warnings,
    },
    lat,
    lon,
    bucketKey: bucket,
    systemKwp: kwp,
    tiltDeg: tilt,
    azimuthDeg: azimuth,
    kwhPerDay,
    monthly,
    performanceRatio,
    assumptions: {
      system_loss_pct: sysLoss,
      pvgis_version: '5.2',
      pvgis_database: 'PVGIS-SARAH3 (if available) else ERA5',
      note: 'Results cite EU JRC / PVGIS. For research & planning only. Cite: Huld et al., Solar Energy 2012.',
    },
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  return withCache(baseResponse, {
    ttl: 86400,
    swr: 3600,
    source: 'pvgis-jrc',
    confidence: warnings.length ? 'low' : 'high',
    warnings,
  });
}
