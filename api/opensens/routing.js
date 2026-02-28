/**
 * /api/opensens/routing
 * Estimates fiber route length from a Starlink hub to candidate node sites.
 *
 * Routing strategy (in priority order):
 *   1. OSRM public demo server (driving network as fiber-trench proxy).
 *   2. Haversine × slackFactor fallback (if OSRM fails or route > maxKm).
 *
 * IMPORTANT: Road-network routing is a proxy only. Actual fiber trenching
 * follows rights-of-way that may differ significantly from roads. This is
 * a PLANNING ESTIMATE. Engage a licensed network engineer for real designs.
 *
 * Query params:
 *   hub_lat, hub_lon          — Starlink hub WGS-84 (required)
 *   sites                     — JSON array of {id,lat,lon} (required, max 20)
 *   slack                     — fiber slack factor (default 1.1, range 1.0–2.0)
 *   cost_per_meter            — USD/m fiber capex (default 15)
 *   max_km                    — exclude sites beyond this haversine km (default 3)
 *
 * Cache: s-maxage=86400 (24 h) — routes change rarely.
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, haversineM, fetchWithTimeout, jsonError } from './_cache.js';

export const config = { runtime: 'edge' };

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

function clamp(v, lo, hi) { return Math.min(Math.max(Number(v), lo), hi); }

/**
 * Fetch OSRM route distance between two points (metres).
 * Returns null if OSRM is unavailable or returns an error.
 */
async function osrmDistance(lat1, lon1, lat2, lon2) {
  const coords = `${lon1.toFixed(6)},${lat1.toFixed(6)};${lon2.toFixed(6)},${lat2.toFixed(6)}`;
  const url = `${OSRM_BASE}/${encodeURIComponent(coords)}?overview=false&geometries=geojson`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'OpenSens-DAMD/1.0' },
    }, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    return data.routes[0].distance; // metres
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (isDisallowedOrigin(req)) return jsonError('Forbidden', 403, corsHeaders);

  const url = new URL(req.url);

  // Parse hub
  const hubLatRaw = url.searchParams.get('hub_lat');
  const hubLonRaw = url.searchParams.get('hub_lon');
  if (!hubLatRaw || !hubLonRaw) return jsonError('hub_lat and hub_lon are required', 400, corsHeaders);
  const hubLat = parseFloat(hubLatRaw);
  const hubLon = parseFloat(hubLonRaw);
  if (isNaN(hubLat) || isNaN(hubLon)) return jsonError('hub_lat/hub_lon must be valid numbers', 400, corsHeaders);

  // Parse sites
  const sitesRaw = url.searchParams.get('sites');
  if (!sitesRaw) return jsonError('sites parameter is required (JSON array of {id,lat,lon})', 400, corsHeaders);
  let sites;
  try {
    sites = JSON.parse(sitesRaw);
    if (!Array.isArray(sites) || !sites.length) throw new Error('sites must be a non-empty array');
    if (sites.length > 20) return jsonError('Maximum 20 sites per request', 400, corsHeaders);
  } catch (e) {
    return jsonError(`Invalid sites parameter: ${e.message}`, 400, corsHeaders);
  }

  const slack        = clamp(url.searchParams.get('slack') || 1.1, 1.0, 2.0);
  const costPerMeter = clamp(url.searchParams.get('cost_per_meter') || 15, 1, 10000);
  const maxKm        = clamp(url.searchParams.get('max_km') || 3, 0.1, 50);

  const warnings = [];
  const results = [];

  for (const site of sites) {
    const sLat = parseFloat(site.lat);
    const sLon = parseFloat(site.lon);
    const sId  = String(site.id ?? `${sLat},${sLon}`);
    if (isNaN(sLat) || isNaN(sLon)) {
      warnings.push(`Skipped site ${sId}: invalid coordinates`);
      continue;
    }

    const hm = haversineM(hubLat, hubLon, sLat, sLon);
    if (hm / 1000 > maxKm) {
      warnings.push(`Site ${sId} is ${(hm / 1000).toFixed(1)} km from hub (> max_km=${maxKm}); excluded.`);
      continue;
    }

    // Try OSRM first
    let routeM = await osrmDistance(hubLat, hubLon, sLat, sLon);
    let routingSource = 'osrm';
    if (routeM == null) {
      routeM = hm;
      routingSource = 'haversine-fallback';
      warnings.push(`OSRM routing unavailable for site ${sId}; using haversine fallback.`);
    }

    const estimatedFiberM = parseFloat((routeM * slack).toFixed(0));
    const fiberCapexUsd   = parseFloat((estimatedFiberM * costPerMeter).toFixed(0));

    results.push({
      siteId: sId,
      lat: sLat,
      lon: sLon,
      routeDistanceM: parseFloat(routeM.toFixed(0)),
      haversineM: parseFloat(hm.toFixed(0)),
      slackFactor: slack,
      estimatedFiberM,
      fiberCapexUsd,
      routingSource,
    });
  }

  // Rank by estimated fiber length (shortest first)
  results.sort((a, b) => a.estimatedFiberM - b.estimatedFiberM);
  results.forEach((r, i) => { r.rank = i + 1; });

  if (!results.length) {
    return jsonError('No sites within max_km radius or all sites had invalid coordinates', 422, corsHeaders);
  }

  const payload = JSON.stringify({
    meta: {
      source: 'OSRM (project-osrm.org, OpenStreetMap data, ODbL) with haversine fallback',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 86400,
      confidence: warnings.some((w) => w.includes('fallback')) ? 'low' : 'medium',
      warnings: [
        'Road-network routing is a proxy for fiber trench routing. Actual fiber paths follow rights-of-way.',
        'Engage a licensed network engineer before procurement.',
        ...warnings,
      ],
    },
    hubLat,
    hubLon,
    sites: results,
    assumptions: {
      slack_factor: slack,
      cost_per_meter_usd: costPerMeter,
      max_km: maxKm,
      routing_primary: 'OSRM public demo (OpenStreetMap data)',
      routing_fallback: 'Haversine straight-line × slack_factor',
      fiber_type: 'underground SMF assumed (cost varies $5–$50/m by terrain)',
    },
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  const confidence = warnings.some((w) => w.includes('fallback')) ? 'low' : 'medium';
  return withCache(baseResponse, { ttl: 86400, swr: 3600, source: 'osrm-routing', confidence, warnings });
}
