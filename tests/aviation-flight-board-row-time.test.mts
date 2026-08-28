// The flights board mixes departures and arrivals — it always did per the
// proto, though list-airport-flights only started actually fetching arrivals
// once `direction=both` stopped falling through to the departures branch. The
// server orders that mixed board by when each flight touches the queried
// airport, so the row must display the same time; showing an arrival's
// departure time (from another airport, hours earlier) makes the list read as
// though it were sorted wrong.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flightBoardTime } from '../src/services/aviation/board-time.ts';
import type { FlightInstance } from '../src/services/aviation/index.ts';

const DEP = new Date('2026-08-27T10:00:00Z');
const ARR = new Date('2026-08-27T18:00:00Z');

function flight(from: string, to: string, dep: Date | null = DEP, arr: Date | null = ARR): FlightInstance {
  return {
    flightNumber: 'TK1', date: '2026-08-27',
    carrier: { iata: 'TK', name: 'Turkish' },
    origin: { iata: from, name: from }, destination: { iata: to, name: to },
    scheduledDeparture: dep, scheduledArrival: arr,
    estimatedDeparture: dep, estimatedArrival: arr,
    status: 'scheduled', delayMinutes: 0, cancelled: false, diverted: false,
    gate: '', terminal: '', aircraftType: '', source: 'aviationstack',
  };
}

describe('flights board row time', () => {
  it('shows the arrival time for a flight landing at the board airport', () => {
    assert.equal(flightBoardTime(flight('LHR', 'IST'), 'IST'), ARR);
  });

  it('shows the departure time for a flight leaving the board airport', () => {
    assert.equal(flightBoardTime(flight('IST', 'JFK'), 'IST'), DEP);
  });

  it('falls back to the other end of the leg when the relevant time is missing', () => {
    assert.equal(flightBoardTime(flight('LHR', 'IST', DEP, null), 'IST'), DEP);
    assert.equal(flightBoardTime(flight('IST', 'JFK', null, ARR), 'IST'), ARR);
  });

  it('returns null when neither end is known, so the row renders an em dash', () => {
    assert.equal(flightBoardTime(flight('LHR', 'IST', null, null), 'IST'), null);
  });

  it('treats every row as a departure before the board airport is known', () => {
    // flightsAirport is empty until the first load resolves; without the guard
    // an empty string would match no destination anyway, but pinning it keeps
    // the pre-load render from depending on that coincidence.
    assert.equal(flightBoardTime(flight('LHR', 'IST'), ''), DEP);
  });
});
