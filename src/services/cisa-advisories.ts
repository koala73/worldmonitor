/**
 * CISA (Cybersecurity and Infrastructure Security Agency) advisories
 * RSS feed — no authentication required
 * https://www.cisa.gov/cybersecurity-advisories/all.xml
 *
 * Unlike the general cyber service, CISA also issues:
 *  - ICS advisories: attacks on industrial control systems (power, water, manufacturing)
 *  - Healthcare advisories: ransomware targeting hospitals
 *  - Water/wastewater advisories: attacks on water treatment systems
 *  - Known Exploited Vulnerabilities (KEV) catalog updates
 *  - Emergency directives for federal agencies
 *
 * These are often direct threats to critical infrastructure that supports
 * emergency response — a CISA advisory on a hospital during a mass casualty
 * event compounds the emergency.
 */

export type CisaSector =
  | 'Healthcare'
  | 'Energy'
  | 'Water'
  | 'Transportation'
  | 'Communications'
  | 'Financial'
  | 'Government'
  | 'Defense'
  | 'Manufacturing'
  | 'Nuclear'
  | 'ICS'
  | 'General';

export type CisaAdvisoryType =
  | 'ICS Advisory'
  | 'ICS Alert'
  | 'Malware Analysis'
  | 'Known Exploited'
  | 'Emergency Directive'
  | 'Alert'
  | 'Advisory';

export interface CisaAdvisory {
  id: string;
  title: string;
  description: string;
  advisoryType: CisaAdvisoryType;
  sector: CisaSector;
  cvssScore: number | null;       // CVSS severity score 0-10
  pubDate: Date;
  url: string;
  affectedVendors: string[];
  isActivelyExploited: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CISA_ALL_RSS = 'https://www.cisa.gov/cybersecurity-advisories/all.xml';
const CISA_ICS_RSS = 'https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml';
const CISA_ALERTS_RSS = 'https://www.cisa.gov/cybersecurity-advisories/alerts.xml';

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { advisories: CisaAdvisory[]; fetchedAt: number } | null = null;

const SECTOR_KEYWORDS: Record<CisaSector, string[]> = {
  Healthcare: ['hospital', 'healthcare', 'medical', 'health', 'clinical', 'pharmacy'],
  Energy: ['energy', 'power', 'electric', 'oil', 'gas', 'pipeline', 'grid', 'utility'],
  Water: ['water', 'wastewater', 'sewage', 'treatment plant'],
  Transportation: ['transportation', 'rail', 'aviation', 'maritime', 'traffic'],
  Communications: ['telecom', 'communications', 'network', 'isp', 'broadband'],
  Financial: ['financial', 'bank', 'payment', 'fintech'],
  Government: ['government', 'federal', 'state', 'municipal', 'public sector'],
  Defense: ['defense', 'military', 'dod', 'pentagon'],
  Manufacturing: ['manufacturing', 'industrial', 'factory'],
  Nuclear: ['nuclear', 'radiological', 'nrc', 'reactor'],
  ICS: ['ics', 'scada', 'ot ', 'operational technology', 'plc', 'hmi', 'industrial control'],
  General: [],
};

function detectSector(title: string, description: string): CisaSector {
  const text = (title + ' ' + description).toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS) as [CisaSector, string[]][]) {
    if (sector === 'General') continue;
    if (keywords.some(k => text.includes(k))) return sector;
  }
  return 'General';
}

function detectAdvisoryType(title: string): CisaAdvisoryType {
  const t = title.toLowerCase();
  if (t.includes('ics alert')) return 'ICS Alert';
  if (t.includes('ics advisory')) return 'ICS Advisory';
  if (t.includes('malware') || t.includes('analysis')) return 'Malware Analysis';
  if (t.includes('known exploited') || t.includes('kev')) return 'Known Exploited';
  if (t.includes('emergency directive') || t.includes('ed ')) return 'Emergency Directive';
  if (t.includes('alert')) return 'Alert';
  return 'Advisory';
}

function extractCvss(description: string): number | null {
  const match = /cvss(?:\s+v[23])?\s*(?:score|base)?\s*[:\-–]?\s*(\d+(?:\.\d+)?)/i.exec(description);
  if (match?.[1]) {
    const score = Number.parseFloat(match[1]);
    if (score >= 0 && score <= 10) return score;
  }
  return null;
}

function extractVendors(title: string, description: string): string[] {
  const text = title + ' ' + description;
  // Common pattern: "VendorName Products" or "ProductName Vulnerability"
  const products: string[] = [];
  const productMatch = text.match(/\b([A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]{2,})?)\s+(?:product|software|firmware|system|device)s?\b/gi);
  if (productMatch) products.push(...productMatch.slice(0, 3).map(p => p.replace(/\s+(product|software|firmware|system|device)s?$/i, '').trim()));
  return [...new Set(products)].slice(0, 5);
}

function cvssToSeverity(cvss: number | null, type: CisaAdvisoryType, activelyExploited: boolean): CisaAdvisory['severity'] {
  if (type === 'Emergency Directive') return 'critical';
  if (activelyExploited && (cvss === null || cvss >= 7)) return 'critical';
  if (cvss !== null) {
    if (cvss >= 9) return 'critical';
    if (cvss >= 7) return 'high';
    if (cvss >= 4) return 'medium';
    return 'low';
  }
  if (type === 'ICS Alert' || type === 'Alert') return 'high';
  if (type === 'ICS Advisory') return 'medium';
  return 'low';
}

async function fetchRss(feedUrl: string): Promise<CisaAdvisory[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    return [...items].map((item) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const guid = item.querySelector('guid')?.textContent?.trim() ?? link;

      const advisoryType = detectAdvisoryType(title);
      const cvssScore = extractCvss(description);
      const isActivelyExploited = /actively exploited|in the wild|exploitation detected|cve known exploited/i.test(title + description);

      return {
        id: `cisa-${guid.split('/').pop() ?? title.replace(/\W/g, '').slice(0, 20)}`,
        title,
        description: description.slice(0, 500),
        advisoryType,
        sector: detectSector(title, description),
        cvssScore,
        pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        affectedVendors: extractVendors(title, description),
        isActivelyExploited,
        severity: cvssToSeverity(cvssScore, advisoryType, isActivelyExploited),
      };
    });
  } catch {
    return [];
  }
}

export async function fetchCisaAdvisories(): Promise<CisaAdvisory[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.advisories;

  const [allResult, icsResult, alertsResult] = await Promise.allSettled([
    fetchRss(CISA_ALL_RSS),
    fetchRss(CISA_ICS_RSS),
    fetchRss(CISA_ALERTS_RSS),
  ]);

  const combined = [
    ...(allResult.status === 'fulfilled' ? allResult.value : []),
    ...(icsResult.status === 'fulfilled' ? icsResult.value : []),
    ...(alertsResult.status === 'fulfilled' ? alertsResult.value : []),
  ];

  // Dedupe by URL
  const seen = new Set<string>();
  const deduped: CisaAdvisory[] = [];
  for (const a of combined.sort((x, y) => y.pubDate.getTime() - x.pubDate.getTime())) {
    if (!seen.has(a.url)) {
      seen.add(a.url);
      deduped.push(a);
    }
  }

  // Last 30 days
  const recent = deduped
    .filter(a => Date.now() - a.pubDate.getTime() < 30 * 24 * 3_600_000)
    .slice(0, 60);

  cache = { advisories: recent, fetchedAt: Date.now() };
  return recent;
}

export function cisaSeverityClass(severity: CisaAdvisory['severity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', low: 'eq-row' }[severity] ?? 'eq-row';
}
