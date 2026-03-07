import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'conflict:ucdp-events:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25h — reject if cron hasn't refreshed

let fallback: { events: UcdpViolenceEvent[]; ts: number } | null = null;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 4;
const MAX_EVENTS = 2000;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DIRECT_FETCH_COOLDOWN_MS = 10 * 60 * 1000; // 10min between direct fetches
let lastDirectFetchMs = 0;

const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceType> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchGedPage(version: string, page: number, token: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) throw new Error(`UCDP API ${resp.status}`);
  return resp.json();
}

async function fetchDirectFromUcdp(): Promise<UcdpViolenceEvent[]> {
  const token = (process.env.UCDP_ACCESS_TOKEN || '').trim();
  const candidates = buildVersionCandidates();

  let version = '';
  let page0: { Result?: unknown[]; TotalPages?: number } | null = null;

  for (const v of candidates) {
    try {
      const data = await fetchGedPage(v, 0, token) as { Result?: unknown[]; TotalPages?: number };
      if (Array.isArray(data?.Result) && data.Result.length > 0) {
        version = v;
        page0 = data;
        break;
      }
    } catch { /* try next */ }
  }

  if (!version || !page0) return [];

  const totalPages = Math.max(1, Number(page0.TotalPages) || 1);
  const newestPage = totalPages - 1;

  const pageResults = await Promise.allSettled(
    Array.from({ length: Math.min(MAX_PAGES, totalPages) }, (_, i) => {
      const page = newestPage - i;
      if (page < 0) return Promise.resolve(null);
      if (page === 0) return Promise.resolve(page0);
      return fetchGedPage(version, page, token);
    }),
  );

  const allEvents: unknown[] = [];
  let latestMs = NaN;

  for (const r of pageResults) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const events = Array.isArray((r.value as { Result?: unknown[] }).Result)
      ? (r.value as { Result: unknown[] }).Result : [];
    allEvents.push(...events);
    for (const e of events) {
      const ms = Date.parse(String((e as { date_start?: string }).date_start));
      if (Number.isFinite(ms) && (!Number.isFinite(latestMs) || ms > latestMs)) latestMs = ms;
    }
  }

  const cutoff = Number.isFinite(latestMs) ? latestMs - TRAILING_WINDOW_MS : 0;
  const mapped: UcdpViolenceEvent[] = [];

  for (const raw of allEvents) {
    const e = raw as Record<string, unknown>;
    const dateStart = Date.parse(String(e.date_start));
    if (!Number.isFinite(dateStart) || dateStart < cutoff) continue;

    mapped.push({
      id: String(e.id || ''),
      dateStart,
      dateEnd: Date.parse(String(e.date_end)) || 0,
      location: {
        latitude: Number(e.latitude) || 0,
        longitude: Number(e.longitude) || 0,
      },
      country: String(e.country || ''),
      sideA: String(e.side_a || '').substring(0, 200),
      sideB: String(e.side_b || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: VIOLENCE_TYPE_MAP[Number(e.type_of_violence)] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: String(e.source_original || '').substring(0, 300),
    });
  }

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  return mapped.slice(0, MAX_EVENTS);
}

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  // 1. Try Redis cache (cloud path)
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      let events = raw.events;
      if (req.country) events = events.filter((e) => e.country === req.country);
      return { events, pagination: undefined };
    }
  } catch { /* fall through */ }

  // 2. In-memory fallback from a previous successful fetch
  if (fallback && (Date.now() - fallback.ts) < 12 * 60 * 60 * 1000) {
    let events = fallback.events;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  }

  // 3. Direct UCDP API fetch (desktop sidecar path — no Redis available)
  if (Date.now() - lastDirectFetchMs > DIRECT_FETCH_COOLDOWN_MS) {
    try {
      const events = await fetchDirectFromUcdp();
      lastDirectFetchMs = Date.now(); // only after successful fetch
      if (events.length > 0) {
        fallback = { events, ts: Date.now() };
        let filtered = events;
        if (req.country) filtered = filtered.filter((e) => e.country === req.country);
        return { events: filtered, pagination: undefined };
      }
    } catch { /* fall through to empty */ }
  }

  return { events: [], pagination: undefined };
}
