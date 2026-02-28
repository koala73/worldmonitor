/**
 * /api/opensens/connectivity
 * ISP vs Starlink comparison for OpenSens node siting.
 *
 * Returns connectivity options with cost, speed, latency, power overhead,
 * and a recommendation under the user-selected objective.
 *
 * Starlink assumptions (editable via query params):
 *   - Monthly plan: $120 USD (Residential), overridable
 *   - Dish power: 75–100 W (average 85 W), overridable
 *   - Download: 100–300 Mbps typical
 *   - Latency: 25–60 ms typical
 *
 * Country ISP priors: static lookup table (editable via `isp_cost` param).
 * All values are estimates; users must verify locally.
 *
 * Query params:
 *   lat, lon          — WGS-84 (required)
 *   country           — ISO-2 country code (required)
 *   objective         — 'cost'|'latency'|'reliability' (default 'cost')
 *   starlink_cost     — monthly USD override (optional)
 *   starlink_power_w  — dish power override watts (optional)
 *   isp_cost          — monthly USD override for local ISP (optional)
 *   isp_download_mbps — local ISP download Mbps override (optional)
 *
 * Cache: s-maxage=3600 (1 h)
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { withCache, parseLatLon, jsonError } from './_cache.js';

export const config = { runtime: 'edge' };

/**
 * Country ISP priors (monthly USD, download Mbps, latency ms, reliability 0–1).
 * Sources: Speedtest Global Index, ITU data, cable.co.uk broadband pricing.
 * These are INDICATIVE averages; real prices vary widely.
 */
const ISP_PRIORS = {
  US: { cost: 65,  dl: 200, latency: 15, reliability: 0.97 },
  GB: { cost: 45,  dl: 150, latency: 10, reliability: 0.97 },
  DE: { cost: 40,  dl: 100, latency: 10, reliability: 0.97 },
  FR: { cost: 35,  dl: 300, latency: 8,  reliability: 0.97 },
  JP: { cost: 35,  dl: 500, latency: 5,  reliability: 0.99 },
  AU: { cost: 75,  dl: 100, latency: 20, reliability: 0.96 },
  BR: { cost: 25,  dl: 100, latency: 25, reliability: 0.92 },
  IN: { cost: 10,  dl: 50,  latency: 25, reliability: 0.88 },
  NG: { cost: 35,  dl: 20,  latency: 60, reliability: 0.70 },
  KE: { cost: 25,  dl: 30,  latency: 50, reliability: 0.75 },
  PH: { cost: 20,  dl: 50,  latency: 30, reliability: 0.80 },
  ID: { cost: 15,  dl: 40,  latency: 30, reliability: 0.82 },
  MX: { cost: 25,  dl: 50,  latency: 20, reliability: 0.88 },
  ZA: { cost: 30,  dl: 40,  latency: 30, reliability: 0.85 },
  SG: { cost: 35,  dl: 500, latency: 5,  reliability: 0.99 },
  // Default for unknown countries
  DEFAULT: { cost: 30, dl: 30, latency: 50, reliability: 0.75 },
};

const STARLINK_DEFAULTS = {
  cost: 120,          // USD/month (Residential)
  dl: 200,            // Mbps typical midpoint
  latency: 40,        // ms typical midpoint
  powerW: 85,         // watts average (dish + router)
  reliability: 0.95,  // high availability (weather dependent)
};

function clamp(v, lo, hi) { return Math.min(Math.max(Number(v), lo), hi); }

function scoreOption(opt, objective) {
  if (objective === 'latency') return -opt.latencyMs;
  if (objective === 'reliability') return opt.reliability;
  return -opt.monthlyCostUsd; // cost: lower is better
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

  const country   = (url.searchParams.get('country') || 'DEFAULT').toUpperCase();
  const objective = url.searchParams.get('objective') || 'cost';
  if (!['cost', 'latency', 'reliability'].includes(objective)) {
    return jsonError("objective must be 'cost', 'latency', or 'reliability'", 400, corsHeaders);
  }

  const prior = ISP_PRIORS[country] ?? ISP_PRIORS.DEFAULT;
  const warnings = [];

  // Build Starlink option
  const slCost    = url.searchParams.get('starlink_cost')    ? clamp(url.searchParams.get('starlink_cost'), 0, 2000)   : STARLINK_DEFAULTS.cost;
  const slPowerW  = url.searchParams.get('starlink_power_w') ? clamp(url.searchParams.get('starlink_power_w'), 0, 250)  : STARLINK_DEFAULTS.powerW;
  const starlinkOption = {
    provider: 'starlink',
    label: 'Starlink (SpaceX)',
    monthlyCostUsd: slCost,
    downloadMbps: STARLINK_DEFAULTS.dl,
    latencyMs: STARLINK_DEFAULTS.latency,
    powerOverheadW: slPowerW,
    reliability: STARLINK_DEFAULTS.reliability,
    notes: [
      `Dish power overhead: ~${slPowerW} W average (75–100 W range).`,
      'Availability: 99%+ globally (weather-dependent degradation possible).',
      'Monthly cost varies by region ($120 Residential / $250 Business / $500 Priority). User override available.',
      'Starlink Gen3 router included in typical plan.',
    ],
  };

  // Build Local ISP option
  const ispCost = url.searchParams.get('isp_cost')
    ? clamp(url.searchParams.get('isp_cost'), 0, 5000)
    : prior.cost;
  const ispDl   = url.searchParams.get('isp_download_mbps')
    ? clamp(url.searchParams.get('isp_download_mbps'), 0, 10000)
    : prior.dl;

  const ispOption = {
    provider: 'local-isp',
    label: `Local ISP — ${country} market average`,
    monthlyCostUsd: ispCost,
    downloadMbps: ispDl,
    latencyMs: prior.latency,
    powerOverheadW: 10, // router/modem ~10 W
    reliability: prior.reliability,
    notes: [
      `Country: ${country}. Source: Speedtest Global Index / ITU indicative data.`,
      'Prices are country-wide averages; negotiate local rates. Override via isp_cost param.',
      'Reliability estimate is national average; rural areas may be lower.',
      prior === ISP_PRIORS.DEFAULT
        ? `WARNING: No country-specific ISP data for ${country}; using global default.`
        : `Data confidence: medium (country-level aggregate, not site-specific).`,
    ],
  };

  if (prior === ISP_PRIORS.DEFAULT) {
    warnings.push(`No ISP prior data for country=${country}; using conservative global default.`);
  }

  const options = [ispOption, starlinkOption];
  const best = options.reduce((b, o) => scoreOption(o, objective) > scoreOption(b, objective) ? o : b);

  const payload = JSON.stringify({
    meta: {
      source: 'Static country ISP priors (Speedtest Global Index / ITU) + Starlink public pricing',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 3600,
      confidence: warnings.length ? 'low' : 'medium',
      warnings,
    },
    lat,
    lon,
    countryCode: country,
    options,
    recommendation: {
      provider: best.provider,
      reason: `Best under objective="${objective}": ${best.label} at $${best.monthlyCostUsd}/mo, ${best.latencyMs}ms latency, ${(best.reliability * 100).toFixed(0)}% reliability.`,
      objective,
    },
  });

  const baseResponse = new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

  return withCache(baseResponse, { ttl: 3600, swr: 900, source: 'connectivity-priors', confidence: 'medium', warnings });
}
