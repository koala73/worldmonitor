/**
 * Hotspot escalation scoring core.
 *
 * Pure, dependency-free computation shared by the browser dashboard
 * (src/services/hotspot-escalation.ts) and server-side (Edge/MCP) callers.
 * Every function here is a total function of its arguments: no module state,
 * no ambient clock — callers inject `now`.
 *
 * Scoring shape: the four components are each normalized to 0-100, weighted
 * into a raw 0-100 composite, mapped onto the published 1-5 escalation scale,
 * then blended 30/70 with the hotspot's curated static baseline.
 */

import { INTEL_HOTSPOTS } from './geo-data';
import type { Hotspot, EscalationTrend } from './geo-data';
import { haversineKm } from './geo-distance';

export type { Hotspot, EscalationTrend } from './geo-data';
export { haversineKm } from './geo-distance';

export const COMPONENT_WEIGHTS = {
  news: 0.35,
  cii: 0.25,
  geo: 0.25,
  military: 0.15,
};

export const SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_HISTORY_POINTS = 48;

export interface EscalationComponents {
  newsActivity: number;
  ciiContribution: number;
  geoConvergence: number;
  militaryActivity: number;
}

export interface EscalationInputs {
  newsMatches: number;
  hasBreaking: boolean;
  newsVelocity: number;
  ciiScore: number | null;
  geoAlertScore: number;
  geoAlertTypes: number;
  flightsNearby: number;
  vesselsNearby: number;
}

export interface EscalationHistoryPoint {
  timestamp: number;
  score: number;
}

export interface DynamicEscalationScore {
  hotspotId: string;
  staticBaseline: number;
  dynamicScore: number;
  combinedScore: number;
  trend: EscalationTrend;
  components: EscalationComponents;
  history: EscalationHistoryPoint[];
  lastUpdated: Date;
}

export interface EscalationSignalReason {
  type: 'threshold_crossed' | 'rapid_increase' | 'critical_reached';
  oldScore: number;
  newScore: number;
  threshold?: number;
}

/** Minimum shape needed to score a hotspot — anything positioned with a baseline. */
export interface ScorableHotspot {
  id: string;
  lat: number;
  lon: number;
  escalationScore?: number;
}

/** Minimum shape needed for proximity counting. */
export interface GeoPoint {
  lat: number;
  lon: number;
}

export function getStaticBaseline(hotspot: { escalationScore?: number }): number {
  return hotspot.escalationScore ?? 3;
}

export function normalizeNewsActivity(matches: number, hasBreaking: boolean, velocity: number): number {
  return Math.min(100, matches * 15 + (hasBreaking ? 30 : 0) + velocity * 5);
}

export function normalizeCII(score: number | null): number {
  return score ?? 30;
}

export function normalizeGeo(alertScore: number, alertTypes: number): number {
  if (alertScore === 0) return 0;
  return Math.min(100, alertScore + alertTypes * 10);
}

export function normalizeMilitary(flights: number, vessels: number): number {
  return Math.min(100, flights * 10 + vessels * 15);
}

export function computeComponents(inputs: EscalationInputs): EscalationComponents {
  return {
    newsActivity: normalizeNewsActivity(inputs.newsMatches, inputs.hasBreaking, inputs.newsVelocity),
    ciiContribution: normalizeCII(inputs.ciiScore),
    geoConvergence: normalizeGeo(inputs.geoAlertScore, inputs.geoAlertTypes),
    militaryActivity: normalizeMilitary(inputs.flightsNearby, inputs.vesselsNearby),
  };
}

export function calculateDynamicRaw(components: EscalationComponents): number {
  return (
    components.newsActivity * COMPONENT_WEIGHTS.news +
    components.ciiContribution * COMPONENT_WEIGHTS.cii +
    components.geoConvergence * COMPONENT_WEIGHTS.geo +
    components.militaryActivity * COMPONENT_WEIGHTS.military
  );
}

export function rawToScore(raw: number): number {
  return 1 + (raw / 100) * 4;
}

export function blendScores(staticBaseline: number, dynamicScore: number): number {
  return staticBaseline * 0.3 + dynamicScore * 0.7;
}

export function pruneHistory(history: EscalationHistoryPoint[], now: number): EscalationHistoryPoint[] {
  const cutoff = now - HISTORY_WINDOW_MS;
  const pruned = history.filter(h => h.timestamp >= cutoff);
  if (pruned.length > MAX_HISTORY_POINTS) {
    return pruned.slice(-MAX_HISTORY_POINTS);
  }
  return pruned;
}

export function detectTrend(history: EscalationHistoryPoint[]): EscalationTrend {
  if (history.length < 3) return 'stable';

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  let validCount = 0;

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry) continue;
    sumX += validCount;
    sumY += entry.score;
    sumXY += validCount * entry.score;
    sumX2 += validCount * validCount;
    validCount++;
  }

  if (validCount < 3) return 'stable';

  const denominator = validCount * sumX2 - sumX * sumX;
  if (denominator === 0) return 'stable';

  const slope = (validCount * sumXY - sumX * sumY) / denominator;

  if (slope > 0.1) return 'escalating';
  if (slope < -0.1) return 'de-escalating';
  return 'stable';
}

export interface ComputeEscalationOptions {
  /** Timestamp for this observation. Injected so scoring is deterministic. */
  now: number;
  /** Prior history for this hotspot, if any. Never mutated. */
  previousHistory?: EscalationHistoryPoint[];
}

export function computeEscalationScore(
  hotspot: ScorableHotspot,
  inputs: EscalationInputs,
  options: ComputeEscalationOptions,
): DynamicEscalationScore {
  const { now, previousHistory } = options;

  const staticBaseline = getStaticBaseline(hotspot);
  const components = computeComponents(inputs);

  const dynamicRaw = calculateDynamicRaw(components);
  const dynamicScore = rawToScore(dynamicRaw);
  const combinedScore = blendScores(staticBaseline, dynamicScore);

  const history = pruneHistory(previousHistory ?? [], now);
  history.push({ timestamp: now, score: combinedScore });

  return {
    hotspotId: hotspot.id,
    staticBaseline,
    dynamicScore: Math.round(dynamicScore * 10) / 10,
    combinedScore: Math.round(combinedScore * 10) / 10,
    trend: detectTrend(history),
    components,
    history,
    lastUpdated: new Date(now),
  };
}

export interface EvaluateSignalOptions {
  oldScore: number | null;
  newScore: number;
  /** When a signal was last emitted for this hotspot; 0 when never. */
  lastSignalAt: number;
  now: number;
}

export function evaluateEscalationSignal(options: EvaluateSignalOptions): EscalationSignalReason | null {
  const { oldScore, newScore, lastSignalAt, now } = options;

  if (now - lastSignalAt < SIGNAL_COOLDOWN_MS) return null;

  if (oldScore === null) return null;

  const oldInt = Math.floor(oldScore);
  const newInt = Math.floor(newScore);
  if (newInt > oldInt && newScore >= 2) {
    return { type: 'threshold_crossed', oldScore, newScore, threshold: newInt };
  }

  if (newScore - oldScore >= 0.5) {
    return { type: 'rapid_increase', oldScore, newScore };
  }

  if (newScore >= 4.5 && oldScore < 4.5) {
    return { type: 'critical_reached', oldScore, newScore };
  }

  return null;
}

export function computeEscalationChange(
  history: EscalationHistoryPoint[],
  now: number,
): { change: number; start: number; end: number } | null {
  if (history.length < 2) return null;

  const h24Ago = now - HISTORY_WINDOW_MS;

  const oldestInWindow = history.find(h => h.timestamp >= h24Ago);
  const newest = history[history.length - 1];

  if (!oldestInWindow || !newest) return null;

  return {
    change: Math.round((newest.score - oldestInWindow.score) * 10) / 10,
    start: Math.round(oldestInWindow.score * 10) / 10,
    end: Math.round(newest.score * 10) / 10,
  };
}

export function countMilitaryNearHotspot(
  hotspot: GeoPoint,
  flights: GeoPoint[],
  vessels: GeoPoint[],
  radiusKm: number = 200,
): { flights: number; vessels: number } {
  let flightCount = 0;
  let vesselCount = 0;

  for (const f of flights) {
    if (haversineKm(hotspot.lat, hotspot.lon, f.lat, f.lon) <= radiusKm) {
      flightCount++;
    }
  }

  for (const v of vessels) {
    if (haversineKm(hotspot.lat, hotspot.lon, v.lat, v.lon) <= radiusKm) {
      vesselCount++;
    }
  }

  return { flights: flightCount, vessels: vesselCount };
}

/** Look up a curated hotspot by id. */
export function findHotspotById(hotspotId: string): Hotspot | undefined {
  return INTEL_HOTSPOTS.find(h => h.id === hotspotId);
}
