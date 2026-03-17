export type CombatantCommand =
  | 'CENTCOM'
  | 'INDOPACOM'
  | 'EUCOM'
  | 'AFRICOM'
  | 'SOUTHCOM'
  | 'NORTHCOM'
  | 'SOCOM'
  | 'SPACECOM'
  | 'DoD';

export interface CommandRelease {
  id: string;
  title: string;
  description: string;
  command: CombatantCommand;
  category: 'airstrike' | 'exercise' | 'deployment' | 'operation' | 'advisory' | 'general';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  region: string;
}

interface CommandFeed {
  command: CombatantCommand;
  url: string;
}

const FEEDS: CommandFeed[] = [
  { command: 'DoD',       url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=25' },
  { command: 'CENTCOM',   url: 'https://www.centcom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=822&max=25' },
  { command: 'INDOPACOM', url: 'https://www.pacom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=519&max=25' },
  { command: 'EUCOM',     url: 'https://www.eucom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=42&max=25' },
  { command: 'AFRICOM',   url: 'https://www.africom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=22&max=25' },
  { command: 'SOUTHCOM',  url: 'https://www.southcom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=63&max=25' },
  { command: 'NORTHCOM',  url: 'https://www.northcom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=28&max=25' },
  { command: 'SOCOM',     url: 'https://www.socom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=81&max=25' },
  { command: 'SPACECOM',  url: 'https://www.spacecom.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=23&max=25' },
];

const CACHE_TTL_MS = 10 * 60 * 1000;

interface Cache {
  items: CommandRelease[];
  ts: number;
}

let _cache: Cache | null = null;

function proxyFeedUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectCategory(text: string): CommandRelease['category'] {
  const t = text.toLowerCase();
  if (/strike|airstrike|bomb|target|destroy|eliminat/.test(t)) return 'airstrike';
  if (/exercise|training|drill|maneuver/.test(t)) return 'exercise';
  if (/deploy|redeploy|positioned|forward|afloat/.test(t)) return 'deployment';
  if (/operation|mission|raid|capture/.test(t)) return 'operation';
  if (/warning|alert|threat|escalat/.test(t)) return 'advisory';
  return 'general';
}

function detectSeverity(category: CommandRelease['category']): CommandRelease['severity'] {
  switch (category) {
    case 'airstrike':  return 'critical';
    case 'operation':
    case 'advisory':   return 'high';
    case 'deployment':
    case 'exercise':   return 'medium';
    default:           return 'low';
  }
}

function detectRegion(text: string): string {
  const t = text.toLowerCase();
  if (/iraq|syria|iran|yemen|gaza|lebanon|jordan|kuwait|qatar|bahrain/.test(t)) return 'Middle East';
  if (/china|taiwan|korea|japan|philippines|australia|pacific|indopacom/.test(t)) return 'Indo-Pacific';
  if (/ukraine|russia|nato|europe|baltic|poland/.test(t)) return 'Europe';
  if (/africa|somalia|sahel|sudan|mali|niger/.test(t)) return 'Africa';
  if (/venezuela|haiti|caribbean|south america|mexico/.test(t)) return 'Americas';
  return 'Global';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\W/g, '');
}

function parseFeed(xmlText: string, command: CombatantCommand): CommandRelease[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  const items = Array.from(doc.querySelectorAll('item'));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  return items.flatMap((item): CommandRelease[] => {
    const titleRaw = item.querySelector('title')?.textContent?.trim() ?? '';
    const descRaw  = item.querySelector('description')?.textContent?.trim() ?? '';
    const link     = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) return [];

    const title       = stripHtml(titleRaw);
    const description = stripHtml(descRaw);
    const combined    = `${title} ${description}`;
    const category    = detectCategory(combined);
    const severity    = detectSeverity(category);
    const region      = detectRegion(combined);
    const id          = `${command}-${link || title}-${pubDate.getTime()}`;

    return [{
      id,
      title,
      description,
      command,
      category,
      pubDate,
      url: link,
      severity,
      region,
    }];
  });
}

const SEVERITY_ORDER: Record<CommandRelease['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchCombatantCommands(): Promise<CommandRelease[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.items;

  const results = await Promise.allSettled(
    FEEDS.map(async ({ command, url }) => {
      const res = await fetch(proxyFeedUrl(url), {
        signal: AbortSignal.timeout(12000),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [] as CommandRelease[];
      const text = await res.text();
      return parseFeed(text, command);
    }),
  );

  const all: CommandRelease[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by normalized title
  const seen = new Set<string>();
  const deduped = all.filter(item => {
    const key = normalizeTitle(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: severity asc-index then pubDate desc
  deduped.sort((a, b) => {
    const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sd !== 0) return sd;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  const items = deduped.slice(0, 60);
  _cache = { items, ts: Date.now() };
  return items;
}

export function commandSeverityClass(severity: CommandRelease['severity']): string {
  switch (severity) {
    case 'critical': return 'text-red-500';
    case 'high':     return 'text-orange-500';
    case 'medium':   return 'text-yellow-500';
    default:         return 'text-gray-400';
  }
}
