// @ts-check
// Evaluates structured trigger thresholds against current snapshot inputs.
// Each trigger maps to one of three states: active, watching, or dormant.

import { num } from './_helpers.mjs';
import { TRIGGER_DEFS } from './triggers.config.mjs';

/**
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @param {import('../../shared/regions.types.js').BalanceVector} balance
 * @returns {import('../../shared/regions.types.js').TriggerLadder}
 */
export function evaluateTriggers(regionId, sources, balance) {
  const active = [];
  const watching = [];
  const dormant = [];

  for (const def of TRIGGER_DEFS) {
    if (def.regionId !== regionId) continue;

    const metricValue = resolveMetric(def.threshold.metric, sources, balance, regionId);
    if (metricValue === null) {
      dormant.push(buildTrigger(def, false));
      continue;
    }

    const passes = evaluateThreshold(metricValue, def.threshold);
    if (passes === true) {
      active.push(buildTrigger(def, true));
    } else if (isCloseToThreshold(metricValue, def.threshold)) {
      watching.push(buildTrigger(def, false));
    } else {
      dormant.push(buildTrigger(def, false));
    }
  }

  return { active, watching, dormant };
}

function buildTrigger(def, activated) {
  return {
    id: def.id,
    description: def.description,
    threshold: def.threshold,
    activated,
    activated_at: activated ? Date.now() : 0,
    scenario_lane: def.scenario_lane,
    evidence_ids: [],
  };
}

/**
 * Resolve a metric reference like `chokepoint:hormuz:threat_level` against
 * the current snapshot inputs. Returns null if the metric is unavailable.
 */
function resolveMetric(metric, sources, balance, regionId) {
  // balance:{region}:{axis}
  if (metric.startsWith('balance:')) {
    const parts = metric.split(':');
    if (parts.length !== 3) return null;
    const [, mRegion, axis] = parts;
    if (mRegion !== regionId) return null;
    const v = balance[axis];
    return typeof v === 'number' ? v : null;
  }

  // chokepoint:{id}:{field}
  if (metric.startsWith('chokepoint:')) {
    const parts = metric.split(':');
    const [, cpId, field] = parts;
    const cps = sources['supply_chain:chokepoints:v4']?.chokepoints;
    const cp = Array.isArray(cps) ? cps.find((c) => c?.id === cpId) : null;
    if (!cp) return null;
    if (field === 'threat_level') {
      const map = { war_zone: 1.0, critical: 0.8, high: 0.6, elevated: 0.4, normal: 0.0 };
      return map[String(cp.threatLevel ?? 'normal').toLowerCase()] ?? 0;
    }
    if (field === 'transit_count') {
      const summaries = sources['supply_chain:transit-summaries:v1']?.summaries ?? {};
      return num(summaries[cpId]?.todayTotal, 0);
    }
    return null;
  }

  // cii:{iso2}:{field}
  if (metric.startsWith('cii:')) {
    const parts = metric.split(':');
    const [, iso] = parts;
    const cii = sources['risk:scores:sebuf:stale:v1']?.ciiScores;
    if (!Array.isArray(cii)) return null;
    const entry = cii.find((s) => s?.region === iso);
    return entry ? num(entry.combinedScore) : null;
  }

  // oref:active_alerts_count
  // Reads the canonical relay:oref:history:v1 key shape:
  //   { history, historyCount24h, totalHistoryCount, activeAlertCount, persistedAt }
  // Prefer activeAlertCount when present (live count), fall back to historyCount24h
  // (rolling 24h window) so the trigger still fires after the relay restarts.
  if (metric === 'oref:active_alerts_count') {
    const oref = sources['relay:oref:history:v1'];
    if (!oref || typeof oref !== 'object') return 0;
    if (typeof oref.activeAlertCount === 'number') return oref.activeAlertCount;
    if (typeof oref.historyCount24h === 'number') return oref.historyCount24h;
    return 0;
  }

  // theater:* metrics not yet implemented in Phase 0
  return null;
}

function evaluateThreshold(value, threshold) {
  switch (threshold.operator) {
    case 'gt':  return value >  threshold.value;
    case 'gte': return value >= threshold.value;
    case 'lt':  return value <  threshold.value;
    case 'lte': return value <= threshold.value;
    // delta_gt and delta_lt require historical snapshots. Phase 0 has no
    // history yet, so these operators are dormant by design. Phase 1
    // populates a baseline reader and re-enables them.
    case 'delta_gt': return false;
    case 'delta_lt': return false;
    default: return false;
  }
}

function isCloseToThreshold(value, threshold) {
  // 80% of the threshold counts as "watching"
  const target = threshold.value;
  if (target === 0) return false;
  const ratio = value / target;
  return ratio > 0.8 && ratio < 1.0;
}
