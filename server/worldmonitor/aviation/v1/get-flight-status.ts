import type {
    ServerContext,
    GetFlightStatusRequest,
    GetFlightStatusResponse,
    FlightInstance,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { getRelayBaseUrl, getRelayHeaders } from './_shared';

const CACHE_TTL = 120; // 2 minutes

interface AVSFlight {
    flight?: { iata?: string; codeshared?: Array<{ flight_iata?: string; airline_iata?: string }> };
    airline?: { iata?: string; icao?: string; name?: string };
    departure?: { iata?: string; icao?: string; airport?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string; gate?: string; terminal?: string; delay?: number };
    arrival?: { iata?: string; icao?: string; airport?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string };
    flight_status?: string;
    aircraft?: { icao24?: string; iata?: string };
}

function normalizeFlight(f: AVSFlight, now: number): FlightInstance {
    const schedDep = f.departure?.scheduled ? new Date(f.departure.scheduled).getTime() : 0;
    const delayMs = (f.departure?.delay ?? 0) * 60_000;
    return {
        flightNumber: f.flight?.iata ?? '',
        date: f.departure?.scheduled?.slice(0, 10) ?? '',
        operatingCarrier: { iataCode: f.airline?.iata ?? '', icaoCode: f.airline?.icao ?? '', name: f.airline?.name ?? '' },
        origin: { iata: f.departure?.iata ?? '', icao: f.departure?.icao ?? '', name: f.departure?.airport ?? '', timezone: f.departure?.timezone ?? 'UTC' },
        destination: { iata: f.arrival?.iata ?? '', icao: f.arrival?.icao ?? '', name: f.arrival?.airport ?? '', timezone: f.arrival?.timezone ?? 'UTC' },
        scheduledDeparture: schedDep,
        estimatedDeparture: f.departure?.estimated ? new Date(f.departure.estimated).getTime() : schedDep + delayMs,
        actualDeparture: f.departure?.actual ? new Date(f.departure.actual).getTime() : 0,
        scheduledArrival: f.arrival?.scheduled ? new Date(f.arrival.scheduled).getTime() : 0,
        estimatedArrival: f.arrival?.estimated ? new Date(f.arrival.estimated).getTime() : 0,
        actualArrival: f.arrival?.actual ? new Date(f.arrival.actual).getTime() : 0,
        status: (() => {
            const m: Record<string, FlightInstance['status']> = { scheduled: 'FLIGHT_INSTANCE_STATUS_SCHEDULED', active: 'FLIGHT_INSTANCE_STATUS_AIRBORNE', landed: 'FLIGHT_INSTANCE_STATUS_LANDED', cancelled: 'FLIGHT_INSTANCE_STATUS_CANCELLED', diverted: 'FLIGHT_INSTANCE_STATUS_DIVERTED' };
            return m[f.flight_status ?? ''] ?? 'FLIGHT_INSTANCE_STATUS_UNKNOWN';
        })(),
        delayMinutes: f.departure?.delay ?? 0,
        cancelled: f.flight_status === 'cancelled',
        diverted: f.flight_status === 'diverted',
        gate: f.departure?.gate ?? '',
        terminal: f.departure?.terminal ?? '',
        aircraftIcao24: f.aircraft?.icao24 ?? '',
        aircraftType: f.aircraft?.iata ?? '',
        codeshareFlightNumbers: (f.flight?.codeshared ?? []).map(c => c.flight_iata ?? '').filter(Boolean),
        source: 'aviationstack',
        updatedAt: now,
    };
}

export async function getFlightStatus(
    _ctx: ServerContext,
    req: GetFlightStatusRequest,
): Promise<GetFlightStatusResponse> {
    // Normalize: strip leading zeros from numeric suffix (EK03 → EK3, BA002 → BA2)
    const flightNumber = (req.flightNumber?.toUpperCase().replace(/\s/g, '') || '')
        .replace(/^([A-Z]{2,3})0+(\d+)$/, '$1$2');
    const date = req.date || new Date().toISOString().slice(0, 10);
    const origin = req.origin?.toUpperCase() || '';
    const cacheKey = `aviation:status:${flightNumber}:${date}:${origin}:v1`;
    const now = Date.now();

    if (!flightNumber || flightNumber.length > 10) {
        return { flights: [], source: 'error', cacheHit: false };
    }

    try {
        const result = await cachedFetchJson<{ flights: FlightInstance[]; source: string }>(
            cacheKey, CACHE_TTL, async () => {
                const relayBase = getRelayBaseUrl();
                if (!relayBase) {
                    return { flights: [], source: 'no-relay' };
                }

                const params = new URLSearchParams({
                    flight_iata: flightNumber,
                    flight_date: date,
                    limit: '5',
                });
                if (origin) params.set('dep_iata', origin);

                const resp = await fetch(`${relayBase}/aviationstack?${params}`, {
                    headers: getRelayHeaders(),
                    signal: AbortSignal.timeout(15_000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json() as { data?: AVSFlight[]; error?: { message?: string } };
                if (json.error) throw new Error(json.error.message);

                const flights = (json.data ?? []).map(f => normalizeFlight(f, now));
                return { flights, source: 'aviationstack' };
            }
        );

        return {
            flights: result?.flights ?? [],
            source: result?.source ?? 'unknown',
            cacheHit: false,
        };
    } catch (err) {
        console.warn(`[Aviation] GetFlightStatus failed for ${flightNumber}: ${err instanceof Error ? err.message : err}`);
        return { flights: [], source: 'error', cacheHit: false };
    }
}
