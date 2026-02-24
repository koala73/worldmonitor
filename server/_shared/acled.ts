/**
 * Shared ACLED API fetch with Redis caching.
 *
 * Three endpoints call ACLED independently (risk-scores, unrest-events,
 * acled-events) with overlapping queries. This shared layer ensures
 * identical queries hit Redis instead of making redundant upstream calls.
 */

declare const process: { env: Record<string, string | undefined> };

import { CHROME_UA } from './constants';
import { getCachedJson, setCachedJson } from './redis';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_CACHE_TTL = 900; // 15 min — matches ACLED rate-limit window
const ACLED_TIMEOUT_MS = 15_000;

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

/**
 * Fetch ACLED events with automatic Redis caching.
 * Cache key is derived from query parameters so identical queries across
 * different handlers share the same cached result.
 */
export async function fetchAcledCached(opts: FetchAcledOptions): Promise<AcledRawEvent[]> {
  const token = process.env.ACLED_ACCESS_TOKEN;
  if (!token) return [];

  const cacheKey = `acled:shared:${opts.eventTypes}:${opts.startDate}:${opts.endDate}:${opts.country || 'all'}:${opts.limit || 500}`;
  const cached = (await getCachedJson(cacheKey)) as AcledRawEvent[] | null;
  if (cached) return cached;

  const params = new URLSearchParams({
    event_type: opts.eventTypes,
    event_date: `${opts.startDate}|${opts.endDate}`,
    event_date_where: 'BETWEEN',
    limit: String(opts.limit || 500),
    _format: 'json',
  });
  if (opts.country) params.set('country', opts.country);

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
  setCachedJson(cacheKey, events, ACLED_CACHE_TTL).catch(() => {});
  return events;
}
