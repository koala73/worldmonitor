/**
 * Power grid emergency alerts and outage monitoring
 *
 * Sources:
 *  - NERC (North American Electric Reliability Corporation) alerts:
 *    https://www.nerc.com/pa/RAPA/alerts/Pages/Alerts_DL.aspx — RSS
 *  - DOE CESER (Office of Cybersecurity, Energy Security, Emergency Response):
 *    https://www.energy.gov/ceser/rss — news/alerts RSS
 *  - EIA Real-Time Grid Monitor — requires free API key (optional, gated)
 *    https://api.eia.gov/v2/electricity/rto/
 *
 * Grid emergencies include: capacity shortages, extreme weather loading,
 * transmission failures, cyber attacks on grid infrastructure.
 */

export interface PowerGridAlert {
  id: string;
  title: string;
  description: string;
  source: 'NERC' | 'DOE' | 'EIA' | 'ERCOT' | 'CAISO';
  region: string;           // e.g. "WECC", "SERC", "Texas", "California"
  alertType: 'emergency' | 'warning' | 'watch' | 'reliability' | 'cyber' | 'info';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// NERC reliability alerts RSS
const NERC_ALERTS_RSS = 'https://www.nerc.com/pa/RAPA/alerts/Pages/Alerts_DL.aspx?View=RSS';
// DOE energy/emergency news
const DOE_CESER_RSS = 'https://www.energy.gov/ceser/rss.xml';
// DOE Office of Electricity
const DOE_OE_RSS = 'https://www.energy.gov/oe/rss.xml';

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { alerts: PowerGridAlert[]; fetchedAt: number } | null = null;

const GRID_EMERGENCY_KEYWORDS = [
  'emergency', 'blackout', 'outage', 'shortage', 'capacity', 'reliability',
  'grid', 'power', 'electricity', 'transmission', 'load shedding',
  'rolling blackout', 'forced outage', 'conservation', 'generation',
  'cyber', 'attack', 'disruption', 'resilience', 'storm', 'extreme heat',
  'extreme cold', 'winter storm', 'heatwave', 'demand response',
];

function isGridRelevant(title: string, description: string): boolean {
  const text = (title + ' ' + description).toLowerCase();
  return GRID_EMERGENCY_KEYWORDS.some(k => text.includes(k));
}

function detectAlertType(title: string, description: string): PowerGridAlert['alertType'] {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('cyber') || text.includes('hack') || text.includes('attack')) return 'cyber';
  if (text.includes('emergency') || text.includes('blackout') || text.includes('outage')) return 'emergency';
  if (text.includes('warning') || text.includes('shortage') || text.includes('conservation')) return 'warning';
  if (text.includes('watch') || text.includes('monitor')) return 'watch';
  if (text.includes('reliability') || text.includes('capacity') || text.includes('transmission')) return 'reliability';
  return 'info';
}

function scoreSeverity(alertType: PowerGridAlert['alertType'], title: string): PowerGridAlert['severity'] {
  const t = title.toLowerCase();
  if (alertType === 'cyber') return 'critical';
  if (alertType === 'emergency' || t.includes('blackout') || t.includes('outage')) return 'critical';
  if (alertType === 'warning' || t.includes('shortage') || t.includes('stage')) return 'high';
  if (alertType === 'watch' || alertType === 'reliability') return 'medium';
  return 'low';
}

function extractRegion(title: string, description: string): string {
  const text = title + ' ' + description;
  const regions = ['WECC', 'SERC', 'RFC', 'MRO', 'NPCC', 'TRE', 'ERCOT', 'CAISO', 'PJM', 'MISO', 'SPP', 'NYISO', 'ISONE'];
  for (const r of regions) {
    if (text.includes(r)) return r;
  }
  const states = /\b(California|Texas|New York|Florida|New England|Midwest|Southeast|Northwest|Southwest)\b/.exec(text);
  return states?.[0] ?? 'North America';
}

async function fetchRssFeed(feedUrl: string, source: PowerGridAlert['source']): Promise<PowerGridAlert[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    const alerts: PowerGridAlert[] = [];

    for (const item of items) {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      if (!isGridRelevant(title, description)) continue;

      const alertType = detectAlertType(title, description);
      alerts.push({
        id: `grid-${source.toLowerCase()}-${title.replace(/\W/g, '').slice(0, 20)}`,
        title,
        description: description.slice(0, 400),
        source,
        region: extractRegion(title, description),
        alertType,
        pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        severity: scoreSeverity(alertType, title),
      });
    }

    return alerts;
  } catch {
    return [];
  }
}

export async function fetchPowerGridAlerts(): Promise<PowerGridAlert[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.alerts;

  const [nercResult, doeResult, oeResult] = await Promise.allSettled([
    fetchRssFeed(NERC_ALERTS_RSS, 'NERC'),
    fetchRssFeed(DOE_CESER_RSS, 'DOE'),
    fetchRssFeed(DOE_OE_RSS, 'DOE'),
  ]);

  const combined = [
    ...(nercResult.status === 'fulfilled' ? nercResult.value : []),
    ...(doeResult.status === 'fulfilled' ? doeResult.value : []),
    ...(oeResult.status === 'fulfilled' ? oeResult.value : []),
  ];

  // Dedupe by title similarity
  const seen = new Set<string>();
  const deduped: PowerGridAlert[] = [];
  for (const a of combined.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())) {
    const key = a.title.toLowerCase().replace(/\W/g, '').slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(a);
    }
  }

  // Keep last 14 days
  const recent = deduped
    .filter(a => Date.now() - a.pubDate.getTime() < 14 * 24 * 3_600_000)
    .slice(0, 40);

  cache = { alerts: recent, fetchedAt: Date.now() };
  return recent;
}

export function gridSeverityClass(severity: PowerGridAlert['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
