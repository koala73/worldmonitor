import type {
    ServerContext,
    GetCarrierOpsRequest,
    GetCarrierOpsResponse,
    CarrierOpsSummary,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
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
    let unavailableSource = 'unavailable';

    try {
        const result = await cachedFetchJson<{ carriers: CarrierOpsSummary[]; source: 'aviationstack' }>(
            cacheKey, CACHE_TTL, async () => {
                // Fetch flights for each airport
                type FI = import('../../../../src/generated/server/worldmonitor/aviation/v1/service_server').FlightInstance;
                const allFlights: FI[] = [];
                const flightAirportMap = new Map<FI, string>();
                const childUnavailableSources = new Set<string>();
                let successfulChildren = 0;

                const flightPromises = airports.map(airport =>
                    listAirportFlights(ctx, {
                        airport,
                        direction: 'FLIGHT_DIRECTION_DEPARTURE',
                        limit: 50,
                    }).then(resp => ({
                        airport,
                        flights: resp.flights,
                        source: resp.source,
                    })),
                );

                const flightResults = await Promise.allSettled(flightPromises);

                for (const child of flightResults) {
                    if (child.status !== 'fulfilled') {
                        childUnavailableSources.add('error');
                        continue;
                    }
                    const { airport, flights, source } = child.value;
                    if (source !== 'aviationstack') {
                        childUnavailableSources.add(source || 'unavailable');
                        continue;
                    }
                    successfulChildren++;
                    for (const f of flights) {
                        allFlights.push(f);
                        flightAirportMap.set(f, airport);
                    }
                }

                if (childUnavailableSources.size > 0) {
                    unavailableSource = successfulChildren > 0
                        ? 'partial'
                        : [...childUnavailableSources][0] ?? 'unavailable';
                    return null;
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

                return { carriers, source: 'aviationstack' };
            }
        );

        if (!result) {
            markNoCacheResponse(ctx.request);
            return {
                carriers: [],
                source: unavailableSource,
                updatedAt: now,
            };
        }

        return {
            carriers: result.carriers.filter(c => c.totalFlights >= minFlights),
            source: result.source,
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] GetCarrierOps failed: ${err instanceof Error ? err.message : err}`);
        markNoCacheResponse(ctx.request);
        return { carriers: [], source: 'error', updatedAt: now };
    }
}
