/**
 * US Treasury OFAC sanctions designations — new additions to the SDN list.
 *
 * Fetches three RSS/Atom feeds through /api/rss-proxy and filters for
 * sanction-relevant items. Parses both RSS <item> and Atom <entry> elements.
 *
 * Program detection covers major country/thematic programs.
 * Keeps last 30 days. Limit 40, sorted by severity then date desc.
 * Cache TTL: 30 minutes.
 */

export type SanctionProgram =
  | 'Russia' | 'Iran' | 'North Korea' | 'China' | 'Venezuela'
  | 'Terrorism' | 'Narcotics' | 'Cyber' | 'Human Rights' | 'Other';

export interface SanctionDesignation {
  id: string;
  title: string;
  description: string;
  program: SanctionProgram;
  entities: string[];
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const FEED_URLS = [
  'https://home.treasury.gov/news/press-releases.xml',
  'https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/rss',
  'https://home.treasury.gov/system/files/126/ofac.xml',
];

const CACHE_TTL_MS = 30 * 60 * 1000;

interface SanctionsCache {
  items: SanctionDesignation[];
  fetchedAt: number;
}

let _cache: SanctionsCache | null = null;

const RELEVANCE_TERMS = /sanction|ofac|sdn|designat|treasury action|blocked/i;

const PROGRAM_PATTERNS: { program: SanctionProgram; pattern: RegExp }[] = [
  { program: 'Russia',       pattern: /russia|ukraine|belarus|kremlin|putin/i },
  { program: 'Iran',         pattern: /iran|irgc|iranian|tehran/i },
  { program: 'North Korea',  pattern: /north korea|dprk|kim jong/i },
  { program: 'China',        pattern: /\bchina\b|prc|ccp|hong kong/i },
  { program: 'Venezuela',    pattern: /venezuela|maduro/i },
  { program: 'Terrorism',    pattern: /terrorism|terrorist|isis|isil|al.?qaeda|hamas|hezbollah|taliban/i },
  { program: 'Narcotics',    pattern: /narcotics|cartel|drug trafficking|fentanyl/i },
  { program: 'Cyber',        pattern: /cyber|hacking|ransomware|malware/i },
  { program: 'Human Rights', pattern: /human rights|corruption|kleptocrat/i },
];

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectProgram(title: string, description: string): SanctionProgram {
  const text = title + ' ' + description;
  for (const { program, pattern } of PROGRAM_PATTERNS) {
    if (pattern.test(text)) return program;
  }
  return 'Other';
}

function detectSeverity(program: SanctionProgram): SanctionDesignation['severity'] {
  if (program === 'Russia' || program === 'Iran' || program === 'North Korea') return 'critical';
  if (program === 'Terrorism' || program === 'Cyber') return 'high';
  if (program !== 'Other') return 'medium';
  return 'low';
}

function extractEntities(title: string): string[] {
  const entities: string[] = [];

  // Extract names in quotes
  const quotedMatches = title.match(/"([^"]{3,60})"/g);
  if (quotedMatches) {
    entities.push(...quotedMatches.map(m => m.replace(/"/g, '').trim()));
  }

  // Extract ALL CAPS words (3+ chars, not common acronyms like OFAC/SDN/U.S.)
  const capsMatches = title.match(/\b[A-Z]{3,}\b/g);
  if (capsMatches) {
    const skipSet = new Set(['OFAC', 'SDN', 'USA', 'U.S.', 'USD', 'DOJ', 'FBI', 'CIA', 'DOT', 'IRAN', 'ISIS', 'ISIL', 'DPRK', 'IRGC', 'CCP', 'PRC']);
    const filtered = capsMatches.filter(w => !skipSet.has(w));
    entities.push(...filtered);
  }

  const unique: string[] = [];
  const entitySeen = new Set<string>();
  for (const e of entities) {
    if (!entitySeen.has(e)) { entitySeen.add(e); unique.push(e); }
  }
  return unique.slice(0, 5);
}

function normalizeId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

interface ParsedItem {
  title: string;
  description: string;
  link: string;
  pubDateStr: string;
  guid: string;
}

function parseRssItems(doc: Document): ParsedItem[] {
  const results: ParsedItem[] = [];

  // RSS <item> elements
  const rssItems = [...doc.querySelectorAll('item')];
  for (const item of rssItems) {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description = stripHtml(item.querySelector('description')?.textContent ?? '');
    const link = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
    const guid = item.querySelector('guid')?.textContent?.trim() ?? link;
    results.push({ title, description, link, pubDateStr, guid });
  }

  // Atom <entry> elements
  const entries = [...doc.querySelectorAll('entry')];
  for (const entry of entries) {
    const title = entry.querySelector('title')?.textContent?.trim() ?? '';
    const rawContent = entry.querySelector('content')?.textContent
      ?? entry.querySelector('summary')?.textContent
      ?? '';
    const description = stripHtml(rawContent);
    const linkEl = entry.querySelector('link[rel="alternate"], link');
    const link = linkEl?.getAttribute('href') ?? entry.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr = entry.querySelector('published')?.textContent?.trim()
      ?? entry.querySelector('updated')?.textContent?.trim()
      ?? '';
    const guid = entry.querySelector('id')?.textContent?.trim() ?? link;
    results.push({ title, description, link, pubDateStr, guid });
  }

  return results;
}

async function fetchFeedDesignations(feedUrl: string): Promise<SanctionDesignation[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const rawItems = parseRssItems(doc);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const designations: SanctionDesignation[] = [];

    for (const raw of rawItems) {
      const combined = raw.title + ' ' + raw.description;
      if (!RELEVANCE_TERMS.test(combined)) continue;

      const pubDate = raw.pubDateStr ? new Date(raw.pubDateStr) : new Date();
      if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) continue;

      const program = detectProgram(raw.title, raw.description);
      const severity = detectSeverity(program);
      const entities = extractEntities(raw.title);

      designations.push({
        id: `ofac-${normalizeId(raw.title)}`,
        title: raw.title,
        description: raw.description.slice(0, 400),
        program,
        entities,
        pubDate,
        url: raw.link,
        severity,
      });
    }

    return designations;
  } catch {
    return [];
  }
}

const SEVERITY_ORDER: Record<SanctionDesignation['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function fetchSanctions(): Promise<SanctionDesignation[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.items;
  }

  const results = await Promise.allSettled(
    FEED_URLS.map(url => fetchFeedDesignations(url)),
  );

  const combined: SanctionDesignation[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      combined.push(...result.value);
    }
  }

  // Deduplicate by normalized title hash
  const seen = new Set<string>();
  const deduped: SanctionDesignation[] = [];
  for (const item of combined) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
  }

  // Sort by severity then date desc
  deduped.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  const items = deduped.slice(0, 40);
  _cache = { items, fetchedAt: Date.now() };
  return items;
}

export function sanctionSeverityClass(severity: SanctionDesignation['severity']): string {
  switch (severity) {
    case 'critical': { return 'text-red-500';
    }
    case 'high': {     return 'text-orange-500';
    }
    case 'medium': {   return 'text-yellow-500';
    }
    default: {         return 'text-gray-400';
    }
  }
}
