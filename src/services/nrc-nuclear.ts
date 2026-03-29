/**
 * NRC (Nuclear Regulatory Commission) Event Notifications
 * Public RSS feed — no authentication required
 * https://www.nrc.gov/reading-rm/news/rss/press-releases.xml
 *
 * Filters for nuclear safety events: emergency declarations,
 * unusual events, reactor trips, radiological releases.
 */

export interface NrcEvent {
  id: string;
  title: string;
  description: string;
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  eventType: 'emergency' | 'alert' | 'unusual-event' | 'site-area-emergency' | 'general-emergency' | 'info';
}

const NRC_RSS = 'https://www.nrc.gov/reading-rm/news/rss/press-releases.xml';
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { events: NrcEvent[]; fetchedAt: number } | null = null;

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

const NUCLEAR_KEYWORDS = [
  'emergency', 'unusual event', 'alert', 'site area', 'general emergency',
  'reactor', 'nuclear', 'radiological', 'radiation', 'fuel', 'core',
  'coolant', 'containment', 'tritium', 'release', 'spill', 'leak',
  'declaration', 'shutdown', 'scram', 'trip',
];

function isNuclearEvent(title: string, description: string): boolean {
  const text = (title + ' ' + description).toLowerCase();
  return NUCLEAR_KEYWORDS.some(k => text.includes(k));
}

function scoreEventType(title: string, desc: string): NrcEvent['eventType'] {
  const t = (title + ' ' + desc).toLowerCase();
  if (t.includes('general emergency')) return 'general-emergency';
  if (t.includes('site area emergency')) return 'site-area-emergency';
  if (t.includes('alert')) return 'alert';
  if (t.includes('unusual event')) return 'unusual-event';
  if (t.includes('emergency')) return 'emergency';
  return 'info';
}

function scoreSeverity(eventType: NrcEvent['eventType']): NrcEvent['severity'] {
  switch (eventType) {
    case 'general-emergency': { return 'critical';
    }
    case 'site-area-emergency': { return 'critical';
    }
    case 'emergency': { return 'high';
    }
    case 'alert': { return 'high';
    }
    case 'unusual-event': { return 'medium';
    }
    default: { return 'low';
    }
  }
}

export async function fetchNrcEvents(): Promise<NrcEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;

  try {
    const res = await fetch(rssProxyUrl(NRC_RSS), { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return cache?.events ?? [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return cache?.events ?? [];

    const items = doc.querySelectorAll('item');
    const events: NrcEvent[] = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const description = item.querySelector('description')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();

      if (!isNuclearEvent(title, description)) continue;

      const eventType = scoreEventType(title, description);
      const severity = scoreSeverity(eventType);

      const rawKey = (title + pubDateStr).slice(0, 60);
      let shortId = '';
      try { shortId = btoa(unescape(encodeURIComponent(rawKey))).slice(0, 20); } catch { shortId = rawKey.replace(/\W/g, '').slice(0, 20); }
      events.push({
        id: `nrc-${shortId}`,
        title,
        description: description.slice(0, 500),
        pubDate,
        url: link,
        severity,
        eventType,
      });
    }

    // Keep last 7 days
    const recent = events
      .filter(e => Date.now() - e.pubDate.getTime() < 7 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, 30);

    cache = { events: recent, fetchedAt: Date.now() };
    return recent;
  } catch {
    return cache?.events ?? [];
  }
}

export function nrcSeverityClass(severity: NrcEvent['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
