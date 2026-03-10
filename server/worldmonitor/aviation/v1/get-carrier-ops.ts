import type {
    ServerContext,
    GetCarrierOpsRequest,
    GetCarrierOpsResponse,
    CarrierOpsSummary,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { parseStringArray, DEFAULT_WATCHED_AIRPORTS } from './_shared';
import { listAirportFlights } from './list-airport-flights';

const CACHE_TTL = 300;

export async function getCarrierOps(
    ctx: ServerContext,
    req: GetCarrierOpsRequest,
): Promise<GetCarrierOpsResponse> {
    const rawAirports = parseStringArray(req.airports);
    const airports = rawAirports.length > 0 ? rawAirports.map(a => a.toUpperCase()) : DEFAULT_WATCHED_AIRPORTS.slice(0, 3);
    const minFlights = req.minFlights ?? 3;
    const cacheKey = `aviation:carrier-ops:${airports.sort().join(',')}:v1`;
    const now = Date.now();

    try {
        const result = await cachedFetchJson<{ carriers: CarrierOpsSummary[] }>(
            cacheKey, CACHE_TTL, async () => {
                // Fetch flights for each airport
                type FI = import('../../../../src/generated/server/worldmonitor/aviation/v1/service_server').FlightInstance;
                const allFlights: FI[] = [];
                const flightAirportMap = new Map<FI, string>();

                const flightPromises = airports.map(airport =>
                    listAirportFlights(ctx, {
                        airport,
                        direction: 'FLIGHT_DIRECTION_DEPARTURE',
                        limit: 50,
                    }).then(resp => ({
                        airport,
                        flights: resp.flights,
                    })),
                );

                const flightResults = await Promise.allSettled(flightPromises);

                for (const result of flightResults) {
                    if (result.status !== 'fulfilled') continue;
                    const { airport, flights } = result.value;
                    for (const f of flights) {
                        allFlights.push(f);
                        flightAirportMap.set(f, airport);
                    }
                }

                // Group by carrier.iataCode + airport
                const groups = new Map<string, {
                    carrier: import('../../../../src/generated/server/worldmonitor/aviation/v1/service_server').Carrier;
                    airport: string;
                    flights: FI[];
                }>();

                for (const f of allFlights) {
                    const airport = flightAirportMap.get(f) ?? f.origin?.iata ?? '';
                    const iata = f.operatingCarrier?.iataCode ?? 'UNK';
                    const key = `${iata}|${airport}`;
                    if (!groups.has(key)) {
                        groups.set(key, { carrier: f.operatingCarrier ?? { iataCode: iata, icaoCode: '', name: iata }, airport, flights: [] });
                    }
                    groups.get(key)!.flights.push(f);
                }

                const carriers: CarrierOpsSummary[] = [];
                for (const [, { carrier, airport, flights }] of groups) {
                    const delayed = flights.filter(f => f.delayMinutes > 0);
                    const cancelled = flights.filter(f => f.cancelled);
                    const totalDelay = delayed.reduce((s, f) => s + f.delayMinutes, 0);

                    carriers.push({
                        carrier,
                        airport,
                        totalFlights: flights.length,
                        delayedCount: delayed.length,
                        cancelledCount: cancelled.length,
                        avgDelayMinutes: delayed.length > 0 ? Math.round(totalDelay / delayed.length) : 0,
                        delayPct: Math.round((delayed.length / flights.length) * 100 * 10) / 10,
                        cancellationRate: Math.round((cancelled.length / flights.length) * 100 * 10) / 10,
                        updatedAt: now,
                    });
                }

                // Sort by worst cancellation rate then delay pct
                carriers.sort((a, b) => b.cancellationRate - a.cancellationRate || b.delayPct - a.delayPct);

                return { carriers };
            }
        );

        return {
            carriers: (result?.carriers ?? []).filter(c => c.totalFlights >= minFlights),
            source: 'aviationstack',
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] GetCarrierOps failed: ${err instanceof Error ? err.message : err}`);
        return { carriers: [], source: 'error', updatedAt: now };
    }
}
