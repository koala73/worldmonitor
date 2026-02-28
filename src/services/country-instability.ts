import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel, ClusteredEvent, InternetOutage, AisDisruptionEvent, CyberThreat } from '@/types';
import type { AirportDelayAlert } from '@/services/aviation';
import type { SecurityAdvisory } from '@/services/security-advisories';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';
import { CURATED_COUNTRIES, DEFAULT_BASELINE_RISK, DEFAULT_EVENT_MULTIPLIER, getHotspotCountries } from '@/config/countries';
import { focalPointDetector } from './focal-point-detector';
import type { ConflictEvent, UcdpConflictStatus, HapiConflictSummary } from './conflict';
import type { CountryDisplacement } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode, getCountryNameByCode, matchCountryNamesInText, ME_STRIKE_BOUNDS, resolveCountryFromBounds } from './country-geometry';

export interface CountryScore {
  code: string;
  name: string;
  score: number;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  trend: 'rising' | 'stable' | 'falling';
  change24h: number;
  components: ComponentScores;
  lastUpdated: Date;
}

export interface ComponentScores {
  unrest: number;
  conflict: number;
  security: number;
  information: number;
}

export interface CountryNewsSignalSummary {
  totalEvents: number;
  criticalSignals: number;
  highSignals: number;
  conflictSignals: number;
  infrastructureSignals: number;
  economicStressSignals: number;
  electionSignals: number;
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
  aisDisruptionMediumCount: number;
  satelliteFireHighCount: number;
  satelliteFireMediumCount: number;
  cyberThreatCriticalCount: number;
  cyberThreatHighCount: number;
  cyberThreatMediumCount: number;
  temporalAnomalyHighCount: number;
  temporalAnomalyMediumCount: number;
}

export interface TemporalAnomalySignal {
  type: string;
  region: string;
  severity: 'medium' | 'high' | 'critical';
}

interface NewsRiskSummary {
  totalEvents: number;
  criticalSignals: number;
  highSignals: number;
  conflictSignals: number;
  infrastructureSignals: number;
  economicStressSignals: number;
  electionSignals: number;
  weightedSeverity: number;
  weightedConflict: number;
  weightedInfrastructure: number;
  weightedEconomicStress: number;
  weightedElection: number;
}

const THREAT_WEIGHT: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number> = {
  critical: 3.5,
  high: 2.5,
  medium: 1.6,
  low: 0.9,
  info: 0.5,
};

const CONFLICT_NEWS_RE = /\b(war|attack|attacks|strike|strikes|missile|airstrike|bombing|shelling|invasion|troops|retaliat|drone|hostage|terror)\b/i;
const INFRA_NEWS_RE = /\b(internet outage|blackout|airport closure|airport closed|flight cancellations?|airspace closed|navigation outage|gps jam|jamming|port closure|rail disruption)\b/i;
const ECONOMIC_STRESS_RE = /\b(recession|inflation|devaluation|currency crisis|bank run|debt default|austerity|capital controls|sanctions|energy shortage|fuel shortage|market crash|bond selloff|sovereign downgrade)\b/i;
const ELECTION_RE = /\b(election|runoff|ballot|polls|vote|referendum|snap election|parliament dissolved|constitutional crisis|government collapse|state of emergency)\b/i;

function getThreatWeight(level: string): number {
  if (level === 'critical' || level === 'high' || level === 'medium' || level === 'low' || level === 'info') {
    return THREAT_WEIGHT[level];
  }
  return THREAT_WEIGHT.info;
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

export function getLearningProgress(): { inLearning: boolean; remainingMinutes: number; progress: number } {
  if (hasCachedScoresAvailable || isLearningComplete) {
    return { inLearning: false, remainingMinutes: 0, progress: 100 };
  }
  if (learningStartTime === null) {
    return { inLearning: true, remainingMinutes: 15, progress: 0 };
  }

  const elapsed = Date.now() - learningStartTime;
  const remaining = Math.max(0, LEARNING_DURATION_MS - elapsed);
  const progress = Math.min(100, (elapsed / LEARNING_DURATION_MS) * 100);

  return {
    inLearning: remaining > 0,
    remainingMinutes: Math.ceil(remaining / 60000),
    progress: Math.round(progress),
  };
}

let processedCount = 0;
let unmappedCount = 0;

export function getIngestStats(): { processed: number; unmapped: number; rate: number } {
  const rate = processedCount > 0 ? unmappedCount / processedCount : 0;
  return { processed: processedCount, unmapped: unmappedCount, rate };
}

export function resetIngestStats(): void {
  processedCount = 0;
  unmappedCount = 0;
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
const previousScores = new Map<string, number>();

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
    aisDisruptionMediumCount: 0,
    satelliteFireHighCount: 0,
    satelliteFireMediumCount: 0,
    cyberThreatCriticalCount: 0,
    cyberThreatHighCount: 0,
    cyberThreatMediumCount: 0,
    temporalAnomalyHighCount: 0,
    temporalAnomalyMediumCount: 0,
  };
}

const newsEventIndexMap = new Map<string, Map<string, number>>();

export function clearCountryData(): void {
  countryDataMap.clear();
  hotspotActivityMap.clear();
  newsEventIndexMap.clear();
  temporalAnomaliesByType.clear();
  globalTemporalAnomalyHighCount = 0;
  globalTemporalAnomalyMediumCount = 0;
}

export function getCountryData(code: string): CountryData | undefined {
  return countryDataMap.get(code);
}

export function getPreviousScores(): Map<string, number> {
  return previousScores;
}

export type { CountryData };

function buildEmptyNewsRiskSummary(): NewsRiskSummary {
  return {
    totalEvents: 0,
    criticalSignals: 0,
    highSignals: 0,
    conflictSignals: 0,
    infrastructureSignals: 0,
    economicStressSignals: 0,
    electionSignals: 0,
    weightedSeverity: 0,
    weightedConflict: 0,
    weightedInfrastructure: 0,
    weightedEconomicStress: 0,
    weightedElection: 0,
  };
}

function getNewsRecencyWeight(firstSeen: Date, now = Date.now()): number {
  const ageMs = now - firstSeen.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
  if (ageMs <= 6 * 60 * 60 * 1000) return 1.25;
  if (ageMs <= 24 * 60 * 60 * 1000) return 1.05;
  if (ageMs <= 72 * 60 * 60 * 1000) return 0.9;
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 0.75;
  return 0.5;
}

function summarizeNewsRisk(events: ClusteredEvent[], now = Date.now()): NewsRiskSummary {
  if (events.length === 0) return buildEmptyNewsRiskSummary();

  const summary = buildEmptyNewsRiskSummary();
  for (const event of events) {
    summary.totalEvents++;

    const title = event.primaryTitle.toLowerCase();
    const category = event.threat?.category;
    const level = event.threat?.level || (event.isAlert ? 'medium' : 'low');

    if (level === 'critical') summary.criticalSignals++;
    if (level === 'high') summary.highSignals++;

    const isConflict = category === 'conflict' || category === 'military' || category === 'terrorism' || CONFLICT_NEWS_RE.test(title);
    const isInfrastructure = category === 'infrastructure' || INFRA_NEWS_RE.test(title);
    const isEconomic = category === 'economic' || ECONOMIC_STRESS_RE.test(title);
    const isElection = ELECTION_RE.test(title);

    if (isConflict) summary.conflictSignals++;
    if (isInfrastructure) summary.infrastructureSignals++;
    if (isEconomic) summary.economicStressSignals++;
    if (isElection) summary.electionSignals++;

    const levelWeight = getThreatWeight(level);
    const alertWeight = event.isAlert ? 1.2 : 1;
    const recencyWeight = getNewsRecencyWeight(event.firstSeen, now);
    const eventWeight = levelWeight * alertWeight * recencyWeight;

    summary.weightedSeverity += eventWeight;
    if (isConflict) summary.weightedConflict += eventWeight;
    if (isInfrastructure) summary.weightedInfrastructure += eventWeight;
    if (isEconomic) summary.weightedEconomicStress += eventWeight;
    if (isElection) summary.weightedElection += eventWeight;
  }

  return summary;
}

function toPublicNewsSummary(summary: NewsRiskSummary): CountryNewsSignalSummary {
  return {
    totalEvents: summary.totalEvents,
    criticalSignals: summary.criticalSignals,
    highSignals: summary.highSignals,
    conflictSignals: summary.conflictSignals,
    infrastructureSignals: summary.infrastructureSignals,
    economicStressSignals: summary.economicStressSignals,
    electionSignals: summary.electionSignals,
  };
}

export function getCountryNewsSignalSummary(code: string): CountryNewsSignalSummary {
  const normalized = ensureISO2(code) ?? code.trim().toUpperCase();
  const data = countryDataMap.get(normalized);
  if (!data) return toPublicNewsSummary(buildEmptyNewsRiskSummary());
  return toPublicNewsSummary(summarizeNewsRisk(data.newsEvents));
}

function normalizeCountryName(name: string): string | null {
  const tokens = tokenizeForMatch(name);
  for (const [code, cfg] of Object.entries(CURATED_COUNTRIES)) {
    if (cfg.scoringKeywords.some(kw => matchKeyword(tokens, kw))) return code;
  }
  return nameToCountryCode(name.toLowerCase());
}

export function ingestProtestsForCII(events: SocialUnrestEvent[]): void {
  for (const e of events) {
    processedCount++;
    const code = normalizeCountryName(e.country);
    if (!code) { unmappedCount++; continue; }
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.protests.push(e);
    trackHotspotActivity(e.lat, e.lon, e.severity === 'high' ? 2 : 1);
  }
}

export function ingestConflictsForCII(events: ConflictEvent[]): void {
  for (const e of events) {
    processedCount++;
    const code = normalizeCountryName(e.country);
    if (!code) { unmappedCount++; continue; }
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.conflicts.push(e);
    trackHotspotActivity(e.lat, e.lon, e.fatalities > 0 ? 3 : 2);
  }
}

export function ingestUcdpForCII(classifications: Map<string, UcdpConflictStatus>): void {
  for (const [code, status] of classifications) {
    processedCount++;
    const iso2 = ensureISO2(code);
    if (!iso2) { unmappedCount++; continue; }
    if (!countryDataMap.has(iso2)) countryDataMap.set(iso2, initCountryData());
    countryDataMap.get(iso2)!.ucdpStatus = status;
  }
}

export function ingestHapiForCII(summaries: Map<string, HapiConflictSummary>): void {
  for (const [code, summary] of summaries) {
    processedCount++;
    const iso2 = ensureISO2(code);
    if (!iso2) { unmappedCount++; continue; }
    if (!countryDataMap.has(iso2)) countryDataMap.set(iso2, initCountryData());
    countryDataMap.get(iso2)!.hapiSummary = summary;
  }
}

export function ingestDisplacementForCII(countries: CountryDisplacement[]): void {
  for (const data of countryDataMap.values()) {
    data.displacementOutflow = 0;
  }

  for (const c of countries) {
    processedCount++;
    let code: string | null = null;
    if (c.code?.length === 3) {
      code = iso3ToIso2Code(c.code);
    } else if (c.code?.length === 2) {
      code = c.code.toUpperCase();
    }
    if (!code) {
      code = nameToCountryCode(c.name);
    }
    if (!code) { unmappedCount++; continue; }
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const outflow = c.refugees + c.asylumSeekers;
    countryDataMap.get(code)!.displacementOutflow = outflow;
  }
}

const ZONE_COUNTRY_MAP: Record<string, string[]> = {
  'Ukraine': ['UA'], 'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE'],
  'South Asia': ['PK', 'IN'], 'Myanmar': ['MM'],
};

export function ingestClimateForCII(anomalies: ClimateAnomaly[]): void {
  for (const data of countryDataMap.values()) {
    data.climateStress = 0;
  }

  for (const a of anomalies) {
    if (a.severity === 'normal') continue;
    const codes = ZONE_COUNTRY_MAP[a.zone] || [];
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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const hotspotActivityMap = new Map<string, number>();

function trackHotspotActivity(lat: number, lon: number, weight: number = 1): void {
  for (const hotspot of INTEL_HOTSPOTS) {
    const dist = haversineKm(lat, lon, hotspot.lat, hotspot.lon);
    if (dist < 150) {
      const countryCodes = getHotspotCountries(hotspot.id);
      for (const countryCode of countryCodes) {
        const current = hotspotActivityMap.get(countryCode) || 0;
        hotspotActivityMap.set(countryCode, current + weight);
      }
    }
  }
  for (const zone of CONFLICT_ZONES) {
    const [zoneLon, zoneLat] = zone.center;
    const dist = haversineKm(lat, lon, zoneLat, zoneLon);
    if (dist < 300) {
      const zoneCountries: Record<string, string[]> = {
        ukraine: ['UA', 'RU'], gaza: ['IL', 'IR'], sudan: ['SA'], myanmar: ['MM'],
      };
      const countries = zoneCountries[zone.id] || [];
      for (const code of countries) {
        const current = hotspotActivityMap.get(code) || 0;
        hotspotActivityMap.set(code, current + weight * 2);
      }
    }
  }
  for (const waterway of STRATEGIC_WATERWAYS) {
    const dist = haversineKm(lat, lon, waterway.lat, waterway.lon);
    if (dist < 200) {
      const waterwayCountries: Record<string, string[]> = {
        taiwan_strait: ['TW', 'CN'], hormuz_strait: ['IR', 'SA'],
        bab_el_mandeb: ['YE', 'SA'], suez: ['IL'], bosphorus: ['TR'],
      };
      const countries = waterwayCountries[waterway.id] || [];
      for (const code of countries) {
        const current = hotspotActivityMap.get(code) || 0;
        hotspotActivityMap.set(code, current + weight * 1.5);
      }
    }
  }
}

function getHotspotBoost(countryCode: string): number {
  const activity = hotspotActivityMap.get(countryCode) || 0;
  return Math.min(10, activity * 1.5);
}

export function ingestMilitaryForCII(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
  const foreignMilitaryByCountry = new Map<string, { flights: number; vessels: number }>();

  for (const f of flights) {
    processedCount++;
    const operatorCode = normalizeCountryName(f.operatorCountry);
    if (operatorCode) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryFlights.push(f);
    } else {
      unmappedCount++;
    }

    const locationCode = getCountryFromLocation(f.lat, f.lon);
    if (locationCode && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.flights++;
    }
    trackHotspotActivity(f.lat, f.lon, 1.5);
  }

  for (const v of vessels) {
    processedCount++;
    const operatorCode = normalizeCountryName(v.operatorCountry);
    if (operatorCode) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryVessels.push(v);
    } else {
      unmappedCount++;
    }

    const locationCode = getCountryFromLocation(v.lat, v.lon);
    if (locationCode && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.vessels++;
    }
    trackHotspotActivity(v.lat, v.lon, 2);
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
  for (const o of outages) {
    processedCount++;
    const code = normalizeCountryName(o.country);
    if (!code) { unmappedCount++; continue; }
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

function getOrefBlendBoost(code: string, data: CountryData): number {
  if (code !== 'IL') return 0;
  return (data.orefAlertCount > 0 ? 15 : 0) + (data.orefHistoryCount24h >= 10 ? 10 : data.orefHistoryCount24h >= 3 ? 5 : 0);
}

export function ingestAviationForCII(alerts: AirportDelayAlert[]): void {
  for (const a of alerts) {
    processedCount++;
    const code = normalizeCountryName(a.country);
    if (!code) { unmappedCount++; continue; }
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

function getAdvisoryBoost(data: CountryData): number {
  if (!data.advisoryMaxLevel) return 0;
  let boost = 0;
  switch (data.advisoryMaxLevel) {
    case 'do-not-travel': boost = 15; break;
    case 'reconsider': boost = 10; break;
    case 'caution': boost = 5; break;
    default: return 0;
  }
  if (data.advisorySources.size >= 3) boost += 5;
  else if (data.advisorySources.size >= 2) boost += 3;
  return boost;
}

function getAdvisoryFloor(data: CountryData): number {
  if (data.advisoryMaxLevel === 'do-not-travel') return 60;
  if (data.advisoryMaxLevel === 'reconsider') return 50;
  return 0;
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

const temporalAnomaliesByType = new Map<string, TemporalAnomalySignal[]>();
let globalTemporalAnomalyHighCount = 0;
let globalTemporalAnomalyMediumCount = 0;

function resolveCountryCodeFromRegion(region: string): string | null {
  const trimmed = region.trim();
  if (!trimmed) return null;
  const iso = ensureISO2(trimmed);
  if (iso) return iso;
  return normalizeCountryName(trimmed);
}

export function ingestAisDisruptionsForCII(events: AisDisruptionEvent[]): void {
  for (const data of countryDataMap.values()) {
    data.aisDisruptionHighCount = 0;
    data.aisDisruptionMediumCount = 0;
  }

  for (const event of events) {
    const code = getCountryAtCoordinates(event.lat, event.lon)?.code
      ?? resolveCountryCodeFromRegion(event.region || '')
      ?? resolveCountryCodeFromRegion(event.name || '');
    if (!code || code === 'XX') continue;

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (event.severity === 'high') data.aisDisruptionHighCount++;
    else if (event.severity === 'elevated') data.aisDisruptionMediumCount++;
  }
}

export function ingestSatelliteFiresForCII(fires: Array<{ lat: number; lon: number; brightness: number; region?: string }>): void {
  for (const data of countryDataMap.values()) {
    data.satelliteFireHighCount = 0;
    data.satelliteFireMediumCount = 0;
  }

  for (const fire of fires) {
    const code = getCountryAtCoordinates(fire.lat, fire.lon)?.code
      ?? resolveCountryCodeFromRegion(fire.region || '');
    if (!code || code === 'XX') continue;

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (fire.brightness >= 360) data.satelliteFireHighCount++;
    else if (fire.brightness >= 320) data.satelliteFireMediumCount++;
  }
}

export function ingestCyberThreatsForCII(threats: CyberThreat[]): void {
  for (const data of countryDataMap.values()) {
    data.cyberThreatCriticalCount = 0;
    data.cyberThreatHighCount = 0;
    data.cyberThreatMediumCount = 0;
  }

  for (const threat of threats) {
    const code = resolveCountryCodeFromRegion(threat.country || '')
      ?? getCountryAtCoordinates(threat.lat, threat.lon)?.code;
    if (!code || code === 'XX') continue;

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (threat.severity === 'critical') data.cyberThreatCriticalCount++;
    else if (threat.severity === 'high') data.cyberThreatHighCount++;
    else if (threat.severity === 'medium') data.cyberThreatMediumCount++;
  }
}

function rebuildTemporalAnomalyCounts(): void {
  globalTemporalAnomalyHighCount = 0;
  globalTemporalAnomalyMediumCount = 0;
  for (const data of countryDataMap.values()) {
    data.temporalAnomalyHighCount = 0;
    data.temporalAnomalyMediumCount = 0;
  }

  for (const anomalies of temporalAnomaliesByType.values()) {
    for (const anomaly of anomalies) {
      const mappedCode = resolveCountryCodeFromRegion(anomaly.region);
      if (!mappedCode || mappedCode === 'XX' || mappedCode === 'GLOBAL') {
        if (anomaly.severity === 'critical' || anomaly.severity === 'high') globalTemporalAnomalyHighCount++;
        else globalTemporalAnomalyMediumCount++;
        continue;
      }

      if (!countryDataMap.has(mappedCode)) countryDataMap.set(mappedCode, initCountryData());
      const data = countryDataMap.get(mappedCode)!;
      if (anomaly.severity === 'critical' || anomaly.severity === 'high') data.temporalAnomalyHighCount++;
      else data.temporalAnomalyMediumCount++;
    }
  }
}

export function ingestTemporalAnomaliesForCII(
  anomalies: TemporalAnomalySignal[],
  replaceTypes: string[] = [],
): void {
  for (const type of replaceTypes) {
    temporalAnomaliesByType.delete(type);
  }

  const grouped = new Map<string, TemporalAnomalySignal[]>();
  for (const anomaly of anomalies) {
    const list = grouped.get(anomaly.type) || [];
    list.push(anomaly);
    grouped.set(anomaly.type, list);
  }
  for (const [type, list] of grouped) {
    temporalAnomaliesByType.set(type, list);
  }

  rebuildTemporalAnomalyCounts();
}

export function getGlobalTemporalAnomalySummary(): { high: number; medium: number; total: number } {
  return {
    high: globalTemporalAnomalyHighCount,
    medium: globalTemporalAnomalyMediumCount,
    total: globalTemporalAnomalyHighCount + globalTemporalAnomalyMediumCount,
  };
}

function calcUnrestScore(data: CountryData, countryCode: string, newsRisk: NewsRiskSummary): number {
  const protestCount = data.protests.length;
  const multiplier = CURATED_COUNTRIES[countryCode]?.eventMultiplier ?? DEFAULT_EVENT_MULTIPLIER;

  let baseScore = 0;
  let fatalityBoost = 0;
  let severityBoost = 0;

  if (protestCount > 0) {
    const fatalities = data.protests.reduce((sum, p) => sum + (p.fatalities || 0), 0);
    const highSeverity = data.protests.filter(p => p.severity === 'high').length;

    const isHighVolume = multiplier < 0.7;
    const adjustedCount = isHighVolume
      ? Math.log2(protestCount + 1) * multiplier * 5
      : protestCount * multiplier;

    baseScore = Math.min(50, adjustedCount * 8);

    fatalityBoost = Math.min(30, fatalities * 5 * multiplier);
    severityBoost = Math.min(20, highSeverity * 10 * multiplier);
  }

  let outageBoost = 0;
  if (data.outages.length > 0) {
    const totalOutages = data.outages.filter(o => o.severity === 'total').length;
    const majorOutages = data.outages.filter(o => o.severity === 'major').length;
    const partialOutages = data.outages.filter(o => o.severity === 'partial').length;

    outageBoost = Math.min(50, totalOutages * 30 + majorOutages * 15 + partialOutages * 5);
  }

  const economicStressBoost = Math.min(20, newsRisk.economicStressSignals * 3 + newsRisk.weightedEconomicStress * 1.4 * multiplier);
  const electionUnrestBoost = Math.min(15, newsRisk.electionSignals * 2 + newsRisk.weightedElection * 1.2 * multiplier);

  return Math.min(100, baseScore + fatalityBoost + severityBoost + outageBoost + economicStressBoost + electionUnrestBoost);
}

function calcNewsConflictFloor(data: CountryData, multiplier: number, now = Date.now()): number {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const cutoff = now - SIX_HOURS;

  const recentConflictNews = data.newsEvents.filter(e =>
    e.isAlert &&
    e.threat &&
    (e.threat.category === 'conflict' || e.threat.category === 'military') &&
    e.firstSeen.getTime() >= cutoff
  );

  if (recentConflictNews.length < 2) return 0;

  const domains = new Set<string>();
  let hasTrustedSource = false;
  for (const e of recentConflictNews) {
    if (e.topSources) {
      for (const s of e.topSources) {
        domains.add(s.name);
        if (s.tier <= 2) hasTrustedSource = true;
      }
    }
  }

  if (domains.size < 2 || !hasTrustedSource) return 0;

  return Math.min(70, 60 * multiplier);
}

function calcConflictScore(data: CountryData, countryCode: string, newsRisk: NewsRiskSummary): number {
  const events = data.conflicts;
  const multiplier = CURATED_COUNTRIES[countryCode]?.eventMultiplier ?? DEFAULT_EVENT_MULTIPLIER;

  let acledScore = 0;
  if (events.length > 0) {
    const battleCount = events.filter(e => e.eventType === 'battle').length;
    const explosionCount = events.filter(e => e.eventType === 'explosion' || e.eventType === 'remote_violence').length;
    const civilianCount = events.filter(e => e.eventType === 'violence_against_civilians').length;
    const totalFatalities = events.reduce((sum, e) => sum + e.fatalities, 0);

    const eventScore = Math.min(50, (battleCount * 3 + explosionCount * 4 + civilianCount * 5) * multiplier);
    const fatalityScore = Math.min(40, Math.sqrt(totalFatalities) * 5 * multiplier);
    const civilianBoost = civilianCount > 0 ? Math.min(10, civilianCount * 3) : 0;
    acledScore = eventScore + fatalityScore + civilianBoost;
  }

  let hapiFallback = 0;
  if (events.length === 0 && data.hapiSummary) {
    const h = data.hapiSummary;
    hapiFallback = Math.min(60, h.eventsPoliticalViolence * 3 * multiplier);
  }

  let newsFloor = 0;
  if (events.length === 0 && hapiFallback === 0) {
    newsFloor = calcNewsConflictFloor(data, multiplier);
  }

  let strikeBoost = 0;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentStrikes = data.strikes.filter(s => s.timestamp >= sevenDaysAgo);
  if (recentStrikes.length > 0) {
    const highCount = recentStrikes.filter(s =>
      s.severity.toLowerCase() === 'high' || s.severity.toLowerCase() === 'critical'
    ).length;
    strikeBoost = Math.min(50, recentStrikes.length * 3 + highCount * 5);
  }

  let orefBoost = 0;
  if (countryCode === 'IL' && data.orefAlertCount > 0) {
    orefBoost = 25 + Math.min(25, data.orefAlertCount * 5);
  }

  const conflictNewsBoost = Math.min(
    30,
    newsRisk.conflictSignals * 2.5 + newsRisk.weightedConflict * 2 * multiplier + newsRisk.criticalSignals * 2,
  );

  return Math.min(100, Math.max(acledScore, hapiFallback, newsFloor) + strikeBoost + orefBoost + conflictNewsBoost);
}

function getUcdpFloor(data: CountryData): number {
  const status = data.ucdpStatus;
  if (!status) return 0;
  switch (status.intensity) {
    case 'war': return 70;
    case 'minor': return 50;
    case 'none': return 0;
  }
}

function calcSecurityScore(data: CountryData, newsRisk: NewsRiskSummary): number {
  const flights = data.militaryFlights.length;
  const vessels = data.militaryVessels.length;
  const flightScore = Math.min(50, flights * 3);
  const vesselScore = Math.min(30, vessels * 5);

  let aviationScore = 0;
  for (const a of data.aviationDisruptions) {
    if (a.delayType === 'closure') aviationScore += 20;
    else if (a.severity === 'severe') aviationScore += 15;
    else if (a.severity === 'major') aviationScore += 10;
    else if (a.severity === 'moderate') aviationScore += 5;
  }
  aviationScore = Math.min(40, aviationScore);

  const gpsJammingScore = Math.min(35, data.gpsJammingHighCount * 5 + data.gpsJammingMediumCount * 2);
  const aisScore = Math.min(25, data.aisDisruptionHighCount * 8 + data.aisDisruptionMediumCount * 4);
  const cyberScore = Math.min(30, data.cyberThreatCriticalCount * 10 + data.cyberThreatHighCount * 6 + data.cyberThreatMediumCount * 3);
  const satelliteFireScore = Math.min(20, data.satelliteFireHighCount * 4 + data.satelliteFireMediumCount * 2);
  const temporalScore = Math.min(20, data.temporalAnomalyHighCount * 6 + data.temporalAnomalyMediumCount * 3);
  const infraNewsBoost = Math.min(20, newsRisk.infrastructureSignals * 2 + newsRisk.weightedInfrastructure * 1.2);

  return Math.min(
    100,
    flightScore + vesselScore + aviationScore + gpsJammingScore + aisScore + cyberScore + satelliteFireScore + temporalScore + infraNewsBoost,
  );
}

function calcInformationScore(data: CountryData, countryCode: string, newsRisk: NewsRiskSummary): number {
  const count = data.newsEvents.length;
  if (count === 0) return 0;

  const multiplier = CURATED_COUNTRIES[countryCode]?.eventMultiplier ?? DEFAULT_EVENT_MULTIPLIER;
  const velocitySum = data.newsEvents.reduce((sum, e) => sum + (e.velocity?.sourcesPerHour || 0), 0);
  const avgVelocity = velocitySum / count;

  const isHighVolume = multiplier < 0.7;
  const adjustedCount = isHighVolume
    ? Math.log2(count + 1) * multiplier * 3
    : count * multiplier;

  const baseScore = Math.min(40, adjustedCount * 5);

  const velocityThreshold = isHighVolume ? 5 : 2;
  const velocityBoost = avgVelocity > velocityThreshold
    ? Math.min(40, (avgVelocity - velocityThreshold) * 10 * multiplier)
    : 0;

  const alertBoost = data.newsEvents.some(e => e.isAlert) ? 18 * multiplier : 0;
  const severityBoost = Math.min(35, newsRisk.weightedSeverity * 1.1 * multiplier);
  const thematicBoost = Math.min(
    30,
    newsRisk.weightedConflict * 0.8 +
      newsRisk.weightedInfrastructure * 0.6 +
      newsRisk.weightedEconomicStress * 0.7 +
      newsRisk.weightedElection * 0.5,
  );

  return Math.min(100, baseScore + velocityBoost + alertBoost + severityBoost + thematicBoost);
}

function getLevel(score: number): CountryScore['level'] {
  if (score >= 81) return 'critical';
  if (score >= 66) return 'high';
  if (score >= 51) return 'elevated';
  if (score >= 31) return 'normal';
  return 'low';
}

function getTrend(code: string, current: number): CountryScore['trend'] {
  const prev = previousScores.get(code);
  if (prev === undefined) return 'stable';
  const diff = current - prev;
  if (diff >= 5) return 'rising';
  if (diff <= -5) return 'falling';
  return 'stable';
}

export function calculateCII(): CountryScore[] {
  const scores: CountryScore[] = [];
  const focalUrgencies = focalPointDetector.getCountryUrgencyMap();

  const countryCodes = new Set<string>([
    ...countryDataMap.keys(),
    ...Object.keys(CURATED_COUNTRIES),
  ]);

  for (const code of countryCodes) {
    const name = CURATED_COUNTRIES[code]?.name || getCountryNameByCode(code) || code;
    const data = countryDataMap.get(code) || initCountryData();
    const baselineRisk = CURATED_COUNTRIES[code]?.baselineRisk ?? DEFAULT_BASELINE_RISK;
    const newsRisk = summarizeNewsRisk(data.newsEvents);

    const components: ComponentScores = {
      unrest: Math.round(calcUnrestScore(data, code, newsRisk)),
      conflict: Math.round(calcConflictScore(data, code, newsRisk)),
      security: Math.round(calcSecurityScore(data, newsRisk)),
      information: Math.round(calcInformationScore(data, code, newsRisk)),
    };

    const eventScore = components.unrest * 0.25 + components.conflict * 0.30 + components.security * 0.20 + components.information * 0.25;

    const hotspotBoost = getHotspotBoost(code);
    const newsUrgencyBoost = components.information >= 70 ? 5
      : components.information >= 50 ? 3
      : 0;
    const focalUrgency = focalUrgencies.get(code);
    const focalBoost = focalUrgency === 'critical' ? 8
      : focalUrgency === 'elevated' ? 4
      : 0;

    const displacementBoost = data.displacementOutflow >= 1_000_000 ? 8
      : data.displacementOutflow >= 100_000 ? 4
      : 0;
    const climateBoost = data.climateStress;

    const advisoryBoost = getAdvisoryBoost(data);
    const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost + displacementBoost + climateBoost + getOrefBlendBoost(code, data) + advisoryBoost;

    const floor = Math.max(getUcdpFloor(data), getAdvisoryFloor(data));
    const score = Math.round(Math.min(100, Math.max(floor, blendedScore)));

    const prev = previousScores.get(code) ?? score;

    scores.push({
      code,
      name,
      score,
      level: getLevel(score),
      trend: getTrend(code, score),
      change24h: score - prev,
      components,
      lastUpdated: new Date(),
    });

    previousScores.set(code, score);
  }

  return scores.sort((a, b) => b.score - a.score);
}

export function getTopUnstableCountries(limit = 10): CountryScore[] {
  return calculateCII().slice(0, limit);
}

export function getCountryScore(code: string): number | null {
  const data = countryDataMap.get(code);
  if (!data) return null;

  const baselineRisk = CURATED_COUNTRIES[code]?.baselineRisk ?? DEFAULT_BASELINE_RISK;
  const newsRisk = summarizeNewsRisk(data.newsEvents);
  const components: ComponentScores = {
    unrest: calcUnrestScore(data, code, newsRisk),
    conflict: calcConflictScore(data, code, newsRisk),
    security: calcSecurityScore(data, newsRisk),
    information: calcInformationScore(data, code, newsRisk),
  };

  const eventScore = components.unrest * 0.25 + components.conflict * 0.30 + components.security * 0.20 + components.information * 0.25;
  const hotspotBoost = getHotspotBoost(code);
  const newsUrgencyBoost = components.information >= 70 ? 5
    : components.information >= 50 ? 3
    : 0;
  const focalUrgency = focalPointDetector.getCountryUrgency(code);
  const focalBoost = focalUrgency === 'critical' ? 8
    : focalUrgency === 'elevated' ? 4
    : 0;
  const displacementBoost = data.displacementOutflow >= 1_000_000 ? 8
    : data.displacementOutflow >= 100_000 ? 4
    : 0;
  const climateBoost = data.climateStress;
  const advisoryBoost = getAdvisoryBoost(data);
  const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost + displacementBoost + climateBoost + getOrefBlendBoost(code, data) + advisoryBoost;

  const floor = Math.max(getUcdpFloor(data), getAdvisoryFloor(data));
  return Math.round(Math.min(100, Math.max(floor, blendedScore)));
}
