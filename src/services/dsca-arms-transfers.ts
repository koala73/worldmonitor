export interface ArmsTransfer {
  id: string;
  title: string;
  description: string;
  recipient: string;
  systems: string[];
  valueEstimate: string | null;
  transmittalNumber: string | null;
  pubDate: Date;
  url: string;
  source: 'federal-register' | 'dsca';
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'major-defense' | 'commercial' | 'training' | 'logistics' | 'general';
}

const CACHE_TTL_MS = 30 * 60 * 1000;

interface Cache {
  items: ArmsTransfer[];
  ts: number;
}

let _cache: Cache | null = null;

const FEDERAL_REGISTER_URL =
  'https://www.federalregister.gov/api/v1/documents.json' +
  '?conditions[agencies][]=defense-security-cooperation-agency' +
  '&per_page=20&order=newest&conditions[type][]=Notice';

const DSCA_RSS_URL = 'https://www.dsca.mil/rss.xml';

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

const WEAPON_SYSTEMS = [
  'F-16', 'F-35', 'F-15', 'C-130', 'AH-64', 'UH-60', 'M1A2', 'Abrams',
  'Patriot', 'HIMARS', 'JDAM', 'AIM-120', 'Harpoon', 'Javelin', 'Stinger',
  'Apache', 'Black Hawk', 'submarine', 'frigate', 'destroyer', 'corvette',
  'radar', 'missile', 'helicopter',
];

const MAJOR_DEFENSE_SYSTEMS = /aircraft|f-16|f-35|f-15|c-130|ah-64|uh-60|m1a2|abrams|patriot|himars|jdam|aim-120|harpoon|javelin|stinger|apache|black hawk|submarine|frigate|destroyer|corvette|radar/i;

function extractSystems(text: string): string[] {
  const found: string[] = [];
  for (const sys of WEAPON_SYSTEMS) {
    const re = new RegExp(sys.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(text)) found.push(sys);
  }
  return found;
}

function extractRecipient(text: string): string {
  // "Government of [Country]"
  const govMatch = text.match(/Government of ([A-Z][A-Za-z\s\-]+?)(?:\s+for|\s+to|\s*[,.(]|$)/);
  if (govMatch?.[1]) return govMatch[1].trim();

  // "to [Country]"
  const toMatch = text.match(/\bto\s+([A-Z][A-Za-z\s\-]+?)(?:\s+for|\s+a\s|\s+the\s|\s*[,.(]|$)/);
  if (toMatch?.[1]) return toMatch[1].trim();

  return 'Unknown';
}

function extractValue(text: string): string | null {
  const m = text.match(/\$[\d,.]+\s*(?:million|billion)/i);
  return m ? m[0] : null;
}

function extractTransmittal(text: string): string | null {
  const m = text.match(/Transmittal\s+(?:No\.?\s*)?(\d{2}-\d+)/i);
  return m ? (m[1] ?? null) : null;
}

function detectCategory(text: string, systems: string[]): ArmsTransfer['category'] {
  const t = text.toLowerCase();
  if (/training/.test(t) && !MAJOR_DEFENSE_SYSTEMS.test(t)) return 'training';
  if (/spare parts|logistics|maintenance|support/.test(t) && !MAJOR_DEFENSE_SYSTEMS.test(t)) return 'logistics';
  if (/letter of offer|commercial/.test(t) && !MAJOR_DEFENSE_SYSTEMS.test(t)) return 'commercial';
  if (systems.length > 0 || MAJOR_DEFENSE_SYSTEMS.test(t)) return 'major-defense';
  return 'general';
}

function detectSeverity(
  category: ArmsTransfer['category'],
  valueEstimate: string | null,
): ArmsTransfer['severity'] {
  if (category !== 'major-defense') return 'low';

  if (valueEstimate) {
    const billions = valueEstimate.match(/\$([\d,.]+)\s*billion/i);
    if (billions) return 'critical';

    const millions = valueEstimate.match(/\$([\d,.]+)\s*million/i);
    if (millions) {
      const amount = parseFloat((millions[1] ?? '0').replace(/,/g, ''));
      if (amount >= 100) return 'high';
    }
  }

  return 'medium';
}

interface FederalRegisterDoc {
  title?: string;
  abstract?: string;
  publication_date?: string;
  html_url?: string;
  document_number?: string;
}

function parseFederalRegisterDocs(docs: FederalRegisterDoc[]): ArmsTransfer[] {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return docs.flatMap((doc): ArmsTransfer[] => {
    const title       = (doc.title ?? '').trim();
    const description = (doc.abstract ?? '').trim();
    const combined    = `${title} ${description}`;

    // Relevance filter
    if (!/sale|transfer|transmittal/i.test(combined)) return [];

    const pubDate = doc.publication_date ? new Date(doc.publication_date) : new Date();
    if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) return [];

    const systems          = extractSystems(combined);
    const valueEstimate    = extractValue(combined);
    const transmittalNumber = extractTransmittal(combined);
    const recipient        = extractRecipient(combined);
    const category         = detectCategory(combined, systems);
    const severity         = detectSeverity(category, valueEstimate);

    return [{
      id: doc.document_number ?? `fr-${pubDate.getTime()}-${title.slice(0, 20)}`,
      title,
      description,
      recipient,
      systems,
      valueEstimate,
      transmittalNumber,
      pubDate,
      url: doc.html_url ?? '',
      source: 'federal-register',
      severity,
      category,
    }];
  });
}

function parseDscaRss(xmlText: string): ArmsTransfer[] {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  const items  = Array.from(doc.querySelectorAll('item'));
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return items.flatMap((item): ArmsTransfer[] => {
    const title       = stripHtml(item.querySelector('title')?.textContent?.trim() ?? '');
    const description = stripHtml(item.querySelector('description')?.textContent?.trim() ?? '');
    const link        = item.querySelector('link')?.textContent?.trim() ?? '';
    const pubDateStr  = item.querySelector('pubDate')?.textContent?.trim() ?? '';
    const combined    = `${title} ${description}`;

    if (!/sale|transfer|transmittal/i.test(combined)) return [];

    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (Number.isNaN(pubDate.getTime()) || pubDate.getTime() < cutoff) return [];

    const systems           = extractSystems(combined);
    const valueEstimate     = extractValue(combined);
    const transmittalNumber = extractTransmittal(combined);
    const recipient         = extractRecipient(combined);
    const category          = detectCategory(combined, systems);
    const severity          = detectSeverity(category, valueEstimate);

    return [{
      id: transmittalNumber ? `dsca-${transmittalNumber}` : `dsca-${pubDate.getTime()}-${title.slice(0, 20)}`,
      title,
      description,
      recipient,
      systems,
      valueEstimate,
      transmittalNumber,
      pubDate,
      url: link,
      source: 'dsca',
      severity,
      category,
    }];
  });
}

export async function fetchArmsTransfers(): Promise<ArmsTransfer[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.items;

  const [frResult, dscaResult] = await Promise.allSettled([
    fetch(FEDERAL_REGISTER_URL, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    }).then(res => {
      if (!res.ok) return [] as ArmsTransfer[];
      return res.json().then((json: { results?: FederalRegisterDoc[] }) =>
        parseFederalRegisterDocs(json.results ?? []),
      );
    }),
    fetch(proxyFeedUrl(DSCA_RSS_URL), {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    }).then(res => {
      if (!res.ok) return [] as ArmsTransfer[];
      return res.text().then(parseDscaRss);
    }),
  ]);

  const all: ArmsTransfer[] = [];
  if (frResult.status === 'fulfilled')   all.push(...frResult.value);
  if (dscaResult.status === 'fulfilled') all.push(...dscaResult.value);

  // Deduplicate by transmittal number, then by document id
  const seen = new Set<string>();
  const deduped = all.filter(item => {
    const key = item.transmittalNumber ?? item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by pubDate desc
  deduped.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  const items = deduped.slice(0, 30);
  _cache = { items, ts: Date.now() };
  return items;
}

export function armsTransferSeverityClass(severity: ArmsTransfer['severity']): string {
  switch (severity) {
    case 'critical': return 'text-red-500';
    case 'high':     return 'text-orange-500';
    case 'medium':   return 'text-yellow-500';
    default:         return 'text-gray-400';
  }
}
