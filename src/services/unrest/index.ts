import {
  UnrestServiceClient,
  type UnrestEvent,
  type ListUnrestEventsResponse,
} from '@/generated/client/worldmonitor/unrest/v1/service_client';
import type { SocialUnrestEvent, ProtestSeverity, ProtestEventType, ProtestSource } from '@/types';
import { createCircuitBreaker } from '@/utils';

// ---- Client + Circuit Breaker ----

const client = new UnrestServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const unrestBreaker = createCircuitBreaker<ListUnrestEventsResponse>({
  name: 'Unrest Events',
});

// ---- Enum Mapping Functions ----

function mapSeverity(s: string): ProtestSeverity {
  switch (s) {
    case 'SEVERITY_LEVEL_HIGH': return 'high';
    case 'SEVERITY_LEVEL_MEDIUM': return 'medium';
    default: return 'low';
  }
}

function mapEventType(t: string): ProtestEventType {
  switch (t) {
    case 'UNREST_EVENT_TYPE_PROTEST': return 'protest';
    case 'UNREST_EVENT_TYPE_RIOT': return 'riot';
    case 'UNREST_EVENT_TYPE_STRIKE': return 'strike';
    case 'UNREST_EVENT_TYPE_DEMONSTRATION': return 'demonstration';
    default: return 'civil_unrest';
  }
}

function mapSourceType(s: string): ProtestSource {
  switch (s) {
    case 'UNREST_SOURCE_TYPE_ACLED': return 'acled';
    case 'UNREST_SOURCE_TYPE_GDELT': return 'gdelt';
    default: return 'rss';
  }
}

function mapConfidence(c: string): 'high' | 'medium' | 'low' {
  switch (c) {
    case 'CONFIDENCE_LEVEL_HIGH': return 'high';
    case 'CONFIDENCE_LEVEL_MEDIUM': return 'medium';
    default: return 'low';
  }
}

// ---- Core Adapter: proto UnrestEvent -> legacy SocialUnrestEvent ----

function toSocialUnrestEvent(e: UnrestEvent): SocialUnrestEvent {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary || undefined,
    eventType: mapEventType(e.eventType),
    city: e.city || undefined,
    country: e.country,
    region: e.region || undefined,
    lat: e.location?.latitude ?? 0,
    lon: e.location?.longitude ?? 0,
    time: new Date(e.occurredAt),
    severity: mapSeverity(e.severity),
    fatalities: e.fatalities > 0 ? e.fatalities : undefined,
    sources: e.sources,
    sourceType: mapSourceType(e.sourceType),
    tags: e.tags.length > 0 ? e.tags : undefined,
    actors: e.actors.length > 0 ? e.actors : undefined,
    confidence: mapConfidence(e.confidence),
    validated: mapConfidence(e.confidence) === 'high',
  };
}

// ---- Exported Types ----

export interface ProtestData {
  events: SocialUnrestEvent[];
  byCountry: Map<string, SocialUnrestEvent[]>;
  highSeverityCount: number;
  sources: { acled: number; gdelt: number };
}

// ---- ACLED Configuration Heuristic ----

let acledConfigured: boolean | null = null;

// ---- Main Fetch Function ----

const emptyFallback: ListUnrestEventsResponse = {
  events: [],
  clusters: [],
  pagination: undefined,
};

export async function fetchProtestEvents(): Promise<ProtestData> {
  const resp = await unrestBreaker.execute(async () => {
    return client.listUnrestEvents({
      country: '',
      minSeverity: 'SEVERITY_LEVEL_UNSPECIFIED',
    });
  }, emptyFallback);

  const events = resp.events.map(toSocialUnrestEvent);

  // Group by country
  const byCountry = new Map<string, SocialUnrestEvent[]>();
  for (const event of events) {
    const existing = byCountry.get(event.country) || [];
    existing.push(event);
    byCountry.set(event.country, existing);
  }

  // Count by source
  const acledCount = events.filter(e => e.sourceType === 'acled').length;
  const gdeltCount = events.filter(e => e.sourceType === 'gdelt').length;

  // Update acledConfigured heuristic based on response
  if (events.length > 0) {
    if (acledCount > 0) {
      acledConfigured = true;
    } else if (gdeltCount > 0 && acledCount === 0) {
      acledConfigured = false;
    }
  }
  // If completely empty response, leave acledConfigured as null

  return {
    events,
    byCountry,
    highSeverityCount: events.filter(e => e.severity === 'high').length,
    sources: {
      acled: acledCount,
      gdelt: gdeltCount,
    },
  };
}

// ---- Status Function ----

export function getProtestStatus(): { acledConfigured: boolean | null; gdeltAvailable: boolean } {
  return { acledConfigured, gdeltAvailable: true };
}
