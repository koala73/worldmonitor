/**
 * Pipeline Stages — INGEST → ENCODE → FILTER → COLLAPSE → SYNTHESIZE → EMIT
 *
 * Each stage is a pure function from input → output with invariant
 * verification at entry and exit. The pipeline runner orchestrates
 * execution and handles halts from fatal invariant violations.
 */

import type {
  Signal,
  EncodedSignal,
  CollapsedSignal,
  Severity,
  SignalDomain,
  StageResult,
} from '../types';
import { PipelineStage } from '../types';

// ============================================================================
// INGEST — Raw data → Signal atoms
// ============================================================================

export interface IngestInput {
  domain: SignalDomain;
  rawItems: Array<{
    id: string;
    severity: Severity;
    regions: string[];
    timestamp: number;
    geo?: { lat: number; lon: number };
    payload: unknown;
    confidence: number;
    tags: string[];
  }>;
}

export function ingest(inputs: IngestInput[]): Signal[] {
  const now = Date.now();
  const signals: Signal[] = [];

  for (const input of inputs) {
    for (const item of input.rawItems) {
      signals.push({
        id: `${input.domain}:${item.id}`,
        domain: input.domain,
        severity: item.severity,
        regions: item.regions,
        timestamp: item.timestamp,
        ingestedAt: now,
        geo: item.geo,
        payload: item.payload,
        confidence: item.confidence,
        provenance: [`ingest:${input.domain}`],
        tags: item.tags,
      });
    }
  }

  return signals;
}

// ============================================================================
// ENCODE — Signal → EncodedSignal (normalized scores + feature vectors)
// ============================================================================

/** Severity → base score mapping */
const SEVERITY_SCORE: Record<Severity, number> = {
  info: 10,
  low: 25,
  medium: 50,
  high: 75,
  critical: 95,
};

/** Domain weight multipliers for cross-domain comparison */
const DOMAIN_WEIGHT: Partial<Record<SignalDomain, number>> = {
  conflict: 1.3,
  military: 1.2,
  cyber: 1.1,
  unrest: 1.1,
  news: 0.8,
  economic: 0.9,
  climate: 0.7,
  wildfire: 0.7,
  seismology: 0.6,
};

export function encode(signals: Signal[]): EncodedSignal[] {
  const now = Date.now();

  return signals.map(signal => {
    const baseScore = SEVERITY_SCORE[signal.severity];
    const domainWeight = DOMAIN_WEIGHT[signal.domain] ?? 1.0;

    // Time decay — signals lose 1 point per hour of age
    const ageHours = (now - signal.timestamp) / (60 * 60 * 1000);
    const timeDecay = Math.max(0, Math.min(10, ageHours));

    // Confidence factor
    const confFactor = 0.5 + 0.5 * signal.confidence;

    const normalizedScore = Math.min(100, Math.max(0,
      baseScore * domainWeight * confFactor - timeDecay
    ));

    // Build a simple feature vector for similarity comparison
    // [severity_score, domain_index, recency, confidence, has_geo, region_count]
    const domainIndex = [
      'news', 'conflict', 'unrest', 'military', 'maritime', 'cyber',
      'economic', 'climate', 'infrastructure', 'seismology', 'wildfire',
      'displacement', 'aviation', 'prediction', 'intelligence',
    ].indexOf(signal.domain);

    const features = [
      normalizedScore / 100,
      domainIndex / 15,
      Math.max(0, 1 - ageHours / 24),
      signal.confidence,
      signal.geo ? 1 : 0,
      Math.min(signal.regions.length / 5, 1),
    ];

    return {
      ...signal,
      normalizedScore,
      features,
      encodedAt: now,
      provenance: [...signal.provenance, 'encode'],
    };
  });
}

// ============================================================================
// FILTER — Remove noise, deduplicate, threshold
// ============================================================================

export interface FilterConfig {
  /** Minimum normalized score to keep */
  minScore: number;
  /** Maximum age in hours */
  maxAgeHours: number;
  /** Minimum confidence */
  minConfidence: number;
  /** Deduplicate by domain+region within this time window (ms) */
  dedupeWindow: number;
}

const DEFAULT_FILTER: FilterConfig = {
  minScore: 5,
  maxAgeHours: 48,
  minConfidence: 0.1,
  dedupeWindow: 5 * 60 * 1000, // 5 minutes
};

export function filter(
  signals: EncodedSignal[],
  config: Partial<FilterConfig> = {},
): EncodedSignal[] {
  const cfg = { ...DEFAULT_FILTER, ...config };
  const now = Date.now();
  const maxAge = cfg.maxAgeHours * 60 * 60 * 1000;

  // Phase 1: threshold filter
  let filtered = signals.filter(s =>
    s.normalizedScore >= cfg.minScore &&
    s.confidence >= cfg.minConfidence &&
    (now - s.timestamp) <= maxAge
  );

  // Phase 2: deduplication (keep highest score per domain:region within window)
  const seen = new Map<string, EncodedSignal>();
  filtered = filtered.filter(s => {
    const key = `${s.domain}:${s.regions.sort().join(',')}`;
    const existing = seen.get(key);
    if (existing && Math.abs(s.timestamp - existing.timestamp) < cfg.dedupeWindow) {
      if (s.normalizedScore > existing.normalizedScore) {
        seen.set(key, s);
        return true;
      }
      return false;
    }
    seen.set(key, s);
    return true;
  });

  return filtered;
}

// ============================================================================
// COLLAPSE — Convergent signals merge upward into composite insights
// ============================================================================

import type { CollapseRule } from '../types';

/** Default collapse rules */
export const DEFAULT_COLLAPSE_RULES: CollapseRule[] = [
  {
    id: 'CR-001',
    name: 'Regional Multi-Domain Convergence',
    minSignals: 3,
    timeWindow: 6 * 60 * 60 * 1000, // 6 hours
    minDomainBreadth: 2,
    regionMatch: true,
    boostFactor: 1.5,
    priority: 10,
  },
  {
    id: 'CR-002',
    name: 'Crisis Cascade',
    minSignals: 2,
    timeWindow: 2 * 60 * 60 * 1000, // 2 hours
    requiredDomains: ['conflict', 'military'],
    regionMatch: true,
    boostFactor: 2.0,
    priority: 20,
  },
  {
    id: 'CR-003',
    name: 'Infrastructure Threat Convergence',
    minSignals: 2,
    timeWindow: 4 * 60 * 60 * 1000,
    requiredDomains: ['infrastructure', 'cyber'],
    regionMatch: false,
    geoRadiusKm: 500,
    boostFactor: 1.8,
    priority: 15,
  },
  {
    id: 'CR-004',
    name: 'Social Instability Surge',
    minSignals: 3,
    timeWindow: 12 * 60 * 60 * 1000,
    requiredDomains: ['unrest'],
    minDomainBreadth: 1,
    regionMatch: true,
    boostFactor: 1.3,
    priority: 5,
  },
  {
    id: 'CR-005',
    name: 'Geospatial Proximity Cluster',
    minSignals: 3,
    timeWindow: 4 * 60 * 60 * 1000,
    geoRadiusKm: 200,
    regionMatch: false,
    boostFactor: 1.4,
    priority: 8,
  },
];

/** Haversine distance in km */
function geoDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geoProximity(
  a: EncodedSignal,
  b: EncodedSignal,
  radiusKm: number,
): boolean {
  if (!a.geo || !b.geo) return false;
  return geoDistance(a.geo.lat, a.geo.lon, b.geo.lat, b.geo.lon) <= radiusKm;
}

export function collapse(
  signals: EncodedSignal[],
  rules: CollapseRule[] = DEFAULT_COLLAPSE_RULES,
): CollapsedSignal[] {
  const results: CollapsedSignal[] = [];
  const consumed = new Set<string>();

  // Sort rules by priority (higher first)
  const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sortedRules) {
    // Group candidates by region (or all together if regionMatch is false)
    const candidates = signals.filter(s => !consumed.has(s.id));

    const groups = rule.regionMatch
      ? groupByRegion(candidates)
      : rule.geoRadiusKm
        ? groupByProximity(candidates, rule.geoRadiusKm)
        : [candidates];

    for (const group of groups) {
      // Time window filter
      const inWindow = group.filter(s => {
        const newest = Math.max(...group.map(g => g.timestamp));
        return newest - s.timestamp <= rule.timeWindow;
      });

      if (inWindow.length < rule.minSignals) continue;

      // Domain breadth check
      const domains = new Set(inWindow.map(s => s.domain));
      if (rule.minDomainBreadth && domains.size < rule.minDomainBreadth) continue;

      // Required domains check
      if (rule.requiredDomains) {
        const hasDomains = rule.requiredDomains.every(d => domains.has(d));
        if (!hasDomains) continue;
      }

      // Build collapsed signal
      const maxScore = Math.max(...inWindow.map(s => s.normalizedScore));
      const avgScore = inWindow.reduce((sum, s) => sum + s.normalizedScore, 0) / inWindow.length;
      const compositeScore = Math.min(100,
        (maxScore * 0.6 + avgScore * 0.4) * rule.boostFactor
      );

      const allRegions = [...new Set(inWindow.flatMap(s => s.regions))];
      const maxSeverity = getMaxSeverity(inWindow.map(s => s.severity));

      results.push({
        id: `collapsed:${rule.id}:${allRegions.join(',')}:${Date.now()}`,
        sources: inWindow,
        severity: maxSeverity,
        regions: allRegions,
        compositeScore,
        domainBreadth: domains.size,
        collapseRule: rule.id,
        collapsedAt: Date.now(),
      });

      // Mark sources as consumed
      for (const s of inWindow) {
        consumed.add(s.id);
      }
    }
  }

  // Any uncollapsed signals become singleton collapsed signals
  for (const s of signals) {
    if (consumed.has(s.id)) continue;
    results.push({
      id: `singleton:${s.id}`,
      sources: [s],
      severity: s.severity,
      regions: s.regions,
      compositeScore: s.normalizedScore,
      domainBreadth: 1,
      collapseRule: 'none',
      collapsedAt: Date.now(),
    });
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

function groupByRegion(signals: EncodedSignal[]): EncodedSignal[][] {
  const map = new Map<string, EncodedSignal[]>();
  for (const s of signals) {
    const key = s.regions.sort().join(',') || '_global';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return [...map.values()];
}

function groupByProximity(signals: EncodedSignal[], radiusKm: number): EncodedSignal[][] {
  const groups: EncodedSignal[][] = [];
  const assigned = new Set<string>();

  for (const s of signals) {
    if (assigned.has(s.id) || !s.geo) continue;
    const group = [s];
    assigned.add(s.id);

    for (const other of signals) {
      if (assigned.has(other.id) || !other.geo) continue;
      if (geoProximity(s, other, radiusKm)) {
        group.push(other);
        assigned.add(other.id);
      }
    }

    if (group.length > 1) groups.push(group);
  }

  // Unassigned signals as singletons
  for (const s of signals) {
    if (!assigned.has(s.id)) groups.push([s]);
  }

  return groups;
}

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

function getMaxSeverity(severities: Severity[]): Severity {
  let max = 0;
  for (const s of severities) {
    const idx = SEVERITY_ORDER.indexOf(s);
    if (idx > max) max = idx;
  }
  return SEVERITY_ORDER[max] ?? 'info';
}

// ============================================================================
// SYNTHESIZE — Collapsed signals → Intelligence findings
// ============================================================================

import type { Finding, FocalPointBrief, TrendDirection } from '../types';

export interface SynthesisOutput {
  findings: Finding[];
  focalPoints: FocalPointBrief[];
  overallThreatLevel: Severity;
}

export function synthesize(collapsed: CollapsedSignal[]): SynthesisOutput {
  const findings: Finding[] = [];
  const focalPointMap = new Map<string, {
    signals: CollapsedSignal[];
    domains: Set<SignalDomain>;
    totalScore: number;
    count: number;
  }>();

  // Generate findings from collapsed signals
  for (const c of collapsed) {
    if (c.compositeScore < 20 && c.collapseRule === 'none') continue;

    const finding: Finding = {
      id: `finding:${c.id}`,
      title: buildFindingTitle(c),
      severity: c.severity,
      regions: c.regions,
      domains: [...new Set(c.sources.map(s => s.domain))],
      summary: buildFindingSummary(c),
      sourceSignals: c.sources.map(s => s.id),
      confidence: c.sources.reduce((sum, s) => sum + s.confidence, 0) / c.sources.length,
    };
    findings.push(finding);

    // Accumulate focal point data
    for (const region of c.regions) {
      if (!focalPointMap.has(region)) {
        focalPointMap.set(region, {
          signals: [],
          domains: new Set(),
          totalScore: 0,
          count: 0,
        });
      }
      const fp = focalPointMap.get(region)!;
      fp.signals.push(c);
      for (const s of c.sources) fp.domains.add(s.domain);
      fp.totalScore += c.compositeScore;
      fp.count += 1;
    }
  }

  // Build focal points
  const focalPoints: FocalPointBrief[] = [...focalPointMap.entries()]
    .filter(([, v]) => v.count >= 2 || v.domains.size >= 2)
    .map(([entity, data]) => ({
      entity,
      entityType: 'country' as const,
      convergenceScore: Math.min(100, data.totalScore / data.count * (data.domains.size / 3)),
      activeDomains: [...data.domains],
      narrative: buildNarrative(entity, data.signals),
      trend: deriveTrend(data.signals) as TrendDirection,
    }))
    .sort((a, b) => b.convergenceScore - a.convergenceScore)
    .slice(0, 10);

  // Overall threat level
  const maxFinding = findings[0];
  const overallThreatLevel: Severity = maxFinding?.severity ?? 'low';

  return { findings, focalPoints, overallThreatLevel };
}

function buildFindingTitle(c: CollapsedSignal): string {
  const domains = [...new Set(c.sources.map(s => s.domain))];
  const region = c.regions[0] ?? 'Global';
  if (c.collapseRule === 'none') {
    return `${region}: ${domains[0]} signal (score ${c.compositeScore.toFixed(0)})`;
  }
  return `${region}: ${domains.join('+')} convergence (${c.sources.length} signals, score ${c.compositeScore.toFixed(0)})`;
}

function buildFindingSummary(c: CollapsedSignal): string {
  const domains = [...new Set(c.sources.map(s => s.domain))];
  const regions = c.regions.join(', ');
  return `${c.sources.length} signal(s) across ${domains.join(', ')} domains converged in ${regions || 'unknown region'}. ` +
    `Composite score: ${c.compositeScore.toFixed(1)}, domain breadth: ${c.domainBreadth}. ` +
    `Collapse rule: ${c.collapseRule}.`;
}

function buildNarrative(entity: string, signals: CollapsedSignal[]): string {
  const domains = [...new Set(signals.flatMap(s => s.sources.map(src => src.domain)))];
  const totalSources = signals.reduce((sum, s) => sum + s.sources.length, 0);
  return `${entity} shows activity across ${domains.join(', ')} (${totalSources} raw signals).`;
}

function deriveTrend(signals: CollapsedSignal[]): string {
  if (signals.length < 2) return 'stable';
  const recent = signals.filter(s => Date.now() - s.collapsedAt < 3600_000);
  const older = signals.filter(s => Date.now() - s.collapsedAt >= 3600_000);
  if (recent.length > older.length) return 'rising';
  if (recent.length < older.length) return 'falling';
  return 'stable';
}

// ============================================================================
// STAGE RESULT BUILDER
// ============================================================================

export function buildStageResult<T>(
  stage: PipelineStage,
  input: unknown,
  output: T,
  startTime: number,
  passedIds: string[],
  violations: import('../types').InvariantViolation[],
  droppedCount: number,
): StageResult<T> {
  return {
    stage,
    input,
    output,
    duration: performance.now() - startTime,
    invariantsPassed: passedIds,
    invariantsFailed: violations,
    droppedCount,
  };
}
