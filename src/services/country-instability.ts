import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel, ClusteredEvent, InternetOutage } from '@/types';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';
import { CURATED_COUNTRIES, DEFAULT_BASELINE_RISK, DEFAULT_EVENT_MULTIPLIER, getHotspotCountries } from '@/config/countries';
import { focalPointDetector } from './focal-point-detector';
import type { ConflictEvent, UcdpConflictStatus, HapiConflictSummary } from './conflict';
import type { CountryDisplacement } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode, getCountryNameByCode, matchCountryNamesInText } from './country-geometry';

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
  displacementOutflow: number;
  climateStress: number;
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
  return { protests: [], conflicts: [], ucdpStatus: null, hapiSummary: null, militaryFlights: [], militaryVessels: [], newsEvents: [], outages: [], strikes: [], displacementOutflow: 0, climateStress: 0 };
}

const newsEventIndexMap = new Map<string, Map<string, number>>();

export function clearCountryData(): void {
  countryDataMap.clear();
  hotspotActivityMap.clear();
  newsEventIndexMap.clear();
}

export function getCountryData(code: string): CountryData | undefined {
  return countryDataMap.get(code);
}

export function getPreviousScores(): Map<string, number> {
  return previousScores;
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

const STRIKE_COUNTRY_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
  IR: { n: 40, s: 25, e: 63, w: 44 }, IL: { n: 33.3, s: 29.5, e: 35.9, w: 34.3 },
  SA: { n: 32, s: 16, e: 55, w: 35 }, IQ: { n: 37.4, s: 29.1, e: 48.6, w: 38.8 },
  SY: { n: 37.3, s: 32.3, e: 42.4, w: 35.7 }, YE: { n: 19, s: 12, e: 54.5, w: 42 },
  LB: { n: 34.7, s: 33.1, e: 36.6, w: 35.1 }, AE: { n: 26.1, s: 22.6, e: 56.4, w: 51.6 },
};

function coordsToBoundsCountry(lat: number, lon: number): string | null {
  for (const [code, b] of Object.entries(STRIKE_COUNTRY_BOUNDS)) {
    if (lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e) return code;
  }
  return null;
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

function calcUnrestScore(data: CountryData, countryCode: string): number {
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

  return Math.min(100, baseScore + fatalityBoost + severityBoost + outageBoost);
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

function calcConflictScore(data: CountryData, countryCode: string): number {
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

  return Math.min(100, Math.max(acledScore, hapiFallback, newsFloor) + strikeBoost);
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

function calcSecurityScore(data: CountryData): number {
  const flights = data.militaryFlights.length;
  const vessels = data.militaryVessels.length;
  const flightScore = Math.min(50, flights * 3);
  const vesselScore = Math.min(30, vessels * 5);
  return Math.min(100, flightScore + vesselScore);
}

function calcInformationScore(data: CountryData, countryCode: string): number {
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

  const alertBoost = data.newsEvents.some(e => e.isAlert) ? 20 * multiplier : 0;

  return Math.min(100, baseScore + velocityBoost + alertBoost);
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

    const components: ComponentScores = {
      unrest: Math.round(calcUnrestScore(data, code)),
      conflict: Math.round(calcConflictScore(data, code)),
      security: Math.round(calcSecurityScore(data)),
      information: Math.round(calcInformationScore(data, code)),
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

    const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost + displacementBoost + climateBoost;

    const floor = getUcdpFloor(data);
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
  const components: ComponentScores = {
    unrest: calcUnrestScore(data, code),
    conflict: calcConflictScore(data, code),
    security: calcSecurityScore(data),
    information: calcInformationScore(data, code),
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
  const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost + displacementBoost + climateBoost;

  const floor = getUcdpFloor(data);
  return Math.round(Math.min(100, Math.max(floor, blendedScore)));
}
