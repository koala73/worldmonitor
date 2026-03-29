/**
 * NTSB (National Transportation Safety Board) Major Accident Investigation Announcements
 * Sources: NTSB RSS feeds via rss-proxy
 */

export type NtsbMode =
  | 'aviation'
  | 'rail'
  | 'highway'
  | 'marine'
  | 'pipeline'
  | 'multi-modal'
  | 'general';

export type NtsbItemType =
  | 'new-investigation'
  | 'preliminary-report'
  | 'accident-report'
  | 'safety-recommendation'
  | 'go-team'
  | 'press-release';

export interface NtsbInvestigation {
  id: string;
  title: string;
  description: string;
  mode: NtsbMode;
  itemType: NtsbItemType;
  location: string;
  date: Date;
  pubDate: Date;
  url: string;
  fatalities: number;
  injuries: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  goTeamDeployed: boolean;
}

const NTSB_FEEDS = [
  'https://www.ntsb.gov/news/press-releases/Pages/default.aspx?Category=RSS',
  'https://www.ntsb.gov/news/rss.xml',
  'https://www.ntsb.gov/investigations/Pages/default.aspx?Category=RSS',
  'https://go.ntsb.gov/rss/',
];

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let cache: { data: NtsbInvestigation[]; ts: number } | null = null;

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function detectMode(text: string): NtsbMode {
  const lower = text.toLowerCase();

  const aviation =
    lower.includes('aircraft') ||
    lower.includes('plane') ||
    lower.includes('flight') ||
    lower.includes('airport') ||
    lower.includes('helicopter') ||
    lower.includes('uav') ||
    lower.includes('faa') ||
    lower.includes('commercial aviation') ||
    (lower.includes('crash') && lower.includes('air'));

  const rail =
    lower.includes('train') ||
    lower.includes('railroad') ||
    lower.includes('amtrak') ||
    lower.includes('freight') ||
    lower.includes('derail') ||
    (lower.includes('collision') && lower.includes('rail'));

  const highway =
    lower.includes('highway') ||
    lower.includes('truck') ||
    lower.includes('bus') ||
    (lower.includes('vehicle') && !aviation) ||
    lower.includes('motorcoach') ||
    lower.includes('roadway');

  const marine =
    lower.includes('vessel') ||
    lower.includes('boat') ||
    lower.includes('ship') ||
    lower.includes('ferry') ||
    lower.includes('capsiz') ||
    lower.includes('marine');

  const pipeline =
    lower.includes('pipeline') ||
    lower.includes('gas') ||
    lower.includes('rupture') ||
    lower.includes('phmsa');

  const modes = [aviation, rail, highway, marine, pipeline].filter(Boolean).length;
  if (modes >= 2) return 'multi-modal';
  if (aviation) return 'aviation';
  if (rail) return 'rail';
  if (highway) return 'highway';
  if (marine) return 'marine';
  if (pipeline) return 'pipeline';
  return 'general';
}

function detectItemType(title: string, description: string): NtsbItemType {
  const text = `${title} ${description}`.toLowerCase();

  if (text.includes('go team') || text.includes('board members launch') || text.includes('investigators deployed')) {
    return 'go-team';
  }
  if (text.includes('preliminary report') || text.includes('preliminary findings')) {
    return 'preliminary-report';
  }
  if (text.includes('accident report') || text.includes('final report') || text.includes('findings')) {
    return 'accident-report';
  }
  if (text.includes('safety recommendation') || text.includes('recommends')) {
    return 'safety-recommendation';
  }
  if (
    text.includes('investigation opened') ||
    text.includes('investigating') ||
    text.includes('accident involving')
  ) {
    return 'new-investigation';
  }
  return 'press-release';
}

function detectGoTeam(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return text.includes('go team') || text.includes('board members launch');
}

function extractNumber(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m?.[1] ? Number.parseInt(m[1] ?? '0', 10) : 0;
}

function extractLocation(title: string, description: string): string {
  // Try "in {City}, {State}" or "{City}, {State}" patterns
  const combined = `${title} ${description}`;
  const m =
    (/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?:,\s*([A-Z]{2})|\s+([A-Z][a-z]+))/i.exec(combined)) ??
    (/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})\b/.exec(combined));
  if (m?.[1]) {
    const city = m[1] ?? '';
    const state = m[2] ?? m[3] ?? '';
    return state ? `${city}, ${state}` : city;
  }
  return '';
}

function computeSeverity(
  goTeamDeployed: boolean,
  fatalities: number,
  injuries: number,
  itemType: NtsbItemType,
): NtsbInvestigation['severity'] {
  if (goTeamDeployed || fatalities > 0) return 'critical';
  if (itemType === 'preliminary-report' || injuries > 0) return 'high';
  if (itemType === 'new-investigation' || itemType === 'safety-recommendation') return 'medium';
  return 'low';
}

function titleHash(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  }
  return `ntsb-${Math.abs(h)}`;
}

function parseFeedXml(text: string, _feedUrl: string): NtsbInvestigation[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  let items = doc.querySelectorAll('item');
  const isAtom = items.length === 0;
  if (isAtom) items = doc.querySelectorAll('entry');

  const results: NtsbInvestigation[] = [];

  [...items].forEach((item) => {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description =
      item.querySelector('description')?.textContent?.trim() ??
      item.querySelector('summary')?.textContent?.trim() ??
      '';
    let url = '';
    url = isAtom ? item.querySelector('link[href]')?.getAttribute('href') ?? '' : item.querySelector('link')?.textContent?.trim() ?? '';

    const pubDateStr = isAtom
      ? (item.querySelector('updated')?.textContent ?? item.querySelector('published')?.textContent ?? '')
      : (item.querySelector('pubDate')?.textContent ?? '');
    const parsed = pubDateStr ? new Date(pubDateStr) : new Date();
    const pubDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    if (!title) return;

    const combined = `${title} ${description}`;
    const mode = detectMode(combined);
    const itemType = detectItemType(title, description);
    const goTeamDeployed = detectGoTeam(title, description);
    const fatalities = extractNumber(combined, /(\d+)\s*(?:fatali|killed|dead)/i);
    const injuries = extractNumber(combined, /(\d+)\s*(?:injur)/i);
    const location = extractLocation(title, description);
    const severity = computeSeverity(goTeamDeployed, fatalities, injuries, itemType);

    results.push({
      id: titleHash(title),
      title,
      description,
      mode,
      itemType,
      location,
      date: pubDate,
      pubDate,
      url,
      fatalities,
      injuries,
      severity,
      goTeamDeployed,
    });
  });

  return results;
}

export async function fetchNtsbInvestigations(): Promise<NtsbInvestigation[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    NTSB_FEEDS.map(async (feedUrl) => {
      const res = await fetch(rssProxyUrl(feedUrl), {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [] as NtsbInvestigation[];
      const text = await res.text();
      return parseFeedXml(text, feedUrl);
    }),
  );

  const all: NtsbInvestigation[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by id (title hash)
  const seen = new Set<string>();
  const deduped = all.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  const severityOrder: Record<NtsbInvestigation['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const filtered = deduped
    .filter((a) => a.pubDate >= sixtyDaysAgo)
    .sort((a, b) => {
      const sd = severityOrder[a.severity] - severityOrder[b.severity];
      if (sd !== 0) return sd;
      return b.pubDate.getTime() - a.pubDate.getTime();
    })
    .slice(0, 30);

  cache = { data: filtered, ts: now };
  return filtered;
}

export function ntsbSeverityClass(severity: NtsbInvestigation['severity']): string {
  switch (severity) {
    case 'critical': {
      return 'eq-row eq-major';
    }
    case 'high': {
      return 'eq-row eq-strong';
    }
    case 'medium': {
      return 'eq-row eq-moderate';
    }
    case 'low': {
      return 'eq-row';
    }
    default: {
      return 'eq-row';
    }
  }
}

export function ntsbModeLabel(mode: NtsbMode): string {
  switch (mode) {
    case 'aviation': {
      return 'Aviation';
    }
    case 'rail': {
      return 'Rail';
    }
    case 'highway': {
      return 'Highway';
    }
    case 'marine': {
      return 'Marine';
    }
    case 'pipeline': {
      return 'Pipeline';
    }
    case 'multi-modal': {
      return 'Multi-Modal';
    }
    case 'general': {
      return 'General';
    }
    default: {
      return 'General';
    }
  }
}
