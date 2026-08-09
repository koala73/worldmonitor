/**
 * Focal Point Detector Core - Intelligence Synthesis Layer
 *
 * Correlates news entities with map signals to identify "main characters"
 * that appear across multiple intelligence streams.
 *
 * Example: IRAN mentioned in 12 news clusters + 5 military flights + internet outage
 * = CRITICAL focal point with rich narrative for AI
 *
 * Extracted from `src/services/focal-point-detector.ts`. Everything here is pure
 * and dependency-free (no `src/`, no `@/`, no DOM) so it can be bundled for Edge
 * runtimes and driven from server-side callers. The entity index is injected;
 * this module never reaches for a singleton. `src/services/focal-point-detector.ts`
 * keeps the stateful `focalPointDetector` singleton the dashboard uses.
 */

import {
  extractEntityContexts,
  type EntityIndex,
} from './entity-extraction-core.js';
import type { EntityType } from './entity-registry.js';

// ============================================================================
// Structural input shapes — the subset of the client types this core reads.
// The corresponding `src/` types are structurally assignable to these.
// ============================================================================

export type SignalType =
  | 'internet_outage'
  | 'military_flight'
  | 'military_vessel'
  | 'protest'
  | 'ais_disruption'
  | 'satellite_fire'
  | 'radiation_anomaly'
  | 'temporal_anomaly'
  | 'sanctions_pressure'
  | 'active_strike';

export interface GeoSignal {
  type: SignalType;
  severity: 'low' | 'medium' | 'high';
  strikeCount?: number;
  highSeverityStrikeCount?: number;
}

export interface CountrySignalCluster {
  country: string;
  signals: GeoSignal[];
  signalTypes: Set<SignalType>;
  totalCount: number;
  highSeverityCount: number;
}

export interface SignalSummary {
  topCountries: CountrySignalCluster[];
}

/** Minimal structural shape the detector reads off a news cluster. */
export interface FocalClusterInput {
  id: string;
  primaryTitle: string;
  primaryLink: string;
  allItems?: Array<{ title: string }>;
}

/**
 * Minimal shape of a per-cluster news entity context. Both the shared
 * `extractEntityContexts` and the client's `extractEntitiesFromClusters`
 * produce maps that satisfy this.
 */
export interface EntityContextInput {
  entities: Array<{ entityId: string; confidence: number }>;
}

// ============================================================================
// Output shapes
// ============================================================================

export type FocalPointUrgency = 'watch' | 'elevated' | 'critical';

export interface HeadlineWithUrl {
  title: string;
  url: string;
}

export interface EntityMention {
  entityId: string;
  entityType: EntityType;
  displayName: string;
  mentionCount: number;
  avgConfidence: number;
  clusterIds: string[];
  topHeadlines: HeadlineWithUrl[];
}

export interface FocalPoint {
  id: string;
  entityId: string;
  entityType: EntityType;
  displayName: string;

  // News dimension
  newsMentions: number;
  newsVelocity: number;
  topHeadlines: HeadlineWithUrl[];

  // Signal dimension
  signalTypes: SignalType[];
  signalCount: number;
  highSeverityCount: number;
  signalDescriptions: string[];

  // Scoring
  focalScore: number;
  urgency: FocalPointUrgency;

  // For AI context
  narrative: string;
  correlationEvidence: string[];
}

export interface FocalPointSummary {
  timestamp: Date;
  focalPoints: FocalPoint[];
  aiContext: string;
  topCountries: FocalPoint[];
  topCompanies: FocalPoint[];
}

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  internet_outage: 'internet outage',
  military_flight: 'military flights',
  military_vessel: 'naval vessels',
  protest: 'protests',
  ais_disruption: 'shipping disruption',
  satellite_fire: 'satellite fires',
  radiation_anomaly: 'radiation anomalies',
  temporal_anomaly: 'anomaly detection',
  sanctions_pressure: 'sanctions pressure',
  active_strike: 'active strikes',
};

export const SIGNAL_TYPE_ICONS: Record<SignalType, string> = {
  internet_outage: '🌐',
  military_flight: '✈️',
  military_vessel: '⚓',
  protest: '📢',
  ais_disruption: '🚢',
  satellite_fire: '🔥',
  radiation_anomaly: '☢️',
  temporal_anomaly: '📊',
  sanctions_pressure: '🚫',
  active_strike: '💥',
};

/**
 * Check if entity name/alias appears in headline title (case-insensitive)
 * This ensures we only show headlines that are actually ABOUT the entity
 */
export function entityAppearsInTitle(entityId: string, title: string, index: EntityIndex): boolean {
  const entity = index.byId.get(entityId);
  if (!entity) return false;

  const titleLower = title.toLowerCase();

  // Check entity name
  if (titleLower.includes(entity.name.toLowerCase())) return true;

  // Check aliases
  for (const alias of entity.aliases) {
    if (titleLower.includes(alias.toLowerCase())) return true;
  }

  return false;
}

/**
 * Aggregate entity mentions across all news clusters
 */
export function aggregateEntities(
  entityContexts: Map<string, EntityContextInput>,
  clusters: FocalClusterInput[],
  index: EntityIndex
): Map<string, EntityMention> {
  const mentions = new Map<string, EntityMention>();
  const clustersById = new Map<string, FocalClusterInput>();
  for (const cluster of clusters) {
    if (!clustersById.has(cluster.id)) clustersById.set(cluster.id, cluster);
  }

  for (const [clusterId, context] of entityContexts) {
    const cluster = clustersById.get(clusterId);
    if (!cluster) continue;

    for (const entity of context.entities) {
      const entityEntry = index.byId.get(entity.entityId);
      if (!entityEntry) continue;

      // Only add headline if entity appears in the title (not just mentioned in body)
      const titleHasEntity = entityAppearsInTitle(entity.entityId, cluster.primaryTitle, index);

      const existing = mentions.get(entity.entityId);
      if (existing) {
        existing.mentionCount++;
        existing.avgConfidence = (existing.avgConfidence * (existing.mentionCount - 1) + entity.confidence) / existing.mentionCount;
        existing.clusterIds.push(clusterId);
        // Only add headlines where entity is prominent in title
        if (existing.topHeadlines.length < 3 && titleHasEntity) {
          existing.topHeadlines.push({ title: cluster.primaryTitle, url: cluster.primaryLink });
        }
      } else {
        mentions.set(entity.entityId, {
          entityId: entity.entityId,
          entityType: entityEntry.type,
          displayName: entityEntry.name,
          mentionCount: 1,
          avgConfidence: entity.confidence,
          clusterIds: [clusterId],
          // Only include headline if entity appears in title
          topHeadlines: titleHasEntity ? [{ title: cluster.primaryTitle, url: cluster.primaryLink }] : [],
        });
      }
    }
  }

  return mentions;
}

/**
 * Build focal points by correlating news entities with map signals
 */
export function buildFocalPoints(
  entityMentions: Map<string, EntityMention>,
  signalSummary: SignalSummary,
  index: EntityIndex
): FocalPoint[] {
  const focalPoints: FocalPoint[] = [];
  const countrySignals = new Map<string, CountrySignalCluster>();

  for (const cluster of signalSummary.topCountries) {
    countrySignals.set(cluster.country, cluster);
  }

  for (const [entityId, mention] of entityMentions) {
    const entityEntry = index.byId.get(entityId);
    if (!entityEntry) continue;

    let signals: CountrySignalCluster | undefined;
    let signalCountry: string | undefined;

    if (entityEntry.type === 'country') {
      signals = countrySignals.get(entityId);
      signalCountry = entityId;
    } else if (entityEntry.related) {
      for (const relatedId of entityEntry.related) {
        const relatedEntity = index.byId.get(relatedId);
        if (relatedEntity?.type === 'country') {
          signals = countrySignals.get(relatedId);
          if (signals) {
            signalCountry = relatedId;
            break;
          }
        }
      }
    }

    const focalPoint = createFocalPoint(mention, signals, signalCountry);
    focalPoints.push(focalPoint);
  }

  for (const [countryCode, signals] of countrySignals) {
    if (!entityMentions.has(countryCode)) {
      const countryEntity = index.byId.get(countryCode);
      if (countryEntity) {
        const mention: EntityMention = {
          entityId: countryCode,
          entityType: 'country',
          displayName: countryEntity.name,
          mentionCount: 0,
          avgConfidence: 0,
          clusterIds: [],
          topHeadlines: [],
        };
        const focalPoint = createFocalPoint(mention, signals, countryCode);
        if (focalPoint.focalScore > 20) {
          focalPoints.push(focalPoint);
        }
      }
    }
  }

  return focalPoints.sort((a, b) => b.focalScore - a.focalScore);
}

/**
 * Create a focal point with scoring and narrative
 */
export function createFocalPoint(
  mention: EntityMention,
  signals: CountrySignalCluster | undefined,
  _signalCountry: string | undefined
): FocalPoint {
  const newsScore = calculateNewsScore(mention);
  const signalScore = signals ? calculateSignalScore(signals) : 0;
  const correlationBonus = calculateCorrelationBonus(mention, signals);
  const conflictScore = signals ? calculateConflictScore(signals) : 0;
  const rawScore = newsScore + signalScore + correlationBonus + conflictScore;

  const signalTypes = signals ? Array.from(signals.signalTypes) : [];
  const urgency = determineUrgency(rawScore, signalTypes.length);
  const urgencyMultiplier = urgency === 'critical' ? 1.3 : urgency === 'elevated' ? 1.15 : 1.0;
  const focalScore = Math.min(100, rawScore * urgencyMultiplier);

  const signalDescriptions = signals
    ? signalTypes.map(type => {
        const count = signals.signals.filter(s => s.type === type).length;
        return `${count} ${SIGNAL_TYPE_LABELS[type]}`;
      })
    : [];

  const narrative = generateNarrative(mention, signals, signalTypes);
  const correlationEvidence = getCorrelationEvidence(mention, signals);

  return {
    id: `fp-${mention.entityId}`,
    entityId: mention.entityId,
    entityType: mention.entityType,
    displayName: mention.displayName,
    newsMentions: mention.mentionCount,
    newsVelocity: mention.mentionCount / 24,
    topHeadlines: mention.topHeadlines,
    signalTypes,
    signalCount: signals?.totalCount || 0,
    highSeverityCount: signals?.highSeverityCount || 0,
    signalDescriptions,
    focalScore,
    urgency,
    narrative,
    correlationEvidence,
  };
}

export function calculateNewsScore(mention: Pick<EntityMention, 'mentionCount' | 'avgConfidence'>): number {
  const base = Math.min(20, mention.mentionCount * 4);
  const velocity = Math.min(10, (mention.mentionCount / 24) * 2);
  const confidence = mention.avgConfidence * 10;
  return base + velocity + confidence;
}

export function calculateSignalScore(signals: CountrySignalCluster): number {
  const nonStrike = signals.signals.filter(s => s.type !== 'active_strike');
  const types = new Set(nonStrike.map(s => s.type));
  const typeBonus = types.size * 10;
  const countBonus = Math.min(15, nonStrike.length * 3);
  const severityBonus = nonStrike.filter(s => s.severity === 'high').length * 5;
  return typeBonus + countBonus + severityBonus;
}

export function calculateConflictScore(signals: CountrySignalCluster): number {
  const strikeSignals = signals.signals.filter(s => s.type === 'active_strike');
  if (strikeSignals.length === 0) return 0;

  let totalCount = 0;
  let highSevCount = 0;
  for (const s of strikeSignals) {
    totalCount += s.strikeCount ?? 0;
    highSevCount += s.highSeverityStrikeCount ?? 0;
  }

  const base = Math.min(30, totalCount * 1.5);
  const severityBonus = Math.min(30, highSevCount * 3);
  return base + severityBonus;
}

export function calculateCorrelationBonus(
  mention: Pick<EntityMention, 'mentionCount' | 'topHeadlines'>,
  signals: CountrySignalCluster | undefined
): number {
  let bonus = 0;

  if (mention.mentionCount > 0 && signals && signals.totalCount > 0) {
    bonus += 10;
  }

  if (signals && mention.topHeadlines.some(h => {
    const lower = h.title.toLowerCase();
    return (signals.signalTypes.has('military_flight') && /military|troops|forces|army|air force/.test(lower)) ||
           (signals.signalTypes.has('military_vessel') && /navy|naval|ships|fleet|carrier/.test(lower)) ||
           (signals.signalTypes.has('protest') && /protest|demonstrat|unrest|riot/.test(lower)) ||
           (signals.signalTypes.has('internet_outage') && /internet|blackout|outage|connectivity/.test(lower)) ||
           (signals.signalTypes.has('sanctions_pressure') && /sanction|designation|ofac|treasury|embargo|blacklist/.test(lower)) ||
           (signals.signalTypes.has('radiation_anomaly') && /nuclear|radiation|reactor|contamination|radnet/.test(lower)) ||
           (signals.signalTypes.has('active_strike') && /strike|attack|bomb|missile|target|hit/.test(lower));
  })) {
    bonus += 5;
  }

  return bonus;
}

export function determineUrgency(score: number, signalTypeCount: number): FocalPointUrgency {
  if (score > 70 || signalTypeCount >= 3) return 'critical';
  if (score > 50 || signalTypeCount >= 2) return 'elevated';
  return 'watch';
}

export function generateNarrative(
  mention: Pick<EntityMention, 'mentionCount' | 'topHeadlines'>,
  signals: CountrySignalCluster | undefined,
  signalTypes: SignalType[]
): string {
  const parts: string[] = [];

  if (mention.mentionCount > 0) {
    parts.push(`${mention.mentionCount} news mentions`);
  }

  if (signals && signalTypes.length > 0) {
    const signalParts = signalTypes.map(type => {
      const count = signals.signals.filter(s => s.type === type).length;
      return `${count} ${SIGNAL_TYPE_LABELS[type]}`;
    });
    parts.push(signalParts.join(', '));
  }

  if (mention.topHeadlines.length > 0 && mention.topHeadlines[0]) {
    const headline = mention.topHeadlines[0].title.slice(0, 60);
    parts.push(`"${headline}..."`);
  }

  return parts.join(' | ');
}

export function getCorrelationEvidence(
  mention: Pick<EntityMention, 'mentionCount' | 'displayName'>,
  signals: CountrySignalCluster | undefined
): string[] {
  const evidence: string[] = [];

  if (mention.mentionCount > 0 && signals && signals.totalCount > 0) {
    evidence.push(`${mention.displayName} appears in both news (${mention.mentionCount}) and map signals (${signals.totalCount})`);
  }

  if (signals && signals.signalTypes.size >= 2) {
    const types = Array.from(signals.signalTypes).map(t => SIGNAL_TYPE_LABELS[t]);
    evidence.push(`Multiple signal convergence: ${types.join(' + ')}`);
  }

  if (signals && signals.highSeverityCount > 0) {
    evidence.push(`${signals.highSeverityCount} high-severity signals detected`);
  }

  return evidence;
}

/**
 * Generate rich AI context for summarization
 */
export function generateAIContext(focalPoints: FocalPoint[]): string {
  if (focalPoints.length === 0) {
    return '';
  }

  const lines: string[] = ['[INTELLIGENCE SYNTHESIS]'];

  const critical = focalPoints.filter(fp => fp.urgency === 'critical').slice(0, 3);
  const elevated = focalPoints.filter(fp => fp.urgency === 'elevated').slice(0, 3);
  const correlatedFPs = focalPoints.filter(fp => fp.newsMentions > 0 && fp.signalCount > 0).slice(0, 5);

  if (critical.length > 0) {
    lines.push('');
    lines.push('CRITICAL FOCAL POINTS:');
    for (const fp of critical) {
      const icons = fp.signalTypes.map(t => SIGNAL_TYPE_ICONS[t as SignalType]).join('');
      lines.push(`- ${fp.displayName} [CRITICAL] ${icons}: ${fp.narrative}`);
      if (fp.correlationEvidence.length > 0) {
        lines.push(`  → ${fp.correlationEvidence[0]}`);
      }
    }
  }

  if (elevated.length > 0) {
    lines.push('');
    lines.push('ELEVATED WATCH:');
    for (const fp of elevated) {
      lines.push(`- ${fp.displayName}: ${fp.newsMentions} news, ${fp.signalCount} signals`);
    }
  }

  if (correlatedFPs.length > 0) {
    lines.push('');
    lines.push('NEWS-SIGNAL CORRELATIONS:');
    for (const fp of correlatedFPs) {
      const signalDesc = fp.signalTypes.map(t => SIGNAL_TYPE_LABELS[t as SignalType]).join(', ');
      lines.push(`- ${fp.displayName}: news coverage + ${signalDesc} detected`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate application-authored context for agent consumers without copying
 * source headlines, generated narratives, or correlation evidence.
 */
export function generateAgentSafeAIContext(focalPoints: FocalPoint[]): string {
  if (focalPoints.length === 0) {
    return '';
  }

  const lines: string[] = ['[INTELLIGENCE SYNTHESIS]'];
  const critical = focalPoints.filter(fp => fp.urgency === 'critical').slice(0, 3);
  const elevated = focalPoints.filter(fp => fp.urgency === 'elevated').slice(0, 3);
  const correlatedFPs = focalPoints.filter(fp => fp.newsMentions > 0 && fp.signalCount > 0).slice(0, 5);

  if (critical.length > 0) {
    lines.push('', 'CRITICAL FOCAL POINTS:');
    for (const fp of critical) {
      const signalDesc = fp.signalTypes
        .map(t => SIGNAL_TYPE_LABELS[t as SignalType])
        .filter(Boolean)
        .join(', ');
      const signalSuffix = signalDesc ? ` (${signalDesc})` : '';
      lines.push(
        `- ${fp.displayName} [CRITICAL]: ${fp.newsMentions} news mentions, ${fp.signalCount} map signals${signalSuffix}`,
      );
    }
  }

  if (elevated.length > 0) {
    lines.push('', 'ELEVATED WATCH:');
    for (const fp of elevated) {
      lines.push(`- ${fp.displayName}: ${fp.newsMentions} news, ${fp.signalCount} signals`);
    }
  }

  if (correlatedFPs.length > 0) {
    lines.push('', 'NEWS-SIGNAL CORRELATIONS:');
    for (const fp of correlatedFPs) {
      const signalDesc = fp.signalTypes.map(t => SIGNAL_TYPE_LABELS[t as SignalType]).join(', ');
      lines.push(`- ${fp.displayName}: news coverage + ${signalDesc} detected`);
    }
  }

  return lines.join('\n');
}

/**
 * Get signal icons for UI display
 */
export function getSignalIcons(signalTypes: string[]): string {
  return signalTypes.map(t => SIGNAL_TYPE_ICONS[t as SignalType] || '').join(' ');
}

/**
 * Stateless focal point detector. Holds only the injected entity index —
 * `analyze` is a pure function of its arguments.
 */
export class FocalPointCore {
  constructor(private readonly index: EntityIndex) {}

  /**
   * Main analysis entry point - correlates news clusters with map signals.
   *
   * `entityContexts` is optional: server-side callers can omit it and let the
   * core run its own extraction, while the dashboard passes the contexts it
   * already computed via `src/services/entity-extraction.ts`.
   */
  analyze(
    clusters: FocalClusterInput[],
    signalSummary: SignalSummary,
    entityContexts?: Map<string, EntityContextInput>
  ): FocalPointSummary {
    const contexts = entityContexts ?? extractEntityContexts(clusters, this.index);
    const entityMentions = aggregateEntities(contexts, clusters, this.index);
    const focalPoints = buildFocalPoints(entityMentions, signalSummary, this.index);
    const aiContext = generateAIContext(focalPoints);

    return {
      timestamp: new Date(),
      focalPoints,
      aiContext,
      topCountries: focalPoints.filter(fp => fp.entityType === 'country').slice(0, 5),
      topCompanies: focalPoints.filter(fp => fp.entityType === 'company').slice(0, 3),
    };
  }
}
