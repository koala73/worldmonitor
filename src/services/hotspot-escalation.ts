import type { Hotspot, MilitaryFlight, MilitaryVessel } from '@/types';
import {
  computeEscalationChange,
  computeEscalationScore,
  countMilitaryNearHotspot as countMilitaryNearPoint,
  evaluateEscalationSignal,
  findHotspotById,
} from '../../shared/analysis-hotspot-escalation';
import { getHotspotCountryScore } from '../../shared/hotspot-country-map';
import type {
  DynamicEscalationScore,
  EscalationInputs,
  EscalationSignalReason,
} from '../../shared/analysis-hotspot-escalation';

// Scoring math lives in shared/analysis-hotspot-escalation.ts so server-side
// (Edge/MCP) callers can compute the same scores. This module owns the browser
// wiring: the live data getters and the in-memory score/history store.
export type { DynamicEscalationScore, EscalationSignalReason };

const scores = new Map<string, DynamicEscalationScore>();
const lastSignalTime = new Map<string, number>();

let ciiGetter: ((code: string) => number | null) | null = null;
let geoAlertGetter: ((lat: number, lon: number, radiusKm: number) => { score: number; types: number } | null) | null = null;

export function setCIIGetter(fn: (code: string) => number | null): void {
  ciiGetter = fn;
}

export function setGeoAlertGetter(fn: (lat: number, lon: number, radiusKm: number) => { score: number; types: number } | null): void {
  geoAlertGetter = fn;
}

function getCIIForHotspot(hotspotId: string): number | null {
  return ciiGetter ? getHotspotCountryScore(hotspotId, ciiGetter) : null;
}

function getGeoAlertForHotspot(hotspot: Hotspot): { score: number; types: number } | null {
  if (!geoAlertGetter) return null;
  return geoAlertGetter(hotspot.lat, hotspot.lon, 150);
}

export function calculateDynamicScore(
  hotspotId: string,
  inputs: EscalationInputs
): DynamicEscalationScore {
  const hotspot = findHotspotById(hotspotId);
  if (!hotspot) {
    throw new Error(`Hotspot not found: ${hotspotId}`);
  }

  const result = computeEscalationScore(hotspot, inputs, {
    now: Date.now(),
    previousHistory: scores.get(hotspotId)?.history,
  });

  scores.set(hotspotId, result);
  return result;
}

export function getHotspotEscalation(hotspotId: string): DynamicEscalationScore | null {
  return scores.get(hotspotId) ?? null;
}

export function getAllEscalationScores(): DynamicEscalationScore[] {
  return Array.from(scores.values());
}

export function shouldEmitSignal(hotspotId: string, oldScore: number | null, newScore: number): EscalationSignalReason | null {
  return evaluateEscalationSignal({
    oldScore,
    newScore,
    lastSignalAt: lastSignalTime.get(hotspotId) ?? 0,
    now: Date.now(),
  });
}

export function markSignalEmitted(hotspotId: string): void {
  lastSignalTime.set(hotspotId, Date.now());
}

export function countMilitaryNearHotspot(
  hotspot: Hotspot,
  flights: MilitaryFlight[],
  vessels: MilitaryVessel[],
  radiusKm: number = 200
): { flights: number; vessels: number } {
  return countMilitaryNearPoint(hotspot, flights, vessels, radiusKm);
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
  const hotspot = findHotspotById(hotspotId);
  if (!hotspot) return null;

  const ciiScore = getCIIForHotspot(hotspotId);
  const geoAlert = getGeoAlertForHotspot(hotspot);
  const military = countMilitaryNearPoint(hotspot, militaryData.flights, militaryData.vessels);

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
  if (!score) return null;

  return computeEscalationChange(score.history, Date.now());
}

export function clearEscalationData(): void {
  scores.clear();
  lastSignalTime.clear();
}
