// @ts-check
// Trigger threshold configuration. Each trigger is a structured assertion
// against a metric, evaluated by trigger-evaluator.mjs.
//
// See docs/internal/pro-regional-intelligence-appendix-scoring.md
// "Trigger Threshold Examples" for the canonical table.

/** @type {Array<{
 *   id: string;
 *   description: string;
 *   regionId: string;
 *   scenario_lane: 'base' | 'escalation' | 'containment' | 'fragmentation';
 *   threshold: import('../../shared/regions.types.js').TriggerThreshold;
 * }>}
 */
export const TRIGGER_DEFS = [
  {
    id: 'hormuz_transit_drop',
    description: 'Hormuz transit count drops sharply vs 7d trailing avg',
    regionId: 'mena',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'chokepoint:hormuz:transit_count',
      operator: 'delta_lt',
      value: -0.20,
      window_minutes: 1440,
      baseline: 'trailing_7d',
    },
  },
  {
    id: 'iran_cii_spike',
    description: 'Iran CII jumps significantly vs 7d trailing avg',
    regionId: 'mena',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'cii:IR:combined_score',
      operator: 'delta_gt',
      value: 15,
      window_minutes: 720,
      baseline: 'trailing_7d',
    },
  },
  {
    id: 'red_sea_critical',
    description: 'Bab el-Mandeb threat level reaches critical',
    regionId: 'mena',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'chokepoint:babelm:threat_level',
      operator: 'gte',
      value: 0.8,
      window_minutes: 60,
      baseline: 'fixed',
    },
  },
  {
    id: 'mena_coercive_high',
    description: 'MENA coercive pressure breaches threshold',
    regionId: 'mena',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'balance:mena:coercive_pressure',
      operator: 'gte',
      value: 0.7,
      window_minutes: 360,
      baseline: 'fixed',
    },
  },
  {
    id: 'oref_cluster',
    description: 'OREF active alert cluster',
    regionId: 'mena',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'oref:active_alerts_count',
      operator: 'gt',
      value: 10,
      window_minutes: 60,
      baseline: 'fixed',
    },
  },
  {
    id: 'taiwan_tension_high',
    description: 'Taiwan Strait threat level elevated',
    regionId: 'east-asia',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'chokepoint:taiwan_strait:threat_level',
      operator: 'gte',
      value: 0.6,
      window_minutes: 120,
      baseline: 'fixed',
    },
  },
  {
    id: 'russia_naval_buildup',
    description: 'Russian fleet concentration in Eastern Europe theater',
    regionId: 'europe',
    scenario_lane: 'escalation',
    threshold: {
      metric: 'theater:eastern_europe:russia_vessel_count',
      operator: 'delta_gt',
      value: 5,
      window_minutes: 1440,
      baseline: 'trailing_30d',
    },
  },
  {
    id: 'european_capital_stress',
    description: 'European capital stress axis breaches threshold',
    regionId: 'europe',
    scenario_lane: 'fragmentation',
    threshold: {
      metric: 'balance:europe:capital_stress',
      operator: 'gte',
      value: 0.7,
      window_minutes: 360,
      baseline: 'fixed',
    },
  },
];
