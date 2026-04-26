import type {
  ServerContext,
  SearchGoogleFlightsRequest,
  SearchGoogleFlightsResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { parseStringArray } from '../../../_shared/parse-string-array';
import { cachedFetchJson } from '../../../_shared/redis';

const CACHE_TTL = 600;

export async function searchGoogleFlights(
  _ctx: ServerContext,
  req: SearchGoogleFlightsRequest,
): Promise<SearchGoogleFlightsResponse> {
  const origin = (req.origin || '').toUpperCase().trim();
  const destination = (req.destination || '').toUpperCase().trim();
  const departureDate = req.departureDate || '';

  if (!origin || !destination || !departureDate) {
    return { flights: [], degraded: true, error: 'origin, destination, and departure_date are required' };
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { flights: [], degraded: true, error: 'relay unavailable' };
  }

  // Clamp once so equivalent relay calls (e.g. passengers=99 → 9) share a cache entry.
  const passengers = Math.max(1, Math.min(req.passengers ?? 1, 9));
  const airlines = parseStringArray(req.airlines);
  const params = new URLSearchParams({
    origin,
    destination,
    departure_date: departureDate,
    ...(req.returnDate ? { return_date: req.returnDate } : {}),
    ...(req.cabinClass ? { cabin_class: req.cabinClass } : {}),
    ...(req.maxStops ? { max_stops: req.maxStops } : {}),
    ...(req.departureWindow ? { departure_window: req.departureWindow } : {}),
    ...(req.sortBy ? { sort_by: req.sortBy } : {}),
    passengers: String(passengers),
  });
  for (const airline of airlines) {
    params.append('airlines', airline);
  }

  // Cache key uses a sorted-airlines axis so input order doesn't fragment cache hits;
  // the relay still receives airlines in the caller's order via `params`.
  const sortedAirlinesKey = [...airlines].sort().join(',');
  const cacheKey = `aviation:gf:${origin}:${destination}:${departureDate}:${req.returnDate ?? ''}:${req.cabinClass ?? ''}:${req.maxStops ?? ''}:${req.departureWindow ?? ''}:${req.sortBy ?? ''}:${passengers}:${sortedAirlinesKey}:v1`;

  try {
    const data = await cachedFetchJson<{ flights: unknown[] }>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const resp = await fetch(`${relayBaseUrl}/google-flights/search?${params}`, {
          headers: getRelayHeaders(),
          signal: AbortSignal.timeout(20_000),
        });
        if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
        const json = (await resp.json()) as { flights?: unknown[]; error?: string };
        if (!Array.isArray(json.flights)) throw new Error(json.error ?? 'no results');
        return { flights: json.flights };
      },
    );

    if (!data) {
      return { flights: [], degraded: true, error: 'no results' };
    }

    return {
      flights: data.flights as SearchGoogleFlightsResponse['flights'],
      degraded: false,
      error: '',
    };
  } catch (err) {
    return { flights: [], degraded: true, error: err instanceof Error ? err.message : 'search failed' };
  }
}
