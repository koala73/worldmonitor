// Kindness data pipeline: real kindness events from curated news
// Green labeled dots on the happy map from actual humanity-kindness articles

import { inferGeoHubsFromTitle } from './geo-hub-index';

export interface KindnessPoint {
  lat: number;
  lon: number;
  name: string;
  description: string;
  intensity: number;      // 0-1, higher = more prominent on map
  type: 'baseline' | 'real';
  timestamp: number;
}

/**
 * Extract real kindness events from curated news items.
 * Filters for humanity-kindness category and geocodes via title.
 */
function extractKindnessEvents(
  newsItems: { title: string; happyCategory?: string }[],
): KindnessPoint[] {
  const kindnessItems = newsItems.filter(
    item => item.happyCategory === 'humanity-kindness',
  );

  const events: KindnessPoint[] = [];
  for (const item of kindnessItems) {
    const matches = inferGeoHubsFromTitle(item.title);
    const firstMatch = matches[0];
    if (firstMatch) {
      events.push({
        lat: firstMatch.hub.lat,
        lon: firstMatch.hub.lon,
        name: item.title,
        description: item.title,
        intensity: 0.8,
        type: 'real',
        timestamp: Date.now(),
      });
    }
  }

  return events;
}

/**
 * Fetch kindness data: real kindness events extracted from curated news.
 * Only returns events that can be geocoded from article titles.
 */
export function fetchKindnessData(
  newsItems?: { title: string; happyCategory?: string }[],
): KindnessPoint[] {
  return newsItems ? extractKindnessEvents(newsItems) : [];
}
