import type {
  ServerContext,
  SearchGoogleDatesRequest,
  SearchGoogleDatesResponse,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { sha256Hex } from '../../../../api/_crypto.js';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import { parseStringArray } from '../../../_shared/parse-string-array';
import { normalizePassengerCount } from '../../../_shared/passenger-count';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';

// Medium-cache tier (10 min) — use cachedFetchJsonWithMeta for stampede protection.
const CACHE_TTL = 600;

export async function searchGoogleDates(
  _ctx: ServerContext,
  req: SearchGoogleDatesRequest,
): Promise<SearchGoogleDatesResponse> {
  const invalid = (message: string): never => { throw new ApiError(400, message, ''); };
  const bounded = (value: string | undefined, max: number): string => {
    if ((value?.length ?? 0) > max) invalid('Date-search field is too long');
    return (value ?? '').trim();
  };
  const origin = bounded(req.origin, 16).toUpperCase();
  const destination = bounded(req.destination, 16).toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) invalid('Expected three-letter airport codes');
  const parseDate = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Expected YYYY-MM-DD dates');
    const time = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid('Invalid calendar date');
    return time;
  };
  const startDate = bounded(req.startDate, 10);
  const endDate = bounded(req.endDate, 10);
  const days = (parseDate(endDate) - parseDate(startDate)) / 86_400_000 + 1;
  // The relay supports six chunks of at most 61 days each.
  if (days < 1 || days > 366) invalid('Date range must contain 1 to 366 days');
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
  const tripDuration = req.isRoundTrip ? req.tripDuration : 0;
  if (req.isRoundTrip && (!Number.isInteger(tripDuration) || tripDuration < 1 || tripDuration > 365)) invalid('Round-trip duration must be 1 to 365 days');

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return { dates: [], degraded: true, error: 'relay unavailable' };
  }

  const passengers = normalizePassengerCount(req.passengers);
  const params = new URLSearchParams({
    origin,
    destination,
    start_date: startDate,
    end_date: endDate,
    is_round_trip: String(req.isRoundTrip ?? false),
    ...(tripDuration ? { trip_duration: String(tripDuration) } : {}),
    cabin_class: cabinClass,
    max_stops: maxStops,
    ...(departureWindow ? { departure_window: departureWindow } : {}),
    sort_by_price: String(req.sortByPrice ?? false),
    passengers: String(passengers),
  });
  for (const airline of airlines) {
    params.append('airlines', airline);
  }

  const cacheKey = `aviation:gf-dates:${await sha256Hex(params.toString())}:v3`;

  try {
    const { data } = await cachedFetchJsonWithMeta<{ dates: unknown[]; degraded: boolean; cooldown: boolean }>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const resp = await fetch(`${relayBaseUrl}/google-flights/search-dates?${params}`, {
          headers: getRelayHeaders(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) throw new Error(`relay returned ${resp.status}`);
        const json = (await resp.json()) as { dates?: unknown[]; partial?: boolean; cooldown?: boolean; error?: string };
        if (!Array.isArray(json.dates)) throw new Error(json.error ?? 'no results');
        return {
          dates: json.dates,
          degraded: json.partial === true || json.cooldown === true,
          cooldown: json.cooldown === true,
        };
      },
      120,
      { cacheFailures: false },
    );

    if (!data) {
      return { dates: [], degraded: true, error: 'no results' };
    }

    return {
      dates: data.dates as SearchGoogleDatesResponse['dates'],
      degraded: data.degraded,
      error: data.cooldown
        ? 'provider cooldown'
        : data.degraded ? 'partial results: one or more date chunks failed' : '',
    };
  } catch (err) {
    return { dates: [], degraded: true, error: err instanceof Error ? err.message : 'search failed' };
  }
}
