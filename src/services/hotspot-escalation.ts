import type { Hotspot, EscalationTrend, MilitaryFlight, MilitaryVessel } from '@/types';
import { INTEL_HOTSPOTS } from '@/config/geo';
import { getHotspotCountries } from '@/config/countries';

export interface DynamicEscalationScore {
  hotspotId: string;
  staticBaseline: number;
  dynamicScore: number;
  combinedScore: number;
  trend: EscalationTrend;
  components: {
    newsActivity: number;
    ciiContribution: number;
    geoConvergence: number;
    militaryActivity: number;
  };
  history: { timestamp: number; score: number }[];
  lastUpdated: Date;
}

interface EscalationInputs {
  newsMatches: number;
  hasBreaking: boolean;
  newsVelocity: number;
  ciiScore: number | null;
  geoAlertScore: number;
  geoAlertTypes: number;
  flightsNearby: number;
  vesselsNearby: number;
}

const COMPONENT_WEIGHTS = {
  news: 0.35,
  cii: 0.25,
  geo: 0.25,
  military: 0.15,
};

const scores = new Map<string, DynamicEscalationScore>();
const lastSignalTime = new Map<string, number>();
const SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 48;

let ciiGetter: ((code: string) => number | null) | null = null;
let geoAlertGetter: ((lat: number, lon: number, radiusKm: number) => { score: number; types: number } | null) | null = null;

export function setCIIGetter(fn: (code: string) => number | null): void {
  ciiGetter = fn;
}

export function setGeoAlertGetter(fn: (lat: number, lon: number, radiusKm: number) => { score: number; types: number } | null): void {
  geoAlertGetter = fn;
}

function getStaticBaseline(hotspot: Hotspot): number {
  return hotspot.escalationScore ?? 3;
}

function getCIIForHotspot(hotspotId: string): number | null {
  if (!ciiGetter) return null;

  const countryCodes = getHotspotCountries(hotspotId);
  if (countryCodes.length === 0) return null;

  const scores = countryCodes.map(code => ciiGetter!(code)).filter((s): s is number => s !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

function getGeoAlertForHotspot(hotspot: Hotspot): { score: number; types: number } | null {
  if (!geoAlertGetter) return null;
  return geoAlertGetter(hotspot.lat, hotspot.lon, 150);
}

function normalizeNewsActivity(matches: number, hasBreaking: boolean, velocity: number): number {
  return Math.min(100, matches * 15 + (hasBreaking ? 30 : 0) + velocity * 5);
}

function normalizeCII(score: number | null): number {
  return score ?? 30;
}

function normalizeGeo(alertScore: number, alertTypes: number): number {
  if (alertScore === 0) return 0;
  return Math.min(100, alertScore + alertTypes * 10);
}

function normalizeMilitary(flights: number, vessels: number): number {
  return Math.min(100, flights * 10 + vessels * 15);
}

function calculateDynamicRaw(components: DynamicEscalationScore['components']): number {
  return (
    components.newsActivity * COMPONENT_WEIGHTS.news +
    components.ciiContribution * COMPONENT_WEIGHTS.cii +
    components.geoConvergence * COMPONENT_WEIGHTS.geo +
    components.militaryActivity * COMPONENT_WEIGHTS.military
  );
}

function rawToScore(raw: number): number {
  return 1 + (raw / 100) * 4;
}

function blendScores(staticBaseline: number, dynamicScore: number): number {
  return staticBaseline * 0.3 + dynamicScore * 0.7;
}

function pruneHistory(history: { timestamp: number; score: number }[]): { timestamp: number; score: number }[] {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const pruned = history.filter(h => h.timestamp >= cutoff);
  if (pruned.length > MAX_HISTORY_POINTS) {
    return pruned.slice(-MAX_HISTORY_POINTS);
  }
  return pruned;
}

function detectTrend(history: { timestamp: number; score: number }[]): EscalationTrend {
  if (history.length < 3) return 'stable';

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  let validCount = 0;

  for (const entry of history) {
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

export function calculateDynamicScore(
  hotspotId: string,
  inputs: EscalationInputs
): DynamicEscalationScore {
  const hotspot = INTEL_HOTSPOTS.find(h => h.id === hotspotId);
  if (!hotspot) {
    throw new Error(`Hotspot not found: ${hotspotId}`);
  }

  const staticBaseline = getStaticBaseline(hotspot);
  const existing = scores.get(hotspotId);
  const now = Date.now();

  const components = {
    newsActivity: normalizeNewsActivity(inputs.newsMatches, inputs.hasBreaking, inputs.newsVelocity),
    ciiContribution: normalizeCII(inputs.ciiScore),
    geoConvergence: normalizeGeo(inputs.geoAlertScore, inputs.geoAlertTypes),
    militaryActivity: normalizeMilitary(inputs.flightsNearby, inputs.vesselsNearby),
  };

  const dynamicRaw = calculateDynamicRaw(components);
  const dynamicScore = rawToScore(dynamicRaw);
  const combinedScore = blendScores(staticBaseline, dynamicScore);

  let history = existing?.history ?? [];
  history = pruneHistory(history);
  history.push({ timestamp: now, score: combinedScore });

  const trend = detectTrend(history);

  const result: DynamicEscalationScore = {
    hotspotId,
    staticBaseline,
    dynamicScore: Math.round(dynamicScore * 10) / 10,
    combinedScore: Math.round(combinedScore * 10) / 10,
    trend,
    components,
    history,
    lastUpdated: new Date(),
  };

  scores.set(hotspotId, result);
  return result;
}

export function getHotspotEscalation(hotspotId: string): DynamicEscalationScore | null {
  return scores.get(hotspotId) ?? null;
}

export function getAllEscalationScores(): DynamicEscalationScore[] {
  return [...scores.values()];
}

export interface EscalationSignalReason {
  type: 'threshold_crossed' | 'rapid_increase' | 'critical_reached';
  oldScore: number;
  newScore: number;
  threshold?: number;
}

export function shouldEmitSignal(hotspotId: string, oldScore: number | null, newScore: number): EscalationSignalReason | null {
  const lastSignal = lastSignalTime.get(hotspotId) ?? 0;
  if (Date.now() - lastSignal < SIGNAL_COOLDOWN_MS) return null;

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

export function markSignalEmitted(hotspotId: string): void {
  lastSignalTime.set(hotspotId, Date.now());
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function countMilitaryNearHotspot(
  hotspot: Hotspot,
  flights: MilitaryFlight[],
  vessels: MilitaryVessel[],
  radiusKm = 200
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

let militaryData: { flights: MilitaryFlight[]; vessels: MilitaryVessel[] } = { flights: [], vessels: [] };

export function setMilitaryData(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
  militaryData = { flights, vessels };
}

export function updateHotspotEscalation(
  hotspotId: string,
  newsMatches: number,
  hasBreaking: boolean,
  newsVelocity: number
): DynamicEscalationScore | null {
  const hotspot = INTEL_HOTSPOTS.find(h => h.id === hotspotId);
  if (!hotspot) return null;

  const ciiScore = getCIIForHotspot(hotspotId);
  const geoAlert = getGeoAlertForHotspot(hotspot);
  const military = countMilitaryNearHotspot(hotspot, militaryData.flights, militaryData.vessels);

  const inputs: EscalationInputs = {
    newsMatches,
    hasBreaking,
    newsVelocity,
    ciiScore,
    geoAlertScore: geoAlert?.score ?? 0,
    geoAlertTypes: geoAlert?.types ?? 0,
    flightsNearby: military.flights,
    vesselsNearby: military.vessels,
  };

  return calculateDynamicScore(hotspotId, inputs);
}

export function getEscalationChange24h(hotspotId: string): { change: number; start: number; end: number } | null {
  const score = scores.get(hotspotId);
  if (!score || score.history.length < 2) return null;

  const now = Date.now();
  const h24Ago = now - HISTORY_WINDOW_MS;

  const oldestInWindow = score.history.find(h => h.timestamp >= h24Ago);
  const newest = score.history[score.history.length - 1];

  if (!oldestInWindow || !newest) return null;

  return {
    change: Math.round((newest.score - oldestInWindow.score) * 10) / 10,
    start: Math.round(oldestInWindow.score * 10) / 10,
    end: Math.round(newest.score * 10) / 10,
  };
}

export function clearEscalationData(): void {
  scores.clear();
  lastSignalTime.clear();
}
