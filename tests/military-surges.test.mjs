import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeMilitaryTheaters, buildMilitarySurges, appendMilitaryHistory } from '../scripts/_military-surges.mjs';

const TEST_THEATERS = [
  {
    id: 'taiwan-theater',
    bounds: { north: 30, south: 18, east: 130, west: 115 },
    thresholds: { elevated: 6, critical: 15 },
    strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 },
  },
];

describe('military surge signals', () => {
  it('summarizes theater activity from raw military flights', () => {
    const flights = [
      { lat: 24, lon: 121, aircraftType: 'fighter', operator: 'plaaf', operatorCountry: 'China' },
      { lat: 24.5, lon: 121.5, aircraftType: 'fighter', operator: 'plaaf', operatorCountry: 'China' },
      { lat: 24.8, lon: 122, aircraftType: 'awacs', operator: 'plaaf', operatorCountry: 'China' },
      { lat: 25.1, lon: 122.4, aircraftType: 'tanker', operator: 'plaaf', operatorCountry: 'China' },
    ];

    const [summary] = summarizeMilitaryTheaters(flights, TEST_THEATERS, 1234);
    assert.equal(summary.theaterId, 'taiwan-theater');
    assert.equal(summary.totalFlights, 4);
    assert.equal(summary.fighters, 2);
    assert.equal(summary.awacs, 1);
    assert.equal(summary.tankers, 1);
    assert.equal(summary.byCountry.China, 4);
  });

  it('detects fighter surges against prior baseline history', () => {
    const history = appendMilitaryHistory([], {
      assessedAt: 1,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history2 = appendMilitaryHistory(history, {
      assessedAt: 2,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history3 = appendMilitaryHistory(history2, {
      assessedAt: 3,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history4 = appendMilitaryHistory(history3, {
      assessedAt: 4,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history5 = appendMilitaryHistory(history4, {
      assessedAt: 5,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history6 = appendMilitaryHistory(history5, {
      assessedAt: 6,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 1, transport: 1, totalFlights: 3 }],
    });
    const history7 = appendMilitaryHistory(history6, {
      assessedAt: 7,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 6, transport: 1, totalFlights: 8 }],
    });
    const history8 = appendMilitaryHistory(history7, {
      assessedAt: 8,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 6, transport: 1, totalFlights: 8 }],
    });
    const history9 = appendMilitaryHistory(history8, {
      assessedAt: 9,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 6, transport: 1, totalFlights: 8 }],
    });

    const surges = buildMilitarySurges([{
      theaterId: 'taiwan-theater',
      assessedAt: 10,
      totalFlights: 10,
      postureLevel: 'elevated',
      strikeCapable: true,
      fighters: 8,
      tankers: 1,
      awacs: 1,
      transport: 1,
      reconnaissance: 0,
      bombers: 0,
      drones: 0,
      byOperator: { plaaf: 8 },
      byCountry: { China: 8 },
    }], history9);

    assert.ok(surges.some((surge) => surge.surgeType === 'fighter'));
    const fighter = surges.find((surge) => surge.surgeType === 'fighter');
    assert.equal(fighter.theaterId, 'taiwan-theater');
    assert.equal(fighter.dominantCountry, 'China');
    assert.ok(fighter.surgeMultiple >= 2);
    assert.ok(fighter.persistent);
    assert.ok(fighter.persistenceCount >= 1);
  });

  it('requires recent snapshots to clear the same surge thresholds before marking persistence', () => {
    const history = appendMilitaryHistory([], {
      assessedAt: 1,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 3, transport: 1, totalFlights: 5 }],
    });
    const history2 = appendMilitaryHistory(history, {
      assessedAt: 2,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 3, transport: 1, totalFlights: 5 }],
    });
    const history3 = appendMilitaryHistory(history2, {
      assessedAt: 3,
      theaters: [{ theaterId: 'taiwan-theater', fighters: 3, transport: 1, totalFlights: 5 }],
    });

    const surges = buildMilitarySurges([{
      theaterId: 'taiwan-theater',
      assessedAt: 4,
      totalFlights: 10,
      postureLevel: 'elevated',
      strikeCapable: true,
      fighters: 8,
      tankers: 1,
      awacs: 1,
      transport: 1,
      reconnaissance: 0,
      bombers: 0,
      drones: 0,
      byOperator: { plaaf: 8 },
      byCountry: { China: 8 },
    }], history3);

    const fighter = surges.find((surge) => surge.surgeType === 'fighter');
    assert.ok(fighter);
    assert.equal(fighter.persistent, false);
    assert.equal(fighter.persistenceCount, 0);
  });

  it('does not build a baseline from a different source family', () => {
    const history = appendMilitaryHistory([], {
      assessedAt: 1,
      sourceVersion: 'opensky-auth',
      theaters: [{ theaterId: 'taiwan-theater', fighters: 2, transport: 1, totalFlights: 4 }],
    });
    const history2 = appendMilitaryHistory(history, {
      assessedAt: 2,
      sourceVersion: 'opensky-anon',
      theaters: [{ theaterId: 'taiwan-theater', fighters: 2, transport: 1, totalFlights: 5 }],
    });
    const history3 = appendMilitaryHistory(history2, {
      assessedAt: 3,
      sourceVersion: 'opensky-auth',
      theaters: [{ theaterId: 'taiwan-theater', fighters: 2, transport: 1, totalFlights: 4 }],
    });

    const surges = buildMilitarySurges([{
      theaterId: 'taiwan-theater',
      assessedAt: 4,
      totalFlights: 10,
      postureLevel: 'elevated',
      strikeCapable: true,
      fighters: 8,
      tankers: 1,
      awacs: 1,
      transport: 1,
      reconnaissance: 0,
      bombers: 0,
      drones: 0,
      byOperator: { plaaf: 8 },
      byCountry: { China: 8 },
    }], history3, { sourceVersion: 'wingbits' });

    assert.equal(surges.length, 0);
  });
});
