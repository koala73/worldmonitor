/**
 * Global food insecurity and famine early warning
 *
 * Sources:
 *  - FEWS NET (Famine Early Warning Systems Network): USAID-funded, covers 30+
 *    at-risk countries. RSS at https://fews.net/rss/all (via rss-proxy)
 *  - IPC (Integrated Food Security Phase Classification): UN/NGO global standard.
 *    Public API at https://www.ipcinfo.org/ipc-api/
 *
 * IPC Phase scale:
 *   Phase 1 = Minimal  Phase 2 = Stressed  Phase 3 = Crisis
 *   Phase 4 = Emergency  Phase 5 = Catastrophe/Famine
 */

export type IpcPhase = 1 | 2 | 3 | 4 | 5;

export interface FoodInsecurityAlert {
  id: string;
  country: string;
  countryCode: string;
  title: string;
  description: string;
  ipcPhase: IpcPhase | null;
  populationAffected: number | null;  // number of people
  source: 'FEWS NET' | 'IPC';
  pubDate: Date;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// FEWS NET RSS — proxied because fews.net doesn't send CORS headers
const FEWS_NET_RSS = 'https://fews.net/rss/all';

// IPC API — returns current acute food insecurity data globally
const IPC_API = 'https://www.ipcinfo.org/ipc-api/api/v2/population?format=json';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min (changes slowly)
let cache: { alerts: FoodInsecurityAlert[]; fetchedAt: number } | null = null;

function ipcPhaseToSeverity(phase: IpcPhase | null): FoodInsecurityAlert['severity'] {
  if (phase === 5) return 'critical';
  if (phase === 4) return 'critical';
  if (phase === 3) return 'high';
  if (phase === 2) return 'medium';
  return 'low';
}

function textToSeverity(title: string, description: string): FoodInsecurityAlert['severity'] {
  const text = (title + ' ' + description).toLowerCase();
  if (/\b(famine|catastrophe|phase 5|ipc 5|starvation|mass starvation)\b/.test(text)) return 'critical';
  if (/\b(emergency|crisis|phase 4|ipc 4|acute|severe hunger|food emergency)\b/.test(text)) return 'critical';
  if (/\b(phase 3|ipc 3|food crisis|food insecurity|malnutrition|warning)\b/.test(text)) return 'high';
  if (/\b(stressed|phase 2|ipc 2|food stress|watch)\b/.test(text)) return 'medium';
  return 'low';
}

async function fetchFewsNet(): Promise<FoodInsecurityAlert[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(FEWS_NET_RSS)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    return [...items].slice(0, 30).map((item, i) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      // FEWS NET titles often start with country name
      const countryMatch = /^([A-Z][a-zA-Z\s]+?)(?:\s*[-–:|]|\s+Food)/.exec(title);
      const country = countryMatch?.[1]?.trim() ?? 'Unknown';

      return {
        id: `fews-${i}-${pubDateStr.slice(0, 10)}`,
        country,
        countryCode: '',
        title,
        description: description.slice(0, 400),
        ipcPhase: null,
        populationAffected: null,
        source: 'FEWS NET' as const,
        pubDate: pubDateStr ? new Date(pubDateStr) : new Date(),
        url: link,
        severity: textToSeverity(title, description),
      };
    });
  } catch {
    return [];
  }
}

interface IpcRecord {
  id?: number;
  country?: string;
  country_code?: string;
  title?: string;
  phase?: number;
  population?: number;
  period?: string;
  reference_year?: number;
  projected_period?: string;
}

interface IpcResponse {
  body?: IpcRecord[];
  data?: IpcRecord[];
}

async function fetchIpc(): Promise<FoodInsecurityAlert[]> {
  try {
    const res = await fetch(IPC_API, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];

    const data: IpcResponse = await res.json();
    const records: IpcRecord[] = data.body ?? data.data ?? [];

    // Filter to IPC Phase 3+ (Crisis or worse)
    return records
      .filter(r => (r.phase ?? 0) >= 3)
      .map(r => {
        const phase = (r.phase ?? null) as IpcPhase | null;
        return {
          id: `ipc-${r.id ?? `${r.country_code}-${r.period}`}`,
          country: r.country ?? 'Unknown',
          countryCode: r.country_code ?? '',
          title: r.title ?? `IPC Phase ${phase} — ${r.country}`,
          description: `Population in IPC Phase ${phase} or above: ${r.population?.toLocaleString() ?? 'unknown'}`,
          ipcPhase: phase,
          populationAffected: r.population ?? null,
          source: 'IPC' as const,
          pubDate: new Date(),
          url: `https://www.ipcinfo.org/ipc-country-analysis/details-map/en/c/${r.country_code ?? ''}`,
          severity: ipcPhaseToSeverity(phase),
        };
      });
  } catch {
    return [];
  }
}

export async function fetchFoodInsecurityAlerts(): Promise<FoodInsecurityAlert[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.alerts;

  const [fewsResult, ipcResult] = await Promise.allSettled([
    fetchFewsNet(),
    fetchIpc(),
  ]);

  const combined = [
    ...(fewsResult.status === 'fulfilled' ? fewsResult.value : []),
    ...(ipcResult.status === 'fulfilled' ? ipcResult.value : []),
  ];

  // Sort: worst phase/severity first, then by date
  const sOrder: Record<FoodInsecurityAlert['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  combined.sort((a, b) => sOrder[a.severity] - sOrder[b.severity] || b.pubDate.getTime() - a.pubDate.getTime());

  cache = { alerts: combined.slice(0, 60), fetchedAt: Date.now() };
  return cache.alerts;
}

export function ipcPhaseName(phase: IpcPhase | null): string {
  return {
    1: 'Minimal',
    2: 'Stressed',
    3: 'Crisis',
    4: 'Emergency',
    5: 'Catastrophe/Famine',
  }[phase as number] ?? 'Unknown';
}

export function foodSeverityClass(severity: FoodInsecurityAlert['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
