/**
 * Copernicus Emergency Management Service (CEMS) — Rapid Mapping
 * Public API — no authentication required
 * https://emergency.copernicus.eu/mapping/
 *
 * CEMS activates when a disaster is severe enough to warrant EU satellite
 * emergency mapping. Activations cover floods, earthquakes, wildfires,
 * industrial accidents, storms, and volcanic eruptions globally.
 *
 * A CEMS activation is strong independent confirmation of a serious event —
 * multiple national emergency agencies must formally request it.
 *
 * API docs: https://emergency.copernicus.eu/mapping/list-of-components/EMSR
 * GeoJSON endpoint (public): https://emergency.copernicus.eu/mapping/activations-rapid/json
 */

export type CemsHazard =
  | 'Flood'
  | 'Storm'
  | 'Earthquake'
  | 'Volcanic Eruption'
  | 'Wildfire'
  | 'Industrial Accident'
  | 'Tsunami'
  | 'Landslide'
  | 'Drought'
  | 'Other';

export interface CemsActivation {
  id: string;               // e.g. "EMSR742"
  title: string;
  country: string;
  hazard: CemsHazard | string;
  activationDate: Date;
  lastUpdateDate: Date;
  status: 'Ongoing' | 'Completed' | 'Delineation';
  lat: number | null;
  lon: number | null;
  affectedAreaKm2: number | null;
  requestingCountry: string;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// Public JSON API — CORS-enabled
const CEMS_JSON_URL = 'https://emergency.copernicus.eu/mapping/activations-rapid/json';
const CEMS_FEED_ALT = 'https://emergency.copernicus.eu/mapping/list-of-components/EMSR/rss';

const CACHE_TTL_MS = 20 * 60 * 1000;
let cache: { activations: CemsActivation[]; fetchedAt: number } | null = null;

function hazardSeverity(hazard: string, status: CemsActivation['status']): CemsActivation['severity'] {
  const h = hazard.toLowerCase();
  const isOngoing = status === 'Ongoing';
  if (h.includes('earthquake') || h.includes('tsunami') || h.includes('volcanic')) {
    return isOngoing ? 'critical' : 'high';
  }
  if (h.includes('flood') || h.includes('wildfire') || h.includes('industrial')) {
    return isOngoing ? 'high' : 'medium';
  }
  return isOngoing ? 'medium' : 'low';
}

interface CemsJsonItem {
  activationCode?: string;
  title?: string;
  country?: string;
  type?: string;          // hazard type
  date?: string;          // activation date
  lastModifiedDate?: string;
  status?: string;
  latitude?: number | string;
  longitude?: number | string;
  affectedArea?: number | string;
  requestingCountry?: string;
  url?: string;
}

interface CemsJsonResponse {
  activations?: CemsJsonItem[];
  features?: { properties?: CemsJsonItem; geometry?: { coordinates?: number[] } }[];
}

async function fetchCemsJson(): Promise<CemsActivation[]> {
  try {
    const res = await fetch(CEMS_JSON_URL, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data: CemsJsonResponse = await res.json();

    // Try GeoJSON features format first, then activations array
    const features = data.features ?? [];
    const raw = data.activations ?? [];

    const items: CemsActivation[] = [];

    // GeoJSON features
    for (const f of features) {
      const p = f.properties ?? {};
      const coords = f.geometry?.coordinates;
      const status = ((p.status ?? 'Ongoing') as string).includes('Ongoing') ? 'Ongoing'
        : ((p.status ?? '').includes('Complet') ? 'Completed' : 'Delineation');
      const hazard = (p.type ?? 'Other') as CemsHazard;
      const activationDate = p.date ? new Date(p.date) : new Date();

      items.push({
        id: `cems-${p.activationCode ?? items.length}`,
        title: p.title ?? p.activationCode ?? 'CEMS Activation',
        country: p.country ?? '',
        hazard,
        activationDate,
        lastUpdateDate: p.lastModifiedDate ? new Date(p.lastModifiedDate) : activationDate,
        status: status as CemsActivation['status'],
        lat: coords?.[1] ?? (typeof p.latitude === 'number' ? p.latitude : null),
        lon: coords?.[0] ?? (typeof p.longitude === 'number' ? p.longitude : null),
        affectedAreaKm2: p.affectedArea ? Number.parseFloat(String(p.affectedArea)) : null,
        requestingCountry: p.requestingCountry ?? p.country ?? '',
        url: p.url ?? `https://emergency.copernicus.eu/mapping/list-of-components/${p.activationCode}`,
        severity: hazardSeverity(String(hazard), status as CemsActivation['status']),
      });
    }

    // Plain array format
    for (const r of raw) {
      const status = ((r.status ?? 'Ongoing') as string).includes('Ongoing') ? 'Ongoing'
        : ((r.status ?? '').includes('Complet') ? 'Completed' : 'Delineation');
      const hazard = (r.type ?? 'Other') as CemsHazard;
      const activationDate = r.date ? new Date(r.date) : new Date();

      items.push({
        id: `cems-${r.activationCode ?? items.length}`,
        title: r.title ?? r.activationCode ?? 'CEMS Activation',
        country: r.country ?? '',
        hazard,
        activationDate,
        lastUpdateDate: r.lastModifiedDate ? new Date(r.lastModifiedDate) : activationDate,
        status: status as CemsActivation['status'],
        lat: typeof r.latitude === 'number' ? r.latitude : Number.parseFloat(String(r.latitude)) || null,
        lon: typeof r.longitude === 'number' ? r.longitude : Number.parseFloat(String(r.longitude)) || null,
        affectedAreaKm2: r.affectedArea ? Number.parseFloat(String(r.affectedArea)) : null,
        requestingCountry: r.requestingCountry ?? r.country ?? '',
        url: r.url ?? `https://emergency.copernicus.eu/mapping/list-of-components/${r.activationCode}`,
        severity: hazardSeverity(String(hazard), status as CemsActivation['status']),
      });
    }

    return items;
  } catch {
    return [];
  }
}

async function fetchCemsRss(): Promise<CemsActivation[]> {
  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(CEMS_FEED_ALT)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];

    const items = doc.querySelectorAll('item');
    return [...items].map((item, i) => {
      const title = item.querySelector('title')?.textContent?.trim() ?? '';
      const description = (item.querySelector('description')?.textContent ?? '').replace(/<[^>]+>/g, '').trim();
      const link = item.querySelector('link')?.textContent?.trim() ?? '';
      const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() ?? '';

      // Extract EMSR code from title or link
      const emsrMatch = /EMSR\d+/.exec((title + link));
      const id = emsrMatch?.[0] ?? `cems-rss-${i}`;

      // Guess hazard from text
      const text2 = (title + description).toLowerCase();
      const hazard: CemsHazard = text2.includes('flood') ? 'Flood'
        : text2.includes('earthquake') ? 'Earthquake'
        : text2.includes('wildfire') || text2.includes('fire') ? 'Wildfire'
        : text2.includes('storm') ? 'Storm'
        : text2.includes('volcanic') || text2.includes('volcano') ? 'Volcanic Eruption'
        : 'Other';

      const activationDate = pubDateStr ? new Date(pubDateStr) : new Date();

      return {
        id: `cems-${id}`,
        title,
        country: '',
        hazard,
        activationDate,
        lastUpdateDate: activationDate,
        status: 'Ongoing' as const,
        lat: null,
        lon: null,
        affectedAreaKm2: null,
        requestingCountry: '',
        url: link,
        severity: hazardSeverity(hazard, 'Ongoing') as CemsActivation['severity'],
      };
    });
  } catch {
    return [];
  }
}

export async function fetchCemsActivations(): Promise<CemsActivation[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.activations;

  const [jsonResult, rssResult] = await Promise.allSettled([
    fetchCemsJson(),
    fetchCemsRss(),
  ]);

  const json = jsonResult.status === 'fulfilled' ? jsonResult.value : [];
  const rss = rssResult.status === 'fulfilled' ? rssResult.value : [];

  // Prefer JSON (richer data); use RSS to fill any gaps
  const seen = new Set(json.map(a => a.id));
  const merged = [...json, ...rss.filter(a => !seen.has(a.id))];

  // Keep last 6 months, sort ongoing first then by date
  const cutoff = Date.now() - 180 * 24 * 3_600_000;
  const activations = merged
    .filter(a => a.activationDate.getTime() > cutoff)
    .sort((a, b) => {
      if (a.status === 'Ongoing' && b.status !== 'Ongoing') return -1;
      if (b.status === 'Ongoing' && a.status !== 'Ongoing') return 1;
      return b.activationDate.getTime() - a.activationDate.getTime();
    })
    .slice(0, 60);

  cache = { activations, fetchedAt: Date.now() };
  return activations;
}

export function cemsSeverityClass(severity: CemsActivation['severity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', low: 'eq-row' }[severity] ?? 'eq-row';
}
