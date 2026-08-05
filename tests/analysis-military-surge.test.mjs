import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MilitarySurgeEngine,
  POSTURE_THEATERS,
  SENSITIVE_REGIONS,
  THEATERS,
  classifyFlight,
  distanceKm,
  findNearbyBases,
  foreignPresenceToSignal,
  getCriticalPostures,
  getRegionForPosition,
  getTheaterForFlight,
  getTheaterPostureSummaries,
  isTransportFlight,
  recalcPostureWithVessels,
  surgeAlertToSignal,
} from '../shared/analysis-military-surge.ts';
import { MILITARY_BASES_EXPANDED } from '../shared/military-bases-data.ts';

const HOUR_MS = 60 * 60 * 1000;

// Al Udeid (Qatar) — a `middle-east` theater base, so flights parked on it
// resolve their theater through the proximity lookup rather than the 1500km
// center fallback.
const AL_UDEID = { lat: 25.2793, lon: 51.5224 };
// Region centers, straight out of SENSITIVE_REGIONS.
const PERSIAN_GULF = { lat: 26.5, lon: 52.0 };
const BALTICS = { lat: 56.0, lon: 24.0 };
const BLACK_SEA = { lat: 43.5, lon: 34.0 };

let flightSeq = 0;

function flight(overrides = {}) {
  flightSeq += 1;
  return {
    id: `flight-${flightSeq}`,
    callsign: `TEST${flightSeq}`,
    aircraftType: 'unknown',
    operator: 'usaf',
    lat: 0,
    lon: 0,
    ...overrides,
  };
}

function flightsAt(count, position, overrides = {}) {
  return Array.from({ length: count }, () => flight({ ...position, ...overrides }));
}

/** Engine bound to a mutable clock so every window/dedup assertion is deterministic. */
function makeEngine(options = {}, startMs = 1_700_000_000_000) {
  const clock = { now: startMs };
  const engine = new MilitarySurgeEngine({ now: () => clock.now, ...options });
  return { engine, clock };
}

describe('military base data move', () => {
  it('carries the full expanded base table', () => {
    assert.equal(MILITARY_BASES_EXPANDED.length, 210);
    const alUdeid = MILITARY_BASES_EXPANDED.find((base) => base.id === 'al_udeid');
    assert.deepEqual(alUdeid, {
      id: 'al_udeid',
      name: 'Al Udeid',
      lat: 25.2793,
      lon: 51.5224,
      type: 'us-nato',
      country: 'Quatar',
      arm: 'Air Force',
      status: 'active',
      description: 'Air Force. Host: Quatar.',
    });
  });
});

describe('flight classification', () => {
  it('treats transports and tankers as airlift regardless of callsign', () => {
    assert.equal(isTransportFlight(flight({ aircraftType: 'transport' })), true);
    assert.equal(isTransportFlight(flight({ aircraftType: 'tanker' })), true);
    assert.equal(classifyFlight(flight({ aircraftType: 'transport' })), 'transport');
    assert.equal(classifyFlight(flight({ aircraftType: 'tanker' })), 'transport');
  });

  it('reclassifies any airframe flying an airlift callsign', () => {
    assert.equal(classifyFlight(flight({ aircraftType: 'fighter', callsign: 'RCH412' })), 'transport');
    assert.equal(classifyFlight(flight({ aircraftType: 'fighter', callsign: 'rch412' })), 'transport');
    assert.equal(classifyFlight(flight({ aircraftType: 'fighter', callsign: 'MOOSE91' })), 'transport');
    assert.equal(classifyFlight(flight({ aircraftType: 'fighter', callsign: 'DUSTOFF7' })), 'transport');
    assert.equal(classifyFlight(flight({ aircraftType: 'fighter', callsign: 'VIPER11' })), 'fighter');
  });

  it('folds AWACS into the recon bucket and leaves everything else other', () => {
    assert.equal(classifyFlight(flight({ aircraftType: 'reconnaissance' })), 'recon');
    assert.equal(classifyFlight(flight({ aircraftType: 'awacs' })), 'recon');
    assert.equal(classifyFlight(flight({ aircraftType: 'bomber' })), 'other');
    assert.equal(classifyFlight(flight({ aircraftType: 'unknown' })), 'other');
  });
});

describe('geography helpers', () => {
  it('measures great-circle distance in kilometres', () => {
    assert.equal(Math.round(distanceKm(0, 0, 0, 1)), 111);
    assert.equal(distanceKm(10, 20, 10, 20), 0);
  });

  it('returns bases inside the proximity radius, nearest first', () => {
    const nearby = findNearbyBases(AL_UDEID.lat, AL_UDEID.lon);
    assert.ok(nearby.length > 0);
    assert.equal(nearby[0].baseId, 'al_udeid');
    assert.equal(nearby[0].distance, 0);
    for (const base of nearby) assert.ok(base.distance <= 150);
    const distances = nearby.map((base) => base.distance);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  it('resolves a theater by nearby base, then by center proximity, then gives up', () => {
    assert.equal(getTheaterForFlight(flight(AL_UDEID))?.id, 'middle-east');
    // Central Iraq: no base within 150km, but inside the theater center's 1500km ring.
    assert.equal(findNearbyBases(30, 44).length, 0);
    assert.equal(getTheaterForFlight(flight({ lat: 30, lon: 44 }))?.id, 'middle-east');
    assert.equal(getTheaterForFlight(flight({ lat: -45, lon: -30 })), null);
  });

  it('maps positions onto the first matching sensitive region', () => {
    assert.equal(getRegionForPosition(PERSIAN_GULF.lat, PERSIAN_GULF.lon)?.id, 'persian-gulf');
    assert.equal(getRegionForPosition(BALTICS.lat, BALTICS.lon)?.id, 'baltics');
    assert.equal(getRegionForPosition(-45, -30), null);
  });

  it('publishes the theater and region tables', () => {
    assert.equal(THEATERS.length, 5);
    assert.equal(SENSITIVE_REGIONS.length, 18);
    assert.equal(POSTURE_THEATERS.length, 9);
  });
});

describe('surge detection against regional baselines', () => {
  it('raises an airlift surge once transports clear both the multiple and the floor', () => {
    const { engine } = makeEngine();
    // Cold start: fewer than 6 samples means the seeded baseline of 3 transports.
    assert.deepEqual(engine.analyzeFlightsForSurge(flightsAt(5, AL_UDEID, { aircraftType: 'transport' })), []);

    const { engine: hot } = makeEngine();
    const alerts = hot.analyzeFlightsForSurge(flightsAt(6, AL_UDEID, { aircraftType: 'transport' }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].id, 'airlift-middle-east');
    assert.equal(alerts[0].type, 'airlift');
    assert.equal(alerts[0].theater.id, 'middle-east');
    assert.equal(alerts[0].currentCount, 6);
    assert.equal(alerts[0].baselineCount, 3);
    assert.equal(alerts[0].surgeMultiple, 2);
    assert.ok(alerts[0].nearbyBases.includes('Al Udeid'));
    assert.equal(alerts[0].aircraftTypes.get('transport'), 6);
  });

  it('updates rather than re-emits a surge that is already active', () => {
    const { engine, clock } = makeEngine();
    assert.equal(engine.analyzeFlightsForSurge(flightsAt(6, AL_UDEID, { aircraftType: 'transport' })).length, 1);
    clock.now += 10 * 60 * 1000;
    assert.deepEqual(engine.analyzeFlightsForSurge(flightsAt(7, AL_UDEID, { aircraftType: 'transport' })), []);
    const active = engine.getActiveSurges();
    assert.equal(active.length, 1);
    assert.equal(active[0].currentCount, 7);
  });

  it('learns the regional baseline from accumulated history', () => {
    const { engine, clock } = makeEngine();
    // Six quiet-but-busy samples: 4 transports never trips the >=5 floor...
    for (let tick = 0; tick < 6; tick += 1) {
      assert.deepEqual(engine.analyzeFlightsForSurge(flightsAt(4, AL_UDEID, { aircraftType: 'transport' })), []);
      clock.now += 10 * 60 * 1000;
    }
    // ...but it lifts the baseline to ~4.3, so 6 transports is no longer a surge —
    // the exact count that alerts on a cold engine.
    assert.deepEqual(engine.analyzeFlightsForSurge(flightsAt(6, AL_UDEID, { aircraftType: 'transport' })), []);

    const history = engine.getTheaterActivity('middle-east');
    assert.equal(history.length, 7);
    assert.equal(history[6].transportCount, 6);
    assert.equal(history[6].totalMilitary, 6);
  });

  it('raises a fighter surge and excludes airlift-callsign fighters from the count', () => {
    const { engine } = makeEngine();
    const alerts = engine.analyzeFlightsForSurge(flightsAt(4, AL_UDEID, { aircraftType: 'fighter' }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'fighter');
    assert.equal(alerts[0].currentCount, 4);
    assert.equal(alerts[0].baselineCount, 2);

    const { engine: masked } = makeEngine();
    const mixed = [
      ...flightsAt(3, AL_UDEID, { aircraftType: 'fighter' }),
      flight({ ...AL_UDEID, aircraftType: 'fighter', callsign: 'RCH999' }),
    ];
    assert.deepEqual(masked.analyzeFlightsForSurge(mixed), []);
    assert.equal(masked.getTheaterActivity('middle-east')[0].fighterCount, 3);
    assert.equal(masked.getTheaterActivity('middle-east')[0].transportCount, 1);
  });

  it('ignores flights that fall outside every theater', () => {
    const { engine } = makeEngine();
    assert.deepEqual(engine.analyzeFlightsForSurge(flightsAt(9, { lat: -45, lon: -30 }, { aircraftType: 'transport' })), []);
    assert.deepEqual(engine.getActiveSurges(), []);
  });

  it('renders a surge alert as a signal', () => {
    const { engine } = makeEngine();
    const [alert] = engine.analyzeFlightsForSurge(flightsAt(12, AL_UDEID, { aircraftType: 'transport' }));
    const signal = surgeAlertToSignal(alert);
    assert.equal(signal.type, 'military_surge');
    assert.equal(signal.severity, 'critical');
    assert.equal(signal.category, 'military');
    assert.equal(signal.title, '🛫 Military Airlift Surge - Middle East / Persian Gulf');
    assert.match(signal.description, /^12 airlift aircraft detected \(4\.0x baseline\)\./);
    assert.deepEqual(signal.location, { lat: 27.0, lon: 50.0, name: 'Middle East / Persian Gulf' });
    assert.equal(signal.metadata.theaterId, 'middle-east');
    assert.deepEqual(signal.metadata.aircraftTypes, { transport: 12 });
  });
});

describe('foreign military presence', () => {
  it('alerts when an operator concentrates outside its home regions', () => {
    const { engine } = makeEngine();
    assert.deepEqual(engine.detectForeignMilitaryPresence(flightsAt(1, PERSIAN_GULF, { operator: 'vks' })), []);

    const { engine: hot } = makeEngine();
    const alerts = hot.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'vks' }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].id, 'vks-persian-gulf');
    assert.equal(alerts[0].operator, 'vks');
    assert.equal(alerts[0].operatorCountry, 'Russia');
    assert.equal(alerts[0].region.id, 'persian-gulf');
    assert.equal(alerts[0].aircraftCount, 2);
    assert.equal(hot.getActiveForeignPresence().length, 1);
  });

  it('stays quiet inside a home region and for operators it does not track', () => {
    const { engine } = makeEngine();
    assert.deepEqual(engine.detectForeignMilitaryPresence(flightsAt(6, BLACK_SEA, { operator: 'vks' })), []);
    assert.deepEqual(engine.detectForeignMilitaryPresence(flightsAt(6, PERSIAN_GULF, { operator: 'nato' })), []);
    assert.deepEqual(engine.getActiveForeignPresence(), []);
  });

  it('honours the per-operator alert threshold', () => {
    const { engine } = makeEngine();
    // RAF needs 3 airframes where VKS needs 2.
    assert.deepEqual(engine.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'raf' })), []);
    assert.equal(engine.detectForeignMilitaryPresence(flightsAt(3, PERSIAN_GULF, { operator: 'raf' })).length, 1);
  });

  it('deduplicates repeat detections inside the same two-hour bucket', () => {
    const { engine, clock } = makeEngine();
    assert.equal(engine.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'vks' })).length, 1);
    assert.deepEqual(engine.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'vks' })), []);
    clock.now += 2 * HOUR_MS;
    assert.equal(engine.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'vks' })).length, 1);
  });

  it('renders a presence alert as a signal without a news source', () => {
    const { engine } = makeEngine();
    const [alert] = engine.detectForeignMilitaryPresence(
      flightsAt(2, PERSIAN_GULF, { operator: 'vks', aircraftModel: 'Su-34' }),
    );
    const signal = engine.foreignPresenceToSignal(alert);
    assert.equal(signal.type, 'military_surge');
    assert.equal(signal.severity, 'medium');
    assert.ok(Math.abs(signal.confidence - 0.8) < 1e-9);
    assert.equal(signal.title, '🚨 Russia Military in Persian Gulf');
    assert.match(signal.description, /^2 Russia aircraft detected in Persian Gulf\. 2x Su-34\./);
    assert.deepEqual(signal.metadata.relevantCountries, ['RU', 'IR', 'SA']);
    assert.equal(signal.metadata.newsCorrelation, null);
    assert.equal(signal.metadata.focalPointContext, null);
  });

  it('escalates known critical operator/region pairs', () => {
    const { engine } = makeEngine();
    const [alert] = engine.detectForeignMilitaryPresence(flightsAt(2, BALTICS, { operator: 'vks' }));
    assert.equal(foreignPresenceToSignal(alert).severity, 'critical');
  });

  it('folds injected news correlation into the signal metadata', () => {
    const seen = [];
    const newsContext = {
      getCorrelation(codes) {
        seen.push(codes);
        return 'Iran: "Strait closure warning..."';
      },
      getFocalPoint(iso) {
        return iso === 'IR' ? { displayName: 'Iran', newsMentions: 5, urgency: 'critical' } : null;
      },
    };
    const { engine } = makeEngine({ newsContext });
    const [alert] = engine.detectForeignMilitaryPresence(flightsAt(2, PERSIAN_GULF, { operator: 'vks' }));
    const signal = engine.foreignPresenceToSignal(alert);
    assert.deepEqual(seen, [['RU', 'IR', 'SA']]);
    assert.equal(signal.metadata.newsCorrelation, 'Iran: "Strait closure warning..."');
    assert.deepEqual(signal.metadata.focalPointContext, ['Iran: 5 news mentions (critical)']);
  });
});

describe('theater posture summaries', () => {
  // lat 26 keeps the package inside taiwan-theater only; at lat 24 the
  // south-china-sea theater (north: 25, east: 121) would also claim it.
  const TAIWAN = { lat: 26, lon: 121 };
  const TAIWAN_STRIKE_PACKAGE = [
    ...flightsAt(4, TAIWAN, { aircraftType: 'fighter', operator: 'plaaf' }),
    flight({ ...TAIWAN, aircraftType: 'tanker', operator: 'plaaf' }),
    flight({ ...TAIWAN, aircraftType: 'awacs', operator: 'plaaf' }),
  ];

  it('counts airframes inside theater bounds and grades the posture', () => {
    const taiwan = getTheaterPostureSummaries(TAIWAN_STRIKE_PACKAGE).find((p) => p.theaterId === 'taiwan-theater');
    assert.equal(taiwan.fighters, 4);
    assert.equal(taiwan.tankers, 1);
    assert.equal(taiwan.awacs, 1);
    assert.equal(taiwan.totalAircraft, 6);
    assert.equal(taiwan.postureLevel, 'elevated');
    assert.equal(taiwan.strikeCapable, true);
    assert.equal(taiwan.summary, '4 fighters, 1 tankers, 1 AWACS');
    assert.equal(taiwan.headline, 'Elevated military activity - Taiwan Strait');
    assert.deepEqual(taiwan.byOperator, { plaaf: 6 });
    assert.equal(taiwan.centerLat, 24);
    assert.equal(taiwan.centerLon, 122.5);
    assert.equal(taiwan.totalVessels, 0);
    assert.equal(taiwan.trend, 'stable');
    assert.equal(taiwan.changePercent, 0);
  });

  it('reports an empty theater as normal', () => {
    const baltic = getTheaterPostureSummaries([]).find((p) => p.theaterId === 'baltic-theater');
    assert.equal(baltic.totalAircraft, 0);
    assert.equal(baltic.postureLevel, 'normal');
    assert.equal(baltic.strikeCapable, false);
    assert.equal(baltic.summary, 'No military aircraft');
    assert.equal(baltic.headline, 'Normal activity - Baltic Theater');
  });

  it('surfaces only critical or strike-capable elevated theaters', () => {
    const critical = getCriticalPostures(TAIWAN_STRIKE_PACKAGE);
    assert.deepEqual(critical.map((p) => p.theaterId).sort(), ['taiwan-theater']);
  });
});

describe('posture recalculation with vessels and CII', () => {
  function ironTheaterPosture(overrides = {}) {
    const posture = getTheaterPostureSummaries([]).find((p) => p.theaterId === 'iran-theater');
    return { ...posture, ...overrides };
  }

  it('escalates on vessels alone', () => {
    const postures = [ironTheaterPosture({ totalVessels: 5 })];
    recalcPostureWithVessels(postures);
    assert.equal(postures[0].postureLevel, 'critical');
    assert.equal(postures[0].headline, 'Critical military buildup - Iran Theater (5 vessels)');
  });

  it('escalates on an injected CII score for the target nation', () => {
    const asked = [];
    const getCii = (code) => {
      asked.push(code);
      return code === 'IR' ? 90 : null;
    };
    const postures = [ironTheaterPosture()];
    recalcPostureWithVessels(postures, getCii);
    assert.deepEqual(asked, ['IR']);
    assert.equal(postures[0].postureLevel, 'critical');
    assert.equal(postures[0].headline, 'Critical military buildup - Iran Theater (No assets)');
  });

  it('maps CII bands onto posture levels', () => {
    for (const [cii, level] of [[90, 'critical'], [75, 'elevated'], [50, 'normal']]) {
      const postures = [ironTheaterPosture()];
      recalcPostureWithVessels(postures, () => cii);
      assert.equal(postures[0].postureLevel, level, `CII ${cii}`);
    }
  });

  it('leaves posture untouched when no CII provider is wired', () => {
    const postures = [ironTheaterPosture()];
    recalcPostureWithVessels(postures);
    assert.equal(postures[0].postureLevel, 'normal');
    assert.equal(postures[0].headline, 'Normal activity - Iran Theater');
  });

  it('asks for every mapped target nation and skips theaters without one', () => {
    const asked = [];
    const postures = getTheaterPostureSummaries([]);
    recalcPostureWithVessels(postures, (code) => {
      asked.push(code);
      return null;
    });
    assert.deepEqual(asked.sort(), ['IR', 'KP', 'PS', 'TW', 'YE']);
  });

  it('routes the engine method through its injected CII provider', () => {
    const { engine } = makeEngine({ getCii: (code) => (code === 'TW' ? 88 : null) });
    const postures = getTheaterPostureSummaries([]);
    engine.recalcPostureWithVessels(postures);
    const taiwan = postures.find((p) => p.theaterId === 'taiwan-theater');
    assert.equal(taiwan.postureLevel, 'critical');
  });
});
