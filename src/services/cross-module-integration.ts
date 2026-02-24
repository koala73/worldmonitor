import { getLocationName, type GeoConvergenceAlert } from './geo-convergence';
import type { CountryScore } from './country-instability';
import type { CascadeResult, CascadeImpactLevel } from '@/types';
import { calculateCII, TIER1_COUNTRIES, isInLearningMode } from './country-instability';
import { t } from '@/services/i18n';

export type AlertPriority = 'critical' | 'high' | 'medium' | 'low';
export type AlertType = 'convergence' | 'cii_spike' | 'cascade' | 'composite';

export interface UnifiedAlert {
  id: string;
  type: AlertType;
  priority: AlertPriority;
  title: string;
  summary: string;
  components: {
    convergence?: GeoConvergenceAlert;
    ciiChange?: CIIChangeAlert;
    cascade?: CascadeAlert;
  };
  location?: { lat: number; lon: number };
  countries: string[];
  timestamp: Date;
}

export interface CIIChangeAlert {
  country: string;
  countryName: string;
  previousScore: number;
  currentScore: number;
  change: number;
  level: CountryScore['level'];
  driver: string;
}

export interface CascadeAlert {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  countriesAffected: number;
  highestImpact: CascadeImpactLevel;
}

export interface StrategicRiskOverview {
  convergenceAlerts: number;
  avgCIIDeviation: number;
  infrastructureIncidents: number;
  compositeScore: number;
  trend: 'escalating' | 'stable' | 'de-escalating';
  topRisks: string[];
  topConvergenceZones: { cellId: string; lat: number; lon: number; score: number }[];
  unstableCountries: CountryScore[];
  timestamp: Date;
}

const alerts: UnifiedAlert[] = [];
const previousCIIScores = new Map<string, number>();
const ALERT_MERGE_WINDOW_MS = 2 * 60 * 60 * 1000;
const ALERT_MERGE_DISTANCE_KM = 200;

let alertIdCounter = 0;
function generateAlertId(): string {
  return `alert-${Date.now()}-${++alertIdCounter}`;
}

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getPriorityFromCIIChange(change: number, level: CountryScore['level']): AlertPriority {
  const absChange = Math.abs(change);
  // Match CII thresholds: critical at 81+, high at 66+
  if (level === 'critical') return 'critical';
  if (level === 'high' || absChange >= 30) return 'high';
  if (level === 'elevated' || absChange >= 15) return 'medium';
  return 'low';
}

function getPriorityFromCascadeImpact(impact: CascadeImpactLevel, count: number): AlertPriority {
  if (impact === 'critical' || (impact === 'high' && count >= 3)) return 'critical';
  if (impact === 'high' || count >= 5) return 'high';
  if (impact === 'medium' || count >= 3) return 'medium';
  return 'low';
}

function getPriorityFromConvergence(score: number, typeCount: number): AlertPriority {
  // Convergence: 4+ event types or score 90+ = critical, 3 types or 70+ = high
  if (typeCount >= 4 || score >= 90) return 'critical';
  if (typeCount >= 3 || score >= 70) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function buildConvergenceAlert(convergence: GeoConvergenceAlert, alertId: string): UnifiedAlert {
  const location = getCountriesNearLocation(convergence.lat, convergence.lon).join(', ') || 'Unknown';
  return {
    id: alertId,
    type: 'convergence',
    priority: getPriorityFromConvergence(convergence.score, convergence.types.length),
    title: t('alerts.geoAlert', { location }),
    summary: t('alerts.eventsDetected', { count: convergence.totalEvents, lat: convergence.lat.toFixed(1), lon: convergence.lon.toFixed(1) }),
    components: { convergence },
    location: { lat: convergence.lat, lon: convergence.lon },
    countries: getCountriesNearLocation(convergence.lat, convergence.lon),
    timestamp: new Date(),
  };
}

export function createConvergenceAlert(convergence: GeoConvergenceAlert): UnifiedAlert {
  const alertId = `conv-${convergence.cellId}`;
  const alert = buildConvergenceAlert(convergence, alertId);
  return addAndMergeAlert(alert);
}

export function createCIIAlert(
  country: string,
  countryName: string,
  previousScore: number,
  currentScore: number,
  level: CountryScore['level'],
  driver: string
): UnifiedAlert | null {
  const change = currentScore - previousScore;
  if (Math.abs(change) < 10) return null;

  const ciiChange: CIIChangeAlert = {
    country,
    countryName,
    previousScore,
    currentScore,
    change,
    level,
    driver,
  };

  const changeStr = change > 0 ? `+${change}` : String(change);
  const summaryKey = change > 0 ? 'alerts.indexRose' : 'alerts.indexFell';

  const alert: UnifiedAlert = {
    id: `cii-${country}`, // Stable ID for deduplication by country
    type: 'cii_spike',
    priority: getPriorityFromCIIChange(change, level),
    title: t(change > 0 ? 'alerts.instabilityRising' : 'alerts.instabilityFalling', { country: countryName }),
    summary: t(summaryKey, { from: previousScore, to: currentScore, change: changeStr, driver }),
    components: { ciiChange },
    countries: [country],
    timestamp: new Date(),
  };

  return addAndMergeAlert(alert);
}

export function createCascadeAlert(cascade: CascadeResult): UnifiedAlert | null {
  if (cascade.countriesAffected.length === 0) return null;

  const highestImpact = cascade.countriesAffected[0]?.impactLevel || 'low';
  const cascadeAlert: CascadeAlert = {
    sourceId: cascade.source.id,
    sourceName: cascade.source.name,
    sourceType: cascade.source.type,
    countriesAffected: cascade.countriesAffected.length,
    highestImpact,
  };

  const alert: UnifiedAlert = {
    id: generateAlertId(),
    type: 'cascade',
    priority: getPriorityFromCascadeImpact(highestImpact, cascade.countriesAffected.length),
    title: t('alerts.infraAlert', { name: cascade.source.name }),
    summary: t('alerts.countriesAffected', { count: cascade.countriesAffected.length, impact: highestImpact }),
    components: { cascade: cascadeAlert },
    location: cascade.source.coordinates
      ? { lat: cascade.source.coordinates[1], lon: cascade.source.coordinates[0] }
      : undefined,
    countries: cascade.countriesAffected.map(c => c.country),
    timestamp: new Date(),
  };

  return addAndMergeAlert(alert);
}

function shouldMergeAlerts(a: UnifiedAlert, b: UnifiedAlert): boolean {
  const sameCountry = a.countries.some(c => b.countries.includes(c));
  const sameTime =
    Math.abs(a.timestamp.getTime() - b.timestamp.getTime()) < ALERT_MERGE_WINDOW_MS;
  const sameLocation = !!(
    a.location &&
    b.location &&
    haversineDistance(a.location.lat, a.location.lon, b.location.lat, b.location.lon) <
      ALERT_MERGE_DISTANCE_KM
  );

  return (sameCountry || sameLocation) && sameTime;
}

function mergeAlerts(existing: UnifiedAlert, incoming: UnifiedAlert): UnifiedAlert {
  const merged: UnifiedAlert = {
    id: existing.id,
    type: 'composite',
    priority: getHigherPriority(existing.priority, incoming.priority),
    title: generateCompositeTitle(existing, incoming),
    summary: generateCompositeSummary(existing, incoming),
    components: {
      ...existing.components,
      ...incoming.components,
    },
    location: existing.location || incoming.location,
    countries: [...new Set([...existing.countries, ...incoming.countries])],
    timestamp: new Date(Math.max(existing.timestamp.getTime(), incoming.timestamp.getTime())),
  };

  return merged;
}

function getHigherPriority(a: AlertPriority, b: AlertPriority): AlertPriority {
  const order: AlertPriority[] = ['critical', 'high', 'medium', 'low'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function getCountryDisplayName(code: string): string {
  return TIER1_COUNTRIES[code] || code;
}

function generateCompositeTitle(a: UnifiedAlert, b: UnifiedAlert): string {
  const ciiChange = a.components.ciiChange || b.components.ciiChange;
  if (ciiChange) {
    return t(ciiChange.change > 0 ? 'alerts.instabilityRising' : 'alerts.instabilityFalling', { country: ciiChange.countryName });
  }

  if (a.components.convergence || b.components.convergence) {
    const countryCode = a.countries[0] || b.countries[0];
    const location = countryCode ? getCountryDisplayName(countryCode) : t('alerts.multipleRegions');
    return t('alerts.geoAlert', { location });
  }

  if (a.components.cascade || b.components.cascade) {
    return t('alerts.cascadeAlert');
  }

  const countryCode = a.countries[0] || b.countries[0];
  const location = countryCode ? getCountryDisplayName(countryCode) : t('alerts.multipleRegions');
  return t('alerts.alert', { location });
}

function generateCompositeSummary(a: UnifiedAlert, b: UnifiedAlert): string {
  // For CII alerts, combine into a single narrative
  const ciiA = a.components.ciiChange;
  const ciiB = b.components.ciiChange;

  if (ciiA && ciiB && ciiA.country === ciiB.country) {
    // Same country, multiple updates - show the progression
    const latest = ciiB.currentScore > ciiA.currentScore ? ciiB : ciiA;
    const earliest = ciiB.currentScore > ciiA.currentScore ? ciiA : ciiB;
    const totalChange = latest.currentScore - earliest.previousScore;
    const changeStr = totalChange > 0 ? `+${totalChange}` : `${totalChange}`;
    const summaryKey = totalChange > 0 ? 'alerts.indexRose' : 'alerts.indexFell';
    return t(summaryKey, { from: earliest.previousScore, to: latest.currentScore, change: changeStr, driver: latest.driver });
  }

  // Otherwise combine summaries — limit to avoid unbounded growth
  // Extract unique bullet segments from both summaries (they may already contain ' • ' from prior merges)
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of [a.summary, b.summary]) {
    if (!s) continue;
    for (const seg of s.split(' • ')) {
      const trimmed = seg.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        parts.push(trimmed);
      }
    }
  }
  // Cap at 3 evidence items to prevent wall-of-text
  if (parts.length > 3) {
    const extra = parts.length - 3;
    return parts.slice(0, 3).join(' • ') + ` (+${extra} more)`;
  }
  return parts.join(' • ');
}

function addAndMergeAlert(alert: UnifiedAlert): UnifiedAlert {
  // First check for existing alert with same ID (stable deduplication)
  const existingByIdIndex = alerts.findIndex(a => a.id === alert.id);
  if (existingByIdIndex !== -1) {
    const existing = alerts[existingByIdIndex]!;
    // Update existing alert with new data, keeping higher priority
    const updated: UnifiedAlert = {
      ...alert,
      priority: getHigherPriority(existing.priority, alert.priority),
      timestamp: new Date(Math.max(existing.timestamp.getTime(), alert.timestamp.getTime())),
    };
    alerts[existingByIdIndex] = updated;
    return updated;
  }

  // Then check for merge candidates based on location/country
  for (let i = 0; i < alerts.length; i++) {
    const existing = alerts[i];
    if (existing && shouldMergeAlerts(existing, alert)) {
      const merged = mergeAlerts(existing, alert);
      alerts[i] = merged;
      return merged;
    }
  }

  alerts.unshift(alert);
  if (alerts.length > 50) alerts.pop();
  return alert;
}

function getCountriesNearLocation(lat: number, lon: number): string[] {
  const countries: string[] = [];

  const regionCountries = {
    europe: ['DE', 'FR', 'GB', 'PL', 'UA'],
    middle_east: ['IR', 'IL', 'SA', 'TR', 'SY', 'YE'],
    east_asia: ['CN', 'TW', 'KP'],
    south_asia: ['IN', 'PK', 'MM'],
    americas: ['US', 'VE'],
  } as const;

  if (lat > 35 && lat < 70 && lon > -10 && lon < 40) {
    countries.push(...regionCountries.europe);
  } else if (lat > 15 && lat < 45 && lon > 25 && lon < 65) {
    countries.push(...regionCountries.middle_east);
  } else if (lat > 15 && lat < 55 && lon > 100 && lon < 145) {
    countries.push(...regionCountries.east_asia);
  } else if (lat > 5 && lat < 40 && lon > 65 && lon < 100) {
    countries.push(...regionCountries.south_asia);
  } else if (lat > -60 && lat < 70 && lon > -130 && lon < -30) {
    countries.push(...regionCountries.americas);
  }

  return countries.filter(c => TIER1_COUNTRIES[c]);
}

export function checkCIIChanges(): UnifiedAlert[] {
  const newAlerts: UnifiedAlert[] = [];
  const scores = calculateCII();

  // Skip alerting during learning mode - data not yet reliable
  const inLearning = isInLearningMode();

  for (const score of scores) {
    const previous = previousCIIScores.get(score.code) ?? score.score;
    const change = score.score - previous;

    // Only emit alerts after learning period completes
    if (!inLearning && Math.abs(change) >= 10) {
      const driver = getHighestComponent(score);
      const alert = createCIIAlert(
        score.code,
        score.name,
        previous,
        score.score,
        score.level,
        driver
      );
      if (alert) newAlerts.push(alert);
    }

    previousCIIScores.set(score.code, score.score);
  }

  return newAlerts;
}

function getHighestComponent(score: CountryScore): string {
  const { unrest, security, information } = score.components;
  if (unrest >= security && unrest >= information) return 'Civil Unrest';
  if (security >= information) return 'Security Activity';
  return 'Information Velocity';
}

// Populate alerts from convergence and CII data
function updateAlerts(convergenceAlerts: GeoConvergenceAlert[]): void {
  // Prune old alerts (older than 24 hours)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (alerts.length > 0 && alerts[0]!.timestamp.getTime() < cutoff) {
    alerts.shift();
  }

  // Add convergence alerts (addAndMergeAlert handles deduplication by stable ID)
  for (const conv of convergenceAlerts) {
    createConvergenceAlert(conv);
  }

  // Check for CII changes (alerts are added internally via addAndMergeAlert)
  checkCIIChanges();

  // Sort by timestamp (newest first) and limit to 100
  alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (alerts.length > 100) {
    alerts.length = 100;
  }
}

export function calculateStrategicRiskOverview(
  convergenceAlerts: GeoConvergenceAlert[]
): StrategicRiskOverview {
  const ciiScores = calculateCII();

  // Update the alerts array with current data
  updateAlerts(convergenceAlerts);

  const ciiRiskScore = calculateCIIRiskScore(ciiScores);

  // Weights for composite score
  const convergenceWeight = 0.3;  // Geo convergence of multiple event types
  const ciiWeight = 0.5;          // Country instability (main driver)
  const infraWeight = 0.2;        // Infrastructure incidents

  const convergenceScore = Math.min(100, convergenceAlerts.length * 25);
  const infraScore = Math.min(100, countInfrastructureIncidents() * 25);

  // CII score is already 0-100 from calculateCIIRiskScore
  const composite = Math.round(
    convergenceScore * convergenceWeight +
    ciiRiskScore * ciiWeight +
    infraScore * infraWeight
  );

  const trend = determineTrend(composite);

  // Top country score for display
  const topCountry = ciiScores[0];
  const topCIIScore = topCountry ? topCountry.score : 0;

  return {
    convergenceAlerts: convergenceAlerts.length,
    avgCIIDeviation: topCIIScore,  // Now shows top country score
    infrastructureIncidents: countInfrastructureIncidents(),
    compositeScore: composite,
    trend,
    topRisks: identifyTopRisks(convergenceAlerts, ciiScores),
    topConvergenceZones: convergenceAlerts
      .slice(0, 3)
      .map(a => ({ cellId: a.cellId, lat: a.lat, lon: a.lon, score: a.score })),
    unstableCountries: ciiScores.filter(s => s.score >= 50).slice(0, 5),
    timestamp: new Date(),
  };
}

function calculateCIIRiskScore(scores: CountryScore[]): number {
  if (scores.length === 0) return 0;

  // Use top 5 highest-scoring countries to determine risk
  // Don't dilute with stable countries
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top5 = sorted.slice(0, 5);

  // Weighted: highest country contributes most
  // Top country: 40%, 2nd: 25%, 3rd: 20%, 4th: 10%, 5th: 5%
  const weights = [0.4, 0.25, 0.2, 0.1, 0.05];
  let weightedScore = 0;

  for (let i = 0; i < top5.length; i++) {
    const country = top5[i];
    const weight = weights[i];
    if (country && weight !== undefined) {
      weightedScore += country.score * weight;
    }
  }

  // Count of elevated countries (score >= 50) adds bonus
  const elevatedCount = scores.filter(s => s.score >= 50).length;
  const elevatedBonus = Math.min(20, elevatedCount * 5);

  return Math.min(100, weightedScore + elevatedBonus);
}

let previousCompositeScore: number | null = null;
function determineTrend(current: number): 'escalating' | 'stable' | 'de-escalating' {
  if (previousCompositeScore === null) {
    previousCompositeScore = current;
    return 'stable';
  }
  const diff = current - previousCompositeScore;
  previousCompositeScore = current;
  if (diff >= 5) return 'escalating';
  if (diff <= -5) return 'de-escalating';
  return 'stable';
}

function countInfrastructureIncidents(): number {
  return alerts.filter(a => a.components.cascade).length;
}

function identifyTopRisks(
  convergence: GeoConvergenceAlert[],
  cii: CountryScore[]
): string[] {
  const risks: string[] = [];

  const top = convergence[0];
  if (top) {
    const location = getLocationName(top.lat, top.lon);
    risks.push(`Convergence: ${location} (score: ${top.score})`);
  }

  const critical = cii.filter(s => s.level === 'critical' || s.level === 'high');
  for (const c of critical.slice(0, 2)) {
    risks.push(`${c.name} instability: ${c.score} (${c.level})`);
  }

  return risks.slice(0, 3);
}

export function getAlerts(): UnifiedAlert[] {
  return [...alerts];
}

export function getRecentAlerts(hours: number = 24): UnifiedAlert[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return alerts.filter(a => a.timestamp.getTime() > cutoff);
}

export function clearAlerts(): void {
  alerts.length = 0;
}

export function getAlertCount(): { critical: number; high: number; medium: number; low: number } {
  return {
    critical: alerts.filter(a => a.priority === 'critical').length,
    high: alerts.filter(a => a.priority === 'high').length,
    medium: alerts.filter(a => a.priority === 'medium').length,
    low: alerts.filter(a => a.priority === 'low').length,
  };
}
