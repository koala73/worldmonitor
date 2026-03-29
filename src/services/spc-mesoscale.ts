/**
 * NOAA Storm Prediction Center Mesoscale Discussions
 * Expert text analyses of developing severe weather situations.
 * Data source: https://www.spc.noaa.gov/products/md/rss.xml (via rss-proxy)
 */

export type MdType = 'tornado' | 'severe-thunderstorm' | 'fire-weather' | 'flooding' | 'winter' | 'general';

export interface MesoscaleDiscussion {
  id: string;
  number: number;
  title: string;
  description: string;
  mdType: MdType;
  watchIssued: boolean;
  pds: boolean;
  affectedStates: string[];
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — time-critical data
let cache: { data: MesoscaleDiscussion[]; ts: number } | null = null;

const SPC_RSS_URL = 'https://www.spc.noaa.gov/products/md/rss.xml';

const US_STATE_ABBREVS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractText(xml: string, tag: string): string {
  const cdataRe = new RegExp(String.raw`<${tag}[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/${tag}>`, 'i');
  const plainRe = new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return (cdataMatch[1] ?? '').trim();
  const plainMatch = xml.match(plainRe);
  if (plainMatch) return stripHtml(plainMatch[1] ?? '').trim();
  return '';
}

function detectMdType(text: string): MdType {
  const lower = text.toLowerCase();
  if (/tornado|tornadic|rotating thunderstorm|supercell/.test(lower)) return 'tornado';
  if (/severe thunderstorm|large hail|damaging wind|derecho/.test(lower)) return 'severe-thunderstorm';
  if (/fire weather|red flag|critical fire|low rh|strong wind/.test(lower)) return 'fire-weather';
  if (/flooding|flash flood|heavy rain|rainfall/.test(lower)) return 'flooding';
  if (/winter storm|blizzard|freezing|ice storm|snow squall/.test(lower)) return 'winter';
  return 'general';
}

function extractAffectedStates(text: string): string[] {
  const matches = text.match(/\b([A-Z]{2})\b/g) ?? [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const abbrev of matches) {
    if (US_STATE_ABBREVS.has(abbrev) && !seen.has(abbrev)) {
      seen.add(abbrev);
      found.push(abbrev);
    }
  }
  return found;
}

function computeSeverity(
  mdType: MdType,
  pds: boolean,
  watchIssued: boolean,
): MesoscaleDiscussion['severity'] {
  if (pds) return 'critical';
  if (mdType === 'tornado' && watchIssued) return 'critical';
  if (mdType === 'tornado') return 'high';
  if (mdType === 'severe-thunderstorm' && watchIssued) return 'high';
  if (mdType === 'severe-thunderstorm') return 'medium';
  if (mdType === 'fire-weather') return 'medium';
  if (mdType === 'flooding') return 'medium';
  return 'low';
}

function parseItems(xmlText: string): MesoscaleDiscussion[] {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const now = Date.now();
  const cutoff = now - 48 * 60 * 60 * 1000;
  const results: MesoscaleDiscussion[] = [];

  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xmlText)) !== null) {
    const block = match[1] ?? '';
    const title = extractText(block, 'title');
    const description = extractText(block, 'description');
    const link = extractText(block, 'link');
    const pubDateStr = extractText(block, 'pubDate');
    const guid = extractText(block, 'guid');

    if (!title) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) continue;

    const numMatch = /Mesoscale Discussion\s+(\d+)/i.exec(title);
    if (!numMatch) continue;
    const number = Number.parseInt(numMatch[1] ?? '0', 10);

    const watchIssued = title.includes('Watch') && title.includes('Issued');
    const combinedText = title + ' ' + description;
    const pds =
      /Particularly Dangerous Situation/i.test(combinedText) ||
      /\bPDS\b/.test(combinedText);

    const mdType = detectMdType(combinedText);
    const affectedStates = extractAffectedStates(description);
    const severity = computeSeverity(mdType, pds, watchIssued);

    results.push({
      id: guid || `spc-md-${number}-${pubDate.getTime()}`,
      number,
      title,
      description: stripHtml(description),
      mdType,
      watchIssued,
      pds,
      affectedStates,
      pubDate,
      url: link,
      severity,
    });
  }

  return results;
}

const SEVERITY_ORDER: Record<MesoscaleDiscussion['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchMesoscaleDiscussions(): Promise<MesoscaleDiscussion[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;

  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(SPC_RSS_URL)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return cache?.data ?? [];

    const xmlText = await res.text();
    const items = parseItems(xmlText);

    items.sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sev !== 0) return sev;
      return b.pubDate.getTime() - a.pubDate.getTime();
    });

    const data = items.slice(0, 25);
    cache = { data, ts: Date.now() };
    return data;
  } catch {
    return cache?.data ?? [];
  }
}

export function mdSeverityClass(severity: MesoscaleDiscussion['severity']): string {
  switch (severity) {
    case 'critical': { return 'eq-row eq-major';
    }
    case 'high': { return 'eq-row eq-strong';
    }
    case 'medium': { return 'eq-row eq-moderate';
    }
    case 'low': { return 'eq-row';
    }
  }
}

export function mdTypeLabel(type: MdType): string {
  switch (type) {
    case 'tornado': { return 'Tornado Threat';
    }
    case 'severe-thunderstorm': { return 'Severe Thunderstorm';
    }
    case 'fire-weather': { return 'Fire Weather';
    }
    case 'flooding': { return 'Flash Flooding';
    }
    case 'winter': { return 'Winter Weather';
    }
    case 'general': { return 'General Discussion';
    }
  }
}
