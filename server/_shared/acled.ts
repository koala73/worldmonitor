/**
 * Shared ACLED API fetch with Redis caching.
 *
 * Three endpoints call ACLED independently (risk-scores, unrest-events,
 * acled-events) with overlapping queries. This shared layer ensures
 * identical queries hit Redis instead of making redundant upstream calls.
 */
import { CHROME_UA } from './constants';
import { cachedFetchJson } from './redis';
import { getAcledAccessToken } from './acled-auth';
import { normalizeCountryToIso2 } from './country-normalize';
import UN_TO_ISO2 from '../../shared/un-to-iso2.json';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_CACHE_TTL = 900; // 15 min — matches ACLED rate-limit window
const ACLED_TIMEOUT_MS = 15_000;
const EVENT_TYPES = ['Battles', 'Explosions/Remote violence', 'Violence against civilians', 'Protests', 'Riots'];
const ISO2_TO_NUMERIC = new Map(Object.entries(UN_TO_ISO2).map(([numeric, iso2]) => [iso2, String(Number(numeric))]));
// ACLED assigns Kosovo 0; the shared UN mapping uses 412.
ISO2_TO_NUMERIC.set('XK', '0');

export interface AcledRawEvent {
  event_id_cnty?: string;
  event_type?: string;
  sub_event_type?: string;
  country?: string;
  location?: string;
  latitude?: string;
  longitude?: string;
  event_date?: string;
  fatalities?: string;
  source?: string;
  actor1?: string;
  actor2?: string;
  admin1?: string;
  notes?: string;
  tags?: string;
}

interface FetchAcledOptions {
  eventTypes: string;
  startDate: string;
  endDate: string;
  country?: string;
  limit?: number;
}

function normalizeAcledQuery(opts: FetchAcledOptions) {
  const invalid = (field: string): never => { throw new Error(`Invalid ACLED query: ${field}`); };
  const dateMs = (value: string) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('date');
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return invalid('date');
    return ms;
  };
  const start = dateMs(opts.startDate);
  const end = dateMs(opts.endDate);
  if (start > end) invalid('date window');

  if (typeof opts.eventTypes !== 'string' || opts.eventTypes.length > 256) invalid('eventTypes');
  const eventTypes = [...new Set(opts.eventTypes.split('|').map(value => {
    const type = EVENT_TYPES.find(candidate => candidate.toLowerCase() === value.trim().toLowerCase());
    return type ?? invalid('eventTypes');
  }))].sort().join('|');

  const limit = opts.limit === undefined ? 500 : opts.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) invalid('limit');

  let iso: string | undefined;
  if (opts.country !== undefined && opts.country !== '') {
    if (typeof opts.country !== 'string' || opts.country.length > 100) invalid('country');
    const iso2 = normalizeCountryToIso2(opts.country);
    iso = iso2 ? ISO2_TO_NUMERIC.get(iso2) : undefined;
    if (!iso) invalid('country');
  }
  return { eventTypes, startDate: opts.startDate, endDate: opts.endDate, iso, limit };
}

/**
 * Fetch ACLED events with automatic Redis caching.
 * Cache key is derived from query parameters so identical queries across
 * different handlers share the same cached result.
 * Rejects unknown filters, invalid or reversed calendar dates, and limits outside
 * 1–1000 before authentication or cache access. Historical ranges remain supported.
 */
export async function fetchAcledCached(opts: FetchAcledOptions): Promise<AcledRawEvent[]> {
  const query = normalizeAcledQuery(opts);
  const token = await getAcledAccessToken();
  if (!token) return [];

  const cacheKey = `acled:shared:v2:${query.eventTypes}:${query.startDate}:${query.endDate}:${query.iso || 'all'}:${query.limit}`;
  const result = await cachedFetchJson<AcledRawEvent[]>(cacheKey, ACLED_CACHE_TTL, async () => {
    const params = new URLSearchParams({
      event_type: query.eventTypes,
      event_date: `${query.startDate}|${query.endDate}`,
      event_date_where: 'BETWEEN',
      limit: String(query.limit),
      _format: 'json',
    });
    if (query.iso) params.set('iso', query.iso);

    const resp = await fetch(`${ACLED_API_URL}?${params}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
    });

    if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
    const data = (await resp.json()) as { data?: AcledRawEvent[]; message?: string; error?: string };
    if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');

    const events = data.data || [];
    return events.length > 0 ? events : null;
  });
  return result || [];
}
