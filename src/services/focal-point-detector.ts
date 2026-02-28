/**
 * Focal Point Detector - Intelligence Synthesis Layer
 *
 * Correlates news entities with map signals to identify "main characters"
 * that appear across multiple intelligence streams.
 *
 * Example: IRAN mentioned in 12 news clusters + 5 military flights + internet outage
 * = CRITICAL focal point with rich narrative for AI
 */

import type { ClusteredEvent, FocalPoint, FocalPointSummary, EntityMention } from '@/types';
import type { SignalSummary, CountrySignalCluster, SignalType } from './signal-aggregator';
import { extractEntitiesFromClusters, type NewsEntityContext } from './entity-extraction';
import { getEntityIndex, type EntityIndex } from './entity-index';

const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  internet_outage: 'internet outage',
  military_flight: 'military flights',
  military_vessel: 'naval vessels',
  protest: 'protests',
  ais_disruption: 'shipping disruption',
  satellite_fire: 'satellite fires',
  temporal_anomaly: 'anomaly detection',
  active_strike: 'active strikes',
};

const SIGNAL_TYPE_ICONS: Record<SignalType, string> = {
  internet_outage: '🌐',
  military_flight: '✈️',
  military_vessel: '⚓',
  protest: '📢',
  ais_disruption: '🚢',
  satellite_fire: '🔥',
  temporal_anomaly: '📊',
  active_strike: '💥',
};

class FocalPointDetector {
  private lastSummary: FocalPointSummary | null = null;

  /**
   * Check if entity name/alias appears in headline title (case-insensitive)
   * This ensures we only show headlines that are actually ABOUT the entity
   */
  private entityAppearsInTitle(entityId: string, title: string, index: EntityIndex): boolean {
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
   * Main analysis entry point - correlates news clusters with map signals
   */
  analyze(clusters: ClusteredEvent[], signalSummary: SignalSummary): FocalPointSummary {
    const entityContexts = extractEntitiesFromClusters(clusters);
    const entityMentions = this.aggregateEntities(entityContexts, clusters);
    const focalPoints = this.buildFocalPoints(entityMentions, signalSummary);
    const aiContext = this.generateAIContext(focalPoints);

    this.lastSummary = {
      timestamp: new Date(),
      focalPoints,
      aiContext,
      topCountries: focalPoints.filter(fp => fp.entityType === 'country').slice(0, 5),
      topCompanies: focalPoints.filter(fp => fp.entityType === 'company').slice(0, 3),
    };

    return this.lastSummary;
  }

  /**
   * Aggregate entity mentions across all news clusters
   */
  private aggregateEntities(
    entityContexts: Map<string, NewsEntityContext>,
    clusters: ClusteredEvent[]
  ): Map<string, EntityMention> {
    const mentions = new Map<string, EntityMention>();
    const index = getEntityIndex();

    for (const [clusterId, context] of entityContexts) {
      const cluster = clusters.find(c => c.id === clusterId);
      if (!cluster) continue;

      for (const entity of context.entities) {
        const entityEntry = index.byId.get(entity.entityId);
        if (!entityEntry) continue;

        // Only add headline if entity appears in the title (not just mentioned in body)
        const titleHasEntity = this.entityAppearsInTitle(entity.entityId, cluster.primaryTitle, index);

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
  private buildFocalPoints(
    entityMentions: Map<string, EntityMention>,
    signalSummary: SignalSummary
  ): FocalPoint[] {
    const focalPoints: FocalPoint[] = [];
    const index = getEntityIndex();
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

      const focalPoint = this.createFocalPoint(mention, signals, signalCountry);
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
          const focalPoint = this.createFocalPoint(mention, signals, countryCode);
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
  private createFocalPoint(
    mention: EntityMention,
    signals: CountrySignalCluster | undefined,
    _signalCountry: string | undefined
  ): FocalPoint {
    const newsScore = this.calculateNewsScore(mention);
    const signalScore = signals ? this.calculateSignalScore(signals) : 0;
    const correlationBonus = this.calculateCorrelationBonus(mention, signals);
    const conflictScore = signals ? this.calculateConflictScore(signals) : 0;
    const rawScore = newsScore + signalScore + correlationBonus + conflictScore;

    const signalTypes = signals ? Array.from(signals.signalTypes) : [];
    const urgency = this.determineUrgency(rawScore, signalTypes.length);
    const urgencyMultiplier = urgency === 'critical' ? 1.3 : urgency === 'elevated' ? 1.15 : 1.0;
    const focalScore = Math.min(100, rawScore * urgencyMultiplier);

    const signalDescriptions = signals
      ? signalTypes.map(type => {
          const count = signals.signals.filter(s => s.type === type).length;
          return `${count} ${SIGNAL_TYPE_LABELS[type]}`;
        })
      : [];

    const narrative = this.generateNarrative(mention, signals, signalTypes);
    const correlationEvidence = this.getCorrelationEvidence(mention, signals);

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

  private calculateNewsScore(mention: EntityMention): number {
    const base = Math.min(20, mention.mentionCount * 4);
    const velocity = Math.min(10, (mention.mentionCount / 24) * 2);
    const confidence = mention.avgConfidence * 10;
    return base + velocity + confidence;
  }

  private calculateSignalScore(signals: CountrySignalCluster): number {
    const nonStrike = signals.signals.filter(s => s.type !== 'active_strike');
    const types = new Set(nonStrike.map(s => s.type));
    const typeBonus = types.size * 10;
    const countBonus = Math.min(15, nonStrike.length * 3);
    const severityBonus = nonStrike.filter(s => s.severity === 'high').length * 5;
    return typeBonus + countBonus + severityBonus;
  }

  private calculateConflictScore(signals: CountrySignalCluster): number {
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

  private calculateCorrelationBonus(
    mention: EntityMention,
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
             (signals.signalTypes.has('active_strike') && /strike|attack|bomb|missile|target|hit/.test(lower));
    })) {
      bonus += 5;
    }

    return bonus;
  }

  private determineUrgency(score: number, signalTypeCount: number): 'watch' | 'elevated' | 'critical' {
    if (score > 70 || signalTypeCount >= 3) return 'critical';
    if (score > 50 || signalTypeCount >= 2) return 'elevated';
    return 'watch';
  }

  private generateNarrative(
    mention: EntityMention,
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

  private getCorrelationEvidence(
    mention: EntityMention,
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
  private generateAIContext(focalPoints: FocalPoint[]): string {
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
   * Get signal icons for UI display
   */
  getSignalIcons(signalTypes: string[]): string {
    return signalTypes.map(t => SIGNAL_TYPE_ICONS[t as SignalType] || '').join(' ');
  }

  /**
   * Get last computed summary
   */
  getLastSummary(): FocalPointSummary | null {
    return this.lastSummary;
  }

  /**
   * Get urgency level for a specific country (for CII integration)
   * Returns the focal point urgency if found, null otherwise
   */
  getCountryUrgency(countryCode: string): 'watch' | 'elevated' | 'critical' | null {
    if (!this.lastSummary) return null;
    const fp = this.lastSummary.focalPoints.find(
      fp => fp.entityType === 'country' && fp.entityId === countryCode
    );
    return fp?.urgency || null;
  }

  /**
   * Get all country urgencies as a map (for batch CII calculation)
   */
  getCountryUrgencyMap(): Map<string, 'watch' | 'elevated' | 'critical'> {
    const map = new Map<string, 'watch' | 'elevated' | 'critical'>();
    if (!this.lastSummary) return map;
    for (const fp of this.lastSummary.focalPoints) {
      if (fp.entityType === 'country') {
        map.set(fp.entityId, fp.urgency);
      }
    }
    return map;
  }

  /**
   * Get full focal point data for a country (for military surge integration)
   * Returns focal point with news headlines and correlation evidence
   */
  getFocalPointForCountry(countryCode: string): FocalPoint | null {
    if (!this.lastSummary) return null;
    return this.lastSummary.focalPoints.find(
      fp => fp.entityType === 'country' && fp.entityId === countryCode
    ) || null;
  }

  /**
   * Get news correlation context for multiple countries (for surge alerts)
   * Returns formatted string describing news-signal correlations
   */
  getNewsCorrelationContext(countryCodes: string[]): string | null {
    if (!this.lastSummary) return null;

    const relevantFPs = this.lastSummary.focalPoints.filter(
      fp => fp.entityType === 'country' && countryCodes.includes(fp.entityId) && fp.newsMentions > 0
    );

    if (relevantFPs.length === 0) return null;

    const lines: string[] = [];
    for (const fp of relevantFPs.slice(0, 3)) {
      const headline = fp.topHeadlines[0];
      if (headline) {
        lines.push(`${fp.displayName}: "${headline.title.slice(0, 80)}..."`);
      }
      const evidence = fp.correlationEvidence[0];
      if (evidence) {
        lines.push(`  → ${evidence}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

}

export const focalPointDetector = new FocalPointDetector();
