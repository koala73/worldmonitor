import type { MilitaryFlight, MilitaryOperator } from '@/types';
import type { SignalType } from '@/utils/analysis-constants';
import { MILITARY_BASES_EXPANDED } from '@/config/bases-expanded';
import { focalPointDetector } from './focal-point-detector';

// Foreign military concentration detection - immediate alerts, no baseline needed
interface GeoRegion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
}

interface OperatorHomeRegions {
  operator: MilitaryOperator;
  country: string;
  homeRegions: string[]; // region IDs where this operator's presence is "normal"
  alertThreshold: number; // minimum aircraft to trigger alert when outside home
}

// Sensitive regions where foreign military concentration is notable
const SENSITIVE_REGIONS: GeoRegion[] = [
  // Middle East / Iran area
  { id: 'persian-gulf', name: 'Persian Gulf', lat: 26.5, lon: 52.0, radiusKm: 600 },
  { id: 'strait-hormuz', name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radiusKm: 300 },
  { id: 'iran-border', name: 'Iran Border Region', lat: 33.0, lon: 47.0, radiusKm: 400 },
  // Eastern Europe / Russia borders
  { id: 'baltics', name: 'Baltic Region', lat: 56.0, lon: 24.0, radiusKm: 400 },
  { id: 'poland-border', name: 'Poland-Belarus Border', lat: 52.5, lon: 23.5, radiusKm: 300 },
  { id: 'black-sea', name: 'Black Sea', lat: 43.5, lon: 34.0, radiusKm: 500 },
  { id: 'kaliningrad', name: 'Kaliningrad Region', lat: 54.7, lon: 20.5, radiusKm: 250 },
  // Asia-Pacific
  { id: 'taiwan-strait', name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radiusKm: 400 },
  { id: 'south-china-sea', name: 'South China Sea', lat: 14.0, lon: 114.0, radiusKm: 800 },
  { id: 'korean-dmz', name: 'Korean DMZ', lat: 38.0, lon: 127.0, radiusKm: 300 },
  { id: 'japan-sea', name: 'Sea of Japan', lat: 40.0, lon: 135.0, radiusKm: 500 },
  // Arctic / Alaska
  { id: 'alaska-adiz', name: 'Alaska ADIZ', lat: 62.0, lon: -165.0, radiusKm: 600 },
  { id: 'arctic-russia', name: 'Arctic (Russian Side)', lat: 72.0, lon: 70.0, radiusKm: 800 },
  // Mediterranean / Libya
  { id: 'east-med', name: 'Eastern Mediterranean', lat: 34.5, lon: 33.0, radiusKm: 500 },
  { id: 'libya-coast', name: 'Libya Coast', lat: 32.5, lon: 15.0, radiusKm: 400 },
  // Africa
  { id: 'horn-africa', name: 'Horn of Africa', lat: 10.0, lon: 45.0, radiusKm: 600 },
  { id: 'sahel', name: 'Sahel Region', lat: 15.0, lon: 5.0, radiusKm: 800 },
  // South America
  { id: 'venezuela', name: 'Venezuela', lat: 8.0, lon: -66.0, radiusKm: 500 },
];

// Define home regions for major military operators
const OPERATOR_HOMES: OperatorHomeRegions[] = [
  { operator: 'usaf', country: 'USA', homeRegions: ['alaska-adiz'], alertThreshold: 2 },
  { operator: 'usn', country: 'USA', homeRegions: ['alaska-adiz'], alertThreshold: 2 },
  { operator: 'usmc', country: 'USA', homeRegions: ['alaska-adiz'], alertThreshold: 2 },
  { operator: 'usa', country: 'USA', homeRegions: ['alaska-adiz'], alertThreshold: 2 },
  { operator: 'vks', country: 'Russia', homeRegions: ['kaliningrad', 'arctic-russia', 'black-sea'], alertThreshold: 2 },
  { operator: 'plaaf', country: 'China', homeRegions: ['taiwan-strait', 'south-china-sea'], alertThreshold: 2 },
  { operator: 'plan', country: 'China', homeRegions: ['taiwan-strait', 'south-china-sea'], alertThreshold: 2 },
  { operator: 'iaf', country: 'Israel', homeRegions: ['east-med', 'iran-border'], alertThreshold: 2 },
  { operator: 'raf', country: 'UK', homeRegions: ['baltics', 'black-sea'], alertThreshold: 3 },
  { operator: 'faf', country: 'France', homeRegions: ['sahel', 'east-med', 'libya-coast'], alertThreshold: 3 },
  { operator: 'gaf', country: 'Germany', homeRegions: ['baltics'], alertThreshold: 3 },
];

export interface ForeignPresenceAlert {
  id: string;
  operator: MilitaryOperator;
  operatorCountry: string;
  region: GeoRegion;
  aircraftCount: number;
  flights: MilitaryFlight[];
  firstDetected: Date;
}

const activeForeignPresence = new Map<string, ForeignPresenceAlert>();
const seenForeignAlerts = new Set<string>();

export interface MilitaryTheater {
  id: string;
  name: string;
  baseIds: string[];
  centerLat: number;
  centerLon: number;
}

export interface SurgeAlert {
  id: string;
  theater: MilitaryTheater;
  type: 'airlift' | 'fighter' | 'reconnaissance';
  currentCount: number;
  baselineCount: number;
  surgeMultiple: number;
  aircraftTypes: Map<string, number>;
  nearbyBases: string[];
  firstDetected: Date;
  lastUpdated: Date;
}

export interface TheaterActivity {
  theaterId: string;
  timestamp: number;
  transportCount: number;
  fighterCount: number;
  reconCount: number;
  totalMilitary: number;
  flightIds: string[];
}

const THEATERS: MilitaryTheater[] = [
  {
    id: 'middle-east',
    name: 'Middle East / Persian Gulf',
    baseIds: ['al_udeid', 'ali_al_salem_air_base', 'camp_arifjan', 'camp_buehring', 'kuwait_naval_base',
              'naval_support_activity_bahrain', 'isa_air_base', 'masirah_aira_base', 'rafo_thumrait',
              'al_dhafra_air_base', 'port_of_jebel_ali', 'fujairah_naval_base', 'prince_sultan_air_base',
              'ain_assad_air_base', 'camp_victory', 'naval_support_facility_diego_garcia'],
    centerLat: 27.0,
    centerLon: 50.0,
  },
  {
    id: 'europe-east',
    name: 'Eastern Europe',
    baseIds: ['camp_bondsteel', 'aitos_logistics_center', 'bezmer', 'graf_ignatievo'],
    centerLat: 45.0,
    centerLon: 25.0,
  },
  {
    id: 'europe-west',
    name: 'Western Europe',
    baseIds: ['ramstein', 'spangdahlem', 'usag_stuttgart', 'raf_lakenheath', 'raf_mildenhall', 'aviano'],
    centerLat: 50.0,
    centerLon: 8.0,
  },
  {
    id: 'pacific-west',
    name: 'Western Pacific',
    baseIds: ['kadena_air_base', 'camp_fuji', 'fleet_activities_okinawa', 'yokota', 'misawsa',
              'osan_air_base', 'kunsan_ab', 'us_army_garrison_humphreys', 'andersen_air_force_base'],
    centerLat: 30.0,
    centerLon: 130.0,
  },
  {
    id: 'africa-horn',
    name: 'Horn of Africa',
    baseIds: ['camp_lemonnier', 'contingency_location_garoua', 'niger_air_base_201'],
    centerLat: 10.0,
    centerLon: 40.0,
  },
];

const SURGE_THRESHOLD = 2.0;
const BASELINE_WINDOW_HOURS = 48;
const BASELINE_MIN_SAMPLES = 6;
const TRANSPORT_CALLSIGN_PATTERNS = [
  /^RCH/i, /^REACH/i, /^MOOSE/i, /^HERKY/i, /^EVAC/i, /^DUSTOFF/i,
];
const PROXIMITY_RADIUS_KM = 150;

const activityHistory = new Map<string, TheaterActivity[]>();
const activeSurges = new Map<string, SurgeAlert>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const MAX_HISTORY_HOURS = 72;

function getTheaterForBase(baseId: string): MilitaryTheater | null {
  for (const theater of THEATERS) {
    if (theater.baseIds.includes(baseId)) {
      return theater;
    }
  }
  return null;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearbyBases(lat: number, lon: number): { baseId: string; baseName: string; distance: number }[] {
  const nearby: { baseId: string; baseName: string; distance: number }[] = [];
  for (const base of MILITARY_BASES_EXPANDED) {
    const dist = distanceKm(lat, lon, base.lat, base.lon);
    if (dist <= PROXIMITY_RADIUS_KM) {
      nearby.push({ baseId: base.id, baseName: base.name, distance: dist });
    }
  }
  return nearby.sort((a, b) => a.distance - b.distance);
}

function isTransportFlight(flight: MilitaryFlight): boolean {
  if (flight.aircraftType === 'transport' || flight.aircraftType === 'tanker') {
    return true;
  }
  const callsign = flight.callsign.toUpperCase();
  return TRANSPORT_CALLSIGN_PATTERNS.some(p => p.test(callsign));
}

function classifyFlight(flight: MilitaryFlight): 'transport' | 'fighter' | 'recon' | 'other' {
  if (isTransportFlight(flight)) return 'transport';
  if (flight.aircraftType === 'fighter') return 'fighter';
  if (flight.aircraftType === 'reconnaissance' || flight.aircraftType === 'awacs') return 'recon';
  return 'other';
}

function getTheaterForFlight(flight: MilitaryFlight): MilitaryTheater | null {
  const nearbyBases = findNearbyBases(flight.lat, flight.lon);
  for (const { baseId } of nearbyBases) {
    const theater = getTheaterForBase(baseId);
    if (theater) return theater;
  }
  for (const theater of THEATERS) {
    const dist = distanceKm(flight.lat, flight.lon, theater.centerLat, theater.centerLon);
    if (dist < 1500) return theater;
  }
  return null;
}

function calculateBaseline(theaterId: string): { transport: number; fighter: number; recon: number } {
  const history = activityHistory.get(theaterId) || [];
  const cutoff = Date.now() - BASELINE_WINDOW_HOURS * 60 * 60 * 1000;
  const relevant = history.filter(h => h.timestamp >= cutoff);

  if (relevant.length < BASELINE_MIN_SAMPLES) {
    return { transport: 3, fighter: 2, recon: 1 };
  }

  const avgTransport = relevant.reduce((sum, h) => sum + h.transportCount, 0) / relevant.length;
  const avgFighter = relevant.reduce((sum, h) => sum + h.fighterCount, 0) / relevant.length;
  const avgRecon = relevant.reduce((sum, h) => sum + h.reconCount, 0) / relevant.length;

  return {
    transport: Math.max(2, avgTransport),
    fighter: Math.max(1, avgFighter),
    recon: Math.max(1, avgRecon),
  };
}

function cleanupOldHistory(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  const cutoff = now - MAX_HISTORY_HOURS * 60 * 60 * 1000;
  for (const [theaterId, history] of activityHistory) {
    const filtered = history.filter(h => h.timestamp >= cutoff);
    if (filtered.length === 0) {
      activityHistory.delete(theaterId);
    } else {
      activityHistory.set(theaterId, filtered);
    }
  }

  for (const [surgeId, surge] of activeSurges) {
    const age = now - surge.lastUpdated.getTime();
    if (age > 2 * 60 * 60 * 1000) {
      activeSurges.delete(surgeId);
    }
  }
}

export function analyzeFlightsForSurge(flights: MilitaryFlight[]): SurgeAlert[] {
  cleanupOldHistory();

  const theaterFlights = new Map<string, MilitaryFlight[]>();
  for (const flight of flights) {
    const theater = getTheaterForFlight(flight);
    if (!theater) continue;
    const existing = theaterFlights.get(theater.id) || [];
    existing.push(flight);
    theaterFlights.set(theater.id, existing);
  }

  const now = Date.now();
  const newAlerts: SurgeAlert[] = [];

  for (const [theaterId, theaterFlightList] of theaterFlights) {
    const theater = THEATERS.find(t => t.id === theaterId);
    if (!theater) continue;

    let transportCount = 0;
    let fighterCount = 0;
    let reconCount = 0;
    const aircraftTypes = new Map<string, number>();
    const nearbyBasesSet = new Set<string>();

    for (const flight of theaterFlightList) {
      const classification = classifyFlight(flight);
      if (classification === 'transport') transportCount++;
      else if (classification === 'fighter') fighterCount++;
      else if (classification === 'recon') reconCount++;

      const typeKey = flight.aircraftModel || flight.aircraftType || 'unknown';
      aircraftTypes.set(typeKey, (aircraftTypes.get(typeKey) || 0) + 1);

      const nearby = findNearbyBases(flight.lat, flight.lon);
      for (const { baseName } of nearby.slice(0, 3)) {
        nearbyBasesSet.add(baseName);
      }
    }

    const activity: TheaterActivity = {
      theaterId,
      timestamp: now,
      transportCount,
      fighterCount,
      reconCount,
      totalMilitary: theaterFlightList.length,
      flightIds: theaterFlightList.map(f => f.id),
    };

    const history = activityHistory.get(theaterId) || [];
    history.push(activity);
    if (history.length > 200) history.shift();
    activityHistory.set(theaterId, history);

    const baseline = calculateBaseline(theaterId);

    if (transportCount >= baseline.transport * SURGE_THRESHOLD && transportCount >= 5) {
      const surgeId = `airlift-${theaterId}`;
      const surgeMultiple = transportCount / baseline.transport;

      const existing = activeSurges.get(surgeId);
      if (existing) {
        existing.currentCount = transportCount;
        existing.surgeMultiple = surgeMultiple;
        existing.aircraftTypes = aircraftTypes;
        existing.nearbyBases = Array.from(nearbyBasesSet);
        existing.lastUpdated = new Date();
      } else {
        const alert: SurgeAlert = {
          id: surgeId,
          theater,
          type: 'airlift',
          currentCount: transportCount,
          baselineCount: Math.round(baseline.transport),
          surgeMultiple,
          aircraftTypes,
          nearbyBases: Array.from(nearbyBasesSet),
          firstDetected: new Date(),
          lastUpdated: new Date(),
        };
        activeSurges.set(surgeId, alert);
        newAlerts.push(alert);
      }
    }

    if (fighterCount >= baseline.fighter * SURGE_THRESHOLD && fighterCount >= 4) {
      const surgeId = `fighter-${theaterId}`;
      const surgeMultiple = fighterCount / baseline.fighter;

      if (!activeSurges.has(surgeId)) {
        const alert: SurgeAlert = {
          id: surgeId,
          theater,
          type: 'fighter',
          currentCount: fighterCount,
          baselineCount: Math.round(baseline.fighter),
          surgeMultiple,
          aircraftTypes,
          nearbyBases: Array.from(nearbyBasesSet),
          firstDetected: new Date(),
          lastUpdated: new Date(),
        };
        activeSurges.set(surgeId, alert);
        newAlerts.push(alert);
      }
    }
  }

  return newAlerts;
}

export function getActiveSurges(): SurgeAlert[] {
  return Array.from(activeSurges.values());
}

export function getTheaterActivity(theaterId: string): TheaterActivity[] {
  return activityHistory.get(theaterId) || [];
}

// ============ FOREIGN MILITARY CONCENTRATION DETECTION ============

function getRegionForPosition(lat: number, lon: number): GeoRegion | null {
  for (const region of SENSITIVE_REGIONS) {
    const dist = distanceKm(lat, lon, region.lat, region.lon);
    if (dist <= region.radiusKm) {
      return region;
    }
  }
  return null;
}

function isHomeRegion(operator: MilitaryOperator, regionId: string): boolean {
  const config = OPERATOR_HOMES.find(o => o.operator === operator);
  if (!config) return true; // Unknown operator - don't alert
  return config.homeRegions.includes(regionId);
}

function getOperatorThreshold(operator: MilitaryOperator): number {
  const config = OPERATOR_HOMES.find(o => o.operator === operator);
  return config?.alertThreshold ?? 3;
}

function getOperatorCountry(operator: MilitaryOperator): string {
  const config = OPERATOR_HOMES.find(o => o.operator === operator);
  return config?.country ?? 'Unknown';
}

export function detectForeignMilitaryPresence(flights: MilitaryFlight[]): ForeignPresenceAlert[] {
  const newAlerts: ForeignPresenceAlert[] = [];

  // Group flights by operator and region
  const presenceMap = new Map<string, { operator: MilitaryOperator; region: GeoRegion; flights: MilitaryFlight[] }>();

  for (const flight of flights) {
    const region = getRegionForPosition(flight.lat, flight.lon);
    if (!region) continue;

    // Skip if this is a home region for this operator
    if (isHomeRegion(flight.operator, region.id)) continue;

    const key = `${flight.operator}-${region.id}`;
    const existing = presenceMap.get(key);
    if (existing) {
      existing.flights.push(flight);
    } else {
      presenceMap.set(key, { operator: flight.operator, region, flights: [flight] });
    }
  }

  // Check for concentrations above threshold
  for (const [key, presence] of presenceMap) {
    const threshold = getOperatorThreshold(presence.operator);
    if (presence.flights.length < threshold) continue;

    // Check if we've already alerted on this (within last 2 hours)
    const alertKey = `${key}-${Math.floor(Date.now() / (2 * 60 * 60 * 1000))}`;
    if (seenForeignAlerts.has(alertKey)) continue;
    seenForeignAlerts.add(alertKey);

    const alert: ForeignPresenceAlert = {
      id: key,
      operator: presence.operator,
      operatorCountry: getOperatorCountry(presence.operator),
      region: presence.region,
      aircraftCount: presence.flights.length,
      flights: presence.flights,
      firstDetected: new Date(),
    };

    activeForeignPresence.set(key, alert);
    newAlerts.push(alert);
  }

  return newAlerts;
}

// Map operator country names to ISO codes for focal point lookup
const COUNTRY_TO_ISO: Record<string, string> = {
  'USA': 'US',
  'Russia': 'RU',
  'China': 'CN',
  'Israel': 'IL',
  'Iran': 'IR',
  'UK': 'GB',
  'France': 'FR',
  'Germany': 'DE',
  'Taiwan': 'TW',
  'Ukraine': 'UA',
  'Saudi Arabia': 'SA',
};

// Map regions to affected countries (for news correlation)
const REGION_AFFECTED_COUNTRIES: Record<string, string[]> = {
  'persian-gulf': ['IR', 'SA'],
  'strait-hormuz': ['IR'],
  'iran-border': ['IR', 'IL'],
  'baltics': ['RU', 'UA'],
  'poland-border': ['RU', 'UA'],
  'black-sea': ['RU', 'UA'],
  'taiwan-strait': ['TW', 'CN'],
  'south-china-sea': ['CN', 'TW'],
  'east-med': ['IL', 'IR'],
  'alaska-adiz': ['RU'],
};

export function foreignPresenceToSignal(alert: ForeignPresenceAlert): {
  id: string;
  type: SignalType;
  source: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  category: string;
  timestamp: Date;
  location?: { lat: number; lon: number; name: string };
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  const aircraftTypes = new Map<string, number>();
  const callsigns: string[] = [];

  for (const flight of alert.flights) {
    const typeKey = flight.aircraftModel || flight.aircraftType || 'unknown';
    aircraftTypes.set(typeKey, (aircraftTypes.get(typeKey) || 0) + 1);
    callsigns.push(flight.callsign);
  }

  const aircraftList = Array.from(aircraftTypes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${count}x ${type}`)
    .join(', ');

  // Severity based on operator and region sensitivity
  const criticalCombos = [
    ['vks', 'baltics'], ['vks', 'poland-border'], ['vks', 'alaska-adiz'],
    ['plaaf', 'taiwan-strait'], ['plan', 'taiwan-strait'],
    ['usaf', 'iran-border'], ['usn', 'persian-gulf'], ['iaf', 'iran-border'],
  ];

  const isCritical = criticalCombos.some(
    ([op, reg]) => alert.operator === op && alert.region.id === reg
  );

  const severity = isCritical ? 'critical' :
    alert.aircraftCount >= 5 ? 'high' : 'medium';

  const confidence = Math.min(0.95, 0.7 + alert.aircraftCount * 0.05);

  // Gather relevant countries for focal point lookup
  const relevantCountries: string[] = [];
  const operatorISO = COUNTRY_TO_ISO[alert.operatorCountry];
  if (operatorISO) relevantCountries.push(operatorISO);

  const affectedCountries = REGION_AFFECTED_COUNTRIES[alert.region.id] || [];
  for (const iso of affectedCountries) {
    if (!relevantCountries.includes(iso)) {
      relevantCountries.push(iso);
    }
  }

  // Get news correlation from focal point detector
  const newsContext = focalPointDetector.getNewsCorrelationContext(relevantCountries);

  // Build enhanced description with news correlation
  let description = `${alert.aircraftCount} ${alert.operatorCountry} aircraft detected in ${alert.region.name}. ` +
    `${aircraftList}. Callsigns: ${callsigns.slice(0, 4).join(', ')}${callsigns.length > 4 ? '...' : ''}`;

  // Check for critical focal points in affected region
  const focalPointContexts: string[] = [];
  for (const iso of relevantCountries) {
    const fp = focalPointDetector.getFocalPointForCountry(iso);
    if (fp && fp.newsMentions > 0) {
      focalPointContexts.push(`${fp.displayName}: ${fp.newsMentions} news mentions (${fp.urgency})`);
    }
  }

  const metadata: Record<string, unknown> = {
    operator: alert.operator,
    operatorCountry: alert.operatorCountry,
    regionId: alert.region.id,
    regionName: alert.region.name,
    lat: alert.region.lat,
    lon: alert.region.lon,
    aircraftCount: alert.aircraftCount,
    aircraftTypes: Object.fromEntries(aircraftTypes),
    callsigns,
    relevantCountries,
    newsCorrelation: newsContext,
    focalPointContext: focalPointContexts.length > 0 ? focalPointContexts : null,
  };

  return {
    id: `foreign-${alert.id}-${alert.firstDetected.getTime()}`,
    type: 'military_surge',
    source: 'Military Flight Tracking',
    title: `🚨 ${alert.operatorCountry} Military in ${alert.region.name}`,
    description,
    severity,
    confidence,
    category: 'military',
    timestamp: alert.firstDetected,
    location: {
      lat: alert.region.lat,
      lon: alert.region.lon,
      name: alert.region.name,
    },
    data: metadata,
    metadata,
  };
}

export function getActiveForeignPresence(): ForeignPresenceAlert[] {
  return Array.from(activeForeignPresence.values());
}

// ============ SURGE DETECTION (baseline-based) ============

export function surgeAlertToSignal(surge: SurgeAlert): {
  id: string;
  type: SignalType;
  source: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  category: string;
  timestamp: Date;
  location?: { lat: number; lon: number; name: string };
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  const typeLabels = {
    airlift: '🛫 Military Airlift Surge',
    fighter: '✈️ Fighter Deployment Surge',
    reconnaissance: '🔭 Reconnaissance Surge',
  };

  const aircraftList = Array.from(surge.aircraftTypes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${count}x ${type}`)
    .join(', ');

  const severity = surge.surgeMultiple >= 4 ? 'critical' :
    surge.surgeMultiple >= 3 ? 'high' : 'medium';

  const confidence = Math.min(0.95, 0.6 + (surge.surgeMultiple - 2) * 0.1);

  const metadata = {
    theaterId: surge.theater.id,
    surgeType: surge.type,
    currentCount: surge.currentCount,
    baselineCount: surge.baselineCount,
    surgeMultiple: surge.surgeMultiple,
    aircraftTypes: Object.fromEntries(surge.aircraftTypes),
    nearbyBases: surge.nearbyBases,
  };

  return {
    id: `surge-${surge.id}-${surge.firstDetected.getTime()}`,
    type: 'military_surge',
    source: 'Military Flight Tracking',
    title: `${typeLabels[surge.type]} - ${surge.theater.name}`,
    description: `${surge.currentCount} ${surge.type} aircraft detected (${surge.surgeMultiple.toFixed(1)}x baseline). ` +
      `${aircraftList}. Near: ${surge.nearbyBases.slice(0, 3).join(', ')}`,
    severity,
    confidence,
    category: 'military',
    timestamp: surge.firstDetected,
    location: {
      lat: surge.theater.centerLat,
      lon: surge.theater.centerLon,
      name: surge.theater.name,
    },
    data: metadata,
    metadata,
  };
}

// ============ THEATER POSTURE AGGREGATION ============

interface PostureTheater {
  id: string;
  name: string;
  shortName: string;
  targetNation: string | null;
  regions: string[];
  bounds: { north: number; south: number; east: number; west: number };
  thresholds: { elevated: number; critical: number };
  strikeIndicators: { minTankers: number; minAwacs: number; minFighters: number };
}

const POSTURE_THEATERS: PostureTheater[] = [
  {
    id: 'iran-theater',
    name: 'Iran Theater',
    shortName: 'IRAN',
    targetNation: 'Iran',
    regions: ['persian-gulf', 'strait-hormuz', 'iran-border'],
    bounds: { north: 42, south: 20, east: 65, west: 30 },
    thresholds: { elevated: 50, critical: 100 },
    strikeIndicators: { minTankers: 10, minAwacs: 2, minFighters: 30 },
  },
  {
    id: 'taiwan-theater',
    name: 'Taiwan Strait',
    shortName: 'TAIWAN',
    targetNation: 'Taiwan',
    regions: ['taiwan-strait', 'south-china-sea'],
    bounds: { north: 30, south: 18, east: 130, west: 115 },
    thresholds: { elevated: 30, critical: 60 },
    strikeIndicators: { minTankers: 5, minAwacs: 1, minFighters: 20 },
  },
  {
    id: 'baltic-theater',
    name: 'Baltic Theater',
    shortName: 'BALTIC',
    targetNation: null,
    regions: ['baltics', 'poland-border', 'kaliningrad'],
    bounds: { north: 65, south: 52, east: 32, west: 10 },
    thresholds: { elevated: 20, critical: 40 },
    strikeIndicators: { minTankers: 4, minAwacs: 1, minFighters: 15 },
  },
  {
    id: 'blacksea-theater',
    name: 'Black Sea',
    shortName: 'BLACK SEA',
    targetNation: null,
    regions: ['black-sea'],
    bounds: { north: 48, south: 40, east: 42, west: 26 },
    thresholds: { elevated: 15, critical: 30 },
    strikeIndicators: { minTankers: 3, minAwacs: 1, minFighters: 10 },
  },
  {
    id: 'korea-theater',
    name: 'Korean Peninsula',
    shortName: 'KOREA',
    targetNation: 'North Korea',
    regions: ['korean-dmz', 'sea-of-japan'],
    bounds: { north: 43, south: 33, east: 132, west: 124 },
    thresholds: { elevated: 20, critical: 50 },
    strikeIndicators: { minTankers: 4, minAwacs: 1, minFighters: 15 },
  },
  {
    id: 'south-china-sea',
    name: 'South China Sea',
    shortName: 'SCS',
    targetNation: null,
    regions: ['south-china-sea', 'spratly-islands'],
    bounds: { north: 25, south: 5, east: 121, west: 105 },
    thresholds: { elevated: 25, critical: 50 },
    strikeIndicators: { minTankers: 5, minAwacs: 1, minFighters: 20 },
  },
  {
    id: 'east-med-theater',
    name: 'Eastern Mediterranean',
    shortName: 'E.MED',
    targetNation: null,
    regions: ['eastern-med', 'levant'],
    bounds: { north: 37, south: 33, east: 37, west: 25 },
    thresholds: { elevated: 15, critical: 30 },
    strikeIndicators: { minTankers: 3, minAwacs: 1, minFighters: 10 },
  },
  {
    id: 'israel-gaza-theater',
    name: 'Israel/Gaza',
    shortName: 'GAZA',
    targetNation: 'Gaza',
    regions: ['israel', 'gaza', 'west-bank'],
    bounds: { north: 33, south: 29, east: 36, west: 33 },
    thresholds: { elevated: 10, critical: 25 },
    strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 8 },
  },
];

export interface TheaterPostureSummary {
  theaterId: string;
  theaterName: string;
  shortName: string;
  targetNation: string | null;
  // Aircraft counts
  fighters: number;
  tankers: number;
  awacs: number;
  reconnaissance: number;
  transport: number;
  bombers: number;
  drones: number;
  totalAircraft: number;
  // Naval vessel counts (added client-side)
  destroyers: number;
  frigates: number;
  carriers: number;
  submarines: number;
  patrol: number;
  auxiliaryVessels: number;
  totalVessels: number;
  // Combined
  byOperator: Record<string, number>;
  postureLevel: 'normal' | 'elevated' | 'critical';
  strikeCapable: boolean;
  trend: 'increasing' | 'stable' | 'decreasing';
  changePercent: number;
  summary: string;
  headline: string;
  centerLat: number;
  centerLon: number;
  // Theater bounds for vessel matching
  bounds?: { north: number; south: number; east: number; west: number };
}

export function getTheaterPostureSummaries(flights: MilitaryFlight[]): TheaterPostureSummary[] {
  const summaries: TheaterPostureSummary[] = [];

  for (const theater of POSTURE_THEATERS) {
    const theaterFlights = flights.filter(
      (f) =>
        f.lat >= theater.bounds.south &&
        f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west &&
        f.lon <= theater.bounds.east
    );

    const byType = {
      fighters: theaterFlights.filter((f) => f.aircraftType === 'fighter').length,
      tankers: theaterFlights.filter((f) => f.aircraftType === 'tanker').length,
      awacs: theaterFlights.filter((f) => f.aircraftType === 'awacs').length,
      reconnaissance: theaterFlights.filter((f) => f.aircraftType === 'reconnaissance').length,
      transport: theaterFlights.filter((f) => f.aircraftType === 'transport').length,
      bombers: theaterFlights.filter((f) => f.aircraftType === 'bomber').length,
      drones: theaterFlights.filter((f) => f.aircraftType === 'drone').length,
    };

    const total = Object.values(byType).reduce((a, b) => a + b, 0);

    const byOperator: Record<string, number> = {};
    for (const f of theaterFlights) {
      byOperator[f.operator] = (byOperator[f.operator] || 0) + 1;
    }

    const postureLevel: 'normal' | 'elevated' | 'critical' =
      total >= theater.thresholds.critical
        ? 'critical'
        : total >= theater.thresholds.elevated
          ? 'elevated'
          : 'normal';

    const strikeCapable =
      byType.tankers >= theater.strikeIndicators.minTankers &&
      byType.awacs >= theater.strikeIndicators.minAwacs &&
      byType.fighters >= theater.strikeIndicators.minFighters;

    const history = activityHistory.get(theater.id) || [];
    const recent = history.slice(-6);
    const older = history.slice(-12, -6);
    const recentAvg =
      recent.length > 0 ? recent.reduce((a, b) => a + b.totalMilitary, 0) / recent.length : total;
    const olderAvg =
      older.length > 0 ? older.reduce((a, b) => a + b.totalMilitary, 0) / older.length : total;
    const changePercent = olderAvg > 0 ? Math.round(((recentAvg - olderAvg) / olderAvg) * 100) : 0;
    const trend: 'increasing' | 'stable' | 'decreasing' =
      changePercent > 10 ? 'increasing' : changePercent < -10 ? 'decreasing' : 'stable';

    const parts: string[] = [];
    if (byType.fighters > 0) parts.push(`${byType.fighters} fighters`);
    if (byType.tankers > 0) parts.push(`${byType.tankers} tankers`);
    if (byType.awacs > 0) parts.push(`${byType.awacs} AWACS`);
    if (byType.reconnaissance > 0) parts.push(`${byType.reconnaissance} recon`);
    const summary = parts.join(', ') || 'No military aircraft';

    const headline =
      postureLevel === 'critical'
        ? `Critical military buildup - ${theater.name}`
        : postureLevel === 'elevated'
          ? `Elevated military activity - ${theater.name}`
          : `Normal activity - ${theater.name}`;

    summaries.push({
      theaterId: theater.id,
      theaterName: theater.name,
      shortName: theater.shortName,
      targetNation: theater.targetNation,
      // Aircraft
      fighters: byType.fighters,
      tankers: byType.tankers,
      awacs: byType.awacs,
      reconnaissance: byType.reconnaissance,
      transport: byType.transport,
      bombers: byType.bombers,
      drones: byType.drones,
      totalAircraft: total,
      // Vessels (populated client-side)
      destroyers: 0,
      frigates: 0,
      carriers: 0,
      submarines: 0,
      patrol: 0,
      auxiliaryVessels: 0,
      totalVessels: 0,
      // Metadata
      byOperator,
      postureLevel,
      strikeCapable,
      trend,
      changePercent,
      summary,
      headline,
      centerLat: (theater.bounds.north + theater.bounds.south) / 2,
      centerLon: (theater.bounds.east + theater.bounds.west) / 2,
      bounds: theater.bounds,
    });
  }

  return summaries;
}

export function getCriticalPostures(flights: MilitaryFlight[]): TheaterPostureSummary[] {
  return getTheaterPostureSummaries(flights).filter(
    (p) => p.postureLevel === 'critical' || (p.postureLevel === 'elevated' && p.strikeCapable)
  );
}
