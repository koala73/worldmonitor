/**
 * Focal Point Detector - Intelligence Synthesis Layer
 *
 * Correlates news entities with map signals to identify "main characters"
 * that appear across multiple intelligence streams.
 *
 * Example: IRAN mentioned in 12 news clusters + 5 military flights + internet outage
 * = CRITICAL focal point with rich narrative for AI
 *
 * The computation lives in `shared/analysis-focal-points.ts` so server-side
 * callers can run it without importing `src/`. This module is the dashboard's
 * stateful wrapper: it wires up the memoized entity index and remembers the last
 * summary so the CII and military-surge integrations can query it.
 */

import type { ClusteredEvent, FocalPoint, FocalPointSummary } from '@/types';
import type { SignalSummary } from './signal-aggregator';
import { extractEntitiesFromClusters } from './entity-extraction';
import { getEntityIndex } from './entity-index';
import { FocalPointCore, getSignalIcons } from '../../shared/analysis-focal-points';

class FocalPointDetector {
  private lastSummary: FocalPointSummary | null = null;
  private core: FocalPointCore | null = null;

  /** Built on first use so importing this module doesn't eagerly index the registry. */
  private getCore(): FocalPointCore {
    if (!this.core) {
      this.core = new FocalPointCore(getEntityIndex());
    }
    return this.core;
  }

  /**
   * Main analysis entry point - correlates news clusters with map signals
   */
  analyze(clusters: ClusteredEvent[], signalSummary: SignalSummary): FocalPointSummary {
    // Entity extraction stays on the client's own module so dashboard output
    // cannot drift from the shared core's port of the same logic.
    const entityContexts = extractEntitiesFromClusters(clusters);
    this.lastSummary = this.getCore().analyze(clusters, signalSummary, entityContexts);
    return this.lastSummary;
  }

  /**
   * Get signal icons for UI display
   */
  getSignalIcons(signalTypes: string[]): string {
    return getSignalIcons(signalTypes);
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
