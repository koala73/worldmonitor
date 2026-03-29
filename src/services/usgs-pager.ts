/**
 * USGS PAGER (Prompt Assessment of Global Earthquakes for Response)
 * Public GeoJSON feed — no authentication required
 * https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson
 *
 * PAGER models rapid fatality and economic loss estimates immediately after
 * significant earthquakes, enabling response prioritization. Alert levels:
 *   GREEN  = <1 fatality or minimal losses
 *   YELLOW = 1–99 fatalities or moderate economic impact
 *   ORANGE = 100–999 fatalities or major economic impact
 *   RED    = 1000+ fatalities or extreme economic impact
 */

export type PagerAlertLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface PagerEvent {
  id: string;
  place: string;
  magnitude: number;
  depth: number;           // km
  lat: number;
  lon: number;
  time: Date;
  updatedAt: Date;
  alertLevel: PagerAlertLevel;
  estimatedFatalities: string;    // e.g. "0" | "1-10" | "100-1000" | "1000+"
  estimatedLosses: string;        // economic loss range
  populationExposed: number | null; // thousands of people exposed
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface UsgsFeature {
  id: string;
  geometry: { coordinates: [number, number, number] };
  properties: {
    mag: number;
    place: string;
    time: number;
    updated: number;
    url: string;
    detail: string;
    alert: string | null;     // PAGER level: 'green'|'yellow'|'orange'|'red'|null
    tsunami: number;
    sig: number;
    products?: {
      losspager?: {
        contents: {
          'alertecon.txt'?: { url: string };
          'alertfatal.txt'?: { url: string };
        };
        properties?: {
          alertlevel?: string;
          maxmmi?: string;
          impact1?: string;  // economic impact description
          impact2?: string;  // population impact description
        };
      }[];
    };
  };
}

interface UsgsGeoJson {
  features: UsgsFeature[];
}

const PAGER_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson';
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { events: PagerEvent[]; fetchedAt: number } | null = null;

function alertLevelToSeverity(level: PagerAlertLevel): PagerEvent['severity'] {
  switch (level) {
    case 'red': { return 'critical';
    }
    case 'orange': { return 'high';
    }
    case 'yellow': { return 'medium';
    }
    default: { return 'low';
    }
  }
}

function alertLevelLabel(level: PagerAlertLevel): { fatalities: string; losses: string } {
  switch (level) {
    case 'red': { return { fatalities: '1,000+', losses: '>$1B' };
    }
    case 'orange': { return { fatalities: '100–999', losses: '$100M–$1B' };
    }
    case 'yellow': { return { fatalities: '1–99', losses: '$1M–$100M' };
    }
    default: { return { fatalities: '< 1', losses: '< $1M' };
    }
  }
}

export async function fetchPagerEvents(): Promise<PagerEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;

  try {
    const res = await fetch(PAGER_FEED, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cache?.events ?? [];

    const data: UsgsGeoJson = await res.json();
    const events: PagerEvent[] = [];

    for (const f of data.features ?? []) {
      const p = f.properties;
      const alertLevel = (p.alert as PagerAlertLevel | null) ?? 'green';
      // Only surface events that PAGER has classified (has an alert level)
      if (!p.alert && p.sig < 600) continue;

      const [lon, lat, depth] = f.geometry.coordinates;
      const labels = alertLevelLabel(alertLevel);
      const losspager = p.products?.losspager?.[0];
      const impact2 = losspager?.properties?.impact2 ?? '';

      events.push({
        id: `pager-${f.id}`,
        place: p.place ?? '',
        magnitude: p.mag,
        depth,
        lat,
        lon,
        time: new Date(p.time),
        updatedAt: new Date(p.updated),
        alertLevel,
        estimatedFatalities: labels.fatalities,
        estimatedLosses: labels.losses,
        populationExposed: impact2 ? null : null, // enriched if detail endpoint fetched
        url: p.url,
        severity: alertLevelToSeverity(alertLevel),
      });
    }

    // Sort: highest alert level first, then by magnitude
    const alertOrder: Record<PagerAlertLevel, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
    events.sort((a, b) => alertOrder[a.alertLevel] - alertOrder[b.alertLevel] || b.magnitude - a.magnitude);

    cache = { events, fetchedAt: Date.now() };
    return events;
  } catch {
    return cache?.events ?? [];
  }
}

export function pagerAlertClass(level: PagerAlertLevel): string {
  return {
    red: 'eq-row eq-major',
    orange: 'eq-row eq-strong',
    yellow: 'eq-row eq-moderate',
    green: 'eq-row',
  }[level] ?? 'eq-row';
}
