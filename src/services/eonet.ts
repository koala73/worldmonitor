import type { NaturalEvent, NaturalEventCategory } from '@/types';
import {
  NaturalServiceClient,
  type ListNaturalEventsResponse,
} from '@/generated/client/worldmonitor/natural/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

const CATEGORY_ICONS: Record<NaturalEventCategory, string> = {
  severeStorms: '🌀',
  wildfires: '🔥',
  volcanoes: '🌋',
  earthquakes: '🔴',
  floods: '🌊',
  landslides: '⛰️',
  drought: '☀️',
  dustHaze: '🌫️',
  snow: '❄️',
  tempExtremes: '🌡️',
  seaLakeIce: '🧊',
  waterColor: '🦠',
  manmade: '⚠️',
};

export function getNaturalEventIcon(category: NaturalEventCategory): string {
  return CATEGORY_ICONS[category] || '⚠️';
}

const client = new NaturalServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListNaturalEventsResponse>({ name: 'NaturalEvents', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyFallback: ListNaturalEventsResponse = { events: [] };

function toNaturalEvent(e: ListNaturalEventsResponse['events'][number]): NaturalEvent {
  return {
    id: e.id,
    title: e.title,
    description: e.description || undefined,
    category: (e.category || 'manmade') as NaturalEventCategory,
    categoryTitle: e.categoryTitle,
    lat: e.lat,
    lon: e.lon,
    date: new Date(e.date),
    magnitude: e.magnitude ?? undefined,
    magnitudeUnit: e.magnitudeUnit ?? undefined,
    sourceUrl: e.sourceUrl || undefined,
    sourceName: e.sourceName || undefined,
    closed: e.closed,
  };
}

export async function fetchNaturalEvents(_days = 30): Promise<NaturalEvent[]> {
  const hydrated = getHydratedData('naturalEvents') as ListNaturalEventsResponse | undefined;
  const response = hydrated ?? await breaker.execute(async () => {
    return client.listNaturalEvents({ days: 30 });
  }, emptyFallback);

  return (response.events || []).map(toNaturalEvent);
}
