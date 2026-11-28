import type { FlightInstance } from './index';

/**
 * When a row of an airport flights board touches `airport`.
 *
 * The board mixes departures and arrivals, and the server orders it by this
 * same notion of time (see `boardTime` in
 * server/worldmonitor/aviation/v1/list-airport-flights.ts — keep the two in
 * step). Showing an arrival's departure time instead — it left somewhere else,
 * hours earlier — makes the list read as though it were sorted wrong.
 *
 * Falls back to the other end of the leg when the relevant time is missing, and
 * to null when neither is known. The time zone is that of the airport where
 * the returned time happens.
 *
 * Lives outside AirlineIntelPanel so it is reachable from a test: the panel
 * module pulls in i18n, whose `import.meta.glob` only resolves under Vite.
 */
export function flightBoardClock(f: FlightInstance, airport: string): { at: Date; timeZone: string } | null {
    const departure = f.scheduledDeparture && { at: f.scheduledDeparture, timeZone: f.origin.timezone };
    const arrival = f.scheduledArrival && { at: f.scheduledArrival, timeZone: f.destination.timezone };
    if (airport && f.destination.iata === airport) return arrival || departure || null;
    return departure || arrival || null;
}

/** `08:15 GMT+3`: the board time on the clock of the airport it happens at. */
export function formatFlightBoardTime(f: FlightInstance, airport: string): string {
    const clock = flightBoardClock(f, airport);
    if (!clock) return '—';
    return clock.at.toLocaleTimeString([], {
        timeZone: clock.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    });
}
