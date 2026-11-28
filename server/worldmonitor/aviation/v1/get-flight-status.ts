import type {
    ServerContext,
    GetFlightStatusRequest,
    GetFlightStatusResponse,
    FlightInstance,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { getRelayBaseUrl, getRelayHeaders, IATA_RE, requireLiveAviationAccess } from './_shared';
import { aviationStackBudgetCycle, reserveAviationStackCalls } from './_avstack-budget';
import { normalizeFlights, type AVSFlight } from './list-airport-flights';

const CACHE_TTL = 120; // 2 minutes

export async function getFlightStatus(
    ctx: ServerContext,
    req: GetFlightStatusRequest,
): Promise<GetFlightStatusResponse> {
    // Normalize: strip leading zeros from numeric suffix (EK03 → EK3, BA002 → BA2)
    // Metered route — gate before anything else. See requireLiveAviationAccess.
    await requireLiveAviationAccess(ctx.request);

    const flightNumber = (req.flightNumber?.toUpperCase().replace(/\s/g, '') || '')
        .replace(/^([A-Z]{2,3})0+(\d+)$/, '$1$2');
    const date = req.date || new Date().toISOString().slice(0, 10);
    const origin = req.origin?.toUpperCase() || '';
    const now = Date.now();

    if (!flightNumber || flightNumber.length > 10) {
        markNoCacheResponse(ctx.request);
        return { flights: [], source: 'error', cacheHit: false };
    }

    // Reject malformed filters before cache reads or provider budget reservation.
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if ((origin && !IATA_RE.test(origin)) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        markNoCacheResponse(ctx.request);
        return { flights: [], source: 'invalid', cacheHit: false };
    }
    const cacheKey = `aviation:status:${flightNumber}:${date}:${origin}:v1:${aviationStackBudgetCycle()}`;

    let unavailableSource = 'unavailable';

    try {
        const result = await cachedFetchJsonWithMeta<{ flights: FlightInstance[]; source: 'aviationstack' }>(
            cacheKey, CACHE_TTL, async () => {
                const relayBase = getRelayBaseUrl();
                if (!relayBase) {
                    unavailableSource = 'no-relay';
                    return null;
                }

                // Monthly quota guard: once the request-time budget is spent,
                // negative-cache the unavailable state rather than storing an
                // empty positive flight-status result.
                if (!(await reserveAviationStackCalls(1, 'request'))) {
                    unavailableSource = 'budget';
                    return null;
                }

                const params = new URLSearchParams({
                    flight_iata: flightNumber,
                    flight_date: date,
                    limit: '5',
                });
                if (origin) params.set('dep_iata', origin);

                try {
                    const resp = await fetch(`${relayBase}/aviationstack?${params}`, {
                        headers: getRelayHeaders(),
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const json = await resp.json() as { data?: AVSFlight[]; error?: { message?: string } };
                    if (json.error) throw new Error(json.error.message);

                    // A row per marketing number; codeshares fold into their operating flight.
                    const flights = normalizeFlights(json.data ?? [], now);
                    return { flights, source: 'aviationstack' };
                } catch (err) {
                    console.warn(`[Aviation] Flight status relay fetch failed for ${flightNumber}: ${err instanceof Error ? err.message : err}`);
                    unavailableSource = 'error';
                    return null;
                }
            }
        );

        if (!result.data) {
            markNoCacheResponse(ctx.request);
            return {
                flights: [],
                source: unavailableSource,
                cacheHit: result.source === 'cache',
            };
        }

        return {
            flights: result.data.flights,
            source: result.data.source,
            cacheHit: result.source === 'cache',
        };
    } catch (err) {
        console.warn(`[Aviation] GetFlightStatus failed for ${flightNumber}: ${err instanceof Error ? err.message : err}`);
        markNoCacheResponse(ctx.request);
        return { flights: [], source: 'error', cacheHit: false };
    }
}
