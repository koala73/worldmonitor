/**
 * ECDC (European Centre for Disease Prevention and Control) Disease Surveillance
 * Sources: ECDC RSS feeds via rss-proxy
 */

export type EcdcReportType =
  | 'rapid-risk-assessment'
  | 'threat-report'
  | 'surveillance'
  | 'outbreak'
  | 'advisory'
  | 'general';

export interface EcdcAlert {
  id: string;
  title: string;
  description: string;
  reportType: EcdcReportType;
  disease: string;
  affectedCountries: string[];
  threatLevel: 'very-high' | 'high' | 'moderate' | 'low' | 'unknown';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const ECDC_FEEDS = [
  'https://www.ecdc.europa.eu/en/rss.xml',
  'https://www.ecdc.europa.eu/en/publications-data/communicable-disease-threats-report/rss',
  'https://www.ecdc.europa.eu/en/publications-data/rapid-risk-assessments/rss',
  'https://www.ecdc.europa.eu/en/news-events/news/rss',
];

const FEED_URL_TYPE_MAP: Record<string, EcdcReportType> = {
  'rapid-risk-assessments': 'rapid-risk-assessment',
  'communicable-disease-threats-report': 'threat-report',
};

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
let cache: { data: EcdcAlert[]; ts: number } | null = null;

const DISEASE_PATTERNS: string[] = [
  'COVID',
  'SARS-CoV',
  'influenza',
  'flu',
  'mpox',
  'monkeypox',
  'measles',
  'meningitis',
  'cholera',
  'dengue',
  'West Nile',
  'Ebola',
  'Marburg',
  'plague',
  'anthrax',
  'botulism',
  'rabies',
  'polio',
  'hepatitis',
  'Salmonella',
  'E.coli',
  'Listeria',
  'MRSA',
  'C.diff',
  'RSV',
  'norovirus',
  'legionella',
];

const EU_EEA_COUNTRIES: string[] = [
  'Germany',
  'France',
  'Italy',
  'Spain',
  'Netherlands',
  'Poland',
  'Sweden',
  'Denmark',
  'Czech Republic',
  'Greece',
  'Hungary',
  'Romania',
  'Bulgaria',
  'Austria',
  'Belgium',
  'Portugal',
  'Finland',
  'Slovakia',
  'Croatia',
  'Ireland',
  'Lithuania',
  'Latvia',
  'Estonia',
  'Slovenia',
  'Luxembourg',
  'Malta',
  'Cyprus',
  'Norway',
  'Iceland',
  'Liechtenstein',
  'Switzerland',
];

const RELEVANCE_KEYWORDS = [
  'disease',
  'outbreak',
  'infection',
  'virus',
  'bacteria',
  'case',
  'surveillance',
  'risk assessment',
  'epidemic',
  'zoonotic',
  'antimicrobial',
  'vaccine-preventable',
];

function rssProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
}

function extractDisease(text: string): string {
  const lower = text.toLowerCase();
  for (const name of DISEASE_PATTERNS) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return '';
}

function extractCountries(text: string): string[] {
  const found: string[] = [];
  for (const country of EU_EEA_COUNTRIES) {
    if (text.includes(country)) found.push(country);
  }
  return found;
}

function detectThreatLevel(text: string): EcdcAlert['threatLevel'] {
  const lower = text.toLowerCase();
  if (lower.includes('very high')) return 'very-high';
  if (lower.includes('high')) return 'high';
  if (lower.includes('moderate')) return 'moderate';
  if (lower.includes('low')) return 'low';
  return 'unknown';
}

function detectReportType(title: string, url: string, feedUrl: string): EcdcReportType {
  const lower = title.toLowerCase();
  const urlLower = url.toLowerCase();

  if (lower.includes('rapid risk assessment') || urlLower.includes('rapid-risk-assessment')) {
    return 'rapid-risk-assessment';
  }
  if (feedUrl.includes('communicable-disease-threats-report') || lower.includes('communicable disease threats')) {
    return 'threat-report';
  }
  if (lower.includes('surveillance')) return 'surveillance';
  if (lower.includes('outbreak')) return 'outbreak';
  if (lower.includes('advisory') || lower.includes('alert')) return 'advisory';

  // Check feed URL for type hints
  for (const [key, type] of Object.entries(FEED_URL_TYPE_MAP)) {
    if (feedUrl.includes(key)) return type;
  }

  return 'general';
}

function computeSeverity(reportType: EcdcReportType, threatLevel: EcdcAlert['threatLevel']): EcdcAlert['severity'] {
  if (reportType === 'rapid-risk-assessment' && (threatLevel === 'very-high' || threatLevel === 'high')) {
    return 'critical';
  }
  if (reportType === 'outbreak') return 'high';
  if (reportType === 'threat-report') return 'medium';
  if (reportType === 'surveillance') return 'low';
  return 'low';
}

function isRelevant(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return RELEVANCE_KEYWORDS.some((kw) => text.includes(kw));
}

function titleHash(title: string): string {
  // Simple deterministic hash for deduplication
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  }
  return `ecdc-${h}`;
}

function parseFeedXml(text: string, feedUrl: string): EcdcAlert[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  let items = doc.querySelectorAll('item');
  const isAtom = items.length === 0;
  if (isAtom) items = doc.querySelectorAll('entry');

  const results: EcdcAlert[] = [];

  [...items].forEach((item) => {
    const title = item.querySelector('title')?.textContent?.trim() ?? '';
    const description =
      item.querySelector('description')?.textContent?.trim() ??
      item.querySelector('summary')?.textContent?.trim() ??
      item.querySelector('content')?.textContent?.trim() ??
      '';
    let url = '';
    url = isAtom ? item.querySelector('link[href]')?.getAttribute('href') ?? '' : item.querySelector('link')?.textContent?.trim() ?? '';

    const pubDateStr = isAtom
      ? (item.querySelector('updated')?.textContent ?? item.querySelector('published')?.textContent ?? '')
      : (item.querySelector('pubDate')?.textContent ?? '');
    const parsed = pubDateStr ? new Date(pubDateStr) : new Date();
    const pubDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

    if (!isRelevant(title, description)) return;

    const combined = `${title} ${description} ${url}`;
    const reportType = detectReportType(title, url, feedUrl);
    const disease = extractDisease(combined);
    const affectedCountries = extractCountries(combined);
    const threatLevel = detectThreatLevel(description);
    const severity = computeSeverity(reportType, threatLevel);

    results.push({
      id: titleHash(title),
      title,
      description,
      reportType,
      disease,
      affectedCountries,
      threatLevel,
      pubDate,
      url,
      severity,
    });
  });

  return results;
}

export async function fetchEcdcAlerts(): Promise<EcdcAlert[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;

  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    ECDC_FEEDS.map(async (feedUrl) => {
      const res = await fetch(rssProxyUrl(feedUrl), {
        signal: AbortSignal.timeout(12_000),
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) return [] as EcdcAlert[];
      const text = await res.text();
      return parseFeedXml(text, feedUrl);
    }),
  );

  const all: EcdcAlert[] = [];
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

  const severityOrder: Record<EcdcAlert['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const filtered = deduped
    .filter((a) => a.pubDate >= thirtyDaysAgo)
    .sort((a, b) => {
      const sd = severityOrder[a.severity] - severityOrder[b.severity];
      if (sd !== 0) return sd;
      return b.pubDate.getTime() - a.pubDate.getTime();
    })
    .slice(0, 40);

  cache = { data: filtered, ts: now };
  return filtered;
}

export function ecdcSeverityClass(severity: EcdcAlert['severity']): string {
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
