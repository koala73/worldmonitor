import { createCircuitBreaker, fetchWithCache } from '@/utils';
import { isFeatureAvailable } from './runtime-config';

export type ConflictEventType = 'battle' | 'explosion' | 'remote_violence' | 'violence_against_civilians';

export interface ConflictEvent {
  id: string;
  eventType: ConflictEventType;
  subEventType: string;
  country: string;
  region?: string;
  location: string;
  lat: number;
  lon: number;
  time: Date;
  fatalities: number;
  actors: string[];
  source: string;
}

export interface ConflictData {
  events: ConflictEvent[];
  byCountry: Map<string, ConflictEvent[]>;
  totalFatalities: number;
  count: number;
}

interface AcledConflictEvent {
  event_id_cnty: string;
  event_date: string;
  event_type: string;
  sub_event_type: string;
  actor1: string;
  actor2?: string;
  country: string;
  admin1?: string;
  location: string;
  latitude: string;
  longitude: string;
  fatalities: string;
  notes: string;
  source: string;
}

const conflictBreaker = createCircuitBreaker<ConflictEvent[]>({ name: 'ACLED Conflicts' });

function mapEventType(eventType: string): ConflictEventType {
  const lower = eventType.toLowerCase();
  if (lower.includes('battle')) return 'battle';
  if (lower.includes('explosion')) return 'explosion';
  if (lower.includes('remote violence')) return 'remote_violence';
  if (lower.includes('violence against')) return 'violence_against_civilians';
  return 'battle';
}

async function fetchAcledConflictEvents(): Promise<ConflictEvent[]> {
  if (!isFeatureAvailable('acledConflicts')) return [];

  return conflictBreaker.execute(async () => {
    const result = await fetchWithCache<{ configured?: boolean; data?: AcledConflictEvent[] }>('/api/acled-conflict', {
      ttl: 120_000,
      headers: { Accept: 'application/json' },
    });
    if (result.configured === false) throw new Error('ACLED not configured');

    const events: AcledConflictEvent[] = result.data || [];

    return events.map((e): ConflictEvent => ({
      id: `conflict-${e.event_id_cnty}`,
      eventType: mapEventType(e.event_type),
      subEventType: e.sub_event_type || '',
      country: e.country,
      region: e.admin1,
      location: e.location,
      lat: parseFloat(e.latitude),
      lon: parseFloat(e.longitude),
      time: new Date(e.event_date),
      fatalities: parseInt(e.fatalities, 10) || 0,
      actors: [e.actor1, e.actor2].filter(Boolean) as string[],
      source: e.source || '',
    }));
  }, []);
}

export async function fetchConflictEvents(): Promise<ConflictData> {
  const events = await fetchAcledConflictEvents();

  console.log(`[Conflicts] Fetched ${events.length} ACLED conflict events`);

  const byCountry = new Map<string, ConflictEvent[]>();
  let totalFatalities = 0;

  for (const event of events) {
    totalFatalities += event.fatalities;
    const existing = byCountry.get(event.country) || [];
    existing.push(event);
    byCountry.set(event.country, existing);
  }

  return {
    events,
    byCountry,
    totalFatalities,
    count: events.length,
  };
}
