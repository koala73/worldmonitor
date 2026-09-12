import type {
  ServerContext,
  SearchGoogleFlightsRequest,
  SearchGoogleFlightsResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { IATA_RE } from './_shared';
// @ts-expect-error — JS module, no declaration file
import { sha256Hex } from '../../../../api/_crypto.js';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { parseStringArray } from '../../../_shared/parse-string-array';
import { normalizePassengerCount } from '../../../_shared/passenger-count';
import { cachedFetchJson } from '../../../_shared/redis';

const CACHE_TTL = 600;

export async function searchGoogleFlights(
  _ctx: ServerContext,
  req: SearchGoogleFlightsRequest,
): Promise<SearchGoogleFlightsResponse> {
  const invalid = (message: string): never => { throw new ApiError(400, message, ''); };
  const bounded = (value: string | undefined, max: number): string => {
    if ((value?.length ?? 0) > max) invalid('Flight-search field is too long');
    return (value ?? '').trim();
  };
  const origin = bounded(req.origin, 16).toUpperCase();
  const destination = bounded(req.destination, 16).toUpperCase();
  if (!IATA_RE.test(origin) || !IATA_RE.test(destination)) invalid('Expected three-letter airport codes');
  const parseDate = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Expected YYYY-MM-DD dates');
    const time = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid('Invalid calendar date');
    return time;
  };
  const departureDate = bounded(req.departureDate, 10);
  const returnDate = bounded(req.returnDate, 10);
  const departureTime = parseDate(departureDate);
  if (returnDate && parseDate(returnDate) < departureTime) invalid('Return date must not precede departure date');
  const cabinClass = bounded(req.cabinClass, 32).toUpperCase() || 'ECONOMY';
  if (!['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'].includes(cabinClass)) invalid('Invalid cabin class');
  const stopValue = bounded(req.maxStops, 32).toUpperCase() || 'ANY';
  const maxStops = ({ '0': 'NON_STOP', '1': 'ONE_STOP', '2': 'TWO_PLUS_STOPS' } as Record<string, string>)[stopValue] ?? stopValue;
  if (!['ANY', 'NON_STOP', 'ONE_STOP', 'TWO_PLUS_STOPS'].includes(maxStops)) invalid('Invalid stop filter');
  let departureWindow = bounded(req.departureWindow, 5);
  if (departureWindow) {
    if (!/^\d{1,2}-\d{1,2}$/.test(departureWindow)) invalid('Invalid departure window');
    const [start, end] = departureWindow.split('-').map(Number) as [number, number];
    if (start < 0 || start > 23 || end > 24 || start >= end) invalid('Invalid departure window');
    departureWindow = `${start}-${end}`;
  }
  const rawAirlines = parseStringArray(req.airlines);
  if (rawAirlines.length > 10) invalid('At most ten airline codes are allowed');
  const airlines = [...new Set(rawAirlines.map(value => {
    const code = bounded(value, 8).toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(code)) invalid('Expected two-character airline codes');
    return code;
  }))].sort();
  const sortValue = bounded(req.sortBy, 32).toUpperCase();
  const sortBy = ({ PRICE: 'CHEAPEST', DEPARTURE: 'DEPARTURE_TIME', ARRIVAL: 'ARRIVAL_TIME' } as Record<string, string>)[sortValue] ?? sortValue;
  if (!['', 'CHEAPEST', 'DURATION', 'DEPARTURE_TIME', 'ARRIVAL_TIME'].includes(sortBy)) invalid('Invalid sort order');

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { flights: [], degraded: true, error: 'relay unavailable' };
  }

  // Clamp once so equivalent relay calls (e.g. passengers=99 → 9) share a cache entry.
  const passengers = normalizePassengerCount(req.passengers);
  const params = new URLSearchParams({
    origin,
    destination,
    departure_date: departureDate,
    ...(returnDate ? { return_date: returnDate } : {}),
    cabin_class: cabinClass,
    max_stops: maxStops,
    ...(departureWindow ? { departure_window: departureWindow } : {}),
    ...(sortBy ? { sort_by: sortBy } : {}),
    passengers: String(passengers),
  });
  for (const airline of airlines) {
    params.append('airlines', airline);
  }

  const cacheKey = `aviation:gf:${await sha256Hex(params.toString())}:v2`;

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
