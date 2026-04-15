// @ts-check
// Builds scenario sets per horizon, normalized so lane probabilities sum to 1.0.
// See docs/internal/pro-regional-intelligence-appendix-scoring.md
// "Scenario Set Normalization".

import { num } from './_helpers.mjs';
// Use scripts/shared mirror (not repo-root shared/): Railway service has
// rootDirectory=scripts so ../../shared/ escapes the deploy root.
import { REGIONS } from '../shared/geography.js';

/** @type {import('../../shared/regions.types.js').ScenarioHorizon[]} */
const HORIZONS = ['24h', '7d', '30d'];
/** @type {import('../../shared/regions.types.js').ScenarioName[]} */
const LANE_NAMES = ['base', 'escalation', 'containment', 'fragmentation'];

/**
 * @param {string} regionId
 * @param {Record<string, any>} sources
 * @param {import('../../shared/regions.types.js').TriggerLadder} triggers
 * @returns {import('../../shared/regions.types.js').ScenarioSet[]}
 */
export function buildScenarioSets(regionId, sources, triggers) {
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) return [];

  const fc = sources['forecast:predictions:v2'];
  const forecasts = Array.isArray(fc?.predictions) ? fc.predictions : [];
  const inRegion = forecasts.filter((f) => {
    const fRegion = String(f?.region ?? '').toLowerCase();
    return fRegion.includes(region.forecastLabel.toLowerCase());
  });

  return HORIZONS.map((horizon) => {
    const lanes = LANE_NAMES.map((name) => buildLane(name, horizon, inRegion, triggers));
    return { horizon, lanes: normalize(lanes) };
  });
}

function buildLane(name, horizon, forecasts, triggers) {
  // Raw score sources:
  //   1. Forecasts whose trend matches the lane direction in this horizon
  //   2. Active trigger count for this lane (each adds 0.1 boost)
  //   3. Default base case score for stability
  let rawScore = name === 'base' ? 0.4 : 0.1;

  for (const f of forecasts) {
    const fHorizon = String(f?.timeHorizon ?? '').toLowerCase();
    if (!matchesHorizon(fHorizon, horizon)) continue;
    const trend = String(f?.trend ?? '').toLowerCase();
    const prob = num(f?.probability, 0);
    if (name === 'escalation' && (trend === 'rising' || trend === 'escalating')) rawScore += prob * 0.5;
    if (name === 'containment' && (trend === 'falling' || trend === 'de-escalating')) rawScore += prob * 0.5;
    if (name === 'base' && trend === 'stable') rawScore += prob * 0.3;
    if (name === 'fragmentation') {
      const cf = JSON.stringify(f?.caseFile ?? {}).toLowerCase();
      if (/fragment|collapse|breakdown/.test(cf)) rawScore += prob * 0.4;
    }
  }

  const activeForLane = triggers.active.filter((t) => t.scenario_lane === name).length;
  rawScore += activeForLane * 0.1;

  const triggerIds = [
    ...triggers.active.filter((t) => t.scenario_lane === name).map((t) => t.id),
    ...triggers.watching.filter((t) => t.scenario_lane === name).map((t) => t.id),
  ];

  return {
    name,
    probability: Math.max(0, rawScore),
    trigger_ids: triggerIds,
    consequences: [],
    transmissions: [],
  };
}

function matchesHorizon(forecastHorizon, targetHorizon) {
  if (!forecastHorizon) return targetHorizon === '7d';
  if (targetHorizon === '24h') return /h24|24h|day|24h/.test(forecastHorizon);
  if (targetHorizon === '7d') return /d7|7d|week|d7/.test(forecastHorizon);
  if (targetHorizon === '30d') return /d30|30d|month|d30/.test(forecastHorizon);
  return false;
}

function normalize(lanes) {
  const total = lanes.reduce((sum, l) => sum + l.probability, 0);
  if (total === 0) {
    return lanes.map((l) => ({ ...l, probability: l.name === 'base' ? 1.0 : 0.0 }));
  }
  return lanes.map((l) => ({ ...l, probability: round(l.probability / total) }));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
