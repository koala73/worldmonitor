/**
 * Data Freshness Tracker
 * Tracks when each data source was last updated to prevent
 * showing misleading "all clear" when we actually have no data.
 */

import { getCSSColor } from '@/utils/theme-colors';
import { isHealthMappedSource } from '@/services/health-freshness-map';
import type { DataSourceId } from '@/types';

export type { DataSourceId } from '@/types';

export type FreshnessStatus = 'fresh' | 'stale' | 'very_stale' | 'no_data' | 'disabled' | 'error';
type FreshnessEvidence = 'session' | 'seed-health';

export interface DataSourceState {
  id: DataSourceId;
  name: string;
  lastUpdate: Date | null;
  lastError: string | null;
  itemCount: number;
  enabled: boolean;
  status: FreshnessStatus;
  // Drives the StrategicRiskPanel hard insufficient-data gate; not the full list of CII score inputs.
  requiredForRisk: boolean;
  maxStaleMin?: number;
  healthStatus?: string;
  freshnessEvidence: FreshnessEvidence | null;
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

export interface PanelFreshnessSource {
  id: DataSourceId;
  name: string;
  status: FreshnessStatus;
  lastUpdate: Date | null;
  itemCount: number;
  healthStatus?: string;
  lastError: string | null;
}

export interface PanelFreshnessSummary {
  panelId: string;
  status: FreshnessStatus;
  lastUpdate: Date | null;
  labelUpdate: Date | null;
  sources: PanelFreshnessSource[];
}

export interface SeedHealthUpdate {
  sourceId: DataSourceId;
  status: string;
  records?: number | null;
  seedAgeMin?: number | null;
  maxStaleMin?: number | null;
  contentAgeMin?: number | null;
  maxContentAgeMin?: number | null;
  checkedAtMs?: number;
}

// Thresholds in milliseconds
const FRESH_THRESHOLD = 15 * 60 * 1000;      // 15 minutes
const STALE_THRESHOLD = 2 * 60 * 60 * 1000;  // 2 hours
const VERY_STALE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours

// Core browser-tracker sources needed before the Strategic Risk panel leaves its
// hard insufficient-data state. This is intentionally narrower than the full CII
// scorer input graph; source-specific health and /api/health.riskScores monitor
// ACLED/UCDP conflict, cyber, and other score-relevant feeds.
const CORE_SOURCES: DataSourceId[] = ['gdelt', 'rss'];

const SOURCE_METADATA: Record<DataSourceId, { name: string; requiredForRisk: boolean; panelId?: string }> = {
  acled: { name: 'Protests & Conflicts', requiredForRisk: false, panelId: 'protests' },
  opensky: { name: 'Military Flights', requiredForRisk: false, panelId: 'military' },
  wingbits: { name: 'Aircraft Enrichment', requiredForRisk: false, panelId: 'military' },
  ais: { name: 'Vessel Tracking', requiredForRisk: false, panelId: 'shipping' },
  usgs: { name: 'Earthquakes', requiredForRisk: false, panelId: 'natural' },
  gdelt: { name: 'News Intelligence', requiredForRisk: true, panelId: 'intel' },
  gdelt_doc: { name: 'GDELT Doc Intelligence', requiredForRisk: false, panelId: 'protests' },
  rss: { name: 'Live News Feeds', requiredForRisk: true, panelId: 'live-news' },
  polymarket: { name: 'Prediction Markets', requiredForRisk: false, panelId: 'polymarket' },
  predictions: { name: 'Predictions Feed', requiredForRisk: false, panelId: 'polymarket' },
  pizzint: { name: 'PizzINT Monitoring', requiredForRisk: false, panelId: 'intel' },
  outages: { name: 'Internet Outages', requiredForRisk: false, panelId: 'outages' },
  cyber_threats: { name: 'Cyber Threat IOCs', requiredForRisk: false, panelId: 'map' },
  weather: { name: 'Weather Alerts', requiredForRisk: false, panelId: 'weather' },
  economic: { name: 'Economic Data (FRED)', requiredForRisk: false, panelId: 'economic' },
  oil: { name: 'Oil Analytics (EIA)', requiredForRisk: false, panelId: 'economic' },
  spending: { name: 'Gov Spending', requiredForRisk: false, panelId: 'economic' },
  firms: { name: 'FIRMS Satellite Fires', requiredForRisk: false, panelId: 'map' },
  acled_conflict: { name: 'Armed Conflicts (ACLED)', requiredForRisk: false, panelId: 'protests' },
  ucdp: { name: 'Conflict Classification (UCDP)', requiredForRisk: false, panelId: 'protests' },
  hapi: { name: 'Conflict Aggregates (HDX)', requiredForRisk: false, panelId: 'protests' },
  ucdp_events: { name: 'UCDP Conflict Events', requiredForRisk: false, panelId: 'ucdp-events' },
  unhcr: { name: 'UNHCR Displacement', requiredForRisk: false, panelId: 'displacement' },
  climate: { name: 'Climate Anomalies', requiredForRisk: false, panelId: 'climate' },
  worldpop: { name: 'Population Exposure', requiredForRisk: false, panelId: 'population-exposure' },
  giving: { name: 'Global Giving Activity', requiredForRisk: false, panelId: 'giving' },
  bis: { name: 'BIS Central Banks', requiredForRisk: false, panelId: 'economic' },
  bls: { name: 'BLS Labor Market', requiredForRisk: false, panelId: 'economic' },
  wto_trade: { name: 'WTO Trade Policy', requiredForRisk: false, panelId: 'trade-policy' },
  supply_chain: { name: 'Supply Chain Intelligence', requiredForRisk: false, panelId: 'supply-chain' },
  security_advisories: { name: 'Security Advisories', requiredForRisk: false, panelId: 'security-advisories' },
  sanctions_pressure: { name: 'Sanctions Pressure', requiredForRisk: false, panelId: 'sanctions-pressure' },
  radiation: { name: 'Radiation Watch', requiredForRisk: false, panelId: 'radiation-watch' },
  gpsjam: { name: 'GPS/GNSS Interference', requiredForRisk: false, panelId: 'map' },
  treasury_revenue: { name: 'Treasury Customs Revenue', requiredForRisk: false, panelId: 'trade-policy' },
};

const PANEL_FRESHNESS_SOURCES: Record<string, readonly DataSourceId[]> = {
  'strategic-risk': CORE_SOURCES,
  cii: CORE_SOURCES,
  'live-news': ['rss'],
  intel: ['gdelt', 'pizzint'],
  'gdelt-intel': ['gdelt'],
  protests: ['acled', 'acled_conflict', 'gdelt_doc', 'ucdp', 'hapi'],
  'ucdp-events': ['ucdp_events'],
  polymarket: ['polymarket', 'predictions'],
  economic: ['economic', 'oil', 'spending', 'bis', 'bls'],
  'trade-policy': ['wto_trade', 'treasury_revenue'],
  'supply-chain': ['supply_chain'],
  'security-advisories': ['security_advisories'],
  'sanctions-pressure': ['sanctions_pressure'],
  'radiation-watch': ['radiation'],
  displacement: ['unhcr'],
  climate: ['climate'],
  'population-exposure': ['worldpop'],
  giving: ['giving'],
  'internet-disruptions': ['outages'],
  outages: ['outages'],
  military: ['opensky', 'wingbits'],
  shipping: ['ais'],
  natural: ['usgs'],
};

const STATUS_SEVERITY: Record<FreshnessStatus, number> = {
  fresh: 0,
  disabled: 1,
  stale: 2,
  very_stale: 3,
  no_data: 4,
  error: 5,
};

class DataFreshnessTracker {
  private sources: Map<DataSourceId, DataSourceState> = new Map();
  private listeners: Set<() => void> = new Set();

  constructor() {
    // Initialize all sources
    for (const [id, meta] of Object.entries(SOURCE_METADATA)) {
      this.sources.set(id as DataSourceId, {
        id: id as DataSourceId,
        name: meta.name,
        lastUpdate: null,
        lastError: null,
        itemCount: 0,
        enabled: true, // Assume enabled by default
        status: 'no_data',
        requiredForRisk: meta.requiredForRisk,
        freshnessEvidence: null,
      });
    }
  }

  /**
   * Record that a data source received new data
   */
  recordUpdate(sourceId: DataSourceId, itemCount: number = 1): void {
    const source = this.sources.get(sourceId);
    if (source) {
      if (isHealthMappedSource(sourceId) && source.freshnessEvidence === 'seed-health') {
        source.itemCount += itemCount;
        source.status = source.enabled ? this.calculateStatus(source) : 'disabled';
        this.notifyListeners();
        return;
      }
      source.lastUpdate = new Date();
      source.itemCount += itemCount;
      source.lastError = null;
      source.freshnessEvidence = 'session';
      source.status = this.calculateStatus(source);
      this.notifyListeners();
    }
  }

  /**
   * Record an error for a data source
   */
  recordError(sourceId: DataSourceId, error: string): void {
    const source = this.sources.get(sourceId);
    if (source) {
      if (isHealthMappedSource(sourceId) && source.freshnessEvidence === 'seed-health') {
        source.status = source.enabled ? this.calculateStatus(source) : 'disabled';
        this.notifyListeners();
        return;
      }
      source.lastError = error;
      source.status = 'error';
      this.notifyListeners();
    }
  }

  /**
   * Merge cadence-aware seed freshness from /api/health.
   */
  recordSeedHealth(updates: SeedHealthUpdate[]): void {
    let changed = false;
    for (const update of updates) {
      const source = this.sources.get(update.sourceId);
      if (!source) continue;

      const records = typeof update.records === 'number' && Number.isFinite(update.records)
        ? Math.max(0, update.records)
        : source.itemCount;
      const maxStaleMin = typeof update.maxStaleMin === 'number' && update.maxStaleMin > 0
        ? update.maxStaleMin
        : undefined;
      const maxContentAgeMin = typeof update.maxContentAgeMin === 'number' && update.maxContentAgeMin > 0
        ? update.maxContentAgeMin
        : undefined;
      const checkedAtMs = Number.isFinite(update.checkedAtMs)
        ? update.checkedAtMs!
        : Date.now();
      const seedAgeMin = typeof update.seedAgeMin === 'number' && update.seedAgeMin >= 0
        ? update.seedAgeMin
        : null;
      const contentAgeMin = typeof update.contentAgeMin === 'number' && update.contentAgeMin >= 0
        ? update.contentAgeMin
        : null;
      const ageMin = update.status === 'STALE_CONTENT' && contentAgeMin !== null
        ? contentAgeMin
        : seedAgeMin;

      source.itemCount = records;
      source.maxStaleMin = update.status === 'STALE_CONTENT'
        ? (maxContentAgeMin ?? maxStaleMin)
        : maxStaleMin;
      source.healthStatus = update.status;
      source.freshnessEvidence = 'seed-health';
      source.lastError = this.healthStatusIsError(update.status) ? update.status : null;
      source.lastUpdate = this.healthStatusHasNoData(update.status)
        ? null
        : ageMin !== null
        ? new Date(checkedAtMs - ageMin * 60_000)
        : source.lastUpdate;
      source.status = source.enabled ? this.calculateStatus(source) : 'disabled';
      changed = true;
    }
    if (changed) this.notifyListeners();
  }

  /**
   * Set whether a source is enabled/disabled
   */
  setEnabled(sourceId: DataSourceId, enabled: boolean): void {
    const source = this.sources.get(sourceId);
    if (source) {
      source.enabled = enabled;
      source.status = enabled ? this.calculateStatus(source) : 'disabled';
      this.notifyListeners();
    }
  }

  /**
   * Get the state of a specific source
   */
  getSource(sourceId: DataSourceId): DataSourceState | undefined {
    const source = this.sources.get(sourceId);
    if (source) {
      // Recalculate status in case time has passed
      source.status = source.enabled ? this.calculateStatus(source) : 'disabled';
    }
    return source;
  }

  /**
   * Get all source states
   */
  getAllSources(): DataSourceState[] {
    return Array.from(this.sources.values()).map(source => ({
      ...source,
      status: source.enabled ? this.calculateStatus(source) : 'disabled',
    }));
  }

  /**
   * Get sources required for the Strategic Risk insufficient-data gate.
   */
  getRiskSources(): DataSourceState[] {
    return this.getAllSources().filter(s => s.requiredForRisk);
  }

  /**
   * Get overall data freshness summary
   */
  getSummary(): DataFreshnessSummary {
    const sources = this.getAllSources();
    const riskSources = sources.filter(s => s.requiredForRisk);

    const activeSources = sources.filter(s => s.status === 'fresh' || s.status === 'stale' || s.status === 'very_stale');
    const activeRiskSources = riskSources.filter(s => s.status === 'fresh' || s.status === 'stale' || s.status === 'very_stale');
    const staleSources = sources.filter(s => s.status === 'stale' || s.status === 'very_stale');
    const disabledSources = sources.filter(s => s.status === 'disabled');
    const errorSources = sources.filter(s => s.status === 'error');

    const updates = sources
      .filter(s => s.lastUpdate)
      .map(s => s.lastUpdate!.getTime());

    // Coverage is based on sources required by the panel's hard gate, not every CII input.
    const coveragePercent = riskSources.length > 0
      ? Math.round((activeRiskSources.length / riskSources.length) * 100)
      : 0;

    // Overall status
    let overallStatus: 'sufficient' | 'limited' | 'insufficient';
    if (activeRiskSources.length >= CORE_SOURCES.length && coveragePercent >= 66) {
      overallStatus = 'sufficient';
    } else if (activeRiskSources.length >= 1) {
      overallStatus = 'limited';
    } else {
      overallStatus = 'insufficient';
    }

    return {
      totalSources: sources.length,
      activeSources: activeSources.length,
      staleSources: staleSources.length,
      disabledSources: disabledSources.length,
      errorSources: errorSources.length,
      overallStatus,
      coveragePercent,
      oldestUpdate: updates.length > 0 ? new Date(updates.reduce((min, d) => d < min ? d : min, updates[0]!)) : null,
      newestUpdate: updates.length > 0 ? new Date(updates.reduce((max, d) => d > max ? d : max, updates[0]!)) : null,
    };
  }

  /**
   * Check if we have enough data for risk assessment
   */
  hasSufficientData(): boolean {
    return this.getSummary().overallStatus === 'sufficient';
  }

  /**
   * Check if we have any data at all
   */
  hasAnyData(): boolean {
    return this.getSummary().activeSources > 0;
  }

  /**
   * Get panel ID for a source (to enable it)
   */
  getPanelIdForSource(sourceId: DataSourceId): string | undefined {
    return SOURCE_METADATA[sourceId]?.panelId;
  }

  /**
   * Get freshness sources that contribute to a panel header badge.
   */
  getSourcesForPanel(panelId: string): PanelFreshnessSource[] {
    const sourceIds = this.getSourceIdsForPanel(panelId);
    if (sourceIds.length === 0 || sourceIds.some(sourceId => !isHealthMappedSource(sourceId))) {
      return [];
    }

    const sources = sourceIds.map(sourceId => this.getSource(sourceId));
    if (sources.some(source => !source || source.freshnessEvidence !== 'seed-health')) {
      return [];
    }

    return sources
      .filter((source): source is DataSourceState => Boolean(source))
      .map(source => ({
        id: source.id,
        name: source.name,
        status: source.status,
        lastUpdate: source.lastUpdate,
        itemCount: source.itemCount,
        healthStatus: source.healthStatus,
        lastError: source.lastError,
      }));
  }

  /**
   * Aggregate a panel's mapped sources to the worst current status.
   */
  getPanelFreshness(panelId: string): PanelFreshnessSummary | null {
    const sources = this.getSourcesForPanel(panelId);
    if (sources.length === 0) return null;

    const activeSources = sources.filter(source => source.status !== 'disabled');
    const sourcesForStatus = activeSources.length > 0 ? activeSources : sources;
    const worstStatus = sourcesForStatus.reduce<FreshnessStatus>((worst, source) => (
      STATUS_SEVERITY[source.status] > STATUS_SEVERITY[worst] ? source.status : worst
    ), 'fresh');

    const updates = sources
      .map(source => source.lastUpdate)
      .filter((date): date is Date => date instanceof Date);
    const newestUpdate = updates.length > 0
      ? new Date(Math.max(...updates.map(date => date.getTime())))
      : null;
    const worstStatusUpdates = sourcesForStatus
      .filter(source => source.status === worstStatus)
      .map(source => source.lastUpdate)
      .filter((date): date is Date => date instanceof Date);
    const labelUpdate = worstStatusUpdates.length > 0
      ? new Date(Math.min(...worstStatusUpdates.map(date => date.getTime())))
      : newestUpdate;

    return {
      panelId,
      status: worstStatus,
      lastUpdate: newestUpdate,
      labelUpdate,
      sources,
    };
  }

  private getSourceIdsForPanel(panelId: string): DataSourceId[] {
    const explicitSources = PANEL_FRESHNESS_SOURCES[panelId];
    const sourceIds = new Set<DataSourceId>(explicitSources ?? []);
    for (const sourceId of Object.entries(SOURCE_METADATA)
      .filter(([, meta]) => meta.panelId === panelId)
      .map(([sourceId]) => sourceId as DataSourceId)) {
      sourceIds.add(sourceId);
    }
    return [...sourceIds];
  }

  /**
   * Subscribe to changes
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private calculateStatus(source: DataSourceState): FreshnessStatus {
    if (!source.enabled) return 'disabled';
    if (source.lastError) return 'error';
    if (!source.lastUpdate) return 'no_data';

    const age = Date.now() - source.lastUpdate.getTime();
    const freshThreshold = source.maxStaleMin ? source.maxStaleMin * 60_000 : FRESH_THRESHOLD;
    const staleThreshold = source.maxStaleMin ? source.maxStaleMin * 2 * 60_000 : STALE_THRESHOLD;
    const veryStaleThreshold = source.maxStaleMin ? source.maxStaleMin * 3 * 60_000 : VERY_STALE_THRESHOLD;
    if (age <= freshThreshold) return source.healthStatus === 'COVERAGE_PARTIAL'
      || source.healthStatus === 'STALE_CONTENT'
      || source.healthStatus === 'STALE_SEED'
      ? 'stale'
      : 'fresh';
    if (age <= staleThreshold) return 'stale';
    if (age <= veryStaleThreshold) return 'very_stale';
    return 'no_data'; // Too old, treat as no data
  }

  private healthStatusIsError(status: string): boolean {
    return status === 'SEED_ERROR' || status === 'REDIS_DOWN' || status === 'REDIS_PARTIAL';
  }

  private healthStatusHasNoData(status: string): boolean {
    return status === 'EMPTY' || status === 'EMPTY_DATA' || status === 'EMPTY_ON_DEMAND';
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error('[DataFreshness] Listener error:', e);
      }
    }
  }

  /**
   * Get human-readable time since last update
   */
  getTimeSince(sourceId: DataSourceId): string {
    const source = this.sources.get(sourceId);
    return this.formatTimeSince(source?.lastUpdate ?? null);
  }

  private formatTimeSince(date: Date | null): string {
    if (!date) return 'never';

    const ms = Math.max(0, Date.now() - date.getTime());
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

}

// Singleton instance
export const dataFreshness = new DataFreshnessTracker();

// Helper to get status color
export function getStatusColor(status: FreshnessStatus): string {
  switch (status) {
    case 'fresh': return getCSSColor('--semantic-normal');
    case 'stale': return getCSSColor('--semantic-elevated');
    case 'very_stale': return getCSSColor('--semantic-high');
    case 'error': return getCSSColor('--semantic-critical');
    case 'disabled': return getCSSColor('--text-muted');
    case 'no_data': return getCSSColor('--text-dim');
  }
}

// Helper to get status icon
export function getStatusIcon(status: FreshnessStatus): string {
  switch (status) {
    case 'fresh': return '●';
    case 'stale': return '◐';
    case 'very_stale': return '○';
    case 'error': return '✕';
    case 'disabled': return '○';
    case 'no_data': return '○';
  }
}

// Intelligence gap messages - explains what analysts CAN'T see (Quick Win #1)
const INTELLIGENCE_GAP_MESSAGES: Record<DataSourceId, string> = {
  acled: 'Protest/conflict events may be missed—ACLED data unavailable',
  opensky: 'Military aircraft positions unknown—flight tracking offline',
  wingbits: 'Aircraft identification limited—enrichment service unavailable',
  ais: 'Vessel positions outdated—possible dark shipping or AIS transponder-off activity undetected',
  usgs: 'Recent earthquakes may not be shown—seismic data unavailable',
  gdelt: 'News event velocity unknown—GDELT intelligence feed offline',
  gdelt_doc: 'Protest intelligence degraded—GDELT Doc feed offline',
  rss: 'Breaking news may be missed—RSS feeds not updating',
  polymarket: 'Prediction market signals unavailable—early warning capability degraded',
  predictions: 'Prediction feed unavailable—scenario signals may be stale',
  pizzint: 'PizzINT monitor unavailable—location/tension tracking degraded',
  outages: 'Internet disruptions may be unreported—outage monitoring offline',
  cyber_threats: 'Cyber IOC map points unavailable—malicious infrastructure visibility reduced',
  weather: 'Severe weather warnings may be missed—weather alerts unavailable',
  economic: 'Economic indicators stale—Fed/Treasury data not updating',
  oil: 'Oil market analytics unavailable—EIA data not updating',
  spending: 'Government spending data unavailable',
  firms: 'Satellite fire detection unavailable—NASA FIRMS data not updating',
  acled_conflict: 'Armed conflict events may be missed—ACLED conflict data unavailable',
  ucdp: 'Conflict classification unavailable—UCDP data not loading',
  hapi: 'Aggregated conflict data unavailable—HDX HAPI not responding',
  ucdp_events: 'UCDP event-level conflict data unavailable',
  unhcr: 'UNHCR displacement data unavailable—refugee flows unknown',
  climate: 'Climate anomaly data unavailable—extreme weather patterns undetected',
  worldpop: 'Population exposure data unavailable—affected population unknown',
  giving: 'Global giving activity data unavailable',
  bis: 'Central bank policy data may be stale—BIS feed unavailable',
  bls: 'Labor market data unavailable—BLS feed not yet seeded',
  wto_trade: 'Trade policy intelligence unavailable—WTO data not updating',
  supply_chain: 'Supply chain disruption status unavailable—chokepoint monitoring offline',
  security_advisories: 'Government travel advisory data unavailable—security alerts may be missed',
  sanctions_pressure: 'Structured sanctions pressure unavailable\u2014OFAC designation visibility reduced',
  radiation: 'Radiation monitoring degraded—EPA RadNet and Safecast observations unavailable',
  gpsjam: 'GPS/GNSS interference data unavailable—jamming zones undetected',
  treasury_revenue: 'US Treasury customs revenue data unavailable',
};

/**
 * Get intelligence gap warnings for stale or unavailable data sources.
 * These warnings help analysts understand what they CANNOT see.
 */
export function getIntelligenceGaps(): { source: DataSourceId; message: string; severity: 'warning' | 'critical' }[] {
  const gaps: { source: DataSourceId; message: string; severity: 'warning' | 'critical' }[] = [];

  for (const source of dataFreshness.getAllSources()) {
    if (source.status === 'no_data' || source.status === 'very_stale' || source.status === 'error') {
      const message = INTELLIGENCE_GAP_MESSAGES[source.id] || `${source.name} data unavailable`;
      const severity = source.requiredForRisk || source.status === 'error' ? 'critical' : 'warning';
      gaps.push({ source: source.id, message, severity });
    }
  }

  return gaps.sort((a, b) => {
    // Critical first
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return 0;
  });
}

/**
 * Get a formatted intelligence gap summary for display.
 */
export function getIntelligenceGapSummary(): string[] {
  const gaps = getIntelligenceGaps();
  return gaps.map(gap => {
    const icon = gap.severity === 'critical' ? '⚠️ CRITICAL' : '⚡';
    return `${icon}: ${gap.message}`;
  });
}

/**
 * Check if there are any critical intelligence gaps.
 */
export function hasCriticalGaps(): boolean {
  return getIntelligenceGaps().some(gap => gap.severity === 'critical');
}
