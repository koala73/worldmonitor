// Disease outbreak surveillance — WHO Disease Outbreak News + ReliefWeb API + ProMED
// All sources are free with no API key required

export interface DiseaseOutbreak {
  id: string;
  title: string;
  country: string;
  disease: string;
  date: Date;
  url?: string;
  source: 'WHO' | 'ReliefWeb' | 'ProMED';
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache: { outbreaks: DiseaseOutbreak[]; fetchedAt: number } | null = null;

// ReliefWeb API — free, no key, returns disease outbreak reports
const RELIEFWEB_API =
  'https://api.reliefweb.int/v1/reports?appname=worldmonitor&filter[field]=type.name&filter[value]=Situation%20Report&filter[conditions][0][field]=theme.name&filter[conditions][0][value]=Health&limit=25&sort[]=date:desc&fields[include][]=title&fields[include][]=date&fields[include][]=country&fields[include][]=url';

// WHO Health Emergencies Dashboard — JSON endpoint
const WHO_EMERGENCIES =
  'https://www.who.int/api/hubs/cms/s3fs-public/attachments/disease-outbreak-news.json';

// ProMED-mail — Program for Monitoring Emerging Diseases (ISID)
// Free RSS feed, earlier than official WHO alerts
const PROMED_RSS = 'https://promedmail.org/promed-posts/';

function promedProxyUrl(): string {
  return `/api/rss-proxy?url=${encodeURIComponent(PROMED_RSS)}`;
}

async function fetchProMED(): Promise<DiseaseOutbreak[]> {
  try {
    const res = await fetch(promedProxyUrl(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    return Array.from(items).slice(0, 30).map((item, i) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';
      const description = item.querySelector('description')?.textContent?.trim() ?? '';
      const country = extractCountry(title + ' ' + description);
      return {
        id: `promed-${i}-${pubDateStr.slice(0, 10)}`,
        title,
        country,
        disease: extractDiseaseName(title),
        date: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        source: 'ProMED' as const,
        severity: scoreSeverity(title),
      };
    });
  } catch {
    return [];
  }
}

function extractDiseaseName(title: string): string {
  const patterns = [
    /mpox/i, /ebola/i, /cholera/i, /dengue/i, /measles/i, /covid/i, /influenza/i, /avian influenza/i,
    /marburg/i, /lassa/i, /nipah/i, /hantavirus/i, /plague/i, /yellow fever/i, /rift valley/i,
    /monkeypox/i, /tuberculosis/i, /polio/i, /rabies/i, /meningitis/i,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return m[0].charAt(0).toUpperCase() + m[0].slice(1);
  }
  // Fall back to first significant noun phrase
  const trimmed = title.replace(/^(outbreak of|case of|cases of|situation report:?)\s*/i, '').trim();
  return trimmed.split(/[\-–—:,]/)[0]?.trim() ?? title.slice(0, 40);
}

function extractCountry(title: string, countryField?: string): string {
  if (countryField) return countryField;
  // Heuristic: last parenthetical or "in <Country>"
  const parenMatch = title.match(/\(([^)]+)\)\s*$/);
  if (parenMatch?.[1]) return parenMatch[1];
  const inMatch = title.match(/\bin\s+([A-Z][a-zA-Z\s]+?)(?:\s*[-–]|\s*$)/);
  if (inMatch?.[1]) return inMatch[1].trim();
  return 'Unknown';
}

function scoreSeverity(title: string): DiseaseOutbreak['severity'] {
  const tl = title.toLowerCase();
  if (/\b(ebola|marburg|nipah|plague|hemorrhagic)\b/.test(tl)) return 'critical';
  if (/\b(mpox|cholera|outbreak|emergency|alert|death|fatal|killed)\b/.test(tl)) return 'high';
  if (/\b(case|situation|report|update|cluster)\b/.test(tl)) return 'medium';
  return 'low';
}

async function fetchReliefWeb(): Promise<DiseaseOutbreak[]> {
  try {
    const res = await fetch(RELIEFWEB_API, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const json = await res.json() as {
      data: Array<{
        id: string;
        fields: {
          title: string;
          date: { created: string };
          country?: Array<{ name: string }>;
          url: string;
        };
      }>;
    };
    return (json.data ?? []).map(item => {
      const f = item.fields;
      const country = f.country?.[0]?.name ?? extractCountry(f.title);
      return {
        id: `rw-${item.id}`,
        title: f.title,
        country,
        disease: extractDiseaseName(f.title),
        date: new Date(f.date?.created ?? Date.now()),
        url: f.url,
        source: 'ReliefWeb',
        severity: scoreSeverity(f.title),
      };
    });
  } catch {
    return [];
  }
}

async function fetchWHOEmergencies(): Promise<DiseaseOutbreak[]> {
  try {
    const res = await fetch(WHO_EMERGENCIES, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const json = await res.json() as Array<{
      Title?: string;
      title?: string;
      Date?: string;
      date?: string;
      Country?: string;
      country?: string;
      Url?: string;
      url?: string;
    }>;
    if (!Array.isArray(json)) return [];
    return json.slice(0, 30).map((item, i) => {
      const title = item.Title ?? item.title ?? '';
      const dateStr = item.Date ?? item.date ?? '';
      const country = item.Country ?? item.country ?? extractCountry(title);
      return {
        id: `who-${i}-${dateStr}`,
        title,
        country,
        disease: extractDiseaseName(title),
        date: dateStr ? new Date(dateStr) : new Date(),
        url: item.Url ?? item.url,
        source: 'WHO',
        severity: scoreSeverity(title),
      };
    });
  } catch {
    return [];
  }
}

export async function fetchDiseaseOutbreaks(): Promise<DiseaseOutbreak[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.outbreaks;
  }

  const [rwResult, whoResult, promedResult] = await Promise.allSettled([
    fetchReliefWeb(),
    fetchWHOEmergencies(),
    fetchProMED(),
  ]);

  const combined: DiseaseOutbreak[] = [
    ...(rwResult.status === 'fulfilled' ? rwResult.value : []),
    ...(whoResult.status === 'fulfilled' ? whoResult.value : []),
    ...(promedResult.status === 'fulfilled' ? promedResult.value : []),
  ];

  // Dedupe by disease+country within 7 days
  const seen = new Set<string>();
  const deduped: DiseaseOutbreak[] = [];
  for (const o of combined.sort((a, b) => b.date.getTime() - a.date.getTime())) {
    const key = `${o.disease.toLowerCase()}-${o.country.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(o);
    }
  }

  cache = { outbreaks: deduped.slice(0, 50), fetchedAt: Date.now() };
  return cache.outbreaks;
}
