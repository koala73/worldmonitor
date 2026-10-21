import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildAdsbSourceMeta,
  convertToStates,
  fetchAdsbFiPoint,
  fetchGapFillStates,
  filterMilitaryFlights,
  parseAircraftResponse,
} from '../scripts/seed-military-flights.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ADSBExchange-compatible military provider normalization', () => {
  it('requires the documented ac array instead of silently treating schema drift as empty', () => {
    assert.throws(
      () => parseAircraftResponse({ aircraft: [] }, 'adsb.fi'),
      /unexpected response shape.*expected ac array/,
    );
  });

  it('parses adsb.fi v3 from ac', async () => {
    globalThis.fetch = async () => Response.json({
      now: 1_700_000_000_000,
      ac: [{ hex: '123456', lat: 25, lon: 55 }],
    });

    const parsed = await fetchAdsbFiPoint(25, 55, 250);
    assert.equal(parsed.aircraft.length, 1);
    assert.equal(parsed.aircraft[0].hex, '123456');
    assert.equal(parsed.responseNowMs, 1_700_000_000_000);
  });

  it('derives observation timestamps from response now plus seen ages and emits booleans', () => {
    const states = [];
    const added = convertToStates([{
      hex: '123456',
      flight: '',
      lat: 25,
      lon: 55,
      alt_baro: 'ground',
      seen: 2.5,
      seen_pos: 4,
      dbFlags: 1,
    }], 'adsb.fi', new Set(), states, 1_700_000_000_000);

    assert.equal(added, 1);
    assert.equal(states[0][3], 1_699_999_996);
    assert.equal(states[0][4], 1_699_999_997.5);
    assert.equal(states[0][8], true);
  });

  it('admits dbFlags military rows even without a callsign or known military hex range', () => {
    const states = [];
    convertToStates([{
      hex: '123456',
      flight: '',
      lat: 25,
      lon: 55,
      alt_baro: 20_000,
      seen: 1,
      dbFlags: 1,
      t: 'C17',
      desc: 'C-17 Globemaster military transport',
    }], 'adsb.fi', new Set(), states, 1_700_000_000_000);

    const { flights, audit } = filterMilitaryFlights(states);
    assert.equal(flights.length, 1);
    assert.equal(flights[0].admissionReason, 'authoritative_military_source');
    assert.equal(flights[0].aircraftType, 'transport');
    assert.equal(flights[0].sourceMeta.source, 'adsb.fi');
    assert.equal(audit.sourceCoverage.authoritativeMilitary, 1);
  });

  it('treats adsb.lol /v2/mil itself as authoritative when dbFlags is absent', () => {
    const meta = buildAdsbSourceMeta({ hex: '123456' }, 'adsb.lol');
    assert.equal(meta.authoritativeMilitary, true);
  });

  it('paces optional point queries at one second and stops at the total budget', async () => {
    const callTimes = [];
    let clock = 0;
    globalThis.fetch = async () => {
      callTimes.push(clock);
      return Response.json({ now: 1_700_000_000_000, ac: [] });
    };

    await fetchGapFillStates(new Set(), [], {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      requestTimeoutMs: 500,
      staggerMs: 1_000,
      totalBudgetMs: 2_500,
    });

    assert.deepEqual(callTimes, [0, 1_000, 2_000]);
    assert.equal(clock, 2_500, 'the optional provider loop exceeded its configured wall-clock budget');
  });
});
