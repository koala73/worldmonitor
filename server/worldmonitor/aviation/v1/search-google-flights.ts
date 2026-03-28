import type {
  ServerContext,
  SearchGoogleFlightsRequest,
  SearchGoogleFlightsResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { parseStringArray } from '../../../_shared/parse-string-array';

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

  try {
    const params = new URLSearchParams({
      origin,
      destination,
      departure_date: departureDate,
      ...(req.returnDate ? { return_date: req.returnDate } : {}),
      ...(req.cabinClass ? { cabin_class: req.cabinClass } : {}),
      ...(req.maxStops ? { max_stops: req.maxStops } : {}),
      ...(req.departureWindow ? { departure_window: req.departureWindow } : {}),
      ...(req.sortBy ? { sort_by: req.sortBy } : {}),
      passengers: String(Math.max(1, Math.min(req.passengers ?? 1, 9))),
    });
    for (const airline of parseStringArray(req.airlines)) {
      params.append('airlines', airline);
    }

    const resp = await fetch(`${relayBaseUrl}/google-flights/search?${params}`, {
      headers: getRelayHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      return { flights: [], degraded: true, error: `relay returned ${resp.status}` };
    }

    const data = (await resp.json()) as { flights?: unknown[]; error?: string };
    if (!Array.isArray(data.flights)) {
      return { flights: [], degraded: true, error: data.error ?? 'no results' };
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
