/**
 * Client-side service for positive geo events.
 * Fetches geocoded positive news from server-side GDELT GEO RPC
 * and geocodes curated RSS items via inferGeoHubsFromTitle.
 */

import type { HappyContentCategory } from './positive-classifier';
import { PositiveEventsServiceClient } from '@/generated/client/worldmonitor/positive_events/v1/service_client';
import { inferGeoHubsFromTitle } from './geo-hub-index';
import { createCircuitBreaker } from '@/utils';

export interface PositiveGeoEvent {
  lat: number;
  lon: number;
  name: string;
  category: HappyContentCategory;
  count: number;
  timestamp: number;
}

const client = new PositiveEventsServiceClient('', {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const breaker = createCircuitBreaker<PositiveGeoEvent[]>({
  name: 'Positive Geo Events',
  cacheTtlMs: 10 * 60 * 1000, // 10min — GDELT data refreshes frequently
  persistCache: true,
});

/**
 * Fetch geocoded positive events from server-side GDELT GEO RPC.
 * Returns instantly from IndexedDB cache on subsequent loads.
 */
export async function fetchPositiveGeoEvents(): Promise<PositiveGeoEvent[]> {
  return breaker.execute(async () => {
    const response = await client.listPositiveGeoEvents({});
    return response.events.map(event => ({
      lat: event.latitude,
      lon: event.longitude,
      name: event.name,
      category: (event.category || 'humanity-kindness') as HappyContentCategory,
      count: event.count,
      timestamp: event.timestamp,
    }));
  }, []);
}

/**
 * Geocode curated RSS items using the geo-hub keyword index.
 * Items without location mentions in their titles are filtered out.
 */
export function geocodePositiveNewsItems(
  items: Array<{ title: string; category?: HappyContentCategory }>,
): PositiveGeoEvent[] {
  const events: PositiveGeoEvent[] = [];

  for (const item of items) {
    const matches = inferGeoHubsFromTitle(item.title);
    const firstMatch = matches[0];
    if (firstMatch) {
      events.push({
        lat: firstMatch.hub.lat,
        lon: firstMatch.hub.lon,
        name: item.title,
        category: item.category || 'humanity-kindness',
        count: 1,
        timestamp: Date.now(),
      });
    }
  }

  return events;
}
