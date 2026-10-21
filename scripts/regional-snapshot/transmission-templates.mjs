// @ts-check
// Pre-built transmission path templates. ~15 covering major corridors.
// Each template is matched at runtime against active triggers and corridor
// status, then enriched with live data (current rates, prices) when available.

const TEMPLATE_VERSION = '1.0.0';

export { TEMPLATE_VERSION };

/** @type {Array<{
 *   id: string;
 *   trigger: string;
 *   corridorId: string;
 *   steps: Array<{ start: string; mechanism: string; end: string; severity: 'critical'|'high'|'medium'|'low'; latencyHours: number; assetClass: string; magnitudeLow: number; magnitudeHigh: number; magnitudeUnit: string; confidence: number }>;
 *   affectedRegions: string[];
 * }>}
 */
export const TRANSMISSION_TEMPLATES = [
  {
    id: 'hormuz_blockade',
    trigger: 'hormuz_transit_drop',
    corridorId: 'hormuz',
    affectedRegions: ['mena', 'east-asia', 'south-asia', 'europe'],
    steps: [
      { start: 'Hormuz transit drop', mechanism: 'tanker insurance premiums spike', end: 'tanker rates +200-400%', severity: 'critical', latencyHours: 12, assetClass: 'shipping', magnitudeLow: 200, magnitudeHigh: 400, magnitudeUnit: 'pct', confidence: 0.90 },
      { start: 'Tanker rates spike', mechanism: 'crude risk premium widens', end: 'Brent +$10-25/bbl', severity: 'critical', latencyHours: 24, assetClass: 'crude', magnitudeLow: 10, magnitudeHigh: 25, magnitudeUnit: 'usd_bbl', confidence: 0.85 },
      { start: 'Brent spikes', mechanism: 'refinery input costs rise', end: 'Asian gasoline/diesel margins +15-30%', severity: 'high', latencyHours: 72, assetClass: 'refined_products', magnitudeLow: 15, magnitudeHigh: 30, magnitudeUnit: 'pct', confidence: 0.70 },
      { start: 'Crude spikes', mechanism: 'SPR coordinated release absorbs demand', end: 'price ceiling for ~30d', severity: 'medium', latencyHours: 96, assetClass: 'crude', magnitudeLow: -10, magnitudeHigh: 0, magnitudeUnit: 'usd_bbl', confidence: 0.60 },
    ],
  },
  {
    id: 'red_sea_rerouting',
    trigger: 'red_sea_critical',
    corridorId: 'babelm',
    affectedRegions: ['mena', 'europe', 'east-asia', 'sub-saharan-africa'],
    steps: [
      { start: 'Bab el-Mandeb threat critical', mechanism: 'shipping diverts around Cape of Good Hope', end: 'Asia-EU transit +10-14 days', severity: 'high', latencyHours: 24, assetClass: 'container', magnitudeLow: 10, magnitudeHigh: 14, magnitudeUnit: 'days', confidence: 0.85 },
      { start: 'Container rerouting', mechanism: 'spot rates spike', end: 'Asia-EU container rates +$2000-4000/TEU', severity: 'high', latencyHours: 72, assetClass: 'container', magnitudeLow: 2000, magnitudeHigh: 4000, magnitudeUnit: 'usd_teu', confidence: 0.85 },
      { start: 'Longer voyages', mechanism: 'bunker fuel demand rises', end: 'bunker prices +8-12%', severity: 'medium', latencyHours: 96, assetClass: 'bunker', magnitudeLow: 8, magnitudeHigh: 12, magnitudeUnit: 'pct', confidence: 0.75 },
      { start: 'Transit cost increase', mechanism: 'EU consumer goods margin pressure', end: 'EU retail inflation +0.3-0.5pp', severity: 'medium', latencyHours: 720, assetClass: 'cpi', magnitudeLow: 0.3, magnitudeHigh: 0.5, magnitudeUnit: 'pp', confidence: 0.50 },
    ],
  },
  {
    id: 'taiwan_strait_tension',
    trigger: 'taiwan_tension_high',
    corridorId: 'taiwan-strait',
    affectedRegions: ['east-asia', 'north-america', 'europe'],
    steps: [
      { start: 'Taiwan Strait threat elevated', mechanism: 'semiconductor supply risk re-priced', end: 'Asian semiconductor stocks -5% to -12%', severity: 'high', latencyHours: 12, assetClass: 'equity', magnitudeLow: -12, magnitudeHigh: -5, magnitudeUnit: 'pct', confidence: 0.75 },
      { start: 'Supply chain de-risking accelerates', mechanism: 'global capex revision toward diversification', end: 'tech sector capex +$20-50B annualized', severity: 'medium', latencyHours: 720, assetClass: 'capex', magnitudeLow: 20, magnitudeHigh: 50, magnitudeUnit: 'usd_b', confidence: 0.60 },
      { start: 'Strait tensions', mechanism: 'East Asia container rates spike', end: 'TPEB rates +30-60%', severity: 'high', latencyHours: 48, assetClass: 'container', magnitudeLow: 30, magnitudeHigh: 60, magnitudeUnit: 'pct', confidence: 0.70 },
    ],
  },
  {
    id: 'iran_cii_escalation',
    trigger: 'iran_cii_spike',
    corridorId: 'hormuz',
    affectedRegions: ['mena', 'east-asia', 'europe'],
    steps: [
      { start: 'Iran instability spike', mechanism: 'regional risk premium widens', end: 'Brent +$3-8/bbl', severity: 'high', latencyHours: 6, assetClass: 'crude', magnitudeLow: 3, magnitudeHigh: 8, magnitudeUnit: 'usd_bbl', confidence: 0.80 },
      { start: 'Iran instability spike', mechanism: 'gold safe-haven bid', end: 'gold +1-3%', severity: 'medium', latencyHours: 6, assetClass: 'metals', magnitudeLow: 1, magnitudeHigh: 3, magnitudeUnit: 'pct', confidence: 0.70 },
    ],
  },
  {
    id: 'russia_naval_baltic',
    trigger: 'russia_naval_buildup',
    corridorId: 'danish',
    affectedRegions: ['europe'],
    steps: [
      { start: 'Russian naval buildup in Baltic', mechanism: 'NATO defense spending re-rated', end: 'EU defense stocks +5-15%', severity: 'medium', latencyHours: 48, assetClass: 'equity', magnitudeLow: 5, magnitudeHigh: 15, magnitudeUnit: 'pct', confidence: 0.65 },
      { start: 'Baltic tension', mechanism: 'gas pipeline risk premium rises', end: 'TTF +5-15%', severity: 'high', latencyHours: 24, assetClass: 'gas', magnitudeLow: 5, magnitudeHigh: 15, magnitudeUnit: 'pct', confidence: 0.70 },
    ],
  },
  {
    id: 'european_capital_stress',
    trigger: 'european_capital_stress',
    corridorId: 'bosphorus',
    affectedRegions: ['europe'],
    steps: [
      { start: 'European capital stress breaches threshold', mechanism: 'sovereign spreads widen', end: 'periphery vs Bund +30-80bp', severity: 'high', latencyHours: 48, assetClass: 'fx', magnitudeLow: 30, magnitudeHigh: 80, magnitudeUnit: 'basis_points', confidence: 0.75 },
      { start: 'Sovereign stress', mechanism: 'EUR weakens vs USD', end: 'EUR/USD -2% to -5%', severity: 'medium', latencyHours: 72, assetClass: 'fx', magnitudeLow: -5, magnitudeHigh: -2, magnitudeUnit: 'pct', confidence: 0.65 },
    ],
  },
  {
    id: 'mena_coercive_general',
    trigger: 'mena_coercive_high',
    corridorId: 'hormuz',
    affectedRegions: ['mena', 'east-asia', 'europe'],
    steps: [
      { start: 'MENA coercive pressure spikes', mechanism: 'broad regional risk-off', end: 'Brent +$5-12/bbl', severity: 'high', latencyHours: 12, assetClass: 'crude', magnitudeLow: 5, magnitudeHigh: 12, magnitudeUnit: 'usd_bbl', confidence: 0.75 },
    ],
  },
];

/**
 * Filter templates that should activate given the active triggers and region.
 *
 * @param {string} regionId
 * @param {import('../../shared/regions.types.js').TriggerLadder} triggers
 * @returns {import('../../shared/regions.types.js').TransmissionPath[]}
 */
export function resolveTransmissions(regionId, triggers) {
  const activeIds = new Set(triggers.active.map((t) => t.id));
  /** @type {import('../../shared/regions.types.js').TransmissionPath[]} */
  const out = [];
  for (const tpl of TRANSMISSION_TEMPLATES) {
    if (!activeIds.has(tpl.trigger)) continue;
    if (!tpl.affectedRegions.includes(regionId)) continue;
    for (const step of tpl.steps) {
      out.push({
        start: step.start,
        mechanism: step.mechanism,
        end: step.end,
        severity: step.severity,
        corridor_id: tpl.corridorId,
        confidence: step.confidence,
        latency_hours: step.latencyHours,
        impacted_asset_class: step.assetClass,
        impacted_regions: /** @type {import('../../shared/regions.types.js').RegionId[]} */ (tpl.affectedRegions),
        magnitude_low: step.magnitudeLow,
        magnitude_high: step.magnitudeHigh,
        magnitude_unit: step.magnitudeUnit,
        template_id: tpl.id,
        template_version: TEMPLATE_VERSION,
      });
    }
  }
  return out;
}
