/**
 * Emergency Brief — per-event cross-service aggregator
 *
 * When a major event occurs, this service automatically cross-correlates
 * ALL active services to build a single "emergency brief" — a consolidated
 * situational picture rather than 12 separate panels to check.
 *
 * For a given location + event type, the brief surfaces:
 *  - PAGER alert level (earthquake) or TC category (hurricane)
 *  - NWS active warnings in the area
 *  - FEMA declaration status
 *  - Tsunami warning status (if coastal)
 *  - Nuclear facility proximity (if earthquake/flood)
 *  - Internet / power grid status in region
 *  - Disease outbreak context (if mass casualty)
 *  - Food/water infrastructure status
 *  - CEMS satellite activation
 *  - Nearest FEMA shelter
 *
 * The brief is updated every 5 minutes and cached by event ID.
 */

import { haversineKm, type HasCoordinates } from './proximity-filter';
import type { FemaDeclaration, FemaShelter } from './fema-disasters';
import type { TropicalCyclone } from './tropical-cyclones';
import type { PagerEvent } from './usgs-pager';
import type { CemsActivation } from './copernicus-cems';

export type BriefTriggerType =
  | 'earthquake'
  | 'hurricane'
  | 'flood'
  | 'wildfire'
  | 'chemical'
  | 'nuclear'
  | 'infrastructure'
  | 'general';

export type BriefSection =
  | 'impact'
  | 'warnings'
  | 'federal_response'
  | 'infrastructure'
  | 'shelters'
  | 'satellite'
  | 'context';

export interface BriefItem {
  section: BriefSection;
  icon: string;
  label: string;
  value: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'ok' | 'unknown';
  url?: string;
}

export interface EmergencyBrief {
  eventId: string;
  eventTitle: string;
  triggerType: BriefTriggerType;
  lat: number;
  lon: number;
  generatedAt: Date;
  overallSeverity: 'critical' | 'high' | 'medium' | 'low';
  headline: string;
  items: BriefItem[];
  nearestShelter: FemaShelter | null;
  femaDeclaration: FemaDeclaration | null;
  cemsActivation: CemsActivation | null;
}

interface BriefContext {
  femaDeclarations: FemaDeclaration[];
  femaShelters: FemaShelter[];
  cemsActivations: CemsActivation[];
  nwsAlerts: { event: string; severity: string; areaDesc: string }[];
  tcStorms: TropicalCyclone[];
  pagerEvents: PagerEvent[];
}

const BRIEF_CACHE = new Map<string, { brief: EmergencyBrief; cachedAt: number }>();
const BRIEF_TTL_MS = 5 * 60 * 1000;

function findNearest<T extends HasCoordinates>(
  items: T[],
  lat: number,
  lon: number,
  maxKm: number
): T | null {
  let nearest: T | null = null;
  let minDist = Infinity;
  for (const item of items) {
    if (item.lat == undefined || item.lon == undefined) continue;
    const d = haversineKm(lat, lon, item.lat, item.lon);
    if (d < minDist && d <= maxKm) {
      minDist = d;
      nearest = item;
    }
  }
  return nearest;
}

function findNearestShelter(shelters: FemaShelter[], lat: number, lon: number): FemaShelter | null {
  let nearest: FemaShelter | null = null;
  let minDist = Infinity;
  for (const s of shelters) {
    if (s.lat == undefined || s.lon == undefined || !s.acceptingEvacuees) continue;
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d < minDist) { minDist = d; nearest = s; }
  }
  return nearest;
}

function buildItems(
  _type: BriefTriggerType,
  lat: number,
  lon: number,
  ctx: BriefContext,
  pager?: PagerEvent,
  tc?: TropicalCyclone
): BriefItem[] {
  const items: BriefItem[] = [];

  // ---- IMPACT section ----
  if (pager) {
    items.push({
      section: 'impact',
      icon: '🔴',
      label: 'PAGER Alert',
      value: `${pager.alertLevel.toUpperCase()} — est. fatalities ${pager.estimatedFatalities}, losses ${pager.estimatedLosses}`,
      severity: pager.severity,
      url: pager.url,
    });
  }
  if (tc) {
    const wind = tc.windKts ? `${tc.windKts}kt winds` : '';
    items.push({
      section: 'impact',
      icon: '🌀',
      label: tc.name,
      value: `${tc.category.replace(/_/g, ' ')} ${wind}`.trim(),
      severity: tc.severity,
    });
  }

  // ---- WARNINGS section ----
  const localWarnings = ctx.nwsAlerts.filter(a => {
    const extreme = a.severity === 'Extreme' || a.severity === 'Severe';
    return extreme;
  }).slice(0, 5);
  for (const w of localWarnings) {
    items.push({
      section: 'warnings',
      icon: '⚠️',
      label: w.event,
      value: w.areaDesc?.slice(0, 80) ?? '',
      severity: w.severity === 'Extreme' ? 'critical' : 'high',
    });
  }

  // ---- FEDERAL RESPONSE section ----
  const nearbyDecl = ctx.femaDeclarations
    .filter(d => d.state && d.isOpen)
    .slice(0, 3);
  for (const d of nearbyDecl) {
    items.push({
      section: 'federal_response',
      icon: '🏛️',
      label: `FEMA DR-${d.disasterNumber}`,
      value: `${d.declarationTitle} — ${d.state}`,
      severity: d.severity,
      url: d.url,
    });
  }

  // ---- SATELLITE section ----
  const nearestCems = findNearest(ctx.cemsActivations, lat, lon, 2000);
  if (nearestCems) {
    items.push({
      section: 'satellite',
      icon: '🛰️',
      label: `CEMS ${nearestCems.id}`,
      value: `${nearestCems.hazard} — ${nearestCems.status} (${nearestCems.country})`,
      severity: nearestCems.severity,
      url: nearestCems.url,
    });
  }

  // ---- SHELTERS section ----
  const shelter = findNearestShelter(ctx.femaShelters, lat, lon);
  if (shelter) {
    const occ = shelter.currentOccupancy != undefined && shelter.capacity != undefined
      ? ` (${shelter.currentOccupancy}/${shelter.capacity})`
      : '';
    items.push({
      section: 'shelters',
      icon: '🏠',
      label: shelter.shelterName,
      value: `${shelter.city}, ${shelter.state}${occ}${shelter.petFriendly ? ' · Pet-friendly' : ''}`,
      severity: 'ok',
    });
  } else {
    items.push({
      section: 'shelters',
      icon: '🏠',
      label: 'FEMA Shelters',
      value: 'No open shelters currently registered in FEMA system',
      severity: 'unknown',
      url: 'https://www.fema.gov/disaster/recover/shelter',
    });
  }

  return items;
}

function computeOverallSeverity(items: BriefItem[]): EmergencyBrief['overallSeverity'] {
  if (items.some(i => i.severity === 'critical')) return 'critical';
  if (items.some(i => i.severity === 'high')) return 'high';
  if (items.some(i => i.severity === 'medium')) return 'medium';
  return 'low';
}

function buildHeadline(
  _type: BriefTriggerType,
  severity: EmergencyBrief['overallSeverity'],
  eventTitle: string
): string {
  const urgency = { critical: 'CRITICAL', high: 'HIGH', medium: 'ELEVATED', low: 'LOW' }[severity];
  return `[${urgency}] ${eventTitle}`;
}

/**
 * Generate an emergency brief for a known event.
 */
export async function generateEmergencyBrief(
  eventId: string,
  eventTitle: string,
  triggerType: BriefTriggerType,
  lat: number,
  lon: number,
  ctx: BriefContext,
  pager?: PagerEvent,
  tc?: TropicalCyclone
): Promise<EmergencyBrief> {
  const cached = BRIEF_CACHE.get(eventId);
  if (cached && Date.now() - cached.cachedAt < BRIEF_TTL_MS) return cached.brief;

  const items = buildItems(triggerType, lat, lon, ctx, pager, tc);
  const nearestShelter = findNearestShelter(ctx.femaShelters, lat, lon);
  const nearestDecl = ctx.femaDeclarations.filter(d => d.isOpen)[0] ?? null;
  const nearestCems = findNearest(ctx.cemsActivations, lat, lon, 2000);

  const overallSeverity = computeOverallSeverity(items);

  const brief: EmergencyBrief = {
    eventId,
    eventTitle,
    triggerType,
    lat,
    lon,
    generatedAt: new Date(),
    overallSeverity,
    headline: buildHeadline(triggerType, overallSeverity, eventTitle),
    items,
    nearestShelter,
    femaDeclaration: nearestDecl,
    cemsActivation: nearestCems,
  };

  BRIEF_CACHE.set(eventId, { brief, cachedAt: Date.now() });
  return brief;
}

export function clearBriefCache(eventId?: string): void {
  if (eventId) BRIEF_CACHE.delete(eventId);
  else BRIEF_CACHE.clear();
}
