import { getLocationName, type GeoConvergenceAlert } from './geo-convergence';
import type { CountryScore } from './country-instability';
import type { CascadeResult, CascadeImpactLevel } from '@/types';
import { calculateCII, isInLearningMode } from './country-instability';
import { getCountryNameByCode } from './country-geometry';
import { t } from '@/services/i18n';
import type { TheaterPostureSummary } from '@/services/military-surge';
import { CURATED_COUNTRIES, DEFAULT_BASELINE_RISK } from '@/config/countries';

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

interface GlobalComponentPressure {
  component: keyof CountryScore['components'];
  score: number;
}

interface CIIRiskConsolidation {
  score: number;
  avgDeviation: number;
  componentPressure: GlobalComponentPressure;
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
  return getCountryNameByCode(code) || code;
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
  document.dispatchEvent(new CustomEvent('wm:intelligence-updated'));
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

  return countries;
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
  const { unrest, conflict, security, information } = score.components;
  if (conflict >= unrest && conflict >= security && conflict >= information) return 'Conflict Activity';
  if (unrest >= security && unrest >= information) return 'Civil Unrest';
  if (security >= information) return 'Security Activity';
  return 'Information Velocity';
}

// Populate alerts from convergence and CII data
function updateAlerts(convergenceAlerts: GeoConvergenceAlert[]): void {
  // Prune old alerts (older than 24 hours)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (let i = alerts.length - 1; i >= 0; i--) {
    const alert = alerts[i];
    if (alert && alert.timestamp.getTime() < cutoff) {
      alerts.splice(i, 1);
    }
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
  convergenceAlerts: GeoConvergenceAlert[],
  theaterPostures?: TheaterPostureSummary[],
  breakingAlertScore?: number,
  theaterStaleFactor?: number
): StrategicRiskOverview {
  const ciiScores = calculateCII();

  // Update the alerts array with current data
  updateAlerts(convergenceAlerts);

  const ciiConsolidation = calculateCIIRiskScore(ciiScores);
  const ciiRiskScore = ciiConsolidation.score;

  // Weights for composite score
  const convergenceWeight = 0.3;  // Geo convergence of multiple event types
  const ciiWeight = 0.5;          // Country instability (main driver)
  const infraWeight = 0.2;        // Infrastructure incidents

  const convergenceScore = Math.min(100, convergenceAlerts.length * 25);
  const infraScore = Math.min(100, countInfrastructureIncidents() * 25);

  // Theater posture boost from raw asset counts (avoids CII double-count)
  let theaterBoost = 0;
  if (theaterPostures && theaterPostures.length > 0) {
    for (const p of theaterPostures) {
      if (p.totalAircraft + p.totalVessels === 0) continue;
      const assetScore = Math.min(10, Math.floor((p.totalAircraft + p.totalVessels) / 5));
      theaterBoost += p.strikeCapable ? assetScore + 5 : assetScore;
    }
    theaterBoost = Math.min(25, theaterBoost);
  }
  theaterBoost = Math.round(theaterBoost * (theaterStaleFactor ?? 1));

  // Breaking news severity boost (pre-computed by panel)
  const breakingBoost = Math.min(15, breakingAlertScore ?? 0);

  const composite = Math.min(100, Math.round(
    convergenceScore * convergenceWeight +
    ciiRiskScore * ciiWeight +
    infraScore * infraWeight +
    theaterBoost +
    breakingBoost
  ));

  const trend = determineTrend(composite);

  return {
    convergenceAlerts: convergenceAlerts.length,
    avgCIIDeviation: ciiConsolidation.avgDeviation,
    infrastructureIncidents: countInfrastructureIncidents(),
    compositeScore: composite,
    trend,
    topRisks: identifyTopRisks(convergenceAlerts, ciiScores, ciiConsolidation.componentPressure),
    topConvergenceZones: convergenceAlerts
      .slice(0, 3)
      .map(a => ({ cellId: a.cellId, lat: a.lat, lon: a.lon, score: a.score })),
    unstableCountries: ciiScores.filter(s => s.score >= 50).slice(0, 5),
    timestamp: new Date(),
  };
}

function getCountryBaseline(code: string): number {
  return CURATED_COUNTRIES[code]?.baselineRisk ?? DEFAULT_BASELINE_RISK;
}

function calculateGlobalComponentPressure(scores: CountryScore[]): GlobalComponentPressure {
  if (scores.length === 0) return { component: 'conflict', score: 0 };

  const totals: Record<keyof CountryScore['components'], number> = {
    unrest: 0,
    conflict: 0,
    security: 0,
    information: 0,
  };

  for (const score of scores) {
    totals.unrest += score.components.unrest;
    totals.conflict += score.components.conflict;
    totals.security += score.components.security;
    totals.information += score.components.information;
  }

  const entries = Object.entries(totals) as Array<[keyof CountryScore['components'], number]>;
  entries.sort((a, b) => b[1] - a[1]);
  const [component, total] = entries[0] ?? ['conflict', 0];
  return { component, score: total / scores.length };
}

function calculateCIIRiskScore(scores: CountryScore[]): CIIRiskConsolidation {
  if (scores.length === 0) {
    return {
      score: 0,
      avgDeviation: 0,
      componentPressure: { component: 'conflict', score: 0 },
    };
  }

  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top5 = sorted.slice(0, 5);
  const weights = [0.4, 0.25, 0.2, 0.1, 0.05];
  let top5Score = 0;

  for (let i = 0; i < top5.length; i++) {
    const country = top5[i];
    const weight = weights[i];
    if (country && weight !== undefined) {
      top5Score += country.score * weight;
    }
  }

  const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const elevatedCount = scores.filter(s => s.score >= 51).length;
  const highCount = scores.filter(s => s.score >= 66).length;
  const criticalCount = scores.filter(s => s.score >= 81).length;

  const elevatedRatio = elevatedCount / scores.length;
  const highRatio = highCount / scores.length;
  const criticalRatio = criticalCount / scores.length;
  const breadthScore = Math.min(100, avgScore * 0.6 + elevatedRatio * 30 + highRatio * 35 + criticalRatio * 25);

  const avgDeviationRaw = scores.reduce((sum, s) => {
    return sum + Math.max(0, s.score - getCountryBaseline(s.code));
  }, 0) / scores.length;
  const avgDeviation = Math.round(avgDeviationRaw * 10) / 10;

  const componentPressure = calculateGlobalComponentPressure(scores);
  const componentBoost = Math.min(8, componentPressure.score * 0.08);

  const score = Math.min(100, Math.round(
    top5Score * 0.55 +
    breadthScore * 0.35 +
    avgDeviation * 0.1 +
    componentBoost
  ));

  return {
    score,
    avgDeviation,
    componentPressure,
  };
}

let previousCompositeScore: number | null = null;
function determineTrend(current: number): 'escalating' | 'stable' | 'de-escalating' {
  if (previousCompositeScore === null) {
    previousCompositeScore = current;
    return 'stable';
  }
  const diff = current - previousCompositeScore;
  previousCompositeScore = current;
  if (diff >= 3) return 'escalating';
  if (diff <= -3) return 'de-escalating';
  return 'stable';
}

function countInfrastructureIncidents(): number {
  return alerts.filter(a => a.components.cascade).length;
}

function identifyTopRisks(
  convergence: GeoConvergenceAlert[],
  cii: CountryScore[],
  componentPressure: GlobalComponentPressure,
): string[] {
  const risks: string[] = [];

  const top = convergence[0];
  if (top) {
    const location = getLocationName(top.lat, top.lon);
    risks.push(`Convergence: ${location} (score: ${top.score})`);
  }

  const componentLabel: Record<keyof CountryScore['components'], string> = {
    unrest: 'Civil unrest pressure',
    conflict: 'Conflict and attack pressure',
    security: 'Security disruption pressure',
    information: 'Critical news pressure',
  };
  if (componentPressure.score >= 25) {
    risks.push(`${componentLabel[componentPressure.component]} (global avg: ${Math.round(componentPressure.score)})`);
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
