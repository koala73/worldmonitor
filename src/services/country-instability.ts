import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel, ClusteredEvent, InternetOutage } from '@/types';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';
import { TIER1_COUNTRIES } from '@/config/countries';
import { focalPointDetector } from './focal-point-detector';

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
  security: number;
  information: number;
}

interface CountryData {
  protests: SocialUnrestEvent[];
  militaryFlights: MilitaryFlight[];
  militaryVessels: MilitaryVessel[];
  newsEvents: ClusteredEvent[];
  outages: InternetOutage[];
}

// Re-export for backwards compatibility
export { TIER1_COUNTRIES } from '@/config/countries';

// Learning Mode - warmup period for reliable data (bypassed when cached scores exist)
const LEARNING_DURATION_MS = 15 * 60 * 1000; // 15 minutes
let learningStartTime: number | null = null;
let isLearningComplete = false;
let hasCachedScoresAvailable = false;

export function setHasCachedScores(hasScores: boolean): void {
  hasCachedScoresAvailable = hasScores;
  if (hasScores) {
    isLearningComplete = true; // Skip learning when cached scores available
  }
}

export function startLearning(): void {
  if (learningStartTime === null) {
    learningStartTime = Date.now();
  }
}

export function isInLearningMode(): boolean {
  if (hasCachedScoresAvailable) return false; // Bypass if backend has cached scores
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

const COUNTRY_KEYWORDS: Record<string, string[]> = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh', 'mbs'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london', 'starmer'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus', 'assad'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma', 'rangoon'],
  VE: ['venezuela', 'caracas', 'maduro'],
};

// Geopolitical baseline risk scores (0-50)
// Reflects inherent instability regardless of current events
const BASELINE_RISK: Record<string, number> = {
  US: 5,    // Stable democracy, high media coverage inflates event counts
  RU: 35,   // Authoritarian, active in Ukraine conflict
  CN: 25,   // Authoritarian, Taiwan tensions, internal repression
  UA: 50,   // Active war zone
  IR: 40,   // Authoritarian, regional tensions, under-reported
  IL: 45,   // Active conflict with Gaza/Lebanon
  TW: 30,   // China tensions, invasion risk
  KP: 45,   // Rogue state, nuclear threat, near-zero reporting
  SA: 20,   // Regional tensions but relatively stable
  TR: 25,   // Regional involvement, internal tensions
  PL: 10,   // NATO frontline but stable
  DE: 5,    // Stable democracy
  FR: 10,   // Social tensions but stable
  GB: 5,    // Stable democracy
  IN: 20,   // Regional tensions, internal issues
  PK: 35,   // Nuclear state, instability, terrorism
  SY: 50,   // Active civil war
  YE: 50,   // Active civil war
  MM: 45,   // Military coup, civil conflict
  VE: 40,   // Economic collapse, authoritarian
};

// Event significance multipliers
// Higher = each event is more significant (authoritarian states where events are suppressed)
// Lower = events are common/expected (open democracies with high media coverage)
const EVENT_MULTIPLIER: Record<string, number> = {
  US: 0.3,  // Many protests normal, over-reported
  RU: 2.0,  // Protests rare and significant
  CN: 2.5,  // Any protest is major (heavily suppressed)
  UA: 0.8,  // War context, events expected
  IR: 2.0,  // Protests suppressed, significant when occur
  IL: 0.7,  // Frequent conflict, well-documented
  TW: 1.5,  // Events significant
  KP: 3.0,  // Almost no reporting, any event = major
  SA: 2.0,  // Suppressed
  TR: 1.2,  // Some suppression
  PL: 0.8,  // Open democracy
  DE: 0.5,  // Protests normal
  FR: 0.6,  // Protests common
  GB: 0.5,  // Open democracy
  IN: 0.8,  // Large democracy, many events
  PK: 1.5,  // Some suppression
  SY: 0.7,  // War zone, events expected
  YE: 0.7,  // War zone, events expected
  MM: 1.8,  // Military suppression
  VE: 1.8,  // Suppressed
};

const countryDataMap = new Map<string, CountryData>();
const previousScores = new Map<string, number>();

function initCountryData(): CountryData {
  return { protests: [], militaryFlights: [], militaryVessels: [], newsEvents: [], outages: [] };
}

export function clearCountryData(): void {
  countryDataMap.clear();
  hotspotActivityMap.clear();
}

function normalizeCountryName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return code;
  }
  for (const [code, countryName] of Object.entries(TIER1_COUNTRIES)) {
    if (lower.includes(countryName.toLowerCase())) return code;
  }
  return null;
}

export function ingestProtestsForCII(events: SocialUnrestEvent[]): void {
  for (const e of events) {
    const code = normalizeCountryName(e.country);
    if (!code || !TIER1_COUNTRIES[code]) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.protests.push(e);
    trackHotspotActivity(e.lat, e.lon, e.severity === 'high' ? 2 : 1);
  }
}

// Country bounding boxes for location-based attribution [minLat, maxLat, minLon, maxLon]
const COUNTRY_BOUNDS: Record<string, [number, number, number, number]> = {
  IR: [25, 40, 44, 63],      // Iran
  IL: [29, 34, 34, 36],      // Israel
  UA: [44, 53, 22, 40],      // Ukraine
  TW: [21, 26, 119, 122],    // Taiwan
  KP: [37, 43, 124, 131],    // North Korea
  SY: [32, 37, 35, 42],      // Syria
  YE: [12, 19, 42, 54],      // Yemen
  SA: [16, 32, 34, 56],      // Saudi Arabia
  TR: [36, 42, 26, 45],      // Turkey
  PK: [23, 37, 60, 77],      // Pakistan
  IN: [6, 36, 68, 97],       // India
  CN: [18, 54, 73, 135],     // China
  RU: [41, 82, 19, 180],     // Russia (simplified)
};

function getCountryFromLocation(lat: number, lon: number): string | null {
  for (const [code, [minLat, maxLat, minLon, maxLon]] of Object.entries(COUNTRY_BOUNDS)) {
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      return code;
    }
  }
  return null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const HOTSPOT_COUNTRY_MAP: Record<string, string> = {
  tehran: 'IR', moscow: 'RU', beijing: 'CN', kyiv: 'UA', taipei: 'TW',
  telaviv: 'IL', pyongyang: 'KP', riyadh: 'SA', ankara: 'TR', damascus: 'SY',
  sanaa: 'YE', caracas: 'VE', dc: 'US', london: 'GB', brussels: 'FR',
  baghdad: 'IR', beirut: 'IR', doha: 'SA', abudhabi: 'SA',
};

const hotspotActivityMap = new Map<string, number>();

function trackHotspotActivity(lat: number, lon: number, weight: number = 1): void {
  for (const hotspot of INTEL_HOTSPOTS) {
    const dist = haversineKm(lat, lon, hotspot.lat, hotspot.lon);
    if (dist < 150) {
      const countryCode = HOTSPOT_COUNTRY_MAP[hotspot.id];
      if (countryCode && TIER1_COUNTRIES[countryCode]) {
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
        if (TIER1_COUNTRIES[code]) {
          const current = hotspotActivityMap.get(code) || 0;
          hotspotActivityMap.set(code, current + weight * 2);
        }
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
        if (TIER1_COUNTRIES[code]) {
          const current = hotspotActivityMap.get(code) || 0;
          hotspotActivityMap.set(code, current + weight * 1.5);
        }
      }
    }
  }
}

function getHotspotBoost(countryCode: string): number {
  const activity = hotspotActivityMap.get(countryCode) || 0;
  return Math.min(10, activity * 1.5);  // Reduced from 30 max to 10 max
}

export function ingestMilitaryForCII(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
  // Track foreign military activity per country
  const foreignMilitaryByCountry = new Map<string, { flights: number; vessels: number }>();

  for (const f of flights) {
    // 1. Credit operator country (their own military activity)
    const operatorCode = normalizeCountryName(f.operatorCountry);
    if (operatorCode && TIER1_COUNTRIES[operatorCode]) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryFlights.push(f);
    }

    // 2. Credit LOCATION country if different (foreign military over their territory = threat)
    const locationCode = getCountryFromLocation(f.lat, f.lon);
    if (locationCode && TIER1_COUNTRIES[locationCode] && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.flights++;
    }
    trackHotspotActivity(f.lat, f.lon, 1.5);
  }

  for (const v of vessels) {
    // 1. Credit operator country
    const operatorCode = normalizeCountryName(v.operatorCountry);
    if (operatorCode && TIER1_COUNTRIES[operatorCode]) {
      if (!countryDataMap.has(operatorCode)) countryDataMap.set(operatorCode, initCountryData());
      countryDataMap.get(operatorCode)!.militaryVessels.push(v);
    }

    // 2. Credit LOCATION country if different (foreign naval presence = threat)
    const locationCode = getCountryFromLocation(v.lat, v.lon);
    if (locationCode && TIER1_COUNTRIES[locationCode] && locationCode !== operatorCode) {
      if (!foreignMilitaryByCountry.has(locationCode)) {
        foreignMilitaryByCountry.set(locationCode, { flights: 0, vessels: 0 });
      }
      foreignMilitaryByCountry.get(locationCode)!.vessels++;
    }
    trackHotspotActivity(v.lat, v.lon, 2);
  }

  // Store foreign military counts for security calculation
  for (const [code, counts] of foreignMilitaryByCountry) {
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    // Add synthetic entries to represent foreign military presence
    // Each foreign flight/vessel counts MORE than own military (it's a threat)
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
    const title = e.primaryTitle.toLowerCase();
    for (const [code] of Object.entries(TIER1_COUNTRIES)) {
      const keywords = COUNTRY_KEYWORDS[code] || [];
      if (keywords.some(kw => title.includes(kw))) {
        if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
        countryDataMap.get(code)!.newsEvents.push(e);
      }
    }
  }
}

export function ingestOutagesForCII(outages: InternetOutage[]): void {
  for (const o of outages) {
    const code = normalizeCountryName(o.country);
    if (!code || !TIER1_COUNTRIES[code]) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.outages.push(o);
  }
}

function calcUnrestScore(data: CountryData, countryCode: string): number {
  const protestCount = data.protests.length;
  const multiplier = EVENT_MULTIPLIER[countryCode] ?? 1.0;

  let baseScore = 0;
  let fatalityBoost = 0;
  let severityBoost = 0;

  if (protestCount > 0) {
    const fatalities = data.protests.reduce((sum, p) => sum + (p.fatalities || 0), 0);
    const highSeverity = data.protests.filter(p => p.severity === 'high').length;

    // For democracies with frequent protests (low multiplier), use log scaling
    // This prevents routine protests from triggering instability alerts
    const isHighVolume = multiplier < 0.7;
    const adjustedCount = isHighVolume
      ? Math.log2(protestCount + 1) * multiplier * 5  // Log scale for democracies
      : protestCount * multiplier;

    baseScore = Math.min(50, adjustedCount * 8);

    // Fatalities and high severity always matter, but scaled by multiplier
    fatalityBoost = Math.min(30, fatalities * 5 * multiplier);
    severityBoost = Math.min(20, highSeverity * 10 * multiplier);
  }

  // Internet outages are a MAJOR signal of instability
  // Governments cut internet during crackdowns, conflicts, coups
  let outageBoost = 0;
  if (data.outages.length > 0) {
    const totalOutages = data.outages.filter(o => o.severity === 'total').length;
    const majorOutages = data.outages.filter(o => o.severity === 'major').length;
    const partialOutages = data.outages.filter(o => o.severity === 'partial').length;

    // Total blackout = major red flag (30 points)
    // Major outage = significant (15 points)
    // Partial = moderate (5 points)
    outageBoost = Math.min(50, totalOutages * 30 + majorOutages * 15 + partialOutages * 5);
  }

  return Math.min(100, baseScore + fatalityBoost + severityBoost + outageBoost);
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

  const multiplier = EVENT_MULTIPLIER[countryCode] ?? 1.0;
  const velocitySum = data.newsEvents.reduce((sum, e) => sum + (e.velocity?.sourcesPerHour || 0), 0);
  const avgVelocity = velocitySum / count;

  // For high-volume countries (US, UK, DE, FR), use logarithmic scaling
  // This prevents routine news volume from triggering instability
  const isHighVolume = multiplier < 0.7;
  const adjustedCount = isHighVolume
    ? Math.log2(count + 1) * multiplier * 3  // Log scale for media-saturated countries
    : count * multiplier;

  const baseScore = Math.min(40, adjustedCount * 5);

  // Velocity only matters if it's actually high (breaking news style)
  const velocityThreshold = isHighVolume ? 5 : 2;
  const velocityBoost = avgVelocity > velocityThreshold
    ? Math.min(40, (avgVelocity - velocityThreshold) * 10 * multiplier)
    : 0;

  // Alert boost also scaled by multiplier
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

  for (const [code, name] of Object.entries(TIER1_COUNTRIES)) {
    const data = countryDataMap.get(code) || initCountryData();
    const baselineRisk = BASELINE_RISK[code] ?? 20;

    // Calculate component scores with country-specific adjustments (rounded for display)
    const components: ComponentScores = {
      unrest: Math.round(calcUnrestScore(data, code)),
      security: Math.round(calcSecurityScore(data)),
      information: Math.round(calcInformationScore(data, code)),
    };

    // Calculate event-based score (weighted components)
    const eventScore = components.unrest * 0.4 + components.security * 0.3 + components.information * 0.3;

    // Hotspot proximity boost - events near strategic locations are more significant
    const hotspotBoost = getHotspotBoost(code);

    // News urgency boost - high information score means breaking news (reduced to prevent score inflation)
    const newsUrgencyBoost = components.information >= 70 ? 5
      : components.information >= 50 ? 3
      : 0;

    // Focal point intelligence boost - FocalPointDetector correlates news entities with map signals
    // Reduced to prevent multiple countries hitting 100
    const focalUrgency = focalUrgencies.get(code);
    const focalBoost = focalUrgency === 'critical' ? 8
      : focalUrgency === 'elevated' ? 4
      : 0;

    // Blend baseline risk with detected events + all boosts
    // - 40% baseline risk (geopolitical context always matters)
    // - 60% event-based (current detected activity)
    // - Boosts: hotspot(10) + news(5) + focal(8) = max 23 points
    const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost;

    // Active conflict zones have a FLOOR score - they're inherently more unstable
    // than peaceful countries regardless of detected events
    const conflictFloor: Record<string, number> = {
      UA: 55,  // Active war
      SY: 50,  // Civil war
      YE: 50,  // Civil war
      MM: 45,  // Coup/civil conflict
      IL: 45,  // Active Gaza conflict
    };
    const floor = conflictFloor[code] ?? 0;
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

  const baselineRisk = BASELINE_RISK[code] ?? 20;
  const components: ComponentScores = {
    unrest: calcUnrestScore(data, code),
    security: calcSecurityScore(data),
    information: calcInformationScore(data, code),
  };

  const eventScore = components.unrest * 0.4 + components.security * 0.3 + components.information * 0.3;
  const hotspotBoost = getHotspotBoost(code);
  const newsUrgencyBoost = components.information >= 70 ? 5
    : components.information >= 50 ? 3
    : 0;
  const focalUrgency = focalPointDetector.getCountryUrgency(code);
  const focalBoost = focalUrgency === 'critical' ? 8
    : focalUrgency === 'elevated' ? 4
    : 0;
  const blendedScore = baselineRisk * 0.4 + eventScore * 0.6 + hotspotBoost + newsUrgencyBoost + focalBoost;

  // Active conflict zones have floor scores
  const conflictFloor: Record<string, number> = {
    UA: 55, SY: 50, YE: 50, MM: 45, IL: 45,
  };
  const floor = conflictFloor[code] ?? 0;

  return Math.round(Math.min(100, Math.max(floor, blendedScore)));
}
