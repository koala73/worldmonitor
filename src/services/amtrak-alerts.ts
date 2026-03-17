/**
 * Amtrak service disruption alerts via public RSS/Atom feeds.
 * Primary: https://www.amtrak.com/content/amtrak/en-us/plan/alerts.atom
 * Fallback: https://www.amtrak.com/rss.xml
 *
 * Both fetched through /api/rss-proxy.
 */

export type AmtrakCorridor =
  | 'Northeast Corridor'
  | 'California'
  | 'Midwest'
  | 'Southeast'
  | 'Long Distance'
  | 'National';

export interface AmtrakAlert {
  id: string;
  title: string;
  description: string;
  trainName: string | null;
  trainNumber: string | null;
  corridor: AmtrakCorridor;
  alertType: 'cancellation' | 'delay' | 'disruption' | 'weather' | 'equipment' | 'general';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const AMTRAK_ATOM_FEED = 'https://www.amtrak.com/content/amtrak/en-us/plan/alerts.atom';
const AMTRAK_RSS_FEED = 'https://www.amtrak.com/rss.xml';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: { alerts: AmtrakAlert[]; fetchedAt: number } | null = null;

// Known Amtrak train names for extraction
const AMTRAK_TRAINS: string[] = [
  'Acela',
  'Northeast Regional',
  'Crescent',
  'Cardinal',
  'Capitol Limited',
  'Empire Builder',
  'California Zephyr',
  'Southwest Chief',
  'Sunset Limited',
  'Auto Train',
  'Silver Star',
  'Silver Meteor',
  'Palmetto',
  'Carolinian',
  'Piedmont',
  'Vermonter',
  'Ethan Allen',
  'Maple Leaf',
  'Adirondack',
  'Lake Shore Limited',
  'Keystone',
  'Pennsylvanian',
  'Wolverine',
  'Blue Water',
  'Pere Marquette',
  'Illini',
  'Saluki',
  'Illinois Zephyr',
  'Carl Sandburg',
  'Hiawatha',
  'Heartland Flyer',
  'Texas Eagle',
  'Pacific Surfliner',
  'Capitol Corridor',
  'San Joaquins',
  'Coast Starlight',
  'Cascades',
];

const NEC_KEYWORDS = [
  'acela',
  'northeast regional',
  'northeast corridor',
  'nec',
  'boston',
  'new york',
  'washington',
  'philadelphia',
  'new haven',
  'providence',
  'penn station',
  'union station',
  'south station',
  'keystone',
  'pennsylvanian',
];

const CALIFORNIA_KEYWORDS = [
  'pacific surfliner',
  'capitol corridor',
  'san joaquin',
  'coast starlight',
  'california',
  'los angeles',
  'san francisco',
  'oakland',
  'sacramento',
  'san diego',
  'santa barbara',
  'emeryville',
];

const MIDWEST_KEYWORDS = [
  'chicago',
  'hiawatha',
  'wolverine',
  'blue water',
  'pere marquette',
  'illini',
  'saluki',
  'illinois zephyr',
  'carl sandburg',
  'heartland flyer',
  'midwest',
  'milwaukee',
  'detroit',
  'st. louis',
  'kansas city',
];

const SOUTHEAST_KEYWORDS = [
  'auto train',
  'silver star',
  'silver meteor',
  'palmetto',
  'carolinian',
  'piedmont',
  'crescent',
  'southeast',
  'florida',
  'miami',
  'orlando',
  'charlotte',
  'atlanta',
  'raleigh',
  'savannah',
];

const LONG_DISTANCE_KEYWORDS = [
  'empire builder',
  'california zephyr',
  'southwest chief',
  'sunset limited',
  'cardinal',
  'capitol limited',
  'texas eagle',
  'vermonter',
  'ethan allen',
  'maple leaf',
  'adirondack',
  'lake shore limited',
  'long distance',
  'transcontinental',
];

function extractTrainName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const train of AMTRAK_TRAINS) {
    if (lower.includes(train.toLowerCase())) return train;
  }
  return null;
}

function extractTrainNumber(text: string): string | null {
  const match = text.match(/\b(?:train\s*(?:#|number|no\.?\s*)?|#\s*)(\d{1,4})\b/i);
  return match ? (match[1] ?? null) : null;
}

function detectCorridor(title: string, description: string): AmtrakCorridor {
  const text = (title + ' ' + description).toLowerCase();

  if (NEC_KEYWORDS.some(k => text.includes(k))) return 'Northeast Corridor';
  if (CALIFORNIA_KEYWORDS.some(k => text.includes(k))) return 'California';
  if (SOUTHEAST_KEYWORDS.some(k => text.includes(k))) return 'Southeast';
  if (MIDWEST_KEYWORDS.some(k => text.includes(k))) return 'Midwest';
  if (LONG_DISTANCE_KEYWORDS.some(k => text.includes(k))) return 'Long Distance';

  return 'National';
}

function detectAlertType(
  title: string,
  description: string,
): AmtrakAlert['alertType'] {
  const text = (title + ' ' + description).toLowerCase();

  if (/\bcancell?(?:ed|ation)\b/.test(text)) return 'cancellation';
  if (/\b(?:delay|delayed|late|behind schedule)\b/.test(text)) return 'delay';
  if (/\b(?:weather|flood|snow|storm|ice|hurricane|tornado|wind)\b/.test(text)) return 'weather';
  if (/\b(?:mechanical|equipment|locomotive|engine\s*failure|power\s*outage)\b/.test(text)) return 'equipment';
  if (/\b(?:service\s*change|bus\s*bridge|bus\s*replacement|substitute|alternate)\b/.test(text)) return 'disruption';

  return 'general';
}

function parseDelayHours(text: string): number | null {
  const match = text.match(/(\d+)\s*(?:hour|hr)s?\s*(?:delay|late)?/i);
  return match ? parseInt(match[1] ?? '0', 10) : null;
}

function computeSeverity(
  alertType: AmtrakAlert['alertType'],
  corridor: AmtrakCorridor,
  title: string,
  description: string,
): AmtrakAlert['severity'] {
  const text = title + ' ' + description;

  if (alertType === 'cancellation' && corridor === 'Northeast Corridor') return 'critical';
  if (alertType === 'cancellation') return 'high';

  const delayHours = parseDelayHours(text);
  if (delayHours !== null && delayHours >= 2) return 'high';

  if (alertType === 'disruption' || alertType === 'weather' || alertType === 'equipment') return 'medium';
  if (alertType === 'delay') return 'medium';

  return 'low';
}

function parseAtomEntries(doc: Document): AmtrakAlert[] {
  const entries = doc.querySelectorAll('entry');
  if (entries.length === 0) return [];

  return Array.from(entries).map((entry) => {
    const title = entry.querySelector('title')?.textContent?.trim() ?? '';
    const summary = (
      entry.querySelector('summary')?.textContent ??
      entry.querySelector('content')?.textContent ??
      ''
    ).replace(/<[^>]+>/g, '').trim();
    const linkEl = entry.querySelector('link');
    const link = linkEl?.getAttribute('href') ?? linkEl?.textContent?.trim() ?? '';
    const updatedStr = entry.querySelector('updated')?.textContent?.trim() ?? '';
    const publishedStr = entry.querySelector('published')?.textContent?.trim() ?? updatedStr;
    const idStr = entry.querySelector('id')?.textContent?.trim() ?? link;

    const text = title + ' ' + summary;
    const trainName = extractTrainName(text);
    const trainNumber = extractTrainNumber(text);
    const corridor = detectCorridor(title, summary);
    const alertType = detectAlertType(title, summary);
    const severity = computeSeverity(alertType, corridor, title, summary);

    return {
      id: `amtrak-${idStr.split('/').pop()?.replace(/\W/g, '') ?? title.replace(/\W/g, '').slice(0, 20)}`,
      title,
      description: summary.slice(0, 500),
      trainName,
      trainNumber,
      corridor,
      alertType,
      pubDate: publishedStr ? new Date(publishedStr) : new Date(),
      url: link,
      severity,
    };
  });
}

function parseRssItems(doc: Document): AmtrakAlert[] {
  const items = doc.querySelectorAll('item');
  if (items.length === 0) return [];

  return Array.from(items).map((item) => {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description = (item.querySelector('description')?.textContent ?? '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const link = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
    const guid = item.querySelector('guid')?.textContent?.trim() ?? link;

    const text = title + ' ' + description;
    const trainName = extractTrainName(text);
    const trainNumber = extractTrainNumber(text);
    const corridor = detectCorridor(title, description);
    const alertType = detectAlertType(title, description);
    const severity = computeSeverity(alertType, corridor, title, description);

    return {
      id: `amtrak-${guid.split('/').pop()?.replace(/\W/g, '') ?? title.replace(/\W/g, '').slice(0, 20)}`,
      title,
      description: description.slice(0, 500),
      trainName,
      trainNumber,
      corridor,
      alertType,
      pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
      url: link,
      severity,
    };
  });
}

async function fetchFeed(feedUrl: string): Promise<AmtrakAlert[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    // Detect Atom vs RSS
    const isAtom = !!doc.querySelector('feed');
    return isAtom ? parseAtomEntries(doc) : parseRssItems(doc);
  } catch {
    return [];
  }
}

export async function fetchAmtrakAlerts(): Promise<AmtrakAlert[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.alerts;
  }

  const [atomResult, rssResult] = await Promise.allSettled([
    fetchFeed(AMTRAK_ATOM_FEED),
    fetchFeed(AMTRAK_RSS_FEED),
  ]);

  const atomAlerts = atomResult.status === 'fulfilled' ? atomResult.value : [];
  const rssAlerts = rssResult.status === 'fulfilled' ? rssResult.value : [];

  // Prefer Atom; merge and dedupe by URL/title
  const combined = [...atomAlerts, ...rssAlerts];
  const seen = new Set<string>();
  const deduped: AmtrakAlert[] = [];
  for (const a of combined) {
    const key = a.url || a.title;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(a);
    }
  }

  const sevenDaysMs = 7 * 24 * 3600_000;
  const now = Date.now();

  const recent = deduped
    .filter(a => now - a.pubDate.getTime() < sevenDaysMs)
    .sort((a, b) => {
      const sOrder: AmtrakAlert['severity'][] = ['critical', 'high', 'medium', 'low'];
      const sr = sOrder.indexOf(a.severity) - sOrder.indexOf(b.severity);
      if (sr !== 0) return sr;
      return b.pubDate.getTime() - a.pubDate.getTime();
    })
    .slice(0, 20);

  cache = { alerts: recent, fetchedAt: Date.now() };
  return recent;
}

export async function fetchAmtrakStatus(): Promise<{
  operational: boolean;
  alertCount: number;
  fetchedAt: Date;
}> {
  const alerts = await fetchAmtrakAlerts();
  const criticalOrHigh = alerts.filter(
    a => a.severity === 'critical' || a.severity === 'high',
  );
  return {
    operational: criticalOrHigh.length === 0,
    alertCount: alerts.length,
    fetchedAt: new Date(),
  };
}

export function amtrakSeverityClass(severity: AmtrakAlert['severity']): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}
