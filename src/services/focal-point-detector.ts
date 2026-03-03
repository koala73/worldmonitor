/**
 * Opportunity Convergence Detector (was: Focal Point Detector)
 *
 * Correlates signals across multiple types to identify companies
 * where 3+ signal types converge within 30 days.
 *
 * Example: Acme Corp has funding + hiring surge + tech adoption + new CTO
 * = CRITICAL opportunity convergence alert
 */

import type { ClusteredEvent, FocalPoint, FocalPointSummary, EntityMention } from '@/types';
import type { CompanySignalCluster, SignalType } from './signal-aggregator';
import { extractEntitiesFromClusters, type NewsEntityContext } from './entity-extraction';
import { getEntityIndex, type EntityIndex } from './entity-index';

const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  executive_movement: 'executive change',
  funding_event: 'funding activity',
  expansion_signal: 'expansion plans',
  technology_adoption: 'technology changes',
  hiring_surge: 'hiring surge',
  financial_trigger: 'financial event',
  leadership_activity: 'leadership activity',
  press_release: 'press coverage',
  job_posting: 'job postings',
  tender_rfp: 'tender/RFP',
};

class OpportunityConvergenceDetector {
  private lastSummary: FocalPointSummary | null = null;

  private entityAppearsInTitle(entityId: string, title: string, index: EntityIndex): boolean {
    const entity = index.byId.get(entityId);
    if (!entity) return false;
    const titleLower = title.toLowerCase();
    if (titleLower.includes(entity.name.toLowerCase())) return true;
    for (const alias of entity.aliases) {
      if (titleLower.includes(alias.toLowerCase())) return true;
    }
    return false;
  }

  detect(
    clusters: ClusteredEvent[],
    companyClusters?: CompanySignalCluster[],
  ): FocalPointSummary {
    const entityIndex = getEntityIndex();
    const entityContexts = extractEntitiesFromClusters(clusters);
    const focalPoints: FocalPoint[] = [];

    for (const ctx of entityContexts) {
      const entity = entityIndex.byId.get(ctx.entityId);
      if (!entity) continue;

      const relevantHeadlines = ctx.headlines
        .filter(h => this.entityAppearsInTitle(ctx.entityId, h.title, entityIndex))
        .slice(0, 5);
      if (relevantHeadlines.length === 0) continue;

      const signalTypesFromNews = new Set<string>();
      for (const headline of relevantHeadlines) {
        const title = headline.title.toLowerCase();
        if (/funding|raised|series [a-f]|investment/i.test(title)) signalTypesFromNews.add('funding_event');
        if (/hire|appointed|new cto|new cio|joins as/i.test(title)) signalTypesFromNews.add('executive_movement');
        if (/expansion|new office|market entry/i.test(title)) signalTypesFromNews.add('expansion_signal');
        if (/technology|cloud|migration|platform/i.test(title)) signalTypesFromNews.add('technology_adoption');
        if (/hiring|recruiting|job posting/i.test(title)) signalTypesFromNews.add('hiring_surge');
      }

      const typeLabels = Array.from(signalTypesFromNews).map(t => SIGNAL_TYPE_LABELS[t as SignalType] ?? t).join(', ');
      const narrative = `${entity.name} appears across ${relevantHeadlines.length} articles with ${signalTypesFromNews.size} signal types (${typeLabels}). This convergence suggests heightened commercial activity.`;

      focalPoints.push({
        entityId: ctx.entityId,
        name: entity.name,
        type: entity.type,
        newsCount: relevantHeadlines.length,
        signalCount: signalTypesFromNews.size,
        totalReach: relevantHeadlines.length + signalTypesFromNews.size,
        signalTypes: Array.from(signalTypesFromNews),
        topHeadlines: relevantHeadlines.map(h => ({ title: h.title, source: h.source, url: h.url })),
        narrative,
      });
    }

    if (companyClusters) {
      for (const cluster of companyClusters) {
        if (cluster.signalTypes.size >= 3) {
          const existing = focalPoints.find(fp => fp.name.toLowerCase() === cluster.company.toLowerCase());
          if (existing) {
            for (const st of cluster.signalTypes) {
              if (!existing.signalTypes.includes(st)) existing.signalTypes.push(st);
            }
            existing.signalCount = existing.signalTypes.length;
            existing.totalReach = existing.newsCount + existing.signalCount;
          } else {
            const signalTypesList = Array.from(cluster.signalTypes);
            const typeLabels = signalTypesList.map(t => SIGNAL_TYPE_LABELS[t as SignalType] ?? t).join(', ');
            focalPoints.push({
              entityId: cluster.company.toLowerCase().replace(/\s+/g, '_'),
              name: cluster.company,
              type: 'company',
              newsCount: 0,
              signalCount: cluster.totalCount,
              totalReach: cluster.totalCount,
              signalTypes: signalTypesList,
              topHeadlines: cluster.signals.slice(0, 5).map(s => ({ title: s.title, source: s.source, url: '' })),
              narrative: `OPPORTUNITY CONVERGENCE: ${cluster.company} has ${cluster.totalCount} signals across ${signalTypesList.length} types (${typeLabels}). Multi-signal convergence indicates active buying behavior.`,
            });
          }
        }
      }
    }

    focalPoints.sort((a, b) => b.totalReach - a.totalReach);

    const topNarrative = focalPoints.length > 0
      ? `${focalPoints.length} companies showing signal convergence. ${focalPoints[0].name} has the strongest opportunity signal.`
      : 'No significant opportunity convergence detected.';

    this.lastSummary = { focalPoints: focalPoints.slice(0, 10), topNarrative, generatedAt: new Date() };
    return this.lastSummary;
  }

  getLastSummary(): FocalPointSummary | null {
    return this.lastSummary;
  }
}

export const focalPointDetector = new OpportunityConvergenceDetector();
