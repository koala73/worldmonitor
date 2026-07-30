import type {
    ServerContext,
    ListAirportFlightsRequest,
    ListAirportFlightsResponse,
    FlightInstance,
    FlightInstanceStatus,
    Carrier,
    AirportRef,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';
import { aviationStackBudgetMonth, reserveAviationStackCalls } from './_avstack-budget';

const CACHE_TTL = 300;
// Always fetch a full page upstream and cache it once per airport+direction,
// then slice to the caller's requested limit in memory. Threading req.limit
// into the cache key (and the upstream query) meant limit 30 vs 31 vs 50 were
// separate PAID AviationStack calls for identical data — a cache-key explosion
// that multiplied spend. The page covers any limit ≤ 100.
const UPSTREAM_PAGE = 100;
const IATA_RE = /^[A-Z]{3}$/;

interface AVSFlight {
    flight?: { iata?: string; icao?: string; codeshared?: { flight_iata?: string; airline_iata?: string }[] };
    airline?: { iata?: string; icao?: string; name?: string };
    departure?: { iata?: string; icao?: string; airport?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string; gate?: string; terminal?: string; delay?: number };
    arrival?: { iata?: string; icao?: string; airport?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string };
    flight_status?: string;
    aircraft?: { icao24?: string; iata?: string };
}

function statusToProto(s: string): FlightInstanceStatus {
    const m: Record<string, FlightInstanceStatus> = {
        scheduled: 'FLIGHT_INSTANCE_STATUS_SCHEDULED',
        active: 'FLIGHT_INSTANCE_STATUS_AIRBORNE',
        landed: 'FLIGHT_INSTANCE_STATUS_LANDED',
        cancelled: 'FLIGHT_INSTANCE_STATUS_CANCELLED',
        incident: 'FLIGHT_INSTANCE_STATUS_UNKNOWN',
        diverted: 'FLIGHT_INSTANCE_STATUS_DIVERTED',
    };
    return m[s] ?? 'FLIGHT_INSTANCE_STATUS_UNKNOWN';
}

function parseTs(s?: string): number {
    if (!s) return 0;
    try { return new Date(s).getTime(); } catch { return 0; }
}

function normalizeFlights(flights: AVSFlight[], now: number): FlightInstance[] {
    return flights.map(f => {
        const carrier: Carrier = {
            iataCode: f.airline?.iata ?? '',
            icaoCode: f.airline?.icao ?? '',
            name: f.airline?.name ?? '',
        };
        const origin: AirportRef = {
            iata: f.departure?.iata ?? '',
            icao: f.departure?.icao ?? '',
            name: f.departure?.airport ?? '',
            timezone: f.departure?.timezone ?? 'UTC',
        };
        const destination: AirportRef = {
            iata: f.arrival?.iata ?? '',
            icao: f.arrival?.icao ?? '',
            name: f.arrival?.airport ?? '',
            timezone: f.arrival?.timezone ?? 'UTC',
        };
        const delayMs = (f.departure?.delay ?? 0) * 60 * 1000;
        const schedDep = parseTs(f.departure?.scheduled);

        return {
            flightNumber: f.flight?.iata ?? '',
            date: f.departure?.scheduled?.slice(0, 10) ?? '',
            operatingCarrier: carrier,
            origin,
            destination,
            scheduledDeparture: schedDep,
            estimatedDeparture: parseTs(f.departure?.estimated) || (schedDep ? schedDep + delayMs : 0),
            actualDeparture: parseTs(f.departure?.actual),
            scheduledArrival: parseTs(f.arrival?.scheduled),
            estimatedArrival: parseTs(f.arrival?.estimated),
            actualArrival: parseTs(f.arrival?.actual),
            status: statusToProto(f.flight_status ?? ''),
            delayMinutes: f.departure?.delay ?? 0,
            cancelled: f.flight_status === 'cancelled',
            diverted: f.flight_status === 'diverted',
            gate: f.departure?.gate ?? '',
            terminal: f.departure?.terminal ?? '',
            aircraftIcao24: f.aircraft?.icao24 ?? '',
            aircraftType: f.aircraft?.iata ?? '',
            codeshareFlightNumbers: [],
            source: 'aviationstack',
            updatedAt: now,
        };
    });
}


// Response-level source values (ListAirportFlightsResponse.source):
//   'aviationstack' — live data from AviationStack via relay
//   'none'          — relay not configured; flights = [] (no-store, negative cached)
//   'error'         — relay fetch failed; flights = [] (no-store, negative cached)
//   'invalid'       — malformed airport code; rejected before any paid call
//   'budget'        — monthly AviationStack budget reached; serving empty (no-store, negative cached)
export async function listAirportFlights(
    ctx: ServerContext,
    req: ListAirportFlightsRequest,
): Promise<ListAirportFlightsResponse> {
    const airport = req.airport?.toUpperCase() || 'IST';
    const direction = req.direction || 'FLIGHT_DIRECTION_BOTH';
    const limit = Math.min(req.limit || 30, 100);
    const now = Date.now();

    // Reject malformed airport codes before they reach the paid API — bounds
    // cache-key cardinality and blocks probing with arbitrary strings.
    if (!IATA_RE.test(airport)) {
        return { flights: [], totalAvailable: 0, source: 'invalid', updatedAt: now };
    }

    // Cache key is limit-independent (see UPSTREAM_PAGE) — one upstream call
    // serves every limit for this airport+direction.
    const cacheKey = `aviation:flights:${airport}:${direction}:v2:${aviationStackBudgetMonth()}`;
    let unavailableSource = 'unavailable';

    try {
        const result = await cachedFetchJson<{ flights: FlightInstance[]; source: 'aviationstack' }>(
            cacheKey, CACHE_TTL, async () => {
                const relayBase = getRelayBaseUrl();
                if (!relayBase) {
                    unavailableSource = 'none';
                    return null;
                }

                // Monthly quota guard: negative-cache the unavailable state
                // instead of positive-caching an empty flight board.
                if (!(await reserveAviationStackCalls(1, 'request'))) {
                    unavailableSource = 'budget';
                    return null;
                }

                const paramKey = direction === 'FLIGHT_DIRECTION_ARRIVAL' ? 'arr_iata' : 'dep_iata';
                const params = new URLSearchParams({
                    [paramKey]: airport,
                    limit: String(UPSTREAM_PAGE),
                });
                const url = `${relayBase}/aviationstack?${params}`;

                try {
                    const resp = await fetch(url, {
                        headers: getRelayHeaders(),
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const json = await resp.json() as { data?: AVSFlight[]; error?: { message?: string } };
                    if (json.error) throw new Error(json.error.message);
                    const flights = normalizeFlights(json.data ?? [], now);
                    return { flights, source: 'aviationstack' };
                } catch (err) {
                    console.warn(`[Aviation] Flights relay fetch failed for ${airport}: ${err instanceof Error ? err.message : err}`);
                    unavailableSource = 'error';
                    return null;
                }
            }
        );

        if (!result) {
            markNoCacheResponse(ctx.request);
            return {
                flights: [],
                totalAvailable: 0,
                source: unavailableSource,
                updatedAt: now,
            };
        }

        const flights = result.flights;
        return {
            flights: flights.slice(0, limit),
            totalAvailable: flights.length,
            source: result.source,
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] ListAirportFlights error: ${err instanceof Error ? err.message : err}`);
        markNoCacheResponse(ctx.request);
        return { flights: [], totalAvailable: 0, source: 'error', updatedAt: now };
    }
}
