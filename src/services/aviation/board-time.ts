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
 * to null when neither is known.
 *
 * Lives outside AirlineIntelPanel so it is reachable from a test: the panel
 * module pulls in i18n, whose `import.meta.glob` only resolves under Vite.
 */
export function flightBoardTime(f: FlightInstance, airport: string): Date | null {
    if (airport && f.destination.iata === airport) return f.scheduledArrival ?? f.scheduledDeparture;
    return f.scheduledDeparture ?? f.scheduledArrival;
}
