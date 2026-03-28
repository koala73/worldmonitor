import type {
  ServerContext,
  SearchGoogleDatesRequest,
  SearchGoogleDatesResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { parseStringArray } from '../../../_shared/parse-string-array';
import { cachedFetchJson } from '../../../_shared/redis';

// Medium-cache tier (10 min) — use cachedFetchJson for stampede protection.
const CACHE_TTL = 600;

export async function searchGoogleDates(
  _ctx: ServerContext,
  req: SearchGoogleDatesRequest,
): Promise<SearchGoogleDatesResponse> {
  const origin = (req.origin || '').toUpperCase().trim();
  const destination = (req.destination || '').toUpperCase().trim();
  const startDate = req.startDate || '';
  const endDate = req.endDate || '';

  if (!origin || !destination || !startDate || !endDate) {
    return { dates: [], degraded: true, error: 'origin, destination, start_date, and end_date are required' };
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { dates: [], degraded: true, error: 'relay unavailable' };
  }

  const passengers = Math.max(1, Math.min(req.passengers ?? 1, 9));
  const airlines = parseStringArray(req.airlines).sort();
  const params = new URLSearchParams({
    origin,
    destination,
    start_date: startDate,
    end_date: endDate,
    is_round_trip: String(req.isRoundTrip ?? false),
    ...(req.tripDuration ? { trip_duration: String(req.tripDuration) } : {}),
    ...(req.cabinClass ? { cabin_class: req.cabinClass } : {}),
    ...(req.maxStops ? { max_stops: req.maxStops } : {}),
    ...(req.departureWindow ? { departure_window: req.departureWindow } : {}),
    sort_by_price: String(req.sortByPrice ?? false),
    passengers: String(passengers),
  });
  for (const airline of airlines) {
    params.append('airlines', airline);
  }

  const cacheKey = `aviation:gf-dates:${origin}:${destination}:${startDate}:${endDate}:${params.toString()}:v1`;

  try {
    const data = await cachedFetchJson<{ dates: unknown[]; partial?: boolean }>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const resp = await fetch(`${relayBaseUrl}/google-flights/search-dates?${params}`, {
          headers: getRelayHeaders(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
        const json = (await resp.json()) as { dates?: unknown[]; partial?: boolean; error?: string };
        if (!Array.isArray(json.dates)) throw new Error(json.error ?? 'no results');
        return { dates: json.dates, partial: json.partial };
      },
    );

    if (!data) {
      return { dates: [], degraded: true, error: 'no results' };
    }

    return {
      dates: data.dates as SearchGoogleDatesResponse['dates'],
      degraded: data.partial === true,
      error: data.partial === true ? 'partial results: one or more date chunks failed' : '',
    };
  } catch (err) {
    return { dates: [], degraded: true, error: err instanceof Error ? err.message : 'search failed' };
  }
}
