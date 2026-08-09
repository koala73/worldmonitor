import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel, ClusteredEvent, InternetOutage, AisDisruptionEvent, CyberThreat } from '@/types';
import type { AirportDelayAlert } from '@/services/aviation';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type { TemporalAnomaly } from '@/services/temporal-baseline';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { CURATED_COUNTRIES } from '@/config/countries';
import type { ConflictEvent, UcdpConflictStatus, HapiConflictSummary } from './conflict';
import type { CountryDisplacement } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import type { Earthquake } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import type { CountrySanctionsPressure } from '@/services/sanctions-pressure';
import { CII_CLIMATE_ZONE_COUNTRIES } from '../../shared/cii-climate-zones';
import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode, matchCountryNamesInText, ME_STRIKE_BOUNDS, resolveCountryFromBounds } from './country-geometry';

export interface CountryScore {
  code: string;
  name: string;
  score: number;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  trend: 'rising' | 'stable' | 'falling';
  change24h: number;
  components: ComponentScores;
  // Null when the underlying source (cached proto) provided no timestamp. See #3800.
  lastUpdated: Date | null;
}

export interface ComponentScores {
  unrest: number;
  conflict: number;
  security: number;
  information: number;
}

interface CountryData {
  protests: SocialUnrestEvent[];
  conflicts: ConflictEvent[];
  ucdpStatus: UcdpConflictStatus | null;
  hapiSummary: HapiConflictSummary | null;
  militaryFlights: MilitaryFlight[];
  militaryVessels: MilitaryVessel[];
  newsEvents: ClusteredEvent[];
  outages: InternetOutage[];
  strikes: Array<{ severity: string; timestamp: number; lat: number; lon: number; title: string; id: string }>;
  aviationDisruptions: AirportDelayAlert[];
  displacementOutflow: number;
  climateStress: number;
  orefAlertCount: number;
  orefHistoryCount24h: number;
  advisoryMaxLevel: SecurityAdvisory['level'] | null;
  advisoryCount: number;
  advisorySources: Set<string>;
  gpsJammingHighCount: number;
  gpsJammingMediumCount: number;
  aisDisruptionHighCount: number;
  aisDisruptionElevatedCount: number;
  aisDisruptionLowCount: number;
  satelliteFireCount: number;
  satelliteFireHighCount: number;
  cyberThreatCriticalCount: number;
  cyberThreatHighCount: number;
  cyberThreatMediumCount: number;
  temporalAnomalyCount: number;
  temporalAnomalyCriticalCount: number;
  earthquakeSignificantCount: number;
  earthquakeMajorCount: number;
  earthquakeSevereCount: number;
  sanctionsEntryCount: number;
  sanctionsNewEntryCount: number;
}

export { TIER1_COUNTRIES } from '@/config/countries';

const LEARNING_DURATION_MS = 15 * 60 * 1000;
let learningStartTime: number | null = null;
let isLearningComplete = false;
let hasCachedScoresAvailable = false;

export function setHasCachedScores(hasScores: boolean): void {
  hasCachedScoresAvailable = hasScores;
  if (hasScores) {
    isLearningComplete = true;
  }
}

export function startLearning(): void {
  if (learningStartTime === null) {
    learningStartTime = Date.now();
  }
}

export function isInLearningMode(): boolean {
  if (hasCachedScoresAvailable) return false;
  if (isLearningComplete) return false;
  if (learningStartTime === null) return true;

  const elapsed = Date.now() - learningStartTime;
  if (elapsed >= LEARNING_DURATION_MS) {
    isLearningComplete = true;
    return false;
  }
  return true;
}

function ensureISO2(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  const iso2 = iso3ToIso2Code(upper);
  if (iso2) return iso2;
  const fromName = nameToCountryCode(code);
  if (fromName) return fromName;
  return null;
}

const countryDataMap = new Map<string, CountryData>();

function initCountryData(): CountryData {
  return {
    protests: [],
    conflicts: [],
    ucdpStatus: null,
    hapiSummary: null,
    militaryFlights: [],
    militaryVessels: [],
    newsEvents: [],
    outages: [],
    strikes: [],
    aviationDisruptions: [],
    displacementOutflow: 0,
    climateStress: 0,
    orefAlertCount: 0,
    orefHistoryCount24h: 0,
    advisoryMaxLevel: null,
    advisoryCount: 0,
    advisorySources: new Set(),
    gpsJammingHighCount: 0,
    gpsJammingMediumCount: 0,
    aisDisruptionHighCount: 0,
    aisDisruptionElevatedCount: 0,
    aisDisruptionLowCount: 0,
    satelliteFireCount: 0,
    satelliteFireHighCount: 0,
    cyberThreatCriticalCount: 0,
    cyberThreatHighCount: 0,
    cyberThreatMediumCount: 0,
    temporalAnomalyCount: 0,
    temporalAnomalyCriticalCount: 0,
    earthquakeSignificantCount: 0,
    earthquakeMajorCount: 0,
    earthquakeSevereCount: 0,
    sanctionsEntryCount: 0,
    sanctionsNewEntryCount: 0,
  };
}

const newsEventIndexMap = new Map<string, Map<string, number>>();

export function getCountryData(code: string): CountryData | undefined {
  return countryDataMap.get(code);
}

export type { CountryData };

function normalizeCountryName(name: string): string | null {
  const tokens = tokenizeForMatch(name);
  for (const [code, cfg] of Object.entries(CURATED_COUNTRIES)) {
    if (cfg.scoringKeywords.some(kw => matchKeyword(tokens, kw))) return code;
  }
  return nameToCountryCode(name.toLowerCase());
}

export function ingestProtestsForCII(events: SocialUnrestEvent[]): void {
  for (const [, data] of countryDataMap) data.protests = [];
  for (const e of events) {
    const code = normalizeCountryName(e.country);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.protests.push(e);
  }
}

export function ingestConflictsForCII(events: ConflictEvent[]): void {
  for (const [, data] of countryDataMap) data.conflicts = [];
  for (const e of events) {
    const code = normalizeCountryName(e.country);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.conflicts.push(e);
  }
}

export function ingestUcdpForCII(classifications: Map<string, UcdpConflictStatus>): void {
  for (const [code, status] of classifications) {
    const iso2 = ensureISO2(code);
    if (!iso2) continue;
    if (!countryDataMap.has(iso2)) countryDataMap.set(iso2, initCountryData());
    countryDataMap.get(iso2)!.ucdpStatus = status;
  }
}

export function ingestHapiForCII(summaries: Map<string, HapiConflictSummary>): void {
  for (const [code, summary] of summaries) {
    const iso2 = ensureISO2(code);
    if (!iso2) continue;
    if (!countryDataMap.has(iso2)) countryDataMap.set(iso2, initCountryData());
    countryDataMap.get(iso2)!.hapiSummary = summary;
  }
}

export function ingestDisplacementForCII(countries: CountryDisplacement[]): void {
  for (const data of countryDataMap.values()) {
    data.displacementOutflow = 0;
  }

  for (const c of countries) {
    let code: string | null = null;
    if (c.code?.length === 3) {
      code = iso3ToIso2Code(c.code);
    } else if (c.code?.length === 2) {
      code = c.code.toUpperCase();
    }
    if (!code) {
      code = nameToCountryCode(c.name);
    }
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const outflow = c.refugees + c.asylumSeekers;
    countryDataMap.get(code)!.displacementOutflow = outflow;
  }
}

export function ingestClimateForCII(anomalies: ClimateAnomaly[]): void {
  for (const data of countryDataMap.values()) {
    data.climateStress = 0;
  }

  for (const a of anomalies) {
    if (a.severity === 'normal') continue;
    const codes = CII_CLIMATE_ZONE_COUNTRIES[a.zone] || [];
    for (const code of codes) {
      if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
      const stress = a.severity === 'extreme' ? 15 : 8;
      countryDataMap.get(code)!.climateStress = Math.max(countryDataMap.get(code)!.climateStress, stress);
    }
  }
}

function getCountryFromLocation(lat: number, lon: number): string | null {
  const precise = getCountryAtCoordinates(lat, lon);
  return precise?.code ?? null;
}

export function ingestMilitaryForCII(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
  for (const [, data] of countryDataMap) { data.militaryFlights = []; data.militaryVessels = []; }
  const foreignMilitaryByCountry = new Map<string, { flights: number; vessels: number }>();

  for (const f of flights) {
    const operatorCode = normalizeCountryName(f.operatorCountry);
    if (operatorCode) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryFlights.push(f);
    }

    const locationCode = getCountryFromLocation(f.lat, f.lon);
    if (locationCode && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.flights++;
    }
  }

  for (const v of vessels) {
    const operatorCode = normalizeCountryName(v.operatorCountry);
    if (operatorCode) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryVessels.push(v);
    }

    const locationCode = getCountryFromLocation(v.lat, v.lon);
    if (locationCode && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.vessels++;
    }
  }

  for (const [code, counts] of foreignMilitaryByCountry) {
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    for (let i = 0; i < counts.flights * 2; i++) {
      data.militaryFlights.push({} as MilitaryFlight);
    }
    for (let i = 0; i < counts.vessels * 2; i++) {
      data.militaryVessels.push({} as MilitaryVessel);
    }
  }
}

export function ingestNewsForCII(events: ClusteredEvent[]): void {
  for (const e of events) {
    const tokens = tokenizeForMatch(e.primaryTitle);
    const matched = new Set<string>();

    for (const [code, cfg] of Object.entries(CURATED_COUNTRIES)) {
      if (cfg.scoringKeywords.some(kw => matchKeyword(tokens, kw))) {
        matched.add(code);
      }
    }

    for (const code of matchCountryNamesInText(e.primaryTitle.toLowerCase())) {
      matched.add(code);
    }

    for (const code of matched) {
      if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
      const cd = countryDataMap.get(code)!;
      if (!newsEventIndexMap.has(code)) newsEventIndexMap.set(code, new Map());
      const idx = newsEventIndexMap.get(code)!;
      const existingIdx = idx.get(e.id);
      if (existingIdx !== undefined) {
        cd.newsEvents[existingIdx] = e;
      } else {
        idx.set(e.id, cd.newsEvents.length);
        cd.newsEvents.push(e);
      }
    }
  }
}

function coordsToBoundsCountry(lat: number, lon: number): string | null {
  return resolveCountryFromBounds(lat, lon, ME_STRIKE_BOUNDS);
}

export function ingestStrikesForCII(events: Array<{
  id: string; category: string; severity: string;
  latitude: number; longitude: number; timestamp: number;
  title: string; locationName: string;
}>): void {
  for (const [, data] of countryDataMap) data.strikes = [];

  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const code = getCountryAtCoordinates(e.latitude, e.longitude)?.code
      ?? coordsToBoundsCountry(e.latitude, e.longitude);
    if (!code || code === 'XX') continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.strikes.push({
      severity: e.severity,
      timestamp: e.timestamp < 1e12 ? e.timestamp * 1000 : e.timestamp,
      lat: e.latitude, lon: e.longitude,
      title: e.title || e.locationName, id: e.id,
    });
  }
}

export function ingestOutagesForCII(outages: InternetOutage[]): void {
  for (const [, data] of countryDataMap) data.outages = [];
  for (const o of outages) {
    const code = normalizeCountryName(o.country);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.outages.push(o);
  }
}

export function ingestOrefForCII(alertCount: number, historyCount24h: number): void {
  if (!countryDataMap.has('IL')) countryDataMap.set('IL', initCountryData());
  const data = countryDataMap.get('IL')!;
  data.orefAlertCount = alertCount;
  data.orefHistoryCount24h = historyCount24h;
}

export function ingestAviationForCII(alerts: AirportDelayAlert[]): void {
  for (const [, data] of countryDataMap) data.aviationDisruptions = [];
  for (const a of alerts) {
    const code = normalizeCountryName(a.country);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.aviationDisruptions.push(a);
  }
}

const TRAVEL_ADVISORY_SOURCES = new Set(['US', 'AU', 'UK', 'NZ']);
const ADVISORY_LEVEL_RANK: Record<string, number> = { 'do-not-travel': 4, 'reconsider': 3, 'caution': 2, 'normal': 1, 'info': 0 };

export function ingestAdvisoriesForCII(advisories: SecurityAdvisory[]): void {
  for (const data of countryDataMap.values()) {
    data.advisoryMaxLevel = null;
    data.advisoryCount = 0;
    data.advisorySources = new Set();
  }

  const travelAdvisories = advisories.filter(a =>
    a.country && TRAVEL_ADVISORY_SOURCES.has(a.sourceCountry) && a.level && a.level !== 'info'
  );

  for (const a of travelAdvisories) {
    const code = a.country!;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    data.advisoryCount++;
    data.advisorySources.add(a.sourceCountry);
    const currentRank = ADVISORY_LEVEL_RANK[data.advisoryMaxLevel || ''] || 0;
    const newRank = ADVISORY_LEVEL_RANK[a.level!] || 0;
    if (newRank > currentRank) data.advisoryMaxLevel = a.level!;
  }
}

const h3CountryCache = new Map<string, string>();

export function ingestGpsJammingForCII(hexes: GpsJamHex[]): void {
  for (const [, data] of countryDataMap) {
    data.gpsJammingHighCount = 0;
    data.gpsJammingMediumCount = 0;
  }

  for (const hex of hexes) {
    let code = h3CountryCache.get(hex.h3);
    if (!code) {
      const hit = getCountryAtCoordinates(hex.lat, hex.lon);
      if (hit) {
        code = hit.code;
        h3CountryCache.set(hex.h3, code);
      } else {
        continue;
      }
    }

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (hex.level === 'high') data.gpsJammingHighCount++;
    else data.gpsJammingMediumCount++;
  }
}

function resolveCountryForSignal(countryHint: string | undefined, lat: number, lon: number): string | null {
  if (countryHint) {
    const iso2 = ensureISO2(countryHint);
    if (iso2) return iso2;
    const fromName = normalizeCountryName(countryHint);
    if (fromName) return fromName;
  }
  return getCountryAtCoordinates(lat, lon)?.code
    ?? coordsToBoundsCountry(lat, lon);
}

export function ingestAisDisruptionsForCII(events: AisDisruptionEvent[]): void {
  for (const [, data] of countryDataMap) {
    data.aisDisruptionHighCount = 0;
    data.aisDisruptionElevatedCount = 0;
    data.aisDisruptionLowCount = 0;
  }

  for (const e of events) {
    const code = resolveCountryForSignal(e.region, e.lat, e.lon);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (e.severity === 'high') data.aisDisruptionHighCount++;
    else if (e.severity === 'elevated') data.aisDisruptionElevatedCount++;
    else data.aisDisruptionLowCount++;
  }
}

export function ingestSatelliteFiresForCII(fires: Array<{
  lat: number;
  lon: number;
  brightness: number;
  frp: number;
  region?: string;
}>): void {
  for (const [, data] of countryDataMap) {
    data.satelliteFireCount = 0;
    data.satelliteFireHighCount = 0;
  }

  for (const fire of fires) {
    const code = resolveCountryForSignal(fire.region, fire.lat, fire.lon);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    data.satelliteFireCount++;
    if (fire.brightness >= 360 || fire.frp >= 50) {
      data.satelliteFireHighCount++;
    }
  }
}

export function ingestCyberThreatsForCII(threats: CyberThreat[]): void {
  for (const [, data] of countryDataMap) {
    data.cyberThreatCriticalCount = 0;
    data.cyberThreatHighCount = 0;
    data.cyberThreatMediumCount = 0;
  }

  for (const threat of threats) {
    const code = resolveCountryForSignal(threat.country, threat.lat, threat.lon);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (threat.severity === 'critical') data.cyberThreatCriticalCount++;
    else if (threat.severity === 'high') data.cyberThreatHighCount++;
    else if (threat.severity === 'medium') data.cyberThreatMediumCount++;
  }
}

export function ingestTemporalAnomaliesForCII(anomalies: TemporalAnomaly[]): void {
  for (const [, data] of countryDataMap) {
    data.temporalAnomalyCount = 0;
    data.temporalAnomalyCriticalCount = 0;
  }

  for (const anomaly of anomalies) {
    const region = anomaly.region.trim();
    if (!region || region.toLowerCase() === 'global') continue;

    const code = ensureISO2(region) || normalizeCountryName(region);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    data.temporalAnomalyCount++;
    if (anomaly.severity === 'critical') data.temporalAnomalyCriticalCount++;
  }
}

const EARTHQUAKE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export function ingestEarthquakesForCII(earthquakes: Earthquake[], now = Date.now()): void {
  for (const [, data] of countryDataMap) {
    data.earthquakeSignificantCount = 0;
    data.earthquakeMajorCount = 0;
    data.earthquakeSevereCount = 0;
  }

  const cutoff = now - EARTHQUAKE_LOOKBACK_MS;
  for (const eq of earthquakes) {
    if (eq.magnitude < 5.5) continue;
    if (eq.occurredAt < cutoff) continue;
    const code = getCountryAtCoordinates(eq.location?.latitude ?? 0, eq.location?.longitude ?? 0)?.code;
    if (!code || code === 'XX') continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (eq.magnitude >= 7.5) data.earthquakeSevereCount++;
    else if (eq.magnitude >= 6.5) data.earthquakeMajorCount++;
    else data.earthquakeSignificantCount++;
  }
}

export function ingestSanctionsForCII(countries: CountrySanctionsPressure[]): void {
  for (const [, data] of countryDataMap) {
    data.sanctionsEntryCount = 0;
    data.sanctionsNewEntryCount = 0;
  }

  for (const c of countries) {
    const code = c.countryCode.toUpperCase();
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    data.sanctionsEntryCount += c.entryCount;
    data.sanctionsNewEntryCount += c.newEntryCount;
  }
}
