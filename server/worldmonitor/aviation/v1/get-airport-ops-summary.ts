import type {
    ServerContext,
    GetAirportOpsSummaryRequest,
    GetAirportOpsSummaryResponse,
    AirportOpsSummary,
    AirportDelayAlert,
    FlightDelaySeverity,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { MONITORED_AIRPORTS } from '../../../../src/config/airports';
import { getCachedJson } from '../../../_shared/redis';
import {
    determineSeverity,
    severityFromCancelRate,
    parseStringArray,
    DEFAULT_WATCHED_AIRPORTS,
    loadNotamClosures,
} from './_shared';

const SEED_CACHE_KEY = 'aviation:delays:intl:v3';

export async function getAirportOpsSummary(
    _ctx: ServerContext,
    req: GetAirportOpsSummaryRequest,
): Promise<GetAirportOpsSummaryResponse> {
    const rawAirports = parseStringArray(req.airports);
    const requested = rawAirports.length > 0
        ? rawAirports.map(a => a.toUpperCase())
        : DEFAULT_WATCHED_AIRPORTS;

    const now = Date.now();

    try {
        const airports = MONITORED_AIRPORTS.filter(a => requested.includes(a.iata));
        const summaries: AirportOpsSummary[] = [];

        // Read delay alerts from relay seed cache (no direct AviationStack call)
        let alerts: AirportDelayAlert[] = [];
        let healthy = false;
        try {
            const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { alerts?: AirportDelayAlert[] } | null;
            if (seedData?.alerts) {
                alerts = seedData.alerts;
                healthy = true;
            }
        } catch { /* graceful degradation */ }

        // Fetch NOTAM closures via shared loader
        let notamClosedIcaos = new Set<string>();
        let notamRestrictedIcaos = new Set<string>();
        let notamReasons: Record<string, string> = {};
        try {
            const notamResult = await loadNotamClosures();
            if (notamResult) {
                notamClosedIcaos = new Set(notamResult.closedIcaos);
                notamRestrictedIcaos = new Set(notamResult.restrictedIcaos ?? []);
                notamReasons = notamResult.reasons;
            }
        } catch { /* graceful degradation */ }

        for (const airport of airports) {
            const alert = alerts.find(a => a.iata === airport.iata);
            const isClosed = notamClosedIcaos.has(airport.icao);
            const isRestricted = notamRestrictedIcaos.has(airport.icao);
            const notamText = notamReasons[airport.icao];

            const delayPct = alert?.delayedFlightsPct ?? 0;
            const avgDelay = alert?.avgDelayMinutes ?? 0;
            const cancelledFlights = alert?.cancelledFlights ?? 0;
            const totalFlights = alert?.totalFlights ?? 0;
            const cancelRate = totalFlights > 0 ? (cancelledFlights / totalFlights) * 100 : 0;

            const cancelSev = severityFromCancelRate(cancelRate);
            const delaySev = determineSeverity(avgDelay, delayPct);
            const notamFloor = isClosed
                ? (totalFlights === 0 ? 'severe' : 'moderate')
                : isRestricted ? 'minor' : 'normal';
            const sevOrder = ['normal', 'minor', 'moderate', 'major', 'severe'];
            const sevStr = sevOrder[Math.max(
                sevOrder.indexOf(cancelSev),
                sevOrder.indexOf(delaySev),
                sevOrder.indexOf(notamFloor),
            )] ?? 'normal';
            const severity = `FLIGHT_DELAY_SEVERITY_${sevStr.toUpperCase()}` as FlightDelaySeverity;

            const notamFlags: string[] = [];
            if (isClosed) notamFlags.push('CLOSED');
            if (isRestricted) notamFlags.push('RESTRICTED');
            if (notamText) notamFlags.push('NOTAM');

            const topDelayReasons: string[] = [];
            if (alert?.reason) topDelayReasons.push(alert.reason);
            if ((isClosed || isRestricted) && notamText) topDelayReasons.push(notamText.slice(0, 80));

            summaries.push({
                iata: airport.iata,
                icao: airport.icao,
                name: airport.name,
                timezone: 'UTC',
                delayPct,
                avgDelayMinutes: avgDelay,
                cancellationRate: Math.round(cancelRate * 10) / 10,
                totalFlights,
                closureStatus: isClosed,
                notamFlags,
                severity,
                topDelayReasons,
                source: healthy ? 'aviationstack' : 'degraded',
                updatedAt: now,
            });
        }

        // Add requested airports not found in MONITORED_AIRPORTS
        for (const iata of requested) {
            if (!summaries.find(s => s.iata === iata)) {
                summaries.push({
                    iata,
                    icao: '',
                    name: iata,
                    timezone: 'UTC',
                    delayPct: 0,
                    avgDelayMinutes: 0,
                    cancellationRate: 0,
                    totalFlights: 0,
                    closureStatus: false,
                    notamFlags: [],
                    severity: 'FLIGHT_DELAY_SEVERITY_NORMAL',
                    topDelayReasons: [],
                    source: 'unknown',
                    updatedAt: now,
                });
            }
        }

        return { summaries, cacheHit: false };
    } catch (err) {
        console.warn(`[Aviation] GetAirportOpsSummary failed: ${err instanceof Error ? err.message : err}`);
        return { summaries: [], cacheHit: false };
    }
}
