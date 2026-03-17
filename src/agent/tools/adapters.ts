/**
 * Service Adapters — bridge existing WorldMonitor services into the tool registry.
 *
 * Each adapter wraps an existing service's fetch function, converts output
 * into canonical Signal format, and registers itself as a tool.
 *
 * Client instantiation pattern matches existing codebase:
 *   new XxxServiceClient('', { fetch: (...args) => globalThis.fetch(...args) })
 */

import type { Signal, Severity } from '../types';
import { registerTool, createSignal } from './registry';

/** Standard client constructor options matching the codebase pattern */
const CLIENT_OPTS = { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) };

// ============================================================================
// ADAPTER: News/RSS → Signal
// ============================================================================

registerTool({
  id: 'news.rss',
  name: 'RSS News Fetcher',
  description: 'Fetches and clusters news from 150+ RSS feeds',
  domains: ['news'],
  inputSchema: { type: 'object', properties: { maxItems: { type: 'number' } } },
  outputDomain: 'news',
  concurrency: 2,
  timeout: 30_000,
  async execute(input) {
    const { fetchCategoryFeeds } = await import('@/services/rss');
    const { FEEDS } = await import('@/config/feeds');
    const feeds = Object.values(FEEDS).flat();
    const items = await fetchCategoryFeeds(feeds);
    const maxItems = (input.maxItems as number) ?? 100;

    return items.slice(0, maxItems).map((item, idx) =>
      createSignal('news', {
        sourceId: `rss-${idx}-${item.link?.slice(-20) ?? Date.now()}`,
        severity: clusterSeverity(item.tier ?? 3, item.isAlert),
        regions: [],
        timestamp: item.pubDate.getTime(),
        geo: item.lat != null && item.lon != null
          ? { lat: item.lat, lon: item.lon }
          : undefined,
        payload: {
          title: item.title,
          source: item.source,
          link: item.link,
          isAlert: item.isAlert,
          tier: item.tier,
        },
        confidence: item.tier === 1 ? 0.95 : item.tier === 2 ? 0.8 : 0.6,
        tags: ['news', 'rss'],
        provenance: 'tool:news.rss',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Conflict Events → Signal
// ============================================================================

registerTool({
  id: 'conflict.acled',
  name: 'ACLED Conflict Events',
  description: 'Fetches armed conflict events from ACLED',
  domains: ['conflict'],
  inputSchema: { type: 'object', properties: { country: { type: 'string' } } },
  outputDomain: 'conflict',
  concurrency: 1,
  timeout: 20_000,
  async execute(input) {
    const { ConflictServiceClient } = await import(
      '@/generated/client/worldmonitor/conflict/v1/service_client'
    );
    const client = new ConflictServiceClient('', CLIENT_OPTS);
    const country = (input.country as string) || 'global';
    const resp = await client.listAcledEvents({ country });
    return (resp.events ?? []).map(evt =>
      createSignal('conflict', {
        sourceId: `acled-${evt.id}`,
        severity: acledSeverity(evt.eventType, evt.fatalities),
        regions: evt.country ? [evt.country.slice(0, 2).toUpperCase()] : [],
        timestamp: evt.occurredAt || Date.now(),
        geo: evt.location
          ? { lat: evt.location.latitude, lon: evt.location.longitude }
          : undefined,
        payload: evt,
        confidence: 0.9,
        tags: ['conflict', 'acled', evt.eventType],
        provenance: 'tool:conflict.acled',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Military Flights → Signal
// ============================================================================

registerTool({
  id: 'military.flights',
  name: 'Military Flight Tracker',
  description: 'Fetches military aircraft positions and surge detection',
  domains: ['military'],
  inputSchema: { type: 'object' },
  outputDomain: 'military',
  concurrency: 1,
  timeout: 15_000,
  async execute() {
    const { MilitaryServiceClient } = await import(
      '@/generated/client/worldmonitor/military/v1/service_client'
    );
    const client = new MilitaryServiceClient('', CLIENT_OPTS);
    const resp = await client.listMilitaryFlights({
      operator: 'MILITARY_OPERATOR_UNSPECIFIED',
      aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED',
    });
    return (resp.flights ?? []).map(flight =>
      createSignal('military', {
        sourceId: `mil-${flight.hexCode || flight.callsign}`,
        severity: 'medium',
        regions: flight.operatorCountry ? [flight.operatorCountry] : [],
        timestamp: Date.now(),
        geo: flight.location
          ? { lat: flight.location.latitude, lon: flight.location.longitude }
          : undefined,
        payload: flight,
        confidence: 0.85,
        tags: ['military', 'aviation', flight.callsign],
        provenance: 'tool:military.flights',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Cyber Threats → Signal
// ============================================================================

registerTool({
  id: 'cyber.threats',
  name: 'Cyber Threat Monitor',
  description: 'Fetches cyber threat advisories and incidents',
  domains: ['cyber'],
  inputSchema: { type: 'object' },
  outputDomain: 'cyber',
  concurrency: 1,
  timeout: 15_000,
  async execute() {
    const { CyberServiceClient } = await import(
      '@/generated/client/worldmonitor/cyber/v1/service_client'
    );
    const client = new CyberServiceClient('', CLIENT_OPTS);
    const resp = await client.listCyberThreats({
      type: 'CYBER_THREAT_TYPE_UNSPECIFIED',
      source: 'CYBER_THREAT_SOURCE_UNSPECIFIED',
      minSeverity: 'CRITICALITY_LEVEL_UNSPECIFIED',
    });
    return (resp.threats ?? []).map(threat =>
      createSignal('cyber', {
        sourceId: `cyber-${threat.id}`,
        severity: mapCriticalityLevel(threat.severity),
        regions: threat.country ? [threat.country] : [],
        timestamp: threat.firstSeenAt || Date.now(),
        geo: threat.location
          ? { lat: threat.location.latitude, lon: threat.location.longitude }
          : undefined,
        payload: threat,
        confidence: 0.8,
        tags: ['cyber', threat.type],
        provenance: 'tool:cyber.threats',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Seismology → Signal
// ============================================================================

registerTool({
  id: 'seismology.earthquakes',
  name: 'Earthquake Monitor',
  description: 'Fetches recent earthquake data',
  domains: ['seismology'],
  inputSchema: { type: 'object' },
  outputDomain: 'seismology',
  concurrency: 1,
  timeout: 15_000,
  async execute() {
    const { SeismologyServiceClient } = await import(
      '@/generated/client/worldmonitor/seismology/v1/service_client'
    );
    const client = new SeismologyServiceClient('', CLIENT_OPTS);
    const resp = await client.listEarthquakes({ minMagnitude: 3.0 });
    return (resp.earthquakes ?? []).map(eq =>
      createSignal('seismology', {
        sourceId: `eq-${eq.id}`,
        severity: earthquakeSeverity(eq.magnitude),
        regions: [],
        timestamp: eq.occurredAt || Date.now(),
        geo: eq.location
          ? { lat: eq.location.latitude, lon: eq.location.longitude }
          : undefined,
        payload: eq,
        confidence: 0.95,
        tags: ['earthquake', `mag${Math.floor(eq.magnitude)}`],
        provenance: 'tool:seismology.earthquakes',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Economic / Market → Signal
// ============================================================================

registerTool({
  id: 'economic.macro',
  name: 'Macro Economic Signals',
  description: 'Fetches FRED indicators and macro signal composite',
  domains: ['economic'],
  inputSchema: { type: 'object' },
  outputDomain: 'economic',
  concurrency: 1,
  timeout: 20_000,
  async execute() {
    const { EconomicServiceClient } = await import(
      '@/generated/client/worldmonitor/economic/v1/service_client'
    );
    const client = new EconomicServiceClient('', CLIENT_OPTS);
    const resp = await client.getMacroSignals({});

    // The response is a composite — verdict, bullishCount, totalCount
    const signals: Signal[] = [];
    if (!resp.unavailable) {
      const verdictSeverity: Severity = resp.verdict === 'CASH' ? 'high'
        : resp.verdict === 'CAUTIOUS' ? 'medium'
        : 'low';

      signals.push(createSignal('economic', {
        sourceId: `macro-verdict-${resp.timestamp}`,
        severity: verdictSeverity,
        regions: ['US'],
        timestamp: Date.now(),
        payload: {
          verdict: resp.verdict,
          bullishCount: resp.bullishCount,
          totalCount: resp.totalCount,
          signals: resp.signals,
        },
        confidence: 0.85,
        tags: ['economic', 'macro', resp.verdict?.toLowerCase() ?? ''],
        provenance: 'tool:economic.macro',
      }));
    }
    return signals;
  },
});

// ============================================================================
// ADAPTER: Infrastructure → Signal
// ============================================================================

registerTool({
  id: 'infrastructure.outages',
  name: 'Infrastructure Outage Monitor',
  description: 'Fetches internet outages and service disruptions',
  domains: ['infrastructure'],
  inputSchema: { type: 'object', properties: { country: { type: 'string' } } },
  outputDomain: 'infrastructure',
  concurrency: 1,
  timeout: 15_000,
  async execute(input) {
    const { InfrastructureServiceClient } = await import(
      '@/generated/client/worldmonitor/infrastructure/v1/service_client'
    );
    const client = new InfrastructureServiceClient('', CLIENT_OPTS);
    const country = (input.country as string) || 'global';
    const resp = await client.listInternetOutages({ country });
    return (resp.outages ?? []).map(outage =>
      createSignal('infrastructure', {
        sourceId: `outage-${outage.id}`,
        severity: mapOutageSeverity(outage.severity),
        regions: outage.country ? [outage.country] : [],
        timestamp: outage.detectedAt || Date.now(),
        geo: outage.location
          ? { lat: outage.location.latitude, lon: outage.location.longitude }
          : undefined,
        payload: outage,
        confidence: 0.85,
        tags: ['infrastructure', 'outage', outage.outageType],
        provenance: 'tool:infrastructure.outages',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Unrest → Signal
// ============================================================================

registerTool({
  id: 'unrest.events',
  name: 'Social Unrest Tracker',
  description: 'Fetches protest and unrest events',
  domains: ['unrest'],
  inputSchema: { type: 'object', properties: { country: { type: 'string' } } },
  outputDomain: 'unrest',
  concurrency: 1,
  timeout: 15_000,
  async execute(input) {
    const { UnrestServiceClient } = await import(
      '@/generated/client/worldmonitor/unrest/v1/service_client'
    );
    const client = new UnrestServiceClient('', CLIENT_OPTS);
    const country = (input.country as string) || 'global';
    const resp = await client.listUnrestEvents({
      country,
      minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
    });
    return (resp.events ?? []).map(evt =>
      createSignal('unrest', {
        sourceId: `unrest-${evt.id}`,
        severity: evt.fatalities > 0 ? 'high' : 'medium',
        regions: evt.country ? [evt.country] : [],
        timestamp: evt.occurredAt || Date.now(),
        geo: evt.location
          ? { lat: evt.location.latitude, lon: evt.location.longitude }
          : undefined,
        payload: evt,
        confidence: 0.8,
        tags: ['unrest', evt.eventType],
        provenance: 'tool:unrest.events',
      })
    );
  },
});

// ============================================================================
// ADAPTER: Intelligence → Signal
// ============================================================================

registerTool({
  id: 'intelligence.risk',
  name: 'Risk Score Calculator',
  description: 'Fetches CII and strategic risk scores',
  domains: ['intelligence'],
  inputSchema: { type: 'object', properties: { region: { type: 'string' } } },
  outputDomain: 'intelligence',
  concurrency: 1,
  timeout: 20_000,
  async execute(input) {
    const { IntelligenceServiceClient } = await import(
      '@/generated/client/worldmonitor/intelligence/v1/service_client'
    );
    const client = new IntelligenceServiceClient('', CLIENT_OPTS);
    const region = (input.region as string) || 'global';
    const resp = await client.getRiskScores({ region });

    const signals: Signal[] = [];

    for (const cii of resp.ciiScores ?? []) {
      signals.push(createSignal('intelligence', {
        sourceId: `cii-${cii.region}`,
        severity: ciiSeverity(cii.combinedScore ?? 0),
        regions: cii.region ? [cii.region] : [],
        timestamp: cii.computedAt ?? Date.now(),
        payload: cii,
        confidence: 0.9,
        tags: ['intelligence', 'cii', cii.trend ?? ''],
        provenance: 'tool:intelligence.risk',
      }));
    }

    return signals;
  },
});

// ============================================================================
// SEVERITY HELPERS
// ============================================================================

function clusterSeverity(tier: number, isAlert: boolean): Severity {
  if (isAlert) return 'high';
  if (tier === 1) return 'medium';
  if (tier === 2) return 'low';
  return 'info';
}

function acledSeverity(eventType: string, fatalities: number): Severity {
  if (fatalities > 50) return 'critical';
  if (fatalities > 10) return 'high';
  if (eventType.includes('battle') || eventType.includes('explosion')) return 'high';
  if (eventType.includes('violence')) return 'medium';
  return 'low';
}

function mapCriticalityLevel(s: string): Severity {
  if (s === 'CRITICALITY_LEVEL_CRITICAL') return 'critical';
  if (s === 'CRITICALITY_LEVEL_HIGH') return 'high';
  if (s === 'CRITICALITY_LEVEL_MEDIUM') return 'medium';
  return 'low';
}

function mapOutageSeverity(s: string): Severity {
  if (s === 'OUTAGE_SEVERITY_TOTAL') return 'critical';
  if (s === 'OUTAGE_SEVERITY_MAJOR') return 'high';
  if (s === 'OUTAGE_SEVERITY_PARTIAL') return 'medium';
  return 'low';
}

function earthquakeSeverity(magnitude: number): Severity {
  if (magnitude >= 7) return 'critical';
  if (magnitude >= 6) return 'high';
  if (magnitude >= 5) return 'medium';
  if (magnitude >= 4) return 'low';
  return 'info';
}

function ciiSeverity(score: number): Severity {
  if (score >= 81) return 'critical';
  if (score >= 66) return 'high';
  if (score >= 51) return 'medium';
  if (score >= 31) return 'low';
  return 'info';
}
