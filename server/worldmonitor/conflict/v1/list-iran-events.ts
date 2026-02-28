import type {
  ServerContext,
  ListIranEventsRequest,
  ListIranEventsResponse,
  IranEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const REDIS_KEY = 'conflict:iran-events:v1';
const TTL = 900;

const IRAN_CITIES: Record<string, { lat: number; lon: number }> = {
  Tehran: { lat: 35.69, lon: 51.39 },
  Isfahan: { lat: 32.65, lon: 51.68 },
  Shiraz: { lat: 29.59, lon: 52.58 },
  Tabriz: { lat: 38.08, lon: 46.29 },
  Mashhad: { lat: 36.30, lon: 59.60 },
  Kerman: { lat: 30.28, lon: 57.08 },
  Ahvaz: { lat: 31.32, lon: 48.69 },
  'Bandar Abbas': { lat: 27.18, lon: 56.28 },
  Bushehr: { lat: 28.97, lon: 50.84 },
  Natanz: { lat: 33.51, lon: 51.92 },
  Parchin: { lat: 35.52, lon: 51.77 },
  Fordow: { lat: 34.88, lon: 51.58 },
  Arak: { lat: 34.09, lon: 49.69 },
  Dezful: { lat: 32.38, lon: 48.40 },
  Chabahar: { lat: 25.29, lon: 60.64 },
  Khorramabad: { lat: 33.49, lon: 48.36 },
  Qom: { lat: 34.64, lon: 50.88 },
  Yazd: { lat: 31.90, lon: 54.37 },
  Rasht: { lat: 37.28, lon: 49.58 },
  Zahedan: { lat: 29.50, lon: 60.86 },
  Hormuz: { lat: 27.06, lon: 56.46 },
  'Kharg Island': { lat: 29.23, lon: 50.32 },
  Kish: { lat: 26.54, lon: 53.98 },
  Abadan: { lat: 30.34, lon: 48.30 },
  Hamadan: { lat: 34.80, lon: 48.51 },
  Sanandaj: { lat: 35.31, lon: 46.99 },
  Urmia: { lat: 37.55, lon: 45.08 },
  Gorgan: { lat: 36.84, lon: 54.44 },
  Kermanshah: { lat: 34.31, lon: 47.07 },
  Bojnurd: { lat: 37.47, lon: 57.33 },
  Birjand: { lat: 32.87, lon: 59.22 },
  Semnan: { lat: 35.58, lon: 53.39 },
  Karaj: { lat: 35.84, lon: 50.94 },
  Sari: { lat: 36.57, lon: 53.06 },
  Ilam: { lat: 33.64, lon: 46.42 },
  Baneh: { lat: 35.99, lon: 45.88 },
  Saravan: { lat: 27.37, lon: 62.33 },
  Sirjan: { lat: 29.45, lon: 55.68 },
  Rafsanjan: { lat: 30.41, lon: 55.99 },
  Khoy: { lat: 38.55, lon: 44.95 },
};

const IRAN_CENTER = { lat: 32.43, lon: 53.69 };

const CAT_MAP: Record<string, { category: string; severity: string }> = {
  cat10: { category: 'military', severity: 'high' },
  cat1: { category: 'politics', severity: 'medium' },
  cat2: { category: 'diplomacy', severity: 'medium' },
  cat5: { category: 'human_rights', severity: 'medium' },
  cat7: { category: 'transport', severity: 'low' },
  cat11: { category: 'regional', severity: 'low' },
};

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CITY_PATTERNS = Object.entries(IRAN_CITIES).map(([city, coords]) => ({
  pattern: new RegExp('\\b' + escapeRegex(stripDiacritics(city)) + '\\b', 'i'),
  city,
  coords,
}));

function geocodeTitle(title: string): { lat: number; lon: number; locationName: string } {
  const normalized = stripDiacritics(title);
  for (const { pattern, city, coords } of CITY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { lat: coords.lat, lon: coords.lon, locationName: city };
    }
  }
  return { lat: IRAN_CENTER.lat, lon: IRAN_CENTER.lon, locationName: 'Iran' };
}

function parseRelativeTime(timeStr: string): number {
  const now = Date.now();
  const m = timeStr.match(/(\d+)\s*(minute|hour|day|second)s?\s*ago/i);
  if (!m) return now;
  const val = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const multipliers: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  return now - val * (multipliers[unit] || 60_000);
}

function parseCategory(classStr: string): { category: string; severity: string } {
  for (const [catClass, meta] of Object.entries(CAT_MAP)) {
    if (classStr.includes(catClass)) return meta;
  }
  return { category: 'regional', severity: 'low' };
}

async function scrapeIranEvents(): Promise<IranEvent[]> {
  const resp = await fetch('https://iran.liveuamap.com', {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
  });
  if (!resp.ok) return [];
  const html = await resp.text();
  if (html.length > 2_000_000) return [];

  const events: IranEvent[] = [];
  const eventRegex = /<div[^>]*data-id="(\d+)"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match: RegExpExecArray | null;

  while ((match = eventRegex.exec(html)) !== null) {
    const id = match[1]!;
    const classStr = match[2]!;
    const inner = match[3]!;

    if (!classStr.includes('event')) continue;

    const titleMatch = inner.match(/<span[^>]*class="[^"]*event-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const title = titleMatch ? titleMatch[1]!.replace(/<[^>]+>/g, '').trim() : '';
    if (!title) continue;

    const linkMatch = inner.match(/href="(https?:\/\/[^"]+)"/);
    const sourceUrl = linkMatch ? linkMatch[1]! : '';

    const timeMatch = inner.match(/<span[^>]*class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const timeStr = timeMatch ? timeMatch[1]!.replace(/<[^>]+>/g, '').trim() : '';

    const { category, severity } = parseCategory(classStr);
    const { lat, lon, locationName } = geocodeTitle(title);
    const timestamp = parseRelativeTime(timeStr);

    events.push({
      id: `liveuamap-iran-${id}`,
      title,
      category,
      sourceUrl,
      latitude: lat,
      longitude: lon,
      locationName,
      timestamp,
      severity,
    });
  }

  return events;
}

export async function listIranEvents(
  _ctx: ServerContext,
  _req: ListIranEventsRequest,
): Promise<ListIranEventsResponse> {
  try {
    const result = await cachedFetchJson<ListIranEventsResponse>(
      REDIS_KEY,
      TTL,
      async () => {
        const events = await scrapeIranEvents();
        return events.length > 0 ? { events, scrapedAt: Date.now() } : null;
      },
    );
    return result || { events: [], scrapedAt: 0 };
  } catch {
    return { events: [], scrapedAt: 0 };
  }
}
