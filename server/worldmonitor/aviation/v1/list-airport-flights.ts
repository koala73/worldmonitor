import type {
    ServerContext,
    ListAirportFlightsRequest,
    ListAirportFlightsResponse,
    FlightInstance,
    FlightInstanceStatus,
    Carrier,
    AirportRef,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders, IATA_RE, requireLiveAviationAccess } from './_shared';
import { aviationStackBudgetCycle, reserveAviationStackCalls } from './_avstack-budget';

// 15min. Held at 300s until Aug 2026, when a scraper polling every ~5.7min
// converted this endpoint to a ~100% cache-miss rate: 504 of 504 requests on a
// single day went upstream because each poll landed just after the 300s key
// expired. Any TTL at or below a caller's polling interval buys nothing — it
// only guarantees the paid call. 900s breaks that resonance for any poller
// faster than 15min, and departure boards do not move meaningfully inside it.
// Arrivals hold for an hour: at the seeded hubs the departure leg is already an
// hourly board, so a fresher arrival leg beside it buys four paid calls an hour
// for a board that is no fresher overall.
const LEG_CACHE_TTL: Record<'departure' | 'arrival', number> = { departure: 900, arrival: 3600 };
// Always fetch a full page upstream and cache it once per airport+leg, then
// slice to the caller's requested limit in memory. Threading req.limit into the
// cache key (and the upstream query) meant limit 30 vs 31 vs 50 were separate
// PAID AviationStack calls for identical data — a cache-key explosion that
// multiplied spend. The page covers any limit ≤ 100.
const UPSTREAM_PAGE = 100;

// scripts/seed-aviation.mjs buys this same dep_iata page for each of its hubs
// about once an hour and stores it here, so departures at those hubs need no
// paid call. Older than this, the seeder has stopped refreshing it (budget,
// outage) and the leg falls back to its own call.
const DEPARTURE_BOARD_MAX_AGE_MS = 90 * 60 * 1000;

export function departureBoardKey(airport: string): string {
    return `aviation:avstack:departures:v1:${airport}`;
}

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

export interface AVSFlight {
    // A codeshare row names its operating flight here, in lower case.
    flight?: { iata?: string; icao?: string; codeshared?: { flight_iata?: string; airline_iata?: string; airline_icao?: string; airline_name?: string } | null };
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

const zoneClocks = new Map<string, Intl.DateTimeFormat | null>();

function zoneClock(zone: string): Intl.DateTimeFormat | null {
    if (!zoneClocks.has(zone)) {
        try {
            zoneClocks.set(zone, new Intl.DateTimeFormat('en-US', {
                timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
                hour: 'numeric', minute: 'numeric', second: 'numeric',
            }));
        } catch {
            zoneClocks.set(zone, null);
        }
    }
    return zoneClocks.get(zone) ?? null;
}

function airportZone(zone?: string): string {
    return zone && zoneClock(zone) ? zone : 'UTC';
}

// AviationStack writes each time as the airport's local wall clock with a
// "+00:00" suffix, so the wall clock is read in that airport's time zone.
function airportMs(wall: string | undefined, zone: string): number {
    const asUtc = parseTs(wall);
    const clock = zoneClock(zone);
    if (!asUtc || !clock) return asUtc;
    const offsetAt = (at: number) => {
        const parts = clock.formatToParts(at);
        const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
        return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - at;
    };
    // The offset at the wall clock read as UTC can be the other side of a
    // clock change, so take it again at the first estimate.
    return asUtc - offsetAt(asUtc - offsetAt(asUtc));
}

function normalizeFlight(f: AVSFlight, now: number): FlightInstance {
    const operator = operatorOf(f);
    const carrier: Carrier = operator
        ? { iataCode: operator.airline_iata?.toUpperCase() ?? '', icaoCode: operator.airline_icao?.toUpperCase() ?? '', name: operator.airline_name ?? '' }
        : { iataCode: f.airline?.iata ?? '', icaoCode: f.airline?.icao ?? '', name: f.airline?.name ?? '' };
    const origin: AirportRef = {
        iata: f.departure?.iata ?? '',
        icao: f.departure?.icao ?? '',
        name: f.departure?.airport ?? '',
        timezone: airportZone(f.departure?.timezone),
    };
    const destination: AirportRef = {
        iata: f.arrival?.iata ?? '',
        icao: f.arrival?.icao ?? '',
        name: f.arrival?.airport ?? '',
        timezone: airportZone(f.arrival?.timezone),
    };
    const delayMs = (f.departure?.delay ?? 0) * 60 * 1000;
    const schedDep = airportMs(f.departure?.scheduled, origin.timezone);

    return {
        flightNumber: operatingNumber(f),
        date: f.departure?.scheduled?.slice(0, 10) ?? '',
        operatingCarrier: carrier,
        origin,
        destination,
        scheduledDeparture: schedDep,
        estimatedDeparture: airportMs(f.departure?.estimated, origin.timezone) || (schedDep ? schedDep + delayMs : 0),
        actualDeparture: airportMs(f.departure?.actual, origin.timezone),
        scheduledArrival: airportMs(f.arrival?.scheduled, destination.timezone),
        estimatedArrival: airportMs(f.arrival?.estimated, destination.timezone),
        actualArrival: airportMs(f.arrival?.actual, destination.timezone),
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
}

// A codeshare row that does not name its operating flight stands for itself.
function operatorOf(f: AVSFlight) {
    return f.flight?.codeshared?.flight_iata ? f.flight.codeshared : undefined;
}

function operatingNumber(f: AVSFlight): string {
    return operatorOf(f)?.flight_iata?.toUpperCase() ?? f.flight?.iata ?? '';
}

/**
 * One instance per physical flight. AviationStack returns a row per marketing
 * number, and the operating row is often missing from the page, so the first
 * row of a flight stands in for it until the operating row arrives.
 */
export function normalizeFlights(rows: AVSFlight[], now: number): FlightInstance[] {
    const byFlight = new Map<string, FlightInstance>();
    const flights: FlightInstance[] = [];
    const operatingFirst = [...rows.filter(f => !operatorOf(f)), ...rows.filter(f => operatorOf(f))];
    for (const f of operatingFirst) {
        const number = operatingNumber(f);
        const key = number && `${number}|${f.departure?.scheduled ?? ''}`;
        let flight = key ? byFlight.get(key) : undefined;
        if (!flight) {
            flight = normalizeFlight(f, now);
            flights.push(flight);
            if (key) byFlight.set(key, flight);
        }
        if (operatorOf(f) && f.flight?.iata) flight.codeshareFlightNumbers.push(f.flight.iata);
    }
    return flights;
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
async function readDepartureBoard(airport: string, now: number): Promise<LegResult | null> {
    const board = await getCachedJson(departureBoardKey(airport), true) as { fetchedAt?: unknown; rows?: unknown } | null;
    if (!board || typeof board.fetchedAt !== 'number' || !Array.isArray(board.rows)) return null;
    const age = now - board.fetchedAt;
    if (!(age >= 0 && age <= DEPARTURE_BOARD_MAX_AGE_MS)) return null;
    return { flights: normalizeFlights(board.rows as AVSFlight[], board.fetchedAt), source: 'aviationstack' };
}

async function fetchLeg(airport: string, leg: Leg, now: number): Promise<LegResult> {
    if (leg === 'departure') {
        const board = await readDepartureBoard(airport, now);
        if (board) return board;
    }

    // Cache key is limit-independent (see UPSTREAM_PAGE) — one upstream call
    // serves every limit for this airport+leg.
    const cacheKey = `aviation:flights:${airport}:${leg}:v4:${aviationStackBudgetCycle()}`;
    // Stays 'unavailable' when the fetcher never runs — a negative-cache hit
    // returns null without telling us which failure originally cached it.
    let unavailableSource = 'unavailable';

    const result = await cachedFetchJson<{ flights: FlightInstance[]; source: 'aviationstack' }>(
        cacheKey, LEG_CACHE_TTL[leg], async () => {
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
    const limit = req.limit > 0 ? Math.min(req.limit, 100) : 30;
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
