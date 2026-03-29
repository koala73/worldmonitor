/**
 * NOAA Pacific Tsunami Warning Center (PTWC) & National Tsunami Warning Center (NTWC)
 * Public Atom feeds — no authentication required
 * Pacific: https://www.tsunami.gov/events/xml/PAAQAtom.xml
 * Atlantic: https://www.tsunami.gov/events/xml/ATAQAtom.xml
 */

export interface TsunamiAlert {
  id: string;
  title: string;
  region: 'Pacific' | 'Atlantic';
  severity: 'warning' | 'watch' | 'advisory' | 'information' | 'threat-canceled';
  description: string;
  pubDate: Date;
  url: string;
}

const FEEDS: { url: string; region: TsunamiAlert['region'] }[] = [
  { url: 'https://www.tsunami.gov/events/xml/PAAQAtom.xml', region: 'Pacific' },
  { url: 'https://www.tsunami.gov/events/xml/ATAQAtom.xml', region: 'Atlantic' },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — tsunami alerts are time-critical
let cache: { alerts: TsunamiAlert[]; fetchedAt: number } | null = null;

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function scoreSeverity(title: string): TsunamiAlert['severity'] {
  const t = title.toLowerCase();
  if (t.includes('warning')) return 'warning';
  if (t.includes('watch')) return 'watch';
  if (t.includes('advisory')) return 'advisory';
  if (t.includes('cancel') || t.includes('all clear') || t.includes('threat has passed')) return 'threat-canceled';
  return 'information';
}

async function fetchFeed(feedUrl: string, region: TsunamiAlert['region']): Promise<TsunamiAlert[]> {
  try {
    const res = await fetch(rssProxyUrl(feedUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const entries = doc.querySelectorAll('entry');
    return [...entries].map((entry, i) => {
      const title = entry.querySelector('title')?.textContent?.trim() ?? '';
      const link = entry.querySelector('link[href]')?.getAttribute('href') ?? '';
      const updated = entry.querySelector('updated')?.textContent ?? entry.querySelector('published')?.textContent ?? '';
      const summary = entry.querySelector('summary, content')?.textContent?.trim() ?? '';
      const rawId = entry.querySelector('id')?.textContent?.trim() ?? `${region}-${i}`;

      return {
        id: `tsunami-${rawId.replace(/[^a-zA-Z0-9]/g, '-').slice(-40)}`,
        title,
        region,
        severity: scoreSeverity(title),
        description: summary.slice(0, 500),
        pubDate: updated ? new Date(updated) : new Date(),
        url: link,
      };
    });
  } catch {
    return [];
  }
}

export async function fetchTsunamiAlerts(): Promise<TsunamiAlert[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.alerts;

  const results = await Promise.allSettled(FEEDS.map(f => fetchFeed(f.url, f.region)));
  const alerts: TsunamiAlert[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') alerts.push(...r.value);
  }

  // Keep last 48 hours
  const recent = alerts
    .filter(a => Date.now() - a.pubDate.getTime() < 48 * 60 * 60 * 1000)
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  cache = { alerts: recent, fetchedAt: Date.now() };
  return recent;
}

export function tsunamiSeverityClass(severity: TsunamiAlert['severity']): string {
  return {
    warning: 'eq-row eq-major',
    watch: 'eq-row eq-strong',
    advisory: 'eq-row eq-moderate',
    information: 'eq-row',
    'threat-canceled': 'eq-row',
  }[severity] ?? 'eq-row';
}
