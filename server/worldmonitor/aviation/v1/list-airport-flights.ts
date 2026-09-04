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
import { getRelayBaseUrl, getRelayHeaders, IATA_RE, requireLiveAviationAccess } from './_shared';
import { aviationStackBudgetCycle, reserveAviationStackCalls } from './_avstack-budget';

// 15min. Held at 300s until Aug 2026, when a scraper polling every ~5.7min
// converted this endpoint to a ~100% cache-miss rate: 504 of 504 requests on a
// single day went upstream because each poll landed just after the 300s key
// expired. Any TTL at or below a caller's polling interval buys nothing — it
// only guarantees the paid call. 900s breaks that resonance for any poller
// faster than 15min, and departure boards do not move meaningfully inside it.
const CACHE_TTL = 900;
// Always fetch a full page upstream and cache it once per airport+leg, then
// slice to the caller's requested limit in memory. Threading req.limit into the
// cache key (and the upstream query) meant limit 30 vs 31 vs 50 were separate
// PAID AviationStack calls for identical data — a cache-key explosion that
// multiplied spend. The page covers any limit ≤ 100.
const UPSTREAM_PAGE = 100;

// A leg is one upstream query. AviationStack ANDs dep_iata with arr_iata — set
// together they describe a ROUTE (A→B), not a both-directions board — so an
// arrivals-inclusive request is two calls merged here, never one call carrying
// both params.
type Leg = 'departure' | 'arrival';

const LEG_PARAM: Record<Leg, 'dep_iata' | 'arr_iata'> = {
    departure: 'dep_iata',
    arrival: 'arr_iata',
};

// BOTH and UNSPECIFIED are both arrivals-inclusive per list_airport_flights
// .proto: BOTH is "Both departures and arrivals" and UNSPECIFIED is documented
// as defaulting to both. UNSPECIFIED is the *default* path, not an edge — the
// generated HTTP decoder passes an absent `direction` query param through as
// UNSPECIFIED, so it never reaches a `|| BOTH` fallback in the handler.
function legsFor(direction: string): Leg[] {
    if (direction === 'FLIGHT_DIRECTION_DEPARTURE') return ['departure'];
    if (direction === 'FLIGHT_DIRECTION_ARRIVAL') return ['arrival'];
    return ['departure', 'arrival'];
}

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


interface LegResult {
    flights: FlightInstance[];
    // 'aviationstack' when this leg served real data; otherwise the reason it
    // did not (see the response-source table on listAirportFlights).
    source: string;
}

/**
 * Fetch (or read from cache) one leg of an airport board.
 *
 * The cache key is keyed on the LEG, not on the caller's requested direction.
 * A both-directions request therefore warms exactly the two keys that a
 * departures-only and an arrivals-only request read, instead of stashing a
 * third byte-identical copy of the departures payload under its own key. That
 * mattered: `direction` used to sit in the key while three of its four values
 * (DEPARTURE, BOTH, UNSPECIFIED) all issued the same dep_iata query, so two of
 * every three warm keys were duplicate departure payloads bought at
 * AviationStack's metered expense.
 */
async function fetchLeg(airport: string, leg: Leg, now: number): Promise<LegResult> {
    // Cache key is limit-independent (see UPSTREAM_PAGE) — one upstream call
    // serves every limit for this airport+leg.
    const cacheKey = `aviation:flights:${airport}:${leg}:v3:${aviationStackBudgetCycle()}`;
    // Stays 'unavailable' when the fetcher never runs — a negative-cache hit
    // returns null without telling us which failure originally cached it.
    let unavailableSource = 'unavailable';

    const result = await cachedFetchJson<{ flights: FlightInstance[]; source: 'aviationstack' }>(
        cacheKey, CACHE_TTL, async () => {
            const relayBase = getRelayBaseUrl();
            if (!relayBase) {
                unavailableSource = 'none';
                return null;
            }

            // Monthly quota guard: negative-cache the unavailable state
            // instead of positive-caching an empty flight board. Reserved per
            // leg on the miss path, so a both-directions request that hits
            // cache on one leg only spends for the other.
            if (!(await reserveAviationStackCalls(1, 'request'))) {
                unavailableSource = 'budget';
                return null;
            }

            const params = new URLSearchParams({
                [LEG_PARAM[leg]]: airport,
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
                // sentry-coverage-ok: a metered third-party relay blip is an
                // expected state, not a defect — the leg negative-caches and the
                // response reports it as 'error' (or 'partial' when the sibling
                // leg served). Matches get-flight-status and track-aircraft.
                console.warn(`[Aviation] Flights relay fetch failed for ${airport} ${leg}s: ${err instanceof Error ? err.message : err}`);
                unavailableSource = 'error';
                return null;
            }
        }
    );

    if (!result) return { flights: [], source: unavailableSource };
    return { flights: result.flights, source: result.source };
}

/**
 * When this flight touches `airport`, in epoch ms.
 *
 * Ordering a mixed board on scheduledDeparture alone buries the arrivals: a
 * long-haul landing at 14:00 left its origin at 06:00, so it sorts hours ahead
 * of the departures it shares a board with. Arrivals are ordered by when they
 * land here, departures by when they leave here.
 */
function boardTime(f: FlightInstance, airport: string): number {
    if (f.destination?.iata === airport) return f.scheduledArrival || f.scheduledDeparture || 0;
    return f.scheduledDeparture || f.scheduledArrival || 0;
}

/**
 * Merge the legs into one board, ordered by airport-local event time.
 *
 * The ordering is load-bearing, not cosmetic. Concatenating 100 departures and
 * 100 arrivals and slicing to the caller's limit (30 by default) hands back 30
 * departures and no arrivals — the merge would be invisible to every caller
 * that does not ask for more than a page.
 */
function mergeLegs(legResults: LegResult[], airport: string): FlightInstance[] {
    const seen = new Set<string>();
    const merged: FlightInstance[] = [];

    for (const { flights } of legResults) {
        for (const f of flights) {
            // Only dedupe rows carrying a flight number; without one the key
            // degenerates and would collapse distinct unidentified rows.
            if (f.flightNumber) {
                const key = `${f.flightNumber}|${f.scheduledDeparture}|${f.origin?.iata ?? ''}|${f.destination?.iata ?? ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
            }
            merged.push(f);
        }
    }

    // Untimed rows sink rather than lead — a missing schedule is not midnight.
    return merged.sort((a, b) =>
        (boardTime(a, airport) || Number.MAX_SAFE_INTEGER) - (boardTime(b, airport) || Number.MAX_SAFE_INTEGER));
}

// Response-level source values (ListAirportFlightsResponse.source):
//   'aviationstack' — live data from AviationStack via relay
//   'partial'       — an arrivals-inclusive request where one leg served and the
//                     other did not; the served leg's flights are returned
//                     (no-store, so the half-board is not edge-cached)
//   'none'          — relay not configured; flights = [] (no-store, negative cached)
//   'error'         — relay fetch failed; flights = [] (no-store, negative cached)
//   'invalid'       — malformed airport code; rejected before any paid call
//   'budget'        — monthly AviationStack budget reached; serving empty (no-store, negative cached)
export async function listAirportFlights(
    ctx: ServerContext,
    req: ListAirportFlightsRequest,
): Promise<ListAirportFlightsResponse> {
    // Metered route — gate before anything else. See requireLiveAviationAccess.
    await requireLiveAviationAccess(ctx.request);

    const airport = req.airport?.toUpperCase() || 'IST';
    const limit = Math.min(req.limit || 30, 100);
    const now = Date.now();

    // Reject malformed airport codes before they reach the paid API — bounds
    // cache-key cardinality and blocks probing with arbitrary strings.
    if (!IATA_RE.test(airport)) {
        return { flights: [], totalAvailable: 0, source: 'invalid', updatedAt: now };
    }

    const legs = legsFor(req.direction);

    try {
        // allSettled, not all: cachedFetchJson throws outright while an
        // isolate-local unavailable backoff is armed, and one leg in that state
        // must not discard a board the other leg is ready to serve.
        const settled = await Promise.allSettled(legs.map(leg => fetchLeg(airport, leg, now)));
        const legResults: LegResult[] = settled.map(r => {
            if (r.status === 'fulfilled') return r.value;
            console.warn(`[Aviation] Flights leg failed for ${airport}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
            return { flights: [], source: 'error' };
        });
        const served = legResults.filter(r => r.source === 'aviationstack');

        if (served.length === 0) {
            markNoCacheResponse(ctx.request);
            return {
                flights: [],
                totalAvailable: 0,
                // Prefer a leg that named its failure. 'unavailable' is what a
                // negative-cache hit reports — it only means "something cached
                // a failure here", so a sibling leg's 'budget' or 'error' is
                // the more actionable answer.
                source: legResults.find(r => r.source !== 'unavailable')?.source ?? 'unavailable',
                updatedAt: now,
            };
        }

        // A half-served board is reported as such rather than passed off as a
        // complete one — silently returning departures-only is exactly the
        // failure this endpoint just stopped shipping by default.
        const partial = served.length < legResults.length;
        if (partial) markNoCacheResponse(ctx.request);

        const flights = mergeLegs(served, airport);
        return {
            flights: flights.slice(0, limit),
            totalAvailable: flights.length,
            source: partial ? 'partial' : 'aviationstack',
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] ListAirportFlights error: ${err instanceof Error ? err.message : err}`);
        markNoCacheResponse(ctx.request);
        return { flights: [], totalAvailable: 0, source: 'error', updatedAt: now };
    }
}
