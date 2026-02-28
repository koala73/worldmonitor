/**
 * /api/opensens/roi
 * ROI aggregator for OpenSens node deployment candidates.
 *
 * Combines:
 *   - PV yield + BESS autonomy (from pv + weather endpoints or provided params)
 *   - Node template compute capacity (from node-templates.json)
 *   - Connectivity cost
 *   - Demand proxies (population density, nighttime light index, business density)
 *
 * Returns three ROI scenarios: conservative / moderate / aggressive.
 * All assumptions are explicit and included in the response.
 *
 * Query params:
 *   lat, lon              — WGS-84 (required)
 *   template_id           — node template ID (default 'standard-mac-mini-m4')
 *   pv_kwp                — PV size kWp (default 3)
 *   bess_kwh              — total BESS kWh (default 20)
 *   bess_li_kwh           — Li-ion portion kWh (default 10)
 *   connectivity_cost     — monthly USD (required or default 65)
 *   starlink_power_w      — watts for connectivity overhead (default 85)
 *   pue                   — Power Use Effectiveness (default 1.25)
 *   pop_density           — people/km² (optional demand proxy)
 *   nighttime_light       — 0–1 VIIRS index (optional demand proxy)
 *   business_density      — businesses/km² (optional demand proxy)
 *   electricity_cost      — local electricity USD/kWh (default 0.15)
 *   revenue_per_node      — monthly USD revenue per compute node (optional; used for moderate scenario)
 *
 * Cache: no server-side cache (computed from user params; client caches).
 * Returns Cache-Control: no-store.
 */
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { jsonError } from './_cache.js';

export const config = { runtime: 'edge' };

// Node template power defaults (fallback if template not found)
const TEMPLATE_DEFAULTS = {
  'standard-mac-mini-m4':    { typical_w: 225, peak_w: 400,  capex_mid: 9750,  nodes: 5 },
  'pro-mac-studio-m4-ultra': { typical_w: 450, peak_w: 720,  capex_mid: 24000, nodes: 3 },
  'premium-nvidia-h100-pcie':{ typical_w: 900, peak_w: 1200, capex_mid: 47500, nodes: 1 },
};

function clamp(v, lo, hi) { return Math.min(Math.max(Number(v), lo), hi); }
function parseNum(v, def) { const n = parseFloat(v); return isNaN(n) ? def : n; }

/**
 * BESS autonomy: hours of IT load support at given DoD.
 */
function autonomyHours(bessKwh, dod, itLoadW, pue) {
  const effectiveW = itLoadW * pue;
  return (bessKwh * dod * 1000) / effectiveW; // hours
}

/**
 * NPV calculation (simple DCF, annual cash flows, constant discount rate).
 */
function npv(initialCapex, annualNetCashFlow, discountRate, years) {
  let value = -initialCapex;
  for (let t = 1; t <= years; t++) {
    value += annualNetCashFlow / Math.pow(1 + discountRate, t);
  }
  return parseFloat(value.toFixed(0));
}

/**
 * Simple IRR via bisection search.
 */
function irr(initialCapex, annualNetCashFlow, years, maxRate = 5.0) {
  if (annualNetCashFlow <= 0) return null;
  let lo = -0.999, hi = maxRate;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pv = npv(initialCapex, annualNetCashFlow, mid, years);
    if (Math.abs(pv) < 1) return parseFloat((mid * 100).toFixed(1));
    if (pv > 0) lo = mid; else hi = mid;
  }
  return parseFloat(((lo + hi) / 2 * 100).toFixed(1));
}

/**
 * Demand score composite (0–100).
 */
function demandScore(popDensity, nightlight, bizDensity) {
  // Normalised against reference: urban centre ~5000 ppl/km², NTL=0.8, biz=200/km²
  // Each component capped; composite capped at 100.
  const popScore = Math.min(40, (popDensity / 5000) * 40);
  const ntlScore = Math.min(30, (nightlight ?? 0.3) * 30);
  const bizScore = Math.min(30, (bizDensity ?? 50) / 200 * 30);
  return parseFloat(Math.min(100, popScore + ntlScore + bizScore).toFixed(1));
}

/**
 * Build a scenario with explicit assumptions.
 */
function buildScenario(label, revenueMultiplier, capexMultiplier, opexMultiplier, params) {
  const {
    templateCapexMid, itLoadW, pue, connectivityCostMonthly, electricityCostKwh,
    pvKwp, bessKwh, nodeCount, revenuePerNodeMonthly, dataCompleteness,
  } = params;

  // CAPEX
  const pvCapex        = pvKwp * 1200;   // $1200/kWp installed rough estimate
  const bessCapex      = bessKwh * 400;  // $400/kWh Li-ion blend rough estimate
  const computeCapex   = templateCapexMid * capexMultiplier;
  const installCapex   = (pvCapex + bessCapex + computeCapex) * 0.15; // 15% install labour
  const totalCapex     = pvCapex + bessCapex + computeCapex + installCapex;

  // OPEX (annual)
  const effectiveW    = itLoadW * pue;
  const annualKwh     = (effectiveW / 1000) * 8760 * 0.6; // 60% duty cycle
  const electricityCost = annualKwh * electricityCostKwh;
  const annualOpex    = (connectivityCostMonthly * 12 + electricityCost + 500) * opexMultiplier;

  // Revenue (annual)
  const annualRevenue = revenuePerNodeMonthly * nodeCount * 12 * revenueMultiplier;
  const annualNet     = annualRevenue - annualOpex;

  const payback = annualNet > 0 ? parseFloat((totalCapex / annualNet).toFixed(1)) : Infinity;
  const npv5y   = npv(totalCapex, annualNet, 0.10, 5);
  const irrVal  = irr(totalCapex, annualNet, 5);

  return {
    label,
    annualRevenueUsd:  parseFloat(annualRevenue.toFixed(0)),
    annualOpexUsd:     parseFloat(annualOpex.toFixed(0)),
    totalCapexUsd:     parseFloat(totalCapex.toFixed(0)),
    paybackYears:      payback,
    npv5y,
    irr:               irrVal,
    confidence:        parseFloat((dataCompleteness * (label === 'moderate' ? 0.8 : 0.65)).toFixed(2)),
    dataCompletenessFlags: dataCompleteness < 0.7 ? ['demand_proxies_missing', 'local_revenue_data_required'] : [],
    assumptions: {
      pv_capex_per_kwp: 1200,
      bess_capex_per_kwh: 400,
      install_pct: 0.15,
      duty_cycle: 0.60,
      electricity_cost_kwh: electricityCostKwh,
      discount_rate: 0.10,
      analysis_years: 5,
      revenue_per_node_monthly: revenuePerNodeMonthly,
      revenue_multiplier: revenueMultiplier,
      capex_multiplier: capexMultiplier,
      opex_multiplier: opexMultiplier,
      note: 'Revenue assumptions are highly speculative. Actual rates depend on local market, service contracts, and regulatory environment.',
    },
  };
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (isDisallowedOrigin(req)) return jsonError('Forbidden', 403, corsHeaders);

  const url = new URL(req.url);
  const p = url.searchParams;

  const latRaw = p.get('lat'); const lonRaw = p.get('lon');
  if (!latRaw || !lonRaw) return jsonError('lat and lon are required', 400, corsHeaders);
  const lat = parseFloat(latRaw); const lon = parseFloat(lonRaw);
  if (isNaN(lat) || isNaN(lon)) return jsonError('lat/lon must be valid numbers', 400, corsHeaders);

  const templateId = p.get('template_id') || 'standard-mac-mini-m4';
  const tmpl = TEMPLATE_DEFAULTS[templateId] ?? TEMPLATE_DEFAULTS['standard-mac-mini-m4'];

  const pvKwp              = clamp(parseNum(p.get('pv_kwp'), 3), 0.5, 20);
  const bessKwh            = clamp(parseNum(p.get('bess_kwh'), 20), 1, 500);
  const bessLiKwh          = clamp(parseNum(p.get('bess_li_kwh'), 10), 0, bessKwh);
  const connectCost        = clamp(parseNum(p.get('connectivity_cost'), 65), 0, 5000);
  const starlinkPowerW     = clamp(parseNum(p.get('starlink_power_w'), 85), 0, 500);
  const pue                = clamp(parseNum(p.get('pue'), 1.25), 1.0, 3.0);
  const popDensity         = parseNum(p.get('pop_density'), null);
  const nightlight         = parseNum(p.get('nighttime_light'), null);
  const bizDensity         = parseNum(p.get('business_density'), null);
  const electricityCost    = clamp(parseNum(p.get('electricity_cost'), 0.15), 0, 5);
  const revenuePerNode     = clamp(parseNum(p.get('revenue_per_node'), 150), 0, 50000);

  const itLoadW = tmpl.typical_w + starlinkPowerW;
  const dScore  = demandScore(popDensity, nightlight, bizDensity);

  // Data completeness: lower if demand proxies are missing
  const hasDemand = [popDensity, nightlight, bizDensity].filter((v) => v !== null).length;
  const completeness = parseFloat((0.5 + (hasDemand / 3) * 0.5).toFixed(2));

  const warnings = [];
  if (completeness < 0.7) warnings.push('Demand proxy data incomplete — ROI confidence is low. Supply pop_density, nighttime_light, and business_density for better estimates.');
  warnings.push('Revenue estimates are highly speculative planning assumptions, not financial projections. Verify against local market rates.');

  const sharedParams = {
    templateCapexMid: tmpl.capex_mid,
    itLoadW, pue, connectivityCostMonthly: connectCost,
    electricityCostKwh: electricityCost, pvKwp, bessKwh,
    nodeCount: tmpl.nodes, revenuePerNodeMonthly: revenuePerNode,
    dataCompleteness: completeness,
  };

  const autonomy = {
    totalKwh: bessKwh,
    liIonKwh: bessLiKwh,
    flowKwh: bessKwh - bessLiKwh,
    itLoadW,
    effectiveLoadW: parseFloat((itLoadW * pue).toFixed(0)),
    autonomyHours: parseFloat(autonomyHours(bessKwh, 1.0, itLoadW, pue).toFixed(1)),
    autonomyDodHours: parseFloat(autonomyHours(bessKwh, 0.80, itLoadW, pue).toFixed(1)),
  };

  const scenarios = [
    buildScenario('conservative', 0.5, 1.1, 1.2, sharedParams),
    buildScenario('moderate',     1.0, 1.0, 1.0, sharedParams),
    buildScenario('aggressive',   1.8, 0.9, 0.9, sharedParams),
  ];

  const payload = JSON.stringify({
    meta: {
      source: 'OpenSens DAMD ROI aggregator — static priors + user-supplied parameters',
      cachedAt: new Date().toISOString(),
      ttlSeconds: 0,
      confidence: completeness >= 0.7 ? 'medium' : 'low',
      warnings,
    },
    lat, lon,
    templateId,
    demandScore: dScore,
    completeness,
    autonomy,
    scenarios,
  });

  // No server-side cache — results are parameter-specific
  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}
