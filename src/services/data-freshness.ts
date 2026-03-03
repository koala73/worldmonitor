/**
 * Data Freshness Tracker — SalesIntel
 * Tracks when each business data source was last updated.
 * Reports intelligence gaps ("LinkedIn data is 6h stale", "Crunchbase feed is down").
 */

import { getCSSColor } from '@/utils';

export type DataSourceId =
  | 'rss'           // RSS business feeds
  | 'crunchbase'    // Crunchbase funding data
  | 'linkedin'      // LinkedIn company/contact data
  | 'sec_edgar'     // SEC filings
  | 'clearbit'      // Company enrichment
  | 'apollo'        // Contact enrichment
  | 'builtwith'     // Technology stack detection
  | 'indeed'        // Job posting analysis
  | 'twitter'       // Social listening
  | 'sam_gov'       // Government procurement
  | 'economic';     // Market/financial data

export type FreshnessStatus = 'fresh' | 'stale' | 'very_stale' | 'no_data' | 'disabled' | 'error';

export interface DataSourceState {
  id: DataSourceId;
  name: string;
  lastUpdate: Date | null;
  lastError: string | null;
  itemCount: number;
  enabled: boolean;
  status: FreshnessStatus;
  requiredForSignals: boolean;
}

export interface DataFreshnessSummary {
  totalSources: number;
  activeSources: number;
  staleSources: number;
  disabledSources: number;
  errorSources: number;
  overallStatus: 'sufficient' | 'limited' | 'insufficient';
  coveragePercent: number;
  oldestUpdate: Date | null;
  newestUpdate: Date | null;
}

// Thresholds in milliseconds
const FRESH_THRESHOLD = 15 * 60 * 1000;       // 15 minutes
const STALE_THRESHOLD = 2 * 60 * 60 * 1000;   // 2 hours
const VERY_STALE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours

// Core sources needed for meaningful signal analysis
const CORE_SOURCES: DataSourceId[] = ['rss', 'crunchbase'];

const SOURCE_METADATA: Record<DataSourceId, { name: string; requiredForSignals: boolean }> = {
  rss: { name: 'Business News Feeds', requiredForSignals: true },
  crunchbase: { name: 'Crunchbase Funding Data', requiredForSignals: true },
  linkedin: { name: 'LinkedIn Intelligence', requiredForSignals: false },
  sec_edgar: { name: 'SEC EDGAR Filings', requiredForSignals: false },
  clearbit: { name: 'Clearbit Enrichment', requiredForSignals: false },
  apollo: { name: 'Apollo Contact Data', requiredForSignals: false },
  builtwith: { name: 'BuiltWith Tech Stack', requiredForSignals: false },
  indeed: { name: 'Indeed Job Postings', requiredForSignals: false },
  twitter: { name: 'Twitter/X Social Data', requiredForSignals: false },
  sam_gov: { name: 'SAM.gov Procurement', requiredForSignals: false },
  economic: { name: 'Market & Financial Data', requiredForSignals: false },
};

class DataFreshnessTracker {
  private sources: Map<DataSourceId, DataSourceState> = new Map();
  private subscribers: Set<(summary: DataFreshnessSummary) => void> = new Set();

  constructor() {
    // Initialize all sources
    for (const [id, meta] of Object.entries(SOURCE_METADATA)) {
      this.sources.set(id as DataSourceId, {
        id: id as DataSourceId,
        name: meta.name,
        lastUpdate: null,
        lastError: null,
        itemCount: 0,
        enabled: true,
        status: 'no_data',
        requiredForSignals: meta.requiredForSignals,
      });
    }
  }

  reportUpdate(sourceId: DataSourceId, itemCount: number): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.lastUpdate = new Date();
    source.lastError = null;
    source.itemCount = itemCount;
    source.status = 'fresh';
    this.notifySubscribers();
  }

  reportError(sourceId: DataSourceId, error: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.lastError = error;
    source.status = 'error';
    this.notifySubscribers();
  }

  setEnabled(sourceId: DataSourceId, enabled: boolean): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.enabled = enabled;
    source.status = enabled ? (source.lastUpdate ? 'fresh' : 'no_data') : 'disabled';
    this.notifySubscribers();
  }

  getSourceState(sourceId: DataSourceId): DataSourceState | undefined {
    const source = this.sources.get(sourceId);
    if (source) this.updateStatus(source);
    return source;
  }

  getSummary(): DataFreshnessSummary {
    this.sources.forEach(s => this.updateStatus(s));

    const allSources = Array.from(this.sources.values());
    const enabledSources = allSources.filter(s => s.enabled);
    const staleSources = enabledSources.filter(s => s.status === 'stale' || s.status === 'very_stale');
    const errorSources = enabledSources.filter(s => s.status === 'error');

    const coreFresh = CORE_SOURCES.every(id => {
      const s = this.sources.get(id);
      return s && s.enabled && (s.status === 'fresh' || s.status === 'stale');
    });

    const updates = enabledSources
      .filter(s => s.lastUpdate)
      .map(s => s.lastUpdate!.getTime());

    const activeSources = enabledSources.filter(s => s.status === 'fresh' || s.status === 'stale').length;
    const coveragePercent = enabledSources.length > 0
      ? Math.round((activeSources / enabledSources.length) * 100)
      : 0;

    return {
      totalSources: allSources.length,
      activeSources,
      staleSources: staleSources.length,
      disabledSources: allSources.length - enabledSources.length,
      errorSources: errorSources.length,
      overallStatus: coreFresh ? (coveragePercent >= 70 ? 'sufficient' : 'limited') : 'insufficient',
      coveragePercent,
      oldestUpdate: updates.length > 0 ? new Date(Math.min(...updates)) : null,
      newestUpdate: updates.length > 0 ? new Date(Math.max(...updates)) : null,
    };
  }

  /**
   * Get human-readable intelligence gap report
   */
  getIntelligenceGaps(): string[] {
    const gaps: string[] = [];
    this.sources.forEach(s => {
      this.updateStatus(s);
      if (!s.enabled) return;
      if (s.status === 'error') {
        gaps.push(`${s.name} is down: ${s.lastError ?? 'unknown error'}`);
      } else if (s.status === 'very_stale' && s.lastUpdate) {
        const hoursAgo = Math.round((Date.now() - s.lastUpdate.getTime()) / (1000 * 60 * 60));
        gaps.push(`${s.name} is ${hoursAgo}h stale`);
      } else if (s.status === 'no_data') {
        gaps.push(`${s.name}: no data received`);
      }
    });
    return gaps;
  }

  subscribe(fn: (summary: DataFreshnessSummary) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private updateStatus(source: DataSourceState): void {
    if (!source.enabled) { source.status = 'disabled'; return; }
    if (source.lastError) { source.status = 'error'; return; }
    if (!source.lastUpdate) { source.status = 'no_data'; return; }

    const age = Date.now() - source.lastUpdate.getTime();
    if (age < FRESH_THRESHOLD) source.status = 'fresh';
    else if (age < STALE_THRESHOLD) source.status = 'stale';
    else if (age < VERY_STALE_THRESHOLD) source.status = 'very_stale';
    else source.status = 'very_stale';
  }

  private notifySubscribers(): void {
    const summary = this.getSummary();
    this.subscribers.forEach(fn => fn(summary));
  }
}

export const dataFreshness = new DataFreshnessTracker();

// Freshness status colors
export function getFreshnessColor(status: FreshnessStatus): string {
  switch (status) {
    case 'fresh': return getCSSColor('--signal-opportunity') || '#10b981';
    case 'stale': return getCSSColor('--signal-attention') || '#f59e0b';
    case 'very_stale': return getCSSColor('--signal-risk') || '#ef4444';
    case 'error': return getCSSColor('--signal-risk') || '#ef4444';
    case 'no_data': return getCSSColor('--text-muted') || '#64748b';
    case 'disabled': return getCSSColor('--text-dim') || '#475569';
  }
}
