import type { SocialUnrestEvent, ProtestSeverity, ProtestEventType } from '@/types';
import { INTEL_HOTSPOTS } from '@/config';
import { generateId, createCircuitBreaker } from '@/utils';

// ACLED API - proxied through serverless function (token kept server-side)
const ACLED_PROXY_URL = '/api/acled';

// GDELT GEO 2.0 API - no auth required
const GDELT_GEO_URL = '/api/gdelt-geo';

const acledBreaker = createCircuitBreaker<SocialUnrestEvent[]>({ name: 'ACLED Protests' });
const gdeltBreaker = createCircuitBreaker<SocialUnrestEvent[]>({ name: 'GDELT Events' });

// Track if ACLED is configured (determined by first API call)
let acledConfigured: boolean | null = null;

// Haversine distance calculation
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find nearby intel hotspots for context
function findNearbyHotspots(lat: number, lon: number, radiusKm = 500): string[] {
  return INTEL_HOTSPOTS
    .filter(h => haversineKm(lat, lon, h.lat, h.lon) < radiusKm)
    .map(h => h.name);
}

// ACLED event type mapping
function mapAcledEventType(eventType: string, subEventType: string): ProtestEventType {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence')) return 'riot';
  if (lower.includes('strike')) return 'strike';
  if (lower.includes('demonstration')) return 'demonstration';
  if (lower.includes('protest')) return 'protest';
  return 'civil_unrest';
}

// ACLED fatality-based severity
function acledSeverity(fatalities: number, eventType: string): ProtestSeverity {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot')) return 'high';
  if (eventType.toLowerCase().includes('protest')) return 'medium';
  return 'low';
}

interface AcledEvent {
  event_id_cnty: string;
  event_date: string;
  event_type: string;
  sub_event_type: string;
  actor1: string;
  actor2?: string;
  country: string;
  admin1?: string;
  admin2?: string;
  location: string;
  latitude: string;
  longitude: string;
  fatalities: string;
  notes: string;
  source: string;
  source_scale?: string;
  tags?: string;
}

async function fetchAcledEvents(): Promise<SocialUnrestEvent[]> {
  return acledBreaker.execute(async () => {
    // Use server-side proxy (token not exposed to client)
    const response = await fetch(ACLED_PROXY_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn('[ACLED] Rate limited, will retry later');
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    // Check if ACLED is configured on server
    if (result.configured === false) {
      acledConfigured = false;
      throw new Error('ACLED not configured');
    }

    acledConfigured = true;
    const events: AcledEvent[] = result.data || [];

    return events.map((e): SocialUnrestEvent => {
      const lat = parseFloat(e.latitude);
      const lon = parseFloat(e.longitude);
      const fatalities = parseInt(e.fatalities, 10) || 0;

      return {
        id: `acled-${e.event_id_cnty}`,
        title: e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`,
        summary: e.notes,
        eventType: mapAcledEventType(e.event_type, e.sub_event_type),
        city: e.location,
        country: e.country,
        region: e.admin1,
        lat,
        lon,
        time: new Date(e.event_date),
        severity: acledSeverity(fatalities, e.event_type),
        fatalities: fatalities > 0 ? fatalities : undefined,
        sources: [e.source],
        sourceType: 'acled',
        actors: [e.actor1, e.actor2].filter(Boolean) as string[],
        tags: e.tags?.split(';').map(t => t.trim()).filter(Boolean),
        relatedHotspots: findNearbyHotspots(lat, lon),
        confidence: 'high',
        validated: true,
      };
    });
  }, []);
}

interface GdeltGeoFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: {
    name: string;
    count: number;
    shareimage?: string;
    html?: string;
  };
}

interface GdeltGeoResponse {
  type: 'FeatureCollection';
  features: GdeltGeoFeature[];
}

async function fetchGdeltEvents(): Promise<SocialUnrestEvent[]> {
  return gdeltBreaker.execute(async () => {
    const params = new URLSearchParams({
      query: 'protest',
      format: 'geojson',
      maxrecords: '250',
      timespan: '7d',
    });

    const response = await fetch(`${GDELT_GEO_URL}?${params}`, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data: GdeltGeoResponse = await response.json();
    const allEvents: SocialUnrestEvent[] = [];
    const seenLocations = new Set<string>();

    for (const feature of data.features || []) {
      const name = feature.properties.name || '';
      if (!name || seenLocations.has(name)) continue;

      const count = feature.properties.count || 1;
      if (count < 5) continue; // Filter noise but keep meaningful events

      seenLocations.add(name);

      const [lon, lat] = feature.geometry.coordinates;
      const lowerName = name.toLowerCase();

      let severity: ProtestSeverity = 'medium';
      if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash')) {
        severity = 'high';
      } else if (count < 25) {
        severity = 'low';
      }

      let eventType: ProtestEventType = 'protest';
      if (lowerName.includes('riot')) eventType = 'riot';
      else if (lowerName.includes('strike')) eventType = 'strike';
      else if (lowerName.includes('demonstration')) eventType = 'demonstration';

      const country = name.split(',').pop()?.trim() || name;

      allEvents.push({
        id: `gdelt-${generateId()}`,
        title: `${name} (${count} reports)`,
        eventType,
        country,
        city: name.split(',')[0]?.trim(),
        lat,
        lon,
        time: new Date(),
        severity,
        sources: ['GDELT'],
        sourceType: 'gdelt',
        relatedHotspots: findNearbyHotspots(lat, lon),
        confidence: count > 20 ? 'high' : 'medium',
        validated: count > 30,
        imageUrl: feature.properties.shareimage,
      });
    }

    return allEvents;
  }, []);
}

// Deduplicate events from multiple sources
function deduplicateEvents(events: SocialUnrestEvent[]): SocialUnrestEvent[] {
  const unique = new Map<string, SocialUnrestEvent>();

  for (const event of events) {
    // Create a rough location key (0.5 degree grid)
    const latKey = Math.round(event.lat * 2) / 2;
    const lonKey = Math.round(event.lon * 2) / 2;
    const dateKey = event.time.toISOString().split('T')[0];
    const key = `${latKey}:${lonKey}:${dateKey}`;

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, event);
    } else {
      // Merge: prefer ACLED (higher confidence), combine sources
      if (event.sourceType === 'acled' && existing.sourceType !== 'acled') {
        event.sources = [...new Set([...event.sources, ...existing.sources])];
        event.validated = true;
        unique.set(key, event);
      } else if (existing.sourceType === 'acled') {
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
        existing.validated = true;
      } else {
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
        if (existing.sources.length >= 2) {
          existing.confidence = 'high';
          existing.validated = true;
        }
      }
    }
  }

  return Array.from(unique.values());
}

// Sort by severity and recency
function sortEvents(events: SocialUnrestEvent[]): SocialUnrestEvent[] {
  const severityOrder: Record<ProtestSeverity, number> = { high: 0, medium: 1, low: 2 };

  return events.sort((a, b) => {
    // First by severity
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;

    // Then by recency
    return b.time.getTime() - a.time.getTime();
  });
}

export interface ProtestData {
  events: SocialUnrestEvent[];
  byCountry: Map<string, SocialUnrestEvent[]>;
  highSeverityCount: number;
  sources: { acled: number; gdelt: number };
}

export async function fetchProtestEvents(): Promise<ProtestData> {
  // Fetch from both sources in parallel
  const [acledEvents, gdeltEvents] = await Promise.all([
    fetchAcledEvents(),
    fetchGdeltEvents(),
  ]);

  console.log(`[Protests] Fetched ${acledEvents.length} ACLED, ${gdeltEvents.length} GDELT events`);

  // Note: Data freshness is recorded in App.ts AFTER ingestProtestsForCII()
  // to avoid race conditions where the Strategic Risk panel refreshes before CII data is ingested

  // Combine and deduplicate
  const allEvents = deduplicateEvents([...acledEvents, ...gdeltEvents]);
  const sorted = sortEvents(allEvents);

  // Group by country
  const byCountry = new Map<string, SocialUnrestEvent[]>();
  for (const event of sorted) {
    const existing = byCountry.get(event.country) || [];
    existing.push(event);
    byCountry.set(event.country, existing);
  }

  return {
    events: sorted,
    byCountry,
    highSeverityCount: sorted.filter(e => e.severity === 'high').length,
    sources: {
      acled: acledEvents.length,
      gdelt: gdeltEvents.length,
    },
  };
}

export function getProtestStatus(): { acledConfigured: boolean | null; gdeltAvailable: boolean } {
  return {
    acledConfigured, // null = unknown, true = configured, false = not configured
    gdeltAvailable: true,
  };
}
