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
import { getRelayBaseUrl, getRelayHeaders } from './_shared';

const CACHE_TTL = 300;

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
//   'none'          — relay not configured; flights = []
//   'error'         — relay fetch failed; flights = []
export async function listAirportFlights(
    _ctx: ServerContext,
    req: ListAirportFlightsRequest,
): Promise<ListAirportFlightsResponse> {
    const airport = req.airport?.toUpperCase() || 'IST';
    const direction = req.direction || 'FLIGHT_DIRECTION_BOTH';
    const limit = Math.min(req.limit || 30, 100);
    const cacheKey = `aviation:flights:${airport}:${direction}:${limit}:v1`;
    const now = Date.now();

    try {
        const result = await cachedFetchJson<{ flights: FlightInstance[]; source: string }>(
            cacheKey, CACHE_TTL, async () => {
                const relayBase = getRelayBaseUrl();
                if (!relayBase) {
                    return { flights: [], source: 'none' };
                }

                const paramKey = direction === 'FLIGHT_DIRECTION_ARRIVAL' ? 'arr_iata' : 'dep_iata';
                const params = new URLSearchParams({
                    [paramKey]: airport,
                    limit: String(limit),
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
                    return { flights: [], source: 'error' };
                }
            }
        );

        const flights = result?.flights ?? [];
        return {
            flights: flights.slice(0, limit),
            totalAvailable: flights.length,
            source: result?.source ?? 'unknown',
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] ListAirportFlights error: ${err instanceof Error ? err.message : err}`);
        return { flights: [], totalAvailable: 0, source: 'error', updatedAt: now };
    }
}
